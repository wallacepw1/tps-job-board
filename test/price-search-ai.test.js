const test = require('node:test');
const assert = require('node:assert/strict');
const { createPriceClient, normalizeIdentify } = require('../src/price-search-client');
const { createBridge } = require('../src/price-bridge');
const { presentResult, handlePriceSearch, resetPriceSearchSessions } = require('../src/price-search');
const { resultsView } = require('../src/price-search-view');

const ADMIN = 'U0876C3TEGL';
const TEAM = 'T086X85G14N';

function slackFetch(store) {
  return async (url, init) => {
    store.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ ok: true, view: { id: 'VPRICE' } }), text: async () => '{"ok":true}' };
  };
}

const NEEDS_ANSWER = {
  contractVersion: 'tps-price-v1',
  status: 'needs_answer',
  questions: [{ id: 'size', text: 'What size is it?', options: ['1/2 in', '3/4 in', '2 in'], allowOther: true }],
  identify: { brand: 'Zurn Wilkins', model: '720A', title: 'Zurn Wilkins 720A pressure vacuum breaker', discontinued: false },
  recommendations: [{ kind: 'exact', brand: 'Zurn Wilkins', model: '720A', title: 'Zurn Wilkins 720A PVB', why: 'Same item.', differences: [], searchTerms: ['Zurn 720A'] }],
  summary: 'Looks like a Zurn 720A. Size is not visible.',
  enrichment: { category: 'backflow_preventer', identity: { model: '720A' }, targetSpecs: {}, candidates: [{ model: '720A' }] },
};

const COMPLETE = {
  ...NEEDS_ANSWER,
  status: 'completed_enrichment',
  questions: [],
  identify: { ...NEEDS_ANSWER.identify, size: '2 in' },
  recommendations: [
    { kind: 'exact', brand: 'Zurn Wilkins', model: '2-720A', title: 'Zurn Wilkins 2-720A 2 in PVB', why: 'Same item, 2 in.', differences: [], searchTerms: ['Zurn 2-720A'] },
    { kind: 'alternative', brand: 'Watts', model: '800M4QT', title: 'Watts 2 in 800M4QT PVB', why: 'Common alternative.', differences: ['Different bonnet'], searchTerms: ['Watts 800M4QT 2'] },
  ],
};

test('identify sends the key and answers, waits for a web search, and passes back questions', async () => {
  const sent = [];
  const fetch = async (url, init) => { sent.push({ url, init, body: JSON.parse(init.body) }); return { ok: true, status: 200, text: async () => JSON.stringify(NEEDS_ANSWER) }; };
  const client = createPriceClient({ env: { PRICE_SEARCH_ENABLED: '1', PRICE_SEARCH_IDENTIFY_URL: 'https://identify.example.test/v1', TPS_INTERNAL_KEY: 'internal-key-1' }, fetch });
  const out = await client.identify({ requestId: 'r', queryType: 'photo' }, { fileContent: 'AAAA' }, [{ id: 'size', question: 'What size is it?', answer: '2 in' }]);
  assert.equal(out.status, 'needs_answer');
  assert.equal(out.questions[0].options.length, 3);
  assert.equal(out.recommendations[0].model, '720A');
  assert.equal(sent[0].body.key, 'internal-key-1');
  assert.equal(sent[0].init.headers.Authorization, 'Bearer internal-key-1');
  assert.equal(sent[0].body.answers[0].answer, '2 in');
  assert.equal(sent[0].body.fileContent, 'AAAA');
  assert.equal(normalizeIdentify(COMPLETE).status, 'complete');
});

test('a photo search asks the follow-up question, then queues the identified item and its alternatives', async () => {
  resetPriceSearchSessions();
  const calls = [];
  const identifyCalls = [];
  const bridge = createBridge({ file: null, enabled: true, now: () => Date.now() });
  const client = {
    config: { identifyConfigured: true, bridgeConfigured: true },
    async identify(request, photo, answers) {
      identifyCalls.push({ request, photo, answers });
      return normalizeIdentify(answers && answers.length ? COMPLETE : NEEDS_ANSWER);
    },
  };
  let release = null;
  const schedule = fn => { release = fn; return () => { release = null; }; };
  const photoLoader = async () => ({ ok: true, photoRef: 'F123', fileName: 'pvb.jpg', fileContent: 'AAAA' });
  const options = { enabled: true, token: 'xoxb-assistant', fetch: slackFetch(calls), schedule, bridge, bridgeConfigured: true, client, photoLoader };
  const opened = handlePriceSearch({ type: 'block_actions', team: { id: TEAM }, user: { id: ADMIN }, trigger_id: 'trig', actions: [{ action_id: 'tps_price_search_open' }] }, options);
  await opened.follow;
  const session = JSON.parse(calls[0].body.view.private_metadata).s;
  const submitted = handlePriceSearch({ type: 'view_submission', team: { id: TEAM }, user: { id: ADMIN }, view: { id: 'VPRICE', callback_id: 'tps_price_search_form', private_metadata: JSON.stringify({ s: session }), state: { values: { ps_photo: { file: { files: [{ id: 'F123', name: 'pvb.jpg' }] } }, ps_category: { category: { selected_option: { value: 'general' } } }, ps_qty: { qty: { value: '1' } } } } } }, options);
  await submitted.follow;
  const asked = calls.at(-1).body.view;
  assert.equal(asked.callback_id, 'tps_price_search_answer');
  assert.match(JSON.stringify(asked), /What size is it\?/);
  assert.equal(bridge.claim({ workerId: 'pc', capabilities: ['hirsch'] }).job, null);

  const answered = handlePriceSearch({ type: 'view_submission', team: { id: TEAM }, user: { id: ADMIN }, view: { id: 'VPRICE', callback_id: 'tps_price_search_answer', private_metadata: JSON.stringify({ s: session }), state: { values: { ps_q0: { answer: { selected_option: { value: '2' } } }, ps_qo0: { other: { value: '' } } } } } }, options);
  assert.equal(answered.json.response_action, 'update');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(identifyCalls.length, 2);
  assert.equal(identifyCalls[1].answers[0].answer, '2 in');
  assert.equal(identifyCalls[1].photo.fileContent, 'AAAA');
  const claimed = bridge.claim({ workerId: 'pc', capabilities: ['hirsch', 'reece_us', 'homedepot', 'lowes', 'supplyhouse', 'masterbuildermercantile', 'winsupply'] }).job;
  assert.ok(claimed);
  assert.match(claimed.request.description, /2-720A|720A/);
  assert.deepEqual(claimed.request.candidateHints.map(hint => hint.model).slice(0, 2), ['Zurn 2-720A', 'Watts 800M4QT 2']);
  assert.ok(claimed.request.suppliers.includes('supplyhouse'));
  if (release) release();
});

test('results show recommendations, leave out suppliers without the item, and name unchecked ones once', () => {
  const input = { description: '2" pressure regulator', categoryHint: 'general', matchPriority: 'default', qty: 1, recommendations: COMPLETE.recommendations, identified: { title: 'Zurn Wilkins 720A PVB', discontinued: false }, aiSummary: 'Pick 2 in.' };
  const result = {
    contractVersion: 'tps-price-v1', requestId: 'r', identify: {}, candidates: [], priceRows: [], uiHints: {}, approvals: {}, collector: { linked: true, liveRun: true, evidenceKind: 'live_dom', httpEndpoint: null },
    supplierErrors: [
      { supplierId: 'hirsch', code: 'not_executed', message: 'Signed in. The supplier\'s search showed no results for "x". That is a search miss, not proof the item is unavailable.' },
      { supplierId: 'homedepot', code: 'not_executed', message: 'Navigation is off.' },
      { supplierId: 'lowes', code: 'not_executed', message: 'Navigation is off.' },
      { supplierId: 'reece_us', code: 'auth_expired', message: 'Not signed in.' },
    ],
  };
  const presented = presentResult(input, result);
  const text = JSON.stringify(resultsView('s', presented));
  assert.match(text, /Recommendations/);
  assert.match(text, /Watts 2 in 800M4QT PVB/);
  assert.doesNotMatch(text, /search miss/);
  assert.match(text, /Not checked yet: Home Depot, Lowe/);
  assert.match(text, /Reece[^"]*account login required/);
});

test('web prices keep only https links on the store site and name stores not found', () => {
  const { normalizeWebPrices } = require('../src/price-search-client');
  const out = normalizeWebPrices({ role: 'web_prices', ok: true, prices: [
    { supplier: 'supplyhouse', item: 1, product: 'Watts 2 in PRV', price: 1403.08, url: 'https://www.supplyhouse.com/Watts-0009465' },
    { supplier: 'homedepot', item: 1, price: 99, url: 'https://evil.example.com/homedepot.com' },
    { supplier: 'lowes', item: 1, price: 0, url: 'https://www.lowes.com/pd/1' },
    { supplier: 'voomisupply', item: 1, price: '1930.82', url: 'http://voomisupply.com/x' },
  ] }, ['supplyhouse', 'homedepot', 'lowes', 'voomisupply']);
  assert.equal(out.prices.length, 1);
  assert.equal(out.prices[0].store, 'SupplyHouse');
  assert.deepEqual(out.notFound, ['homedepot', 'lowes', 'voomisupply']);
  assert.equal(normalizeWebPrices({ ok: false }).ok, false);
});

test('a search shows web prices even when the PC price search is not connected', async () => {
  resetPriceSearchSessions();
  const calls = [];
  const webCalls = [];
  const client = {
    config: { identifyConfigured: true, bridgeConfigured: false },
    async identify() { return normalizeIdentify(COMPLETE); },
    async webPrices(requestId, items, suppliers) {
      webCalls.push({ requestId, items, suppliers });
      return { ok: true, prices: [{ supplier: 'supplyhouse', store: 'SupplyHouse', item: 1, product: 'Zurn 2-720A', price: 512.4, unit: 'ea', url: 'https://www.supplyhouse.com/Zurn-2-720A', stockNote: 'In Stock' }], notFound: ['homedepot', 'lowes'], note: null };
    },
  };
  const options = { enabled: true, token: 'xoxb-assistant', fetch: slackFetch(calls), schedule: () => () => {}, bridge: null, bridgeConfigured: false, client };
  const opened = handlePriceSearch({ type: 'block_actions', team: { id: TEAM }, user: { id: ADMIN }, trigger_id: 'trig', actions: [{ action_id: 'tps_price_search_open' }] }, options);
  await opened.follow;
  const session = JSON.parse(calls[0].body.view.private_metadata).s;
  const submitted = handlePriceSearch({ type: 'view_submission', team: { id: TEAM }, user: { id: ADMIN }, view: { id: 'VPRICE', callback_id: 'tps_price_search_form', private_metadata: JSON.stringify({ s: session }), state: { values: { ps_desc: { desc: { value: 'Zurn 720A 2 inch' } }, ps_category: { category: { selected_option: { value: 'general' } } }, ps_qty: { qty: { value: '1' } } } } } }, options);
  await submitted.follow;
  assert.equal(webCalls.length, 1);
  assert.equal(webCalls[0].items[0].model, '2-720A');
  assert.ok(webCalls[0].suppliers.includes('masterbuildermercantile'));
  const text = JSON.stringify(calls.at(-1).body.view);
  assert.match(text, /Web prices/);
  assert.match(text, /SupplyHouse\*: \$512\.40 ea/);
  assert.match(text, /Not found online: Home Depot, Lowe/);
  assert.match(text, /not your account price/);
  assert.match(text, /Account prices \(Reece, Winsupply\) are not connected yet/);
});
