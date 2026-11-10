const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/mixed-source-tps-price-v1.json');
const { adaptCollectorResult, validateResult } = require('../src/price-contract');
const { presentResult } = require('../src/price-search');
const { resultsView, priceLines, stockLines } = require('../src/price-search-view');

const wrapped = { ...fixture, identify: {}, uiHints: {}, supplierErrors: [] };

test('mixed collector result validates and only the live row shows a signed-in price', () => {
  const adapted = adaptCollectorResult(wrapped);
  const checked = validateResult(adapted.schema);
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));
  assert.equal(adapted.schema.collector.evidenceKind, 'mixed');
  const hidden = adapted.normalized.priceRows.find(row => row.live_observation === false);
  const shown = adapted.normalized.priceRows.find(row => row.live_observation === true);
  const view = JSON.stringify(resultsView('mixed', presentResult({ description: '1 inch reduced pressure zone', categoryHint: 'backflow' }, wrapped)));
  assert.equal(view.includes(hidden.rawPriceText), false);
  assert.equal(view.includes(hidden.image.url), false);
  assert.equal(view.includes(shown.rawPriceText), true);
  assert.match(view, /Signed-in price; net status unverified/);
  assert.doesNotMatch(view, /Account net|verified_account_net|login_required/);
});

test('signed-in null price is call for pricing, and guest prices stay hidden', () => {
  const collector = { linked: true, liveRun: true, evidenceKind: 'mixed', httpEndpoint: null, bridge: 'outbound_mac_worker' };
  const row = { supplierId: 'winsupply', price: null, priceKind: 'authenticated_unknown', rawPriceText: 'Call for pricing', evidenceKind: 'live_dom', live_observation: true, auth: { signedInMarker: 'observed', netLabelVerified: false, priceKind: 'authenticated_unknown', displayLabel: 'signed_in_net_unverified' }, guaranteedStock: false, availability: { local: null, network: '542', raw: 'Call to confirm', needsConfirmation: true, guaranteedStock: false }, otherBranches: [{ name: 'Escondido', scope: 'other_branch', quantity: '2', needsConfirmation: true, guaranteedStock: false, etaProvenance: 'not_displayed' }, { name: 'Temecula', scope: 'other_branch', quantity: '41', needsConfirmation: true, guaranteedStock: false, etaProvenance: 'not_displayed' }] };
  const text = [...priceLines(row, collector), ...stockLines(row, collector)].join('\n');
  assert.match(text, /Call for pricing/);
  assert.doesNotMatch(text, /login_required|Account net/);
  assert.match(text, /542/);
  assert.match(text, /unconfirmed/);
  assert.match(text, /Escondido: 2/);
  assert.match(text, /Temecula: 41/);
  assert.doesNotMatch(text, /ETA|guaranteed delivery/);
  const guest = priceLines({ supplierId: 'supplyhouse', price: '41.00', priceKind: 'list', evidenceKind: 'live_dom', live_observation: true, guaranteedStock: false }, collector).join(' ');
  assert.doesNotMatch(guest, /41\.00/);
  assert.match(guest, /login_required/);
});
