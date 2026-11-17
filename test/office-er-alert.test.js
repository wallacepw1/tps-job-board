'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { sendStaffAlert, staffAlertNumbers } = require('../src/emergency-sms');

test('staff numbers come from the env list, office line and junk dropped', () => {
  assert.deepEqual(staffAlertNumbers('619-555-0101, (619) 555-0102,6194763116,abc,619-555-0101'), ['+16195550101', '+16195550102']);
  assert.deepEqual(staffAlertNumbers(''), []);
});
test('staff alert texts every number once with the sender and message', async () => {
  const now = Date.now(), sent = [];
  const r = await sendStaffAlert({ eventId: 'evt12345', from: '+16193398746', excerpt: 'Emergency!!\n\nWater leak', issuedAt: now },
    async (path, b) => { sent.push([path, b]); }, '/accounts/1/messages', { now, numbers: ['+16195550101', '+16195550102'] });
  assert.equal(r.status, 'accepted');
  assert.equal(sent.length, 2);
  assert.equal(sent[0][1].from, '+16194763116');
  assert.match(sent[0][1].text, /^TPS ALERT: Emergency text from \(619\) 339-8746: "Emergency!! Water leak"/);
});
test('staff alert with no numbers set sends nothing', async () => {
  const r = await sendStaffAlert({ eventId: 'evt12345', from: '+16193398746', excerpt: 'ER', issuedAt: Date.now() },
    async () => { throw Error('no'); }, '/p', { numbers: [] });
  assert.equal(r.status, 'no_numbers');
});
test('staff alert rejects stale requests', async () => {
  const r = await sendStaffAlert({ eventId: 'evt12345', from: '+16193398746', excerpt: 'ER', issuedAt: 1 },
    async () => {}, '/p', { numbers: ['+16195550101'] });
  assert.equal(r.status, 'invalid');
});
