const test = require('node:test');
const assert = require('node:assert');
const { parseIntake, parseReplies, statusOf } = require('../src/parse');

const FAIRGROVE = `132174
259008-1

132174
259008-1
Fairgrove Property Management

AZ Brant - Unit A
2446 Brant St. - Unit A
San Diego, CA 92101

Issue                                         Drain/Pipe Clog
Multiple drains affected                      No

Paul Novacovici     Mobile - <tel:(847)361-7570|(847) 361-7570>

WORK ORDER/MEDIA
 <https://drive.google.com/drive/folders/12950aqdjc0vD41S06JOEv-WYUqgvvgQS>
Rec0CB86ZJQAZ
<https://drive.google.com/drive/folders/12950aqdjc0vD41S06JOEv-WYUqgvvgQS|Work Order Files>
Assign button`;

const DIRECT = `132176
null

132176
null
Dinorah Soriano

null

null

311 F Street
Chula Vista, CA
Suite 101 (Massage)

Leaking water heater.  Please bypass and remove it so they can dry out the area.

null

WORK ORDER/MEDIA
<https://drive.google.com/drive/folders/18fmpE2mOG0o3JPE5hbgGRXbk8fZceZTW|Work Order Files>`;

test('parses a property-manager intake post', () => {
  const j = parseIntake(FAIRGROVE);
  assert.equal(j.jobNumber, '132174');
  assert.equal(j.workOrder, '259008-1');
  assert.equal(j.client, 'Fairgrove Property Management');
  assert.equal(j.address, '2446 Brant St. - Unit A, San Diego, CA 92101');
  assert.equal(j.issue, 'Drain/Pipe Clog');
  assert.match(j.filesUrl, /12950aqdjc0vD41S06JOEv/);
});

test('parses a direct-customer intake post', () => {
  const j = parseIntake(DIRECT);
  assert.equal(j.jobNumber, '132176');
  assert.equal(j.workOrder, null);
  assert.equal(j.client, 'Dinorah Soriano');
  assert.equal(j.address, '311 F Street, Chula Vista, CA');
  assert.match(j.issue, /^Leaking water heater/);
});

test('reads tech, schedule and completion from thread replies', () => {
  const s = parseReplies([
    { text: 'Call assigned to Eduardo on 2026-10-22T17:49:56Z' },
    { text: '*The call is Scheduled for 2026-10-23 at 09:00*' },
  ]);
  assert.equal(s.tech, 'Eduardo');
  assert.deepEqual(s.scheduledFor, { date: '2026-10-23', time: '09:00' });
  assert.equal(statusOf(s), 'scheduled');
  assert.equal(statusOf({ ...s, completed: true }), 'done');
  assert.equal(statusOf({}), 'new');
});

test('reads the Rescheduled reply format', () => {
  const s = parseReplies([
    { ts: '1792711700.000000', text: ':calendar: *Rescheduled: Friday, Oct 23 at 2:00 PM*\nRescheduled from #please-assign-these by <@U0876C3TEGL|Paul> and sent to Future Calls.' },
  ]);
  assert.deepEqual(s.scheduledFor, { date: '2026-10-23', time: '14:00' });
});

test('reads a #future-calls post as the schedule for that job', () => {
  const { addFuture } = require('../src/jobs');
  const found = new Map();
  addFuture(found, {
    ts: '1792718000.000000',
    text: 'TORREY PINES PROPERTY MGMT, INC.\n\nBN-San Remo Court - 16\n540 Naples Street\nUnit 16\nChula Vista, CA 91911\n\nKitchen sink faucet is leaking and needs replacement.\n\nWORK ORDER/MEDIA\n https://drive.google.com/drive/folders/1ipBLB2p84wp2V8ABiLKGFHXJatZxKMWQ\n132118\n385138-1\nRec0CAR7MA8F2\n1792178561.478429\n<https://drive.google.com/drive/folders/1ipBLB2p84wp2V8ABiLKGFHXJatZxKMWQ|Work Order Files>\n*The call is Scheduled for Monday, Oct 26 at 9:00 AM*\nEduardo button\nReschedule button',
  });
  const f = found.get('132118');
  assert.deepEqual(f.scheduledFor, { date: '2026-10-26', time: '09:00' });
  assert.equal(f.threadTs, '1792178561.478429');
  assert.equal(f.intake.client, 'TORREY PINES PROPERTY MGMT, INC.');
});
