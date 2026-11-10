const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { createHmac } = require('node:crypto');
const { buildRequest, createPriceClient, publicStatus } = require('../src/price-search-client');
const { createBridge } = require('../src/price-bridge');
const { supplierIdsFor } = require('../src/price-search-policy');
const { presentResult, handlePriceSearch, resetPriceSearchSessions, canUsePriceSearch } = require('../src/price-search');
const { searchForm, searchingView, resultsView, priceSearchHomeEntry, appendPriceSearchHomeButton, priceLines, stockLines } = require('../src/price-search-view');
const { registerAssistantEventsProxy } = require('../src/assistant-events-proxy');
const { homeView } = require('../src/views');

const ADMIN = 'U0876C3TEGL';
const TEAM = 'T086X85G14N';
const HEATER = { description: 'commercial 80 gallon 120k natural gas metal', categoryHint: 'heater', matchPriority: 'default', qty: 1, existingHeater: 'gal80' };

test('seven suppliers, and heaters drop only SupplyHouse and MBM', () => {
  assert.deepEqual(supplierIdsFor('backflow'), ['hirsch', 'reece_us', 'homedepot', 'lowes', 'supplyhouse', 'masterbuildermercantile', 'winsupply']);
  assert.deepEqual(supplierIdsFor('general'), supplierIdsFor('backflow'));
  assert.deepEqual(supplierIdsFor('heater'), ['hirsch', 'reece_us', 'homedepot', 'lowes', 'winsupply']);
  assert.equal(canUsePriceSearch(ADMIN), true);
  assert.equal(canUsePriceSearch('U0C2TELAYKE'), false);
});

test('request uses the prose contract and no embedded endpoint', () => {
  const request = buildRequest({ ...HEATER, requestId: 'req-1', queryType: 'description', location: '97214', photoRef: 'F123' });
  assert.equal(request.contractVersion, undefined);
  assert.equal(request.companyContext.winsupply, 'WinSupply of South San Diego (National City)');
  assert.equal(request.mode, 'plan');
  assert.equal(request.identifiedSpecs, undefined);
  assert.equal(request.queryType, 'description');
  assert.equal(request.matchPriority, 'default');
  assert.equal(request.uiSource, 'tps_assistant_app_home');
  assert.equal(request.categoryHint, 'water_heater');
  assert.equal(request.photoRef, 'F123');
  assert.equal(request.fileUrl, undefined);
  assert.ok(request.suppliers.includes('winsupply'));
  assert.ok(!request.suppliers.includes('supplyhouse'));
  assert.equal(JSON.stringify(request).includes('latenode'), false);
});

test('gallon keyword, electric, and smaller gas heaters are not commercial 120k equivalents', () => {
  const result = presentResult(HEATER, { candidates: [
    { title: 'A.O. Smith 80 Gallon 12.3 kW 208V Commercial Electric Water Heater', model: 'E-123' },
    { title: 'A.O. Smith 80 Gallon 18 kW Commercial Electric', model: 'E-18' },
    { title: 'A.O. Smith 74 Gallon 75100 BTU Natural Gas Commercial Water Heater', model: 'G-75' },
    { title: 'A.O. Smith 80 Gallon Commercial Heat Pump Water Heater', model: 'HP-80' },
    { title: 'A.O. Smith 50 Gallon 76000 BTU Natural Gas Power Vent', model: 'G-76' },
    { title: 'Standard residential 80 gallon 40000 BTU natural gas', model: 'R-80' },
    { title: 'Bradford White 80 Gallon 125000 BTU Natural Gas Commercial metal', model: 'BW-125', supplierId: 'winsupply', evidenceKind: 'supplied_observation', comparison: { fuel: 'natural gas', gallons: '80', inputBtu: '125000', ventMaterial: 'metal' } },
    { title: 'Rheem 80 Gallon 120000 BTU Natural Gas Commercial metal', model: 'RH-120', supplierId: 'lowes', evidenceKind: 'supplied_observation', comparison: { fuel: 'natural gas', gallons: '80', inputBtu: '120000', ventMaterial: 'metal' }, image: { url: 'https://example.com/rheem.jpg', alt: 'Rheem commercial tank', relation: 'displayed_image' } },
    { title: 'A.O. Smith 80 Gallon 120000 BTU Natural Gas Commercial metal', model: 'AOS-120', supplierId: 'hirsch', evidenceKind: 'supplied_observation', comparison: { fuel: 'natural gas', gallons: '80', inputBtu: '120000', ventMaterial: 'metal' }, image: { url: 'http://example.com/not-used.jpg', relation: 'displayed_image' } },
  ], priceRows: [
    { supplierId: 'winsupply', price: null, priceKind: 'not_configured', guaranteedStock: false, availability: { network: 'In Network (6)', raw: 'Call to Confirm Availability', needsConfirmation: true, guaranteedStock: false }, otherBranches: [{ name: 'Local branch', location: 'Local branch', scope: 'local', quantity: '1', quantityProvenance: 'explicit_cell', needsConfirmation: false, guaranteedStock: false }, { name: 'East branch', scope: 'other_branch', quantity: '2', etaText: 'Thursday', etaProvenance: 'displayed_text', needsConfirmation: true, guaranteedStock: false }] },
    { supplierId: 'supplyhouse', price: '49.00', priceKind: 'public', guaranteedStock: false },
    { supplierId: 'lowes', price: '12.00', priceKind: 'authenticated_unknown', guaranteedStock: false },
  ], collector: { linked: false, liveRun: false, evidenceKind: 'not_collected', httpEndpoint: null, bridge: 'outbound_mac_worker' } });
  const titles = group => result.groups[group].map(item => item.model);
  assert.deepEqual(titles('equivalent'), ['AOS-120', 'BW-125', 'RH-120']);
  assert.deepEqual(titles('exact'), []);
  assert.ok(['E-123', 'E-18', 'G-75', 'HP-80', 'G-76', 'R-80'].every(model => titles('rejected').includes(model)));
  const view = JSON.stringify(resultsView('session-1', result, new Date('2026-11-09T23:00:00Z')));
  assert.match(view, /Exact match|Candidate equivalent/);
  assert.match(view, /Needs verification|Not a match/);
  assert.match(view, /In stock \(1\)/);
  assert.match(view, /In network — unconfirmed\. In Network \(6\)/);
  assert.match(view, /Call to Confirm Availability/);
  assert.match(view, /Not a guaranteed delivery/);
  assert.match(view, /https:\/\/example.com\/rheem.jpg/);
  assert.doesNotMatch(view, /http:\/\/example.com/);
  assert.match(view, /SupplyHouse and MBM are excluded/);
  assert.doesNotMatch(view, /\*SupplyHouse\*/);
  assert.match(view, /WinSupply/);
  assert.doesNotMatch(view, /\$|49\.00|12\.00|Add to Cart|Add to List/);
  assert.match(view, /Account login required/);
  assert.match(view, /Not a confirmed net price/);
  assert.match(view, /Installer approval is not granted/);
});

test('null and unproven prices never become amounts', () => {
  const live = { linked: true, liveRun: true, evidenceKind: 'live_dom', httpEndpoint: null };
  assert.match(priceLines({ price: null, priceKind: 'not_configured' }, { linked: false }).join(' '), /collector not linked/);
  assert.match(priceLines({ price: '19.99', priceKind: 'authenticated_unknown', guaranteedStock: false }, live).join(' '), /Not a confirmed net price/);
  assert.doesNotMatch(priceLines({ price: '19.99', priceKind: 'authenticated_unknown' }, live).join(' '), /19\.99/);
  assert.match(priceLines({ price: '20.00', priceKind: 'public', currency: 'USD', uom: 'each', rawPriceText: '20.00', freshness: { observedAt: '2026-11-09T00:00:00Z' }, guaranteedStock: false }, live).join('\n'), /Displayed price 20\.00 · USD · each/);
  assert.match(priceLines({ price: '30.00', priceKind: 'list', currency: 'USD', guaranteedStock: false }, live).join('\n'), /Factory list 30\.00/);
  assert.doesNotMatch(priceLines({ supplierId: 'winsupply', price: '$5,670.79', priceKind: 'public', guaranteedStock: false }, live).join(' '), /5,670/);
  assert.match(priceLines({ supplierId: 'winsupply', price: '$5,670.79', priceKind: 'public', guaranteedStock: false }, live).join(' '), /Account login required/);
  const stock = stockLines({ availability: { network: 'In Network (4)', needsConfirmation: true, guaranteedStock: false, availableToOrder: true } }).join(' ');
  assert.match(stock, /unconfirmed/);
  assert.match(stock, /Available to order — not stock/);
  assert.match(stockLines({ availability: { guaranteedStock: false } }).join(' '), /Stock network unknown/);
  assert.doesNotMatch(stockLines({ availability: { guaranteedStock: false } }).join(' '), /None in stock/);
});

test('unconfigured client does not call the network or invent a price', async () => {
  let calls = 0;
  const client = createPriceClient({ env: {}, fetch: async () => { calls += 1; return { ok: true, status: 200, text: async () => '{"price":1}' }; } });
  assert.deepEqual(client.config, { enabled: false, identifyConfigured: false, bridgeConfigured: false });
  assert.equal((await client.identify({ requestId: 'x', queryType: 'description', description: 'valve' })).status, 'disabled');
  assert.equal(calls, 0);
  const enabled = createPriceClient({ env: { PRICE_SEARCH_ENABLED: '1' }, fetch: async () => { calls += 1; } });
  assert.equal((await enabled.identify({})).status, 'unconfigured');
  assert.equal(calls, 0);
  assert.equal(publicStatus({}, false).bridgeConfigured, false);
  assert.equal(publicStatus({}, false).identifyConfigured, false);
});

test('identify uses TLS only and does not call a loopback or unfinished webhook', async () => {
  let calls = 0;
  const fetch = async () => { calls += 1; return { ok: true, status: 200, text: async () => '{"status":"pending","jobId":"x"}' }; };
  const loopback = createPriceClient({ env: { PRICE_SEARCH_ENABLED: '1', PRICE_SEARCH_IDENTIFY_URL: 'https://127.0.0.1/identify', PRICE_SEARCH_IDENTIFY_TOKEN: 'test-token-value' }, fetch });
  assert.equal((await loopback.identify({ requestId: 'r', queryType: 'description', description: 'valve' })).status, 'unconfigured');
  assert.equal(calls, 0);
  const client = createPriceClient({ env: { PRICE_SEARCH_ENABLED: '1', PRICE_SEARCH_IDENTIFY_URL: 'https://identify.example.test/v1', PRICE_SEARCH_IDENTIFY_TOKEN: 'test-token-value' }, fetch });
  const pending = await client.identify({ requestId: 'r', queryType: 'description', description: 'valve' });
  assert.equal(pending.error.code, 'identify_incomplete');
  assert.equal(calls, 1);
});

function slackFetch(store) {
  return async (url, init) => {
    store.push({ url, body: init?.body ? JSON.parse(init.body) : null, authorization: init?.headers?.Authorization });
    return { ok: true, status: 200, json: async () => ({ ok: true, view: { id: 'VPRICE' } }), text: async () => '{"ok":true}' };
  };
}

function memoryBridge() { return createBridge({ file: null, enabled: true, now: () => Date.now() }); }

test('admin click opens the form; closing cancels a pending job before a price is shown', async () => {
  resetPriceSearchSessions();
  const calls = [];
  let release = null;
  const schedule = fn => { release = fn; return () => { release = null; }; };
  const bridge = memoryBridge();
  const opened = handlePriceSearch({ type: 'block_actions', team: { id: TEAM }, user: { id: ADMIN }, trigger_id: 'trig', actions: [{ action_id: 'tps_price_search_open' }] }, { enabled: true, token: 'xoxb-assistant', fetch: slackFetch(calls), schedule, bridge, bridgeConfigured: true });
  await opened.follow;
  assert.equal(calls[0].url, 'https://slack.com/api/views.open');
  assert.equal(calls[0].body.view.private_metadata.includes('xoxb'), false);
  const session = JSON.parse(calls[0].body.view.private_metadata).s;
  const submitted = handlePriceSearch({ type: 'view_submission', team: { id: TEAM }, user: { id: ADMIN }, view: { id: 'VPRICE', callback_id: 'tps_price_search_form', private_metadata: JSON.stringify({ s: session }), state: { values: { ps_model: { model: { value: 'G80-125' } }, ps_category: { category: { selected_option: { value: 'heater' } } }, ps_priority: { priority: { selected_option: { value: 'default' } } }, ps_qty: { qty: { value: '1' } } } } } }, { enabled: true, token: 'xoxb-assistant', fetch: slackFetch(calls), schedule, bridge, bridgeConfigured: true, client: { config: { identifyConfigured: false, bridgeConfigured: true } } });
  assert.equal(submitted.json.response_action, 'update');
  assert.match(JSON.stringify(submitted.json.view), /Checking supplier prices/);
  await new Promise(resolve => setImmediate(resolve));
  const closed = handlePriceSearch({ type: 'view_closed', team: { id: TEAM }, user: { id: ADMIN }, view: { callback_id: 'tps_price_search_results', private_metadata: JSON.stringify({ s: session }) } }, { enabled: true, token: 'xoxb-assistant', bridge });
  assert.equal(closed.status, 200);
  await submitted.follow;
  if (release) release();
  assert.equal(calls.some(call => /Displayed price|5,670/.test(JSON.stringify(call.body || {}))), false);
  assert.equal(bridge.claim({ workerId: 'mac', capabilities: ['hirsch', 'winsupply'] }).job, null);
});

test('text search queues without invented specs, and a disabled flag does not claim the click', async () => {
  resetPriceSearchSessions();
  const calls = [];
  const bridge = memoryBridge();
  const opened = handlePriceSearch({ type: 'block_actions', team: { id: TEAM }, user: { id: ADMIN }, trigger_id: 'trig', actions: [{ action_id: 'tps_price_search_open' }] }, { enabled: true, token: 'xoxb-assistant', fetch: slackFetch(calls), bridge, bridgeConfigured: false, client: { config: { identifyConfigured: false, bridgeConfigured: false } } });
  await opened.follow;
  const session = JSON.parse(calls[0].body.view.private_metadata).s;
  const submitted = handlePriceSearch({ type: 'view_submission', team: { id: TEAM }, user: { id: ADMIN }, view: { id: 'VPRICE', callback_id: 'tps_price_search_form', private_metadata: JSON.stringify({ s: session }), state: { values: { ps_desc: { desc: { value: '2 inch ball valve' } }, ps_category: { category: { selected_option: { value: 'general' } } }, ps_qty: { qty: { value: '1' } } } } } }, { enabled: true, token: 'xoxb-assistant', fetch: slackFetch(calls), bridge, bridgeConfigured: false, client: { config: { identifyConfigured: false, bridgeConfigured: false } } });
  await submitted.follow;
  assert.match(JSON.stringify(calls.at(-1).body.view), /not connected/);
  assert.equal(bridge.claim({ workerId: 'mac', capabilities: ['hirsch'] }).job, null);
  assert.equal(handlePriceSearch({ type: 'block_actions', actions: [{ action_id: 'tps_price_search_open' }] }, { enabled: false }), null);
  assert.equal(handlePriceSearch({ type: 'block_actions', team: { id: TEAM }, user: { id: 'U0C2TELAYKE' }, actions: [{ action_id: 'tps_price_search_open' }] }, { enabled: true, token: 'xoxb-assistant', fetch: slackFetch(calls) }).follow, undefined);
});

test('the Job Board Home is unchanged and an Assistant Home keeps its existing controls', () => {
  const board = JSON.stringify(homeView({ jobs: [], techs: () => [], updatedAt: new Date() }, { tab: 'today', tech: 'all', user: ADMIN }));
  assert.equal(board.includes('tps_price_search'), false);
  const home = { type: 'home', blocks: [{ type: 'header', text: { type: 'plain_text', text: 'TPS Assistant' } }, { type: 'actions', block_id: 'admin_tools', elements: [{ type: 'button', action_id: 'qb_menu', text: { type: 'plain_text', text: 'Invoices' } }, { type: 'button', action_id: 'tps_phone_open', text: { type: 'plain_text', text: 'Phone settings' } }] }] };
  const next = appendPriceSearchHomeButton(home, true);
  assert.deepEqual(next.blocks[2], home.blocks[1]);
  assert.equal(next.blocks[1].elements[0].action_id, 'tps_price_search_open');
  assert.equal(appendPriceSearchHomeButton(home, false), home);
  for (const view of [searchForm('s'), searchingView('s'), priceSearchHomeEntry()]) assert.equal(JSON.stringify(view).includes('Add to Cart'), false);
});

test('price files do not carry a backend host, and the flag keeps other Assistant actions on their current path', async () => {
  for (const file of ['price-search.js', 'price-search-client.js', 'price-search-view.js', 'price-search-policy.js', 'price-bridge.js', 'price-contract.js']) {
    const source = fs.readFileSync(require.resolve(`../src/${file}`), 'utf8');
    assert.equal(/latenode|webhook\.|xoxb-|7d92c1f1/i.test(source), false);
  }
  const sent = [];
  const routes = {};
  registerAssistantEventsProxy({ router: { post: (path, handler) => { routes[path] = handler; }, get: () => {} } }, { secret: 'fixture-signing', priceSearchEnabled: true, fetch: async url => { sent.push(url); return { ok: true, status: 200, text: async () => '' }; } });
  const payload = { type: 'block_actions', actions: [{ action_id: 'qb:menu' }] };
  const raw = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const ts = String(Math.floor(Date.now() / 1000));
  const headers = { 'x-slack-request-timestamp': ts, 'x-slack-signature': 'v0=' + createHmac('sha256', 'fixture-signing').update(`v0:${ts}:${raw}`).digest('hex') };
  const res = { status(code) { this.code = code; return this; }, send() { return this; }, json() { return this; }, type() { return this; } };
  await routes['/slack/assistant-events']({ rawBody: Buffer.from(raw), headers }, res);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /media-bot-slack-events/);
});
