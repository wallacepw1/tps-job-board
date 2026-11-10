const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBridge, registerPriceBridge } = require('../src/price-bridge');
const { buildRequest } = require('../src/price-search-client');
const { validateRequest, validateResult } = require('../src/price-contract');

const TOKEN = 'bridge-token-test';
const request = buildRequest({ requestId: 'req-bridge-1', queryType: 'description', description: '1 inch Watts RPZ', categoryHint: 'backflow', qty: 1, matchPriority: 'default' });
const emptyResult = { contractVersion: 'tps-price-v1', requestId: 'req-bridge-1', identify: {}, candidates: [], priceRows: [], supplierErrors: [{ supplierId: 'winsupply', code: 'auth_expired', message: 'Sign in required.', retryable: true }], uiHints: {}, approvals: { edgarApprovalRequired: true, installerConfirmRequired: true, autoPurchase: false }, collector: { linked: false, liveRun: false, evidenceKind: 'not_collected', httpEndpoint: null, bridge: 'outbound_mac_worker' } };

function routesFor(bridge, enabled = true) {
  const routes = {};
  registerPriceBridge({ router: { post: (p, h) => { routes[p] = h; }, get: (p, h) => { routes[p] = h; } } }, { bridge, enabled, token: TOKEN });
  return routes;
}
function res() { return { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } }; }

test('bridge auth, claim, idempotent result, and restart do not leave a job running', async () => {
  assert.equal(validateRequest(request).ok, true, JSON.stringify(validateRequest(request).errors));
  assert.equal(request.companyContext.winsupply, 'WinSupply of South San Diego (National City)');
  assert.equal(validateResult(emptyResult).ok, true);
  const file = path.join(os.tmpdir(), `tps-price-${Date.now()}.json`);
  const bridge = createBridge({ file, enabled: true, now: () => 1_000 });
  const queued = bridge.enqueue(request, { reasonsAreNotFacts: true, candidates: [{ model: '009', oemProven: false }] });
  assert.equal(queued.ok, true);
  const routes = routesFor(bridge);
  const denied = res();
  await routes['/internal/tps-pricing/claim']({ rawBody: Buffer.from('{"workerId":"mac","capabilities":["winsupply"]}'), headers: { authorization: 'Bearer wrong-token-value' } }, denied);
  assert.equal(denied.statusCode, 401);
  assert.equal(JSON.stringify(denied).includes(TOKEN), false);
  const claimed = res();
  await routes['/internal/tps-pricing/claim']({ rawBody: Buffer.from('{"workerId":"mac","capabilities":["hirsch","winsupply"]}'), headers: { authorization: `Bearer ${TOKEN}` } }, claimed);
  assert.equal(claimed.body.job.request.requestId, 'req-bridge-1');
  assert.equal(claimed.body.job.request.oemProven, undefined);
  const posted = res();
  const resultBody = { workerId: 'mac', leaseId: claimed.body.job.leaseId, result: emptyResult };
  await routes['/internal/tps-pricing/jobs/:id/result']({ params: { id: claimed.body.job.id }, rawBody: Buffer.from(JSON.stringify(resultBody)), headers: { authorization: `Bearer ${TOKEN}` } }, posted);
  assert.deepEqual(posted.body, { accepted: true });
  const again = res();
  await routes['/internal/tps-pricing/jobs/:id/result']({ params: { id: claimed.body.job.id }, rawBody: Buffer.from(JSON.stringify(resultBody)), headers: { authorization: `Bearer ${TOKEN}` } }, again);
  assert.deepEqual(again.body, { accepted: true });
  const restarted = createBridge({ file, enabled: true, now: () => 1_000 });
  assert.notEqual(restarted.get(claimed.body.job.id).status, 'leased');
  assert.notEqual(restarted.get(claimed.body.job.id).status, 'running');
  fs.rmSync(file, { force: true });
});

test('an expired lease is rejected and the job is queued again', () => {
  let time = 1000;
  const bridge = createBridge({ file: null, enabled: true, now: () => time });
  assert.equal(bridge.enqueue(request).ok, true);
  const claimed = bridge.claim({ workerId: 'mac', capabilities: ['hirsch', 'winsupply'] });
  time = 1000 + 180000;
  const late = bridge.postResult(claimed.job.id, { workerId: 'mac', leaseId: claimed.job.leaseId, result: emptyResult });
  assert.equal(late.status, 409);
  assert.equal(late.body.error, 'wrong_lease');
  assert.equal(bridge.get(claimed.job.id).status, 'queued');
  assert.notEqual(bridge.get(claimed.job.id).status, 'running');
});

test('disabled bridge is not advertised and a Mac endpoint is refused', async () => {
  const routes = routesFor(createBridge({ file: null, enabled: false }), false);
  const hidden = res();
  await routes['/internal/tps-pricing/claim']({ rawBody: Buffer.from('{}'), headers: {} }, hidden);
  assert.equal(hidden.statusCode, 404);
  const bad = { ...emptyResult, collector: { ...emptyResult.collector, httpEndpoint: 'https://127.0.0.1/prices' } };
  assert.equal(validateResult(bad).endpointRejected, true);
  const unsupported = { ...emptyResult, priceRows: [{ supplierId: 'supplyhouse', price: '12.00', priceKind: 'unsupported', guaranteedStock: false }] };
  assert.equal(validateResult(unsupported).ok, true);
  const ordered = { ...emptyResult, approvals: { ...emptyResult.approvals, autoPurchase: true } };
  assert.equal(validateResult(ordered).ok, false);
});
