'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { sendEmergencyAcknowledgment } = require('../src/emergency-sms');

async function sent(route) {
  const now = Date.now(), text = 'ER pipe burst';
  const phone = { accountId: async () => '1', request: async () => ({ items: [{ id: 'evt12345', from: '+16195550100', to: ['+16194763116'], text, created_at: now }] }) };
  let body;
  const r = await sendEmergencyAcknowledgment({ eventId: 'evt12345', recipient: '+16195550100', route, issuedAt: now }, phone, async (_p, b) => { body = b; }, now);
  assert.equal(r.status, 'accepted');
  return body.text;
}
test('business-hours ER ack says office', async () => {
  const t = await sent('office_emergency');
  assert.match(t, /sent to the office\./);
  assert.match(t, /Reply STOP to opt out or HELP for help\.$/);
});
test('after-hours ER ack says on-call plumber', async () => {
  const t = await sent('emergency');
  assert.match(t, /sent to our on-call plumber\./);
  assert.doesNotMatch(t, /the office/);
});
test('ack waits for Phone.com to list a just-arrived text', async () => {
  const now = Date.now(), text = 'Emergency!!\n\nWater leak';
  let calls = 0, body;
  const phone = { accountId: async () => '1', request: async () => (++calls < 2 ? { items: [] } :
    { items: [{ id: 'evt99999', from: '+16195550100', to: ['+16194763116'], text, created_at: now }] }) };
  const waits = [];
  const r = await sendEmergencyAcknowledgment({ eventId: 'evt99999', recipient: '+16195550100', route: 'office_emergency', issuedAt: now },
    phone, async (_p, b) => { body = b; }, now, { sleep: async ms => { waits.push(ms); } });
  assert.equal(r.status, 'accepted');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [3000]);
  assert.match(body.text, /sent to the office\./);
});
test('ack still refuses a text Phone.com never lists', async () => {
  const now = Date.now();
  const phone = { accountId: async () => '1', request: async () => ({ items: [] }) };
  const r = await sendEmergencyAcknowledgment({ eventId: 'evt12345', recipient: '+16195550100', route: 'office_emergency', issuedAt: now },
    phone, async () => { throw Error('should not send'); }, now, { sleep: async () => {} });
  assert.equal(r.status, 'inbound_unverified');
});
test('unlisted ER text is trusted on the signed request when recent', async () => {
  const now = Date.now(); let body;
  const phone = { accountId: async () => '1', request: async () => ({ items: [] }) };
  const r = await sendEmergencyAcknowledgment({ eventId: 'evtTRUST1', recipient: '+16195550100', route: 'office_emergency', issuedAt: now,
    inboundHash: 'a'.repeat(64), inboundAt: now - 5000 }, phone, async (_p, b) => { body = b; }, now, { sleep: async () => {} });
  assert.equal(r.status, 'accepted');
  assert.equal(r.verifiedBy, 'signature');
  assert.match(body.text, /sent to the office\./);
  const again = await sendEmergencyAcknowledgment({ eventId: 'evtTRUST1', recipient: '+16195550100', route: 'office_emergency', issuedAt: now,
    inboundAt: now - 5000 }, phone, async () => { throw Error('dup'); }, now, { sleep: async () => {} });
  assert.equal(again.status, 'duplicate');
});
test('unlisted ER text older than the window is refused', async () => {
  const now = Date.now();
  const phone = { accountId: async () => '1', request: async () => ({ items: [] }) };
  const r = await sendEmergencyAcknowledgment({ eventId: 'evtOLD0001', recipient: '+16195550100', route: 'office_emergency', issuedAt: now,
    inboundAt: now - 20*60000 }, phone, async () => { throw Error('no'); }, now, { sleep: async () => {} });
  assert.equal(r.status, 'inbound_unverified');
});
