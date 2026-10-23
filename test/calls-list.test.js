const test = require('node:test');
const assert = require('node:assert');
const { parseListItem, COL } = require('../src/calls-list');

const item = (fields) => ({ id: 'Rec0CB86ZJQAZ', fields });

test('reads tech and the job Completed checkbox from a Calls list row', () => {
  const row = parseListItem(item([
    { key: COL.name[0], text: '132174' },
    { key: COL.assignee[0], user: ['U0C2MSLLS1L'] },
    { key: COL.assigned[0], checkbox: true },
    { key: 'todo_completed', value: false },
    { key: COL.completed[0], checkbox: true },
    { key: COL.assignedMessage[0], message: [{ value: 'https://tpsplumbing.slack.com/archives/C0C1M4CRKSB/p1792691395739399' }] },
  ]));
  assert.equal(row.jobNumber, '132174');
  assert.equal(row.assigneeId, 'U0C2MSLLS1L');
  assert.equal(row.completed, true);
  assert.match(row.assignedMessageUrl, /C0C1M4CRKSB/);
});

test('the to-do checkbox and the office default assignee do not count', () => {
  const row = parseListItem(item([
    { key: COL.name[0], text: '132180' },
    { key: COL.assignee[0], user: ['U0876C3TEGL'] },
    { key: COL.assigned[0], checkbox: true },
    { key: 'todo_completed', value: true },
    { key: COL.completed[0], checkbox: false },
  ]));
  assert.equal(row.assigneeId, null);
  assert.equal(row.completed, false);
});

test('matches columns by column id as well as key', () => {
  const row = parseListItem(item([
    { column_id: 'Col00', text: '132174' },
    { column_id: 'Col0C4PMWD5T6', checkbox: true },
  ]));
  assert.equal(row.completed, true);
});

test('an unassigned row (after a reschedule) has no tech message', () => {
  const row = parseListItem(item([
    { key: COL.name[0], text: '132179' },
    { key: COL.assigned[0], checkbox: false },
    { key: COL.assignedMessage[0], message: [{ value: 'https://tpsplumbing.slack.com/archives/C0C1M4CRKSB/p1' }] },
  ]));
  assert.equal(row.assignedMessageUrl, null);
});
