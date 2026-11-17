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
  const phone = { accountId: async () => '1', request: async () => (++calls < 3 ? { items: [] } :
    { items: [{ id: 'evt12345', from: '+16195550100', to: ['+16194763116'], text, created_at: now }] }) };
  const waits = [];
  const r = await sendEmergencyAcknowledgment({ eventId: 'evt12345', recipient: '+16195550100', route: 'office_emergency', issuedAt: now },
    phone, async (_p, b) => { body = b; }, now, { sleep: async ms => { waits.push(ms); } });
  assert.equal(r.status, 'accepted');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [3000, 4000]);
  assert.match(body.text, /sent to the office\./);
});
test('ack still refuses a text Phone.com never lists', async () => {
  const now = Date.now();
  const phone = { accountId: async () => '1', request: async () => ({ items: [] }) };
  const r = await sendEmergencyAcknowledgment({ eventId: 'evt12345', recipient: '+16195550100', route: 'office_emergency', issuedAt: now },
    phone, async () => { throw Error('should not send'); }, now, { sleep: async () => {} });
  assert.equal(r.status, 'inbound_unverified');
});
