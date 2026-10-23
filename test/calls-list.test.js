const test = require('node:test');
const assert = require('node:assert');
const { parseListItem, COL } = require('../src/calls-list');

const item = (fields) => ({ id: 'Rec0CB86ZJQAZ', fields });

test('reads tech and the job Completed checkbox from a Calls list row', () => {
  const row = parseListItem(item([
    { key: COL.name, text: '132174' },
    { key: COL.assignee, user: ['U0C2MSLLS1L'] },
    { key: COL.assigned, checkbox: true },
    { key: 'todo_completed', value: false },
    { key: COL.completed, checkbox: true },
    { key: COL.assignedMessage, message: [{ value: 'https://tpsplumbing.slack.com/archives/C0C1M4CRKSB/p1792691395739399' }] },
  ]));
  assert.equal(row.jobNumber, '132174');
  assert.equal(row.assigneeId, 'U0C2MSLLS1L');
  assert.equal(row.completed, true);
  assert.match(row.assignedMessageUrl, /C0C1M4CRKSB/);
});

test('the to-do checkbox and the office default assignee do not count', () => {
  const row = parseListItem(item([
    { key: COL.name, text: '132180' },
    { key: COL.assignee, user: ['U0876C3TEGL'] },
    { key: COL.assigned, checkbox: true },
    { key: 'todo_completed', value: true },
    { key: COL.completed, checkbox: false },
  ]));
  assert.equal(row.assigneeId, null);
  assert.equal(row.completed, false);
});
