const test = require('node:test');
const assert = require('node:assert');
const { homeView, filterJobs } = require('../src/views');
const { isIntakePlaceholder, zonedDate, dayKey } = require('../src/jobs');

const now = new Date();
const today = dayKey(now);
const jobs = [
  { jobNumber: '132174', client: 'Fairgrove Property Management', location: '2446 Brant St, San Diego, CA 92101', issue: 'Drain/Pipe Clog', status: 'scheduled', tech: 'Eduardo', when: zonedDate(today, '09:00'), timed: true, threadTs: '1792690044.863279' },
  { jobNumber: '132181', client: 'Fairgrove Property Management', issue: 'Drain clog', status: 'new', when: now, timed: false },
  { jobNumber: '132179', client: 'Fairgrove Property Management', issue: 'Toilet running', status: 'new', when: new Date(now - 2 * 864e5), timed: false, threadTs: '1792711637.429499' },
  { jobNumber: '131000', issue: 'Calendar-only, never closed', status: 'new', when: new Date(now - 3 * 864e5), timed: false },
  { jobNumber: '132162', status: 'done', tech: 'Eduardo', when: new Date(now - 864e5), timed: false },
];
const store = { jobs, techs: () => ['Eduardo'], updatedAt: now };

test('tabs split jobs by day and status', () => {
  // Today = only today's jobs: booked times first, then today's calls. Older open calls go to All open.
  assert.deepEqual(filterJobs(jobs, { tab: 'today', tech: 'all' }).map((j) => j.jobNumber), ['132174', '132181']);
  assert.deepEqual(filterJobs(jobs, { tab: 'open', tech: 'unassigned' }).map((j) => j.jobNumber), ['132181']);
  assert.deepEqual(filterJobs(jobs, { tab: 'recent', tech: 'all' }).map((j) => j.jobNumber), ['132162']);
});

test('home view stays within Slack block limits', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ ...jobs[0], jobNumber: String(132000 + i) }));
  const view = homeView({ ...store, jobs: many }, { tab: 'today', tech: 'all' });
  assert.ok(view.blocks.length <= 100, `${view.blocks.length} blocks`);
  assert.match(JSON.stringify(view), /archives\/C0C19TG3KJ6\/p1792690044863279/);
});

test('a job with several calendar events uses its latest real appointment', () => {
  const { preferEvent } = require('../src/jobs');
  const placeholder = { created: '2026-10-15T15:42:54Z', start: { dateTime: '2026-10-15T08:42:54-07:00' } };
  const first = { created: '2026-10-15T16:00:00Z', start: { dateTime: '2026-10-16T10:00:00-07:00' } };
  const revisit = { created: '2026-10-20T16:00:00Z', start: { dateTime: '2026-10-23T10:00:00-07:00' } };
  assert.equal(preferEvent(first, placeholder), true);
  assert.equal(preferEvent(placeholder, first), false);
  assert.equal(preferEvent(revisit, first), true);
  assert.equal(preferEvent(first, revisit), false);
});

test('intake placeholders are told apart from real appointments', () => {
  assert.equal(isIntakePlaceholder({ created: '2026-10-16T15:10:06Z', start: { dateTime: '2026-10-16T08:10:05-07:00' } }), true);
  assert.equal(isIntakePlaceholder({ created: '2026-10-15T20:00:00Z', start: { dateTime: '2026-10-16T10:00:00-07:00' } }), false);
});

test('Slack schedule times are read as San Diego local time', () => {
  assert.equal(zonedDate('2026-10-21', '09:00').toISOString(), '2026-10-21T16:00:00.000Z');
});

test('shows Future calls until a tech is assigned, then Tech chat', () => {
  const { jobBlocks } = require('../src/views');
  const buttons = (job) => (jobBlocks(job,'U0876C3TEGL')[2].elements||[]).map((e) => e.text.text);
  const waiting = { jobNumber: '132180', status: 'scheduled', recordId:'RecTEST123',threadTs:'1793220000.000001', futureTs: '1792712542.021789' };
  assert.ok(buttons(waiting).includes('Assign'));assert.ok(buttons(waiting).includes('Reschedule'));assert.ok(!buttons(waiting).includes('Future calls'));
  const assigned = { ...waiting,techId:'U0C2MSLLS1L',status:'assigned', assignedMessageUrl: 'https://tpsplumbing.slack.com/archives/C0C1M4CRKSB/p1792691395739399' };
  assert.ok(buttons(assigned).includes('Tech chat'));
  assert.ok(!buttons(assigned).includes('Future calls'));
});

test('My jobs shows only the viewer\'s open jobs plus what they finished today', () => {
  const mine = [
    { jobNumber: '1', techId: 'U1', status: 'assigned', when: new Date(now - 2 * 864e5), timed: false },
    { jobNumber: '2', techId: 'U1', status: 'scheduled', when: zonedDate(today, '10:00'), timed: true },
    { jobNumber: '3', techId: 'U1', status: 'done', when: now, completedAt: now, timed: false },
    { jobNumber: '4', techId: 'U1', status: 'done', when: new Date(now - 2 * 864e5), timed: false },
    { jobNumber: '5', techId: 'U2', status: 'assigned', when: now, timed: false },
  ];
  assert.deepEqual(filterJobs(mine, { tab: 'mine', tech: 'all', user: 'U1' }).map((j) => j.jobNumber), ['2', '3']);
});

test('assigned open jobs get an Add photos/notes button', () => {
  const { jobBlocks, noteModal } = require('../src/views');
  const job = { jobNumber: '132180',status:'assigned',techId:'U0C2MSLLS1L',threadTs:'1793220000.000001', assignedMessageUrl: 'https://tpsplumbing.slack.com/archives/C0C1M4CRKSB/p1792691395739399' };
  const add = jobBlocks(job)[2].elements.find((e) => e.action_id === 'addnote_132180');
  assert.equal(add.value, '132180');
  assert.ok(!jobBlocks({ ...job, status: 'done' })[2].elements.some((e) => e.action_id?.startsWith('addnote_')));
  assert.deepEqual(JSON.parse(noteModal(job).private_metadata), { jobNumber: '132180', url: job.assignedMessageUrl });
});

test('a call finished last week does not show as today\'s work on its old calendar day (132099)', () => {
  const lastWeek = new Date(now - 5 * 864e5);
  const list = [
    { jobNumber: '132099', status: 'done', tech: 'Eduardo', techId: 'U1', when: zonedDate(today, '10:00'), timed: true, completedAt: lastWeek },
    { jobNumber: '132100', status: 'done', tech: 'Eduardo', techId: 'U1', when: zonedDate(today, '09:00'), timed: true }, // Completed box only
    { jobNumber: '132101', status: 'done', tech: 'Eduardo', techId: 'U1', when: zonedDate(today, '08:00'), timed: true, completedAt: now },
    { jobNumber: '132102', status: 'scheduled', tech: 'Eduardo', techId: 'U1', when: zonedDate(today, '11:00'), timed: true },
  ];
  assert.deepEqual(filterJobs(list, { tab: 'today', tech: 'all' }).map((j) => j.jobNumber), ['132102', '132101']);
  assert.deepEqual(filterJobs(list, { tab: 'mine', tech: 'all', user: 'U1' }).map((j) => j.jobNumber), ['132102', '132101']);
  const tomorrow = list.map((j) => ({ ...j, when: new Date(j.when.getTime() + 864e5) }));
  assert.deepEqual(filterJobs(tomorrow, { tab: 'tomorrow', tech: 'all' }).map((j) => j.jobNumber), ['132102']);
  assert.ok(filterJobs(list, { tab: 'recent', tech: 'all' }).some((j) => j.jobNumber === '132099'));
  const view = JSON.stringify(homeView({ ...store, jobs: list }, { tab: 'today', tech: 'all' }));
  assert.match(view, /Done today/);
  assert.match(view, /\*Today:\* 1 to do/);
  assert.match(view, /1 done/);
});

test('a newer "no date yet" #future-calls post clears the old date and the TO SCHEDULE calendar time', () => {
  const { addFuture, finalize, isToSchedule } = require('../src/jobs');
  const found = new Map();
  const sentBack = '132099\n259544-2\nFairgrove Property Management\n418 Grand Avenue\n:hourglass_flowing_sand: *NEEDS TO BE SCHEDULED - no date yet*';
  const old = '132099\n259544-2\nFairgrove Property Management\n*The call is Scheduled for 2026-10-26 at 09:00*';
  for (const text of [sentBack, old]) if (!found.has('132099')) addFuture(found, { text, ts: '1' });
  assert.equal(found.get('132099').scheduledFor, null);
  assert.equal(found.get('132099').needsDate, true);
  const ev = { summary: 'TO SCHEDULE - 132099', created: '2026-10-20T16:00:00Z', start: { dateTime: '2026-10-26T10:00:00-07:00' } };
  assert.equal(isToSchedule(ev), true);
  const job = finalize({ jobNumber: '132099', needsDate: true, event: ev, postedAt: new Date('2026-10-14T15:00:00Z') });
  assert.equal(job.timed, false);
  assert.ok(!filterJobs([{ ...job, status: 'new' }], { tab: 'today', tech: 'all' }).length || dayKey(job.when) === today);
  assert.equal(filterJobs([{ ...job, status: 'new' }], { tab: 'open', tech: 'all' }).length, 1);
});
