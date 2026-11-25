const test = require('node:test');
const assert = require('node:assert');
const { parseRow, summarize, resultView, formView, parsePrice, addressOf, chunkLines, isAdmin } = require('../src/plumber-totals');

const rt = (t) => [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: t }] }] }];
const item = (n, { tech = 'U0C2MSLLS1L', due = '2026-11-10', price, completed = true, created = 1794000000 } = {}) => ({
  id: 'Rec' + n, date_created: created,
  fields: [
    { key: 'name', column_id: 'Col0C38GZ8N4T', text: String(n) },
    { key: 'todo_assignee', column_id: 'Col01', user: [tech] },
    ...(due ? [{ key: 'todo_due_date', column_id: 'Col02', date: [due] }] : []),
    { key: 'Col0C4DQV3BUK', text: `${n}\n388419-1\nTORREY PINES\n\n4457 Temecula Street\nUnit 105` },
    { key: 'Col0C5ECQNS56', column_id: 'Col0C4PMWD5T6', checkbox: completed },
    ...(price != null ? [{ key: 'Col0C5L470C5R', column_id: 'Col0C5QC3UGJ2', rich_text: rt(price) }] : []),
  ],
});

test('reads plumber, visit date, price and street from a Calls list row', () => {
  const r = parseRow(item(132404, { price: '389' }));
  assert.equal(r.jobNumber, '132404');
  assert.equal(r.techId, 'U0C2MSLLS1L');
  assert.equal(r.date, '2026-11-10');
  assert.equal(r.price, 389);
  assert.equal(r.address, '4457 Temecula Street');
});

test('falls back to the day the row was made when there is no Due Date', () => {
  const r = parseRow(item(132405, { due: null, created: Date.UTC(2026, 10, 18, 20) / 1000 }));
  assert.equal(r.date, '2026-11-18');
});

test('the office default assignee is not a plumber', () => {
  assert.equal(parseRow(item(132406, { tech: 'U0876C3TEGL' })).techId, null);
});

test('prices: dollars and commas count, words do not', () => {
  assert.equal(parsePrice('$1,250'), 1250);
  assert.equal(parsePrice('10990'), 10990);
  assert.equal(parsePrice('249.50'), 249.5);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice('cancel'), null);
});

test('street skips the call and work order numbers', () => {
  assert.equal(addressOf('132472\nDinorah Soriano\n\n416 1/2 4th Ave\nChula Vista, CA', '132472'), '416 1/2 4th Ave');
});

test('adds up one plumber between two dates, both ends included, and lists unpriced work', () => {
  const rows = [
    item(132001, { due: '2026-11-01', price: '100' }),
    item(132002, { due: '2026-11-15', price: '$1,000' }),
    item(132003, { due: '2026-11-16', price: '50' }),
    item(132004, { due: '2026-11-10' }),
    item(132005, { due: '2026-11-10', completed: false }),
    item(132006, { due: '2026-11-10', price: '999', tech: 'U0C2TELAYKE' }),
    item(132007, { due: '2026-10-31', price: '999' }),
  ].map(parseRow);
  const s = summarize(rows, { tech: 'U0C2MSLLS1L', from: '2026-11-01', to: '2026-11-15' });
  assert.equal(s.total, 1100);
  assert.deepEqual(s.priced.map((r) => r.jobNumber), ['132001', '132002']);
  assert.deepEqual(s.unpriced.map((r) => r.jobNumber), ['132004']);
  const all = summarize(rows, { tech: 'all', from: '2026-11-01', to: '2026-11-30' });
  assert.equal(all.total, 2149);
  assert.deepEqual(all.byTech.map((t) => [t.techId, t.total, t.calls]), [['U0C2MSLLS1L', 1150, 3], ['U0C2TELAYKE', 999, 1]]);
});

test('result view shows the total, per-plumber split and stays inside Slack limits', () => {
  const rows = Array.from({ length: 400 }, (_, i) => parseRow(item(130000 + i, { due: '2026-11-1' + (i % 10), price: '295', tech: i % 2 ? 'U0C2MSLLS1L' : 'U0C2JV565K7' })));
  const params = { tech: 'all', from: '2026-11-01', to: '2026-11-30' };
  const v = resultView(summarize(rows, params), params);
  assert.match(v.blocks[0].text.text, /\$118,000/);
  assert.match(v.blocks[1].text.text, /Eduardo/);
  assert.ok(v.blocks.length <= 100);
  for (const b of v.blocks) if (b.text) assert.ok(b.text.text.length < 3000);
});

test('long lists split into sections under 3000 characters', () => {
  const parts = chunkLines(Array.from({ length: 200 }, () => 'x'.repeat(50)));
  assert.ok(parts.length > 1 && parts.every((p) => p.length <= 2800));
});

test('only Paul, Edgar and Thayned get the report', () => {
  assert.equal(isAdmin('U0876C3TEGL'), true);
  assert.equal(isAdmin('U0C2PMHJK0A'), true);
  assert.equal(isAdmin('U0C2X3HU490'), true);
  assert.equal(isAdmin('U0C2MSLLS1L'), false);
});

test('form defaults to this month so far', () => {
  const v = formView();
  assert.match(v.blocks[1].element.initial_date, /^\d{4}-\d{2}-01$/);
});
