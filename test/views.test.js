const test = require('node:test');
const assert = require('node:assert');
const { homeView, filterJobs } = require('../src/views');
const { isIntakePlaceholder, zonedDate, dayKey } = require('../src/jobs');

const now = new Date();
const today = dayKey(now);
const jobs = [
  { jobNumber: '132174', client: 'Fairgrove Property Management', location: '2446 Brant St, San Diego, CA 92101', issue: 'Drain/Pipe Clog', status: 'scheduled', tech: 'Eduardo', when: zonedDate(today, '09:00'), threadTs: '1792690044.863279' },
  { jobNumber: '132179', client: 'Fairgrove Property Management', issue: 'Toilet running', status: 'new', when: null, postedAt: now },
  { jobNumber: '132162', status: 'done', tech: 'Eduardo', when: new Date(now - 864e5) },
];
const store = { jobs, techs: () => ['Eduardo'], updatedAt: now };

test('tabs split jobs by day and status', () => {
  assert.deepEqual(filterJobs(jobs, { tab: 'today', tech: 'all' }).map((j) => j.jobNumber), ['132174']);
  assert.deepEqual(filterJobs(jobs, { tab: 'unscheduled', tech: 'all' }).map((j) => j.jobNumber), ['132179']);
  assert.deepEqual(filterJobs(jobs, { tab: 'recent', tech: 'all' }).map((j) => j.jobNumber), ['132162']);
  assert.deepEqual(filterJobs(jobs, { tab: 'unscheduled', tech: 'unassigned' }).map((j) => j.jobNumber), ['132179']);
});

test('home view stays within Slack block limits', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ ...jobs[0], jobNumber: String(132000 + i) }));
  const view = homeView({ ...store, jobs: many }, { tab: 'today', tech: 'all' });
  assert.ok(view.blocks.length <= 100, `${view.blocks.length} blocks`);
  assert.match(JSON.stringify(view), /archives\/C0C19TG3KJ6\/p1792690044863279/);
});

test('intake placeholders are told apart from real appointments', () => {
  assert.equal(isIntakePlaceholder({ created: '2026-10-16T15:10:06Z', start: { dateTime: '2026-10-16T08:10:05-07:00' } }), true);
  assert.equal(isIntakePlaceholder({ created: '2026-10-15T20:00:00Z', start: { dateTime: '2026-10-16T10:00:00-07:00' } }), false);
});

test('Slack schedule times are read as San Diego local time', () => {
  assert.equal(zonedDate('2026-10-21', '09:00').toISOString(), '2026-10-21T16:00:00.000Z');
});
