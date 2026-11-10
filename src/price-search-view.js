'use strict';
// Block Kit for the TPS Assistant price-search modal. Read only: no order or cart actions.

const { supplierName, imageEvidence, formatBtuh, labelFuel } = require('./price-search-policy');
const OPEN = 'tps_price_search_open';
const RETRY = 'tps_price_search_retry';
const NEW = 'tps_price_search_new';
const FORM = 'tps_price_search_form';
const RESULTS = 'tps_price_search_results';

const plain = text => ({ type: 'plain_text', text: String(text).slice(0, 150) });
const title = text => ({ type: 'plain_text', text: String(text).slice(0, 24) });
const esc = text => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (text, n) => { const s = String(text || ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const option = (text, value) => ({ text: { type: 'plain_text', text }, value });

function priceSearchHomeButton() {
  return { type: 'button', action_id: OPEN, text: { type: 'plain_text', text: 'Search prices' }, value: 'open' };
}

function priceSearchHomeEntry() {
  return {
    type: 'home',
    callback_id: 'tps_assistant_price_entry',
    blocks: [
      { type: 'header', text: plain('Price search') },
      { type: 'section', text: { type: 'mrkdwn', text: 'Look up supplier prices and stock. This does not order parts.' } },
      { type: 'actions', block_id: 'tps_price_search_entry', elements: [priceSearchHomeButton()] },
    ],
  };
}

// Inserts the Assistant entry without removing or reordering existing Home blocks.
function appendPriceSearchHomeButton(view, allowed) {
  if (!allowed || !view || view.type !== 'home' || !Array.isArray(view.blocks)) return view;
  if (view.blocks.some(block => JSON.stringify(block).includes(OPEN)) || view.blocks.length >= 100) return view;
  const blocks = view.blocks.map(block => ({ ...block }));
  const at = blocks.findIndex(block => block.type === 'header');
  blocks.splice(at >= 0 ? at + 1 : 0, 0, { type: 'actions', block_id: 'tps_price_search_entry', elements: [priceSearchHomeButton()] });
  return { ...view, blocks };
}

function meta(sessionId) { return JSON.stringify({ s: sessionId }); }

function select(action_id, options, initial) {
  const element = { type: 'static_select', action_id, options };
  if (initial) element.initial_option = options.find(item => item.value === initial) || options[0];
  return element;
}

function searchForm(sessionId) {
  return {
    type: 'modal',
    callback_id: FORM,
    private_metadata: meta(sessionId),
    notify_on_close: true,
    title: title('Price search'),
    submit: title('Search'),
    close: title('Cancel'),
    blocks: [
      { type: 'alert', block_id: 'ps_notice', level: 'info', text: { type: 'mrkdwn', text: 'Read only. This does not order parts or grant installer approval.' } },
      input('ps_model', 'Model', { type: 'plain_text_input', action_id: 'model', max_length: 120, placeholder: plain('Example: G80-125') }),
      input('ps_part', 'Part number', { type: 'plain_text_input', action_id: 'part', max_length: 80, placeholder: plain('Optional') }, true),
      input('ps_desc', 'Description', { type: 'plain_text_input', action_id: 'desc', multiline: true, max_length: 500, placeholder: plain('Fuel, gallons, BTU, vent, or what the job needs') }, true),
      input('ps_photo', 'Photo of the label or part', { type: 'file_input', action_id: 'file', max_files: 1, filetypes: ['jpg', 'jpeg', 'png', 'heic', 'gif', 'webp'] }, true),
      input('ps_category', 'Category', select('category', [option('General plumbing', 'general'), option('Water heater', 'heater'), option('Backflow', 'backflow')], 'general')),
      input('ps_priority', 'Match priority', select('priority', [option('Default match', 'default'), option('Strict size', 'strict_size')], 'default')),
      input('ps_qty', 'Quantity', { type: 'plain_text_input', action_id: 'qty', initial_value: '1', max_length: 3 }),
      input('ps_location', 'ZIP, store, or branch', { type: 'plain_text_input', action_id: 'location', max_length: 80, placeholder: plain('Optional') }, true),
      input('ps_existing', 'Existing water heater', select('existing', [option('Not a replacement', 'none'), option('70 gal metal, ample room', 'gal70'), option('80 gal metal, ample room', 'gal80'), option('Other or unknown', 'other')], 'none'), true),
      { type: 'section', block_id: 'ps_policy', text: { type: 'mrkdwn', text: 'Water heaters use Hirsch, Reece US, Home Depot, Lowe\'s, and WinSupply of South San Diego (National City). SupplyHouse and MBM stay off heater searches. Those three accounts need a signed-in price. A guest price is not shown.' } },
    ],
  };
}

function input(block_id, label, element, optional = false) {
  return { type: 'input', block_id, optional, label: plain(label), element };
}

function shell(sessionId, heading, blocks) {
  return {
    type: 'modal',
    callback_id: RESULTS,
    private_metadata: meta(sessionId),
    notify_on_close: true,
    title: title(heading),
    close: title('Close'),
    blocks,
  };
}

function actions(sessionId) {
  return { type: 'actions', block_id: 'ps_actions', elements: [
    { type: 'button', action_id: RETRY, text: plain('Search again'), style: 'primary', value: sessionId },
    { type: 'button', action_id: NEW, text: plain('New search'), value: sessionId },
  ] };
}

function searchingView(sessionId, note) {
  return shell(sessionId, 'Searching prices', [
    { type: 'section', block_id: 'ps_wait', text: { type: 'mrkdwn', text: 'Checking supplier prices and stock. This window updates in place. Closing it stops the status checks.' } },
    ...(note ? [{ type: 'section', block_id: 'ps_identify', text: { type: 'mrkdwn', text: clip(note, 500) } }] : []),
    { type: 'context', block_id: 'ps_wait_note', elements: [{ type: 'mrkdwn', text: 'No order is placed. Installer approval is not granted.' }] },
  ]);
}

function statusView(sessionId, level, message) {
  return shell(sessionId, 'Price search', [
    { type: 'alert', block_id: 'ps_status', level, text: { type: 'mrkdwn', text: clip(message, 200) } },
    actions(sessionId),
  ]);
}

function liveCapture(collector) {
  return collector?.linked === true && collector?.liveRun === true && collector?.evidenceKind === 'live_dom' && collector?.httpEndpoint == null;
}

function livePrice(row, collector) {
  const kind = String(row.priceKind || '');
  return liveCapture(collector) && ['verified_account_net', 'public', 'list'].includes(kind) && typeof row.price === 'string' && row.price.trim();
}

function priceLines(row, collector) {
  const kind = String(row.priceKind || '');
  const { ACCOUNT_PRICE_SUPPLIERS } = require('./price-search-policy');
  const account = ACCOUNT_PRICE_SUPPLIERS.includes(row.supplierId);
  if (account && kind !== 'verified_account_net') return ['login_required. Account price not_validated. Guest price is not shown.'];
  if (account && !liveCapture(collector)) return ['not_validated. Account price is not shown until a live signed-in check.'];
  if (!livePrice(row, collector)) {
    if (kind === 'authenticated_unknown') return ['login_required. Account price not_validated. Not a confirmed net price.'];
    if (kind === 'unsupported') return ['unsupported. login_required. Price not_validated.'];
    if (kind === 'not_configured' || collector?.linked === false) return ['not_validated. Price unknown. Collector is not linked.'];
    return ['not_validated. Price unknown.'];
  }
  const name = kind === 'list' ? 'Factory list' : kind === 'verified_account_net' ? 'Account net' : 'Displayed price';
  const shown = row.rawPriceText ? esc(row.rawPriceText) : esc(row.price);
  const when = row.freshness?.observedAt || 'time unknown';
  return [`${name} ${shown} · ${esc(row.currency || 'currency unknown')} · ${esc(row.uom || 'unit unknown')} · ${esc(when)}`];
}

function stockLines(row, collector) {
  if (!liveCapture(collector)) return ['Stock not_validated. Not a live check.'];
  const lines = [];
  const availability = row.availability || {};
  const branches = Array.isArray(row.otherBranches) ? row.otherBranches : [];
  const confirmed = branches.find(branch => branch.scope === 'local' && branch.quantity && branch.needsConfirmation === false && ['explicit_cell', 'displayed_count'].includes(branch.quantityProvenance));
  if (confirmed) lines.push(`In stock (${esc(confirmed.quantity)})${confirmed.location ? ` · ${esc(confirmed.location)}` : ''}`);
  else if (typeof availability.local === 'string' && availability.local) lines.push(`Local: ${esc(availability.local)} — unconfirmed.`);
  for (const branch of branches.filter(branch => branch !== confirmed).slice(0, 4)) {
    const where = esc(branch.name || branch.location || 'Branch');
    if (!branch.quantity || branch.quantityProvenance === 'not_displayed') lines.push(`${where}: quantity not displayed.`);
    else {
      let line = `${where}: ${esc(branch.quantity)}${branch.needsConfirmation === false ? '' : ' — unconfirmed'}`;
      if (branch.etaText && branch.etaProvenance === 'displayed_text') line += `. Supplier showed: ${esc(branch.etaText)}. Not a guaranteed delivery.`;
      lines.push(line);
    }
  }
  if (typeof availability.network === 'string' && availability.network) lines.push(`In network — unconfirmed. ${esc(availability.network)}.${availability.raw ? ` ${esc(availability.raw)}.` : ' Call to confirm availability.'} Not guaranteed stock.`);
  else if (!availability.local && !branches.length) lines.push('Stock network unknown.');
  if (availability.availableToOrder === true) lines.push('Available to order — not stock.');
  if (!lines.length) lines.push('Stock unknown.');
  return lines;
}

function supplierLine(row, collector) {
  const known = supplierName(row.supplierId || row.supplier);
  const name = known ? known.name : 'Unknown supplier';
  return `*${esc(name)}*\n${[...priceLines(row, collector), ...stockLines(row, collector)].join('\n')}`;
}

function productBlocks(item, index) {
  const badge = { exact: 'Exact match', equivalent: 'Candidate equivalent', verify: 'Needs verification' }[item.kind];
  const summary = [item.model ? `Model ${item.model}` : null, item.partNumber ? `Part ${item.partNumber}` : null].filter(Boolean).join(' · ') || 'Model unknown';
  const card = {
    type: 'card',
    block_id: `ps_card_${index}`,
    title: { type: 'plain_text', text: clip(item.title || 'Product', 150) },
    subtitle: { type: 'plain_text', text: badge },
    body: { type: 'mrkdwn', text: clip(esc(summary), 200) },
  };
  const image = item.observed ? imageEvidence(item.imageUrl, item.title || 'Product photo from the supplier') : null;
  if (image && !item.illustrative) card.hero_image = { type: 'image', image_url: image.url, alt_text: image.alt };
  const notes = [...(item.differences || []), ...(item.reasons || [])];
  if (!image) notes.unshift('No product image from the supplier.');
  const blocks = [card, { type: 'section', block_id: `ps_price_${index}`, text: { type: 'mrkdwn', text: clip((item.rows || []).map(row => supplierLine(row, item.collector)).join('\n\n') || 'No supplier rows were returned.', 2900) } }];
  if (notes.length) blocks.splice(1, 0, { type: 'section', block_id: `ps_notes_${index}`, text: { type: 'mrkdwn', text: clip(notes.map(note => `• ${esc(note)}`).join('\n'), 2900) } });
  return blocks;
}

function resultsView(sessionId, presented, now = new Date()) {
  const blocks = [
    { type: 'alert', block_id: 'ps_readonly', level: 'info', text: { type: 'mrkdwn', text: 'Read only. Does not order. Installer approval is not granted. Edgar approval is still required.' } },
    ...(presented.liveNotice ? [{ type: 'alert', block_id: 'ps_live', level: 'warning', text: { type: 'mrkdwn', text: clip(presented.liveNotice, 200) } }] : []),
    { type: 'section', block_id: 'ps_query', text: { type: 'mrkdwn', text: clip(presented.summary, 2900) } },
  ];
  const groups = [['exact', 'Exact matches'], ['equivalent', 'Candidate equivalents'], ['verify', 'Needs verification']];
  let index = 0;
  for (const [kind, heading] of groups) {
    const items = presented.groups[kind] || [];
    if (!items.length) continue;
    blocks.push({ type: 'header', block_id: `ps_h_${kind}`, text: plain(heading) });
    for (const item of items) blocks.push(...productBlocks(item, index++));
  }
  if (!presented.groups.exact.length && !presented.groups.equivalent.length && !presented.groups.verify.length) {
    blocks.push({ type: 'section', block_id: 'ps_empty', text: { type: 'mrkdwn', text: 'No exact, equivalent, or unverified candidate was returned.' } });
  }
  if (presented.errors?.length) blocks.push({ type: 'section', block_id: 'ps_errors', text: { type: 'mrkdwn', text: clip(presented.errors.map(error => `• ${esc(error)}`).join('\n'), 2900) } });
  if (presented.groups.rejected.length) {
    blocks.push({ type: 'header', block_id: 'ps_h_rejected', text: plain('Not a match') });
    blocks.push({ type: 'section', block_id: 'ps_rejected', text: { type: 'mrkdwn', text: clip(presented.groups.rejected.map(item => `• ${esc(item.title || 'Product')}: ${esc(item.reasons[0] || 'Not a compatible match.')}`).join('\n'), 2900) } });
  }
  blocks.push(actions(sessionId));
  const when = presented.searchedAt ? `Checked ${esc(presented.searchedAt)}` : 'Checked time unknown';
  const stale = presented.searchedAt && now.getTime() - Date.parse(presented.searchedAt) > 15 * 60 * 1000;
  blocks.push({ type: 'context', block_id: 'ps_fresh', elements: [{ type: 'mrkdwn', text: clip(`${when}${stale ? ' · Older than 15 minutes. Search again for a fresh check.' : ''} · ${presented.footer}`, 300) }] });
  return shell(sessionId, 'Price results', blocks.slice(0, 100));
}

function understoodLine(intent) {
  const bits = [intent.category, intent.fuel ? labelFuel(intent.fuel) : null, intent.gallons ? `${intent.gallons} gal` : null, intent.btuh ? formatBtuh(intent.btuh) : null, intent.vent, intent.priority === 'strict_size' ? 'strict size' : 'default match'].filter(Boolean);
  return `*Searching* ${esc(bits.join(' · ') || 'the text you entered')}`;
}

module.exports = {
  OPEN, RETRY, NEW, FORM, RESULTS, priceSearchHomeButton, priceSearchHomeEntry, appendPriceSearchHomeButton,
  searchForm, searchingView, statusView, resultsView, understoodLine, priceLines, stockLines,
};
