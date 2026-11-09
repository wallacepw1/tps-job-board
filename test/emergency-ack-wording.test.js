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
