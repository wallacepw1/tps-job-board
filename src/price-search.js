'use strict';
// TPS Assistant price search. Handled on /slack/assistant-events, the same gateway as Phone settings.
// This does not publish the Assistant Home. That Home is produced by the forwarded app_home_opened event.
const { randomUUID } = require('node:crypto');
const { ADMINS } = require('./assignment-policy');
const { slackApi } = require('./job-files');
const { createPriceClient, publicStatus, buildRequest } = require('./price-search-client');
const { getPriceBridge } = require('./price-bridge');
const { validateResult } = require('./price-contract');
const { intentFrom, normModel, classifyCandidate, brandRank, supplierIdsFor, effectiveCategory, supplierName, HEATER_EXCLUDED } = require('./price-search-policy');
const { OPEN, RETRY, NEW, searchForm, searchingView, statusView, resultsView, understoodLine } = require('./price-search-view');

const TEAM = 'T086X85G14N';
const sessions = new Map();

function resetPriceSearchSessions() { for (const session of sessions.values()) stop(session); sessions.clear(); }
function canUsePriceSearch(userId) { return ADMINS.includes(userId); }
function sessionIdFrom(view) { try { const parsed = JSON.parse(view?.private_metadata || '{}'); return typeof parsed.s === 'string' ? parsed.s : null; } catch { return null; } }
function stop(session) { if (!session) return; session.closed = true; session.cancel?.(); session.cancel = null; sessions.delete(session.id); }
function prune(now) { for (const session of sessions.values()) if (now - session.started > 15 * 60 * 1000) stop(session); }

function claim(body, enabled) {
  if (!enabled) return null;
  const action = body?.actions?.[0]?.action_id || '';
  const callback = body?.view?.callback_id || '';
  if (body?.type === 'block_actions' && action.startsWith('tps_price_')) return action;
  if ((body?.type === 'view_submission' || body?.type === 'view_closed') && callback.startsWith('tps_price_search_')) return body.type;
  return null;
}

function clean(value, max) {
  const text = String(value || '').replace(/[\u0000-\u001f]/g, ' ').trim();
  return text ? text.slice(0, max) : '';
}

function readForm(view) {
  const values = view?.state?.values || {};
  const file = values.ps_photo?.file?.files?.[0] || null;
  return {
    modelHint: clean(values.ps_model?.model?.value, 120),
    partNumber: clean(values.ps_part?.part?.value, 80),
    description: clean(values.ps_desc?.desc?.value, 500),
    categoryHint: values.ps_category?.category?.selected_option?.value || '',
    matchPriority: values.ps_priority?.priority?.selected_option?.value === 'strict_size' ? 'strict_size' : 'default',
    qtyText: clean(values.ps_qty?.qty?.value, 3),
    location: clean(values.ps_location?.location?.value, 80),
    existingHeater: values.ps_existing?.existing?.selected_option?.value || 'none',
    photo: file && /^F[A-Z0-9]+$/.test(file.id || '') ? { id: file.id, name: clean(file.name, 120) } : null,
  };
}

function queryTypeOf(input) {
  if (input.partNumber) return 'part_number';
  if (input.modelHint) return 'model_text';
  if (input.description) return 'description';
  if (input.photo) return 'photo';
  return null;
}

function composeDescription(input) {
  const note = { gal70: 'Existing heater: 70 gallon metal, ample room, not PVC.', gal80: 'Existing heater: 80 gallon metal, ample room, not PVC.' }[input.existingHeater];
  return [input.description, note].filter(Boolean).join('\n');
}

function formErrors(input) {
  const errors = {};
  const qty = Number(input.qtyText || '1');
  if (!queryTypeOf({ ...input, description: input.description })) errors.ps_model = 'Enter a model, part, description, or photo.';
  if (!Number.isInteger(qty) || qty < 1 || qty > 99) errors.ps_qty = 'Enter a quantity from 1 to 99.';
  return { errors, qty };
}

function specNumbers(specs) {
  if (!specs || typeof specs !== 'object') return {};
  const gallons = Array.isArray(specs.gallons) ? specs.gallons[0] : specs.gallons;
  const gallonText = String(gallons ?? '');
  const gallonMatch = /(\d{2,3}(?:\.\d)?)/.exec(gallonText);
  const btuMatch = /(\d{2,3}(?:,\d{3})+|\d{4,6}|\d{2,3}\s*k)/i.exec(String(specs.inputBtu || specs.btuh || ''));
  return {
    gallons: gallonMatch ? Number(gallonMatch[1]) : null,
    btuh: btuMatch ? (/k/i.test(btuMatch[1]) ? Number(btuMatch[1]) * 1000 : Number(btuMatch[1].replace(/[^\d]/g, ''))) : null,
    fuel: /natural gas|\bng\b/i.test(String(specs.fuel || '')) ? 'natural_gas' : /propane|\blp\b/i.test(String(specs.fuel || '')) ? 'lp' : /electric/i.test(String(specs.fuel || '')) ? 'electric' : /heat pump/i.test(String(specs.fuel || '')) ? 'heat_pump' : null,
    vent: specs.ventMaterial || specs.ventType || specs.vent || null,
    material: specs.ventMaterial || specs.material || null,
    emissions: specs.emissions || null,
  };
}

function rowsFor(candidate, rows) {
  const supplier = candidate.supplierId;
  const matched = supplier ? rows.filter(row => (row.supplierId || row.supplier) === supplier) : [];
  return matched.length ? matched : rows.length === 1 ? rows : [];
}

function presentResult(input, result) {
  const intent = intentFrom(input);
  intent.modelKey = normModel(input.modelHint || input.partNumber);
  const category = effectiveCategory(input);
  const collector = result.collector || {};
  const live = collector.linked === true && collector.liveRun === true && ['live_dom', 'supplied_observation'].includes(collector.evidenceKind) && collector.httpEndpoint == null;
  const rows = (result.priceRows || []).filter(row => {
    if (category !== 'heater') return true;
    const known = supplierName(row.supplierId || row.supplier);
    return !known || !HEATER_EXCLUDED.includes(known.id);
  });
  const candidates = (result.candidates || []).map(raw => {
    const comparison = raw.comparison || raw.specs || {};
    const image = raw.image || {};
    const illustrative = image.relation === 'supplier_illustrative_not_exact_model' || image.relation === 'supplier_catalog_illustration';
    const item = {
      supplierId: raw.supplierId || null,
      title: raw.title || raw.name || [supplierName(raw.supplierId)?.name, raw.model || comparison.model].filter(Boolean).join(' ') || 'Product',
      brand: raw.brand || supplierName(raw.supplierId)?.name || '',
      model: raw.model || raw.modelHint || '',
      partNumber: raw.partNumber || raw.part || '',
      specs: { ...specNumbers(comparison), ...(raw.specs || {}) },
      imageUrl: typeof image.url === 'string' ? image.url : raw.imageUrl || null,
      illustrative,
      filterPass: raw.evidenceKind === 'fixture' ? false : raw.filterPass,
      backendKind: raw.matchClass || raw.matchKind || raw.kind || '',
      differences: Array.isArray(raw.differences) ? raw.differences.map(String).slice(0, 6) : [],
      collector,
    };
    const judged = classifyCandidate(intent, item);
    const observed = ['live_dom', 'supplied_observation'].includes(raw.evidenceKind);
    let kind = raw.evidenceKind === 'fixture' || raw.filterPass === false || judged.kind === 'rejected' || raw.matchClass === 'not_equivalent' ? 'rejected' : raw.matchClass === 'exact' && judged.kind === 'exact' ? 'exact' : ['candidate_equivalent', 'suitable_equivalent', 'tradeoff'].includes(raw.matchClass) ? 'equivalent' : ['insufficient_evidence', 'unknown'].includes(raw.matchClass) ? 'verify' : judged.kind;
    if ((kind === 'exact' || kind === 'equivalent') && !observed) kind = 'verify';
    const unverified = (kind === 'verify' && !observed) ? ['Unverified until a manufacturer or product page spec is collected.'] : [];
    return { ...item, ...judged, kind, rows: rowsFor({ ...item, supplierId: raw.supplierId }, rows), differences: [...item.differences, ...judged.tradeoffs, ...unverified, ...(illustrative ? ['Supplier illustration is not confirmed as this exact model.'] : []), ...(raw.evidenceKind === 'fixture' ? ['Fixture evidence is not a live product.'] : [])] };
  });
  const groups = { exact: [], equivalent: [], verify: [], rejected: [] };
  for (const item of candidates) {
    const bucket = item.kind === 'exact' ? groups.exact : item.kind === 'equivalent' ? groups.equivalent : item.kind === 'verify' ? groups.verify : groups.rejected;
    bucket.push(item);
  }
  for (const bucket of [groups.exact, groups.equivalent, groups.verify]) bucket.sort((a, b) => brandRank(a) - brandRank(b));
  const errors = (result.supplierErrors || []).map(error => {
    const name = supplierName(error.supplierId)?.name || error.supplierId || 'Supplier';
    if (error.code === 'location_required' && error.supplierId === 'winsupply') return `${name}: WinSupply of South San Diego (National City) is selected, but the signed-in location was not confirmed.`;
    if (['auth_expired', 'access_denied', 'missing_company'].includes(error.code)) return `${name}: account login required. Price unverified.`;
    return `${name}: ${error.message || error.code || 'could not be checked.'}`;
  });
  const hypotheses = (input.enrichment?.candidates || []).filter(item => item?.model).map(item => `Unverified hypothesis: ${item.model}. Not OEM-proven.`);
  const unknowns = (input.enrichment?.unknowns || []).map(item => `${item}: unknown`);
  const summary = [understoodLine(intent), input.identifyNote, category === 'heater' ? 'SupplyHouse and MBM are excluded for this heater search. WinSupply of South San Diego (National City) stays included.' : `Suppliers: ${supplierIdsFor(category).join(', ')}.`, ...unknowns, ...hypotheses].filter(Boolean).join('\n');
  const liveNotice = live ? null : collector.evidenceKind === 'fixture' ? 'Fixture data is not a live supplier check. No prices are shown.' : 'Not a live supplier check. No prices are shown.';
  return { groups: { ...groups, rejected: groups.rejected.slice(0, 8), exact: groups.exact.slice(0, 4), equivalent: groups.equivalent.slice(0, 4), verify: groups.verify.slice(0, 3) }, summary, errors, liveNotice, searchedAt: result.searchedAt || rows.find(row => row.freshness?.observedAt)?.freshness.observedAt || null, footer: 'Prices appear only on a live collector result.' };
}

async function defaultPhoto(file, token, fetch) {
  const info = await slackApi('files.info', { file: file.id }, token, fetch);
  const remote = info.file || {};
  const mime = String(remote.mimetype || '');
  if (!/^image\/(jpeg|png|gif|webp|heic|heif)$/.test(mime)) return { ok: false, reason: 'unsupported_type' };
  const download = remote.url_private_download || remote.url_private;
  if (!download) return { ok: false, reason: 'unavailable' };
  const res = await fetch(download, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return { ok: false, reason: 'unavailable' };
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > 1500000) return { ok: false, reason: 'too_large' };
  return { ok: true, photoRef: file.id, fileName: remote.name || file.name || 'label.jpg', fileContent: bytes.toString('base64') };
}

function handlePriceSearch(body, options = {}) {
  const env = options.env || process.env;
  const enabled = typeof options.enabled === 'boolean' ? options.enabled : env.PRICE_SEARCH_ENABLED === '1';
  if (!claim(body, enabled)) return null;
  const user = body.user?.id || body.user_id;
  const team = body.team?.id || body.team_id;
  const token = options.token ?? env.TPS_ASSISTANT_BOT_TOKEN;
  const fetch = options.fetch || global.fetch;
  const schedule = options.schedule || ((fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return () => clearTimeout(timer); });
  const now = options.now || (() => new Date());
  if (body.type === 'view_closed') {
    const session = sessions.get(sessionIdFrom(body.view));
    if (session && session.user === user) { if (session.bridgeJobId && options.bridge) options.bridge.cancel(session.bridgeJobId); stop(session); }
    return { status: 200, body: '' };
  }
  if (team !== TEAM || !canUsePriceSearch(user)) return { status: 200, body: '' };
  if (!token) { console.error('price search failed', 'missing_assistant_token'); return { status: 200, body: '' }; }
  const client = options.client || createPriceClient({ env, fetch });
  const bridge = options.bridge || getPriceBridge(env);
  const bridgeConfigured = typeof options.bridgeConfigured === 'boolean' ? options.bridgeConfigured : client.config.bridgeConfigured;
  const current = now();
  prune(current.getTime());

  const update = async (viewId, view, hash) => {
    try { await slackApi('views.update', { view_id: viewId, ...(hash ? { hash } : {}), view }, token, fetch); }
    catch (error) {
      if (hash && /hash_conflict/.test(error.message || '')) await slackApi('views.update', { view_id: viewId, view }, token, fetch);
      else throw error;
    }
  };

  if (body.type === 'block_actions' && body.actions?.[0]?.action_id === NEW) {
    const session = openSession(user, current);
    const follow = update(body.view.id, searchForm(session.id), body.view.hash).catch(error => console.error('price search failed', safeCode(error)));
    return { status: 200, body: '', follow };
  }
  if (body.type === 'block_actions' && body.actions?.[0]?.action_id === OPEN) {
    const session = openSession(user, current);
    const follow = slackApi('views.open', { trigger_id: body.trigger_id, view: searchForm(session.id) }, token, fetch)
      .then(opened => { session.viewId = opened.view?.id || session.viewId; })
      .catch(error => console.error('price search failed', safeCode(error)));
    return { status: 200, body: '', follow };
  }

  const action = body.actions?.[0]?.action_id;
  const existing = sessions.get(sessionIdFrom(body.view) || body.actions?.[0]?.value);
  if ((action === RETRY || body.type === 'view_submission') && (!existing || existing.user !== user)) {
    const session = openSession(user, current);
    if (body.type === 'view_submission') return { status: 200, json: { response_action: 'update', view: statusView(session.id, 'warning', 'That search expired. Start again.') } };
    const follow = update(body.view.id, statusView(session.id, 'warning', 'That search expired. Start again.'), body.view.hash).catch(error => console.error('price search failed', safeCode(error)));
    return { status: 200, body: '', follow };
  }

  let input = existing?.input;
  let response = null;
  if (body.type === 'view_submission') {
    input = readForm(body.view);
    const { errors, qty } = formErrors(input);
    if (Object.keys(errors).length) return { status: 200, json: { response_action: 'errors', errors } };
    input = { ...input, qty, description: composeDescription(input), queryType: queryTypeOf(input), requestId: randomUUID() };
    existing.input = input;
    existing.viewId = body.view.id;
    response = { status: 200, json: { response_action: 'update', view: searchingView(existing.id) } };
  } else if (action === RETRY) {
    existing.viewId = body.view.id;
    response = { status: 200, body: '' };
  } else return { status: 200, body: '' };

  const generation = ++existing.generation;
  existing.cancel?.();
  const follow = runSearch(existing, generation, { input, client, bridge, bridgeConfigured, token, fetch, schedule, update, photoLoader: options.photoLoader, hash: body.view?.hash, showSearching: action === RETRY, now }).catch(error => console.error('price search failed', safeCode(error)));
  return { ...response, follow };
}

function openSession(user, now) {
  const session = { id: randomUUID(), user, viewId: null, input: null, generation: 0, closed: false, cancel: null, started: now.getTime() };
  sessions.set(session.id, session);
  return session;
}

async function runSearch(session, generation, ctx) {
  if (ctx.showSearching && session.viewId) await ctx.update(session.viewId, searchingView(session.id), ctx.hash);
  const payload = { ...ctx.input };
  const photo = payload.photo;
  delete payload.photo;
  if (photo) {
    let loaded = { ok: false, reason: 'unavailable' };
    try { loaded = await (ctx.photoLoader || defaultPhoto)(photo, ctx.token, ctx.fetch); } catch { loaded = { ok: false, reason: 'unavailable' }; }
    if (!loaded.ok) return finish(session, generation, ctx, payload, { status: 'error', error: { message: loaded.reason === 'unsupported_type' ? 'This photo type is not supported. Use a JPEG, PNG, GIF, or WEBP.' : loaded.reason === 'too_large' ? 'That photo is too large to identify.' : 'The photo could not be read. Identification did not run.' } });
    payload.photoRef = loaded.photoRef;
    payload.fileName = loaded.fileName;
    payload.photoBytes = { fileName: loaded.fileName, fileContent: loaded.fileContent };
    if (!ctx.client.config.identifyConfigured) return finish(session, generation, ctx, payload, { status: 'error', error: { message: 'Photo identification is not connected. No supplier search was queued.' } });
  }
  if (session.closed || session.generation !== generation) return;
  let identifyNote = null;
  if (ctx.client.config.identifyConfigured) {
    const identified = await ctx.client.identify(buildRequest(payload), payload.photoBytes);
    if (identified.status !== 'complete') return finish(session, generation, ctx, payload, { status: 'error', error: identified.error || { message: 'Identification could not be completed. No supplier search was queued.' } });
    if (identified.identifiedSpecs) payload.identifiedSpecs = identified.identifiedSpecs;
    if (Array.isArray(identified.candidateHints)) payload.candidateHints = identified.candidateHints;
    if (identified.categoryHint) payload.categoryHint = identified.categoryHint;
    if (identified.enrichment) payload.enrichment = identified.enrichment;
    if (identified.dropped) identifyNote = 'Some identification fields were outside the supported list and were not queued.';
  } else identifyNote = 'Model identification is not connected. No identified specs were added.';
  payload.identifyNote = identifyNote;
  delete payload.photoBytes;
  if (!ctx.bridgeConfigured) return finish(session, generation, ctx, payload, { status: 'unconfigured' });
  const request = buildRequest(payload);
  const queued = ctx.bridge.enqueue(request, payload.enrichment);
  if (!queued.ok) return finish(session, generation, ctx, payload, { status: 'error', error: { message: queued.error === 'full' ? 'Price search is busy. Try again shortly.' : 'The search could not be queued. No prices are shown.', retryable: true } });
  session.bridgeJobId = queued.id;
  if (identifyNote && session.viewId) await ctx.update(session.viewId, searchingView(session.id, identifyNote));
  const result = await pollBridge(session, generation, queued.id, ctx);
  return finish(session, generation, ctx, payload, result);
}

async function finish(session, generation, ctx, payload, result) {
  session.cancel?.();
  session.cancel = null;
  if (session.closed || session.generation !== generation || !session.viewId) return;
  if (result.status === 'closed') return;
  await ctx.update(session.viewId, viewFor(session, payload, result, ctx.now()));
}

function pause(session, ms, schedule) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    const cancelTimer = schedule(() => finish(true), ms);
    session.cancel = () => { cancelTimer(); finish(false); };
  });
}

async function pollBridge(session, generation, jobId, ctx) {
  const deadline = ctx.now().getTime() + 10 * 60 * 1000;
  while (ctx.now().getTime() < deadline) {
    if (session.closed || session.generation !== generation) return { status: 'closed' };
    const job = ctx.bridge.get(jobId);
    if (job.status === 'complete') {
      const checked = validateResult(job.result);
      if (!checked.ok || checked.endpointRejected) return { status: 'error', error: { message: 'Supplier result did not match the price contract. No prices are shown.' } };
      return { status: 'complete', ...job.result };
    }
    if (job.status === 'expired' || job.status === 'missing') return { status: 'error', error: { message: job.status === 'missing' ? 'The search was interrupted. Search again.' : 'The supplier check expired. Search again.', retryable: true } };
    const resume = await pause(session, 2000, ctx.schedule);
    if (!resume || session.closed || session.generation !== generation) return { status: 'closed' };
  }
  return { status: 'error', error: { message: 'The supplier check is still waiting. Search again to check. Closing this window stops the status checks.', retryable: true } };
}

function viewFor(session, input, result, now) {
  if (result.status === 'unconfigured' || result.status === 'disabled') return statusView(session.id, 'warning', 'Supplier price bridge is not connected. No prices are shown.');
  if (result.status !== 'complete') return statusView(session.id, 'error', safeText(result.error?.message) || 'Price search could not be completed. You can search again.');
  const presented = presentResult(input, result);
  if (input.photoNote) presented.summary = `${presented.summary}\n${input.photoNote}`;
  presented.searchedAt = presented.searchedAt || now.toISOString();
  return resultsView(session.id, presented, now);
}

function safeText(value) {
  const text = String(value || '');
  if (!text || /bearer|token|secret|authorization|webhook|https?:\/\//i.test(text)) return '';
  return text.slice(0, 180);
}

function safeCode(error) {
  const text = String(error?.message || 'error');
  if (/bearer|token|secret|authorization|webhook/i.test(text)) return 'request_failed';
  return text.slice(0, 120);
}

module.exports = { handlePriceSearch, presentResult, canUsePriceSearch, resetPriceSearchSessions, publicStatus };
