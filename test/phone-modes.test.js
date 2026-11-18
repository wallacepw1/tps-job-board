const test = require('node:test'), assert = require('node:assert/strict');
const ical = require('node-ical');
const cal = require('../src/oncall-calendar');
const { applyOfficeMode, wantedMode, currentMode, holidayRules, dayOffRules } = require('../src/office-mode');
const { eventFor, addEvent, removeEvent } = require('../src/oncall-writer');
const { handlePhone, resetPhoneCache } = require('../src/phone-admin');
const { syncOnce } = require('../src/oncall-sync');

test('calendar titles: shifts, holidays and Paul’s days off', () => {
  assert.equal(cal.kindOf('Edgar On Call').kind, 'shift');
  assert.equal(cal.kindOf('Paul T On Call').kind, 'shift');
  assert.equal(cal.kindOf('Holiday: office to on call').kind, 'holiday');
  assert.equal(cal.kindOf('Office closed').kind, 'holiday');
  assert.deepEqual(cal.kindOf('Paul off: Thayned answers'), { kind: 'dayoff', cover: 'Thayned' });
  assert.deepEqual(cal.kindOf('Paul off - Edgar'), { kind: 'dayoff', cover: 'Edgar' });
  assert.deepEqual(cal.kindOf('Paul day off'), { kind: 'dayoff', cover: null });
  assert.equal(cal.kindOf('Dentist').kind, 'other');
});

const ICS = `BEGIN:VCALENDAR\nVERSION:2.0
BEGIN:VEVENT\nUID:edgar\nDTSTART;TZID=America/Los_Angeles:20261104T080000\nDTEND;TZID=America/Los_Angeles:20261105T080000\nRRULE:FREQ=WEEKLY;BYDAY=WE\nSUMMARY:Edgar On Call\nEND:VEVENT
BEGIN:VEVENT\nUID:swap1\nDTSTART;TZID=America/Los_Angeles:20261125T080000\nDTEND;TZID=America/Los_Angeles:20261126T080000\nSUMMARY:Cindy On Call (swap)\nDESCRIPTION:Added from TPS Assistant /phone\nEND:VEVENT
BEGIN:VEVENT\nUID:hol1\nDTSTART;VALUE=DATE:20261126\nDTEND;VALUE=DATE:20261127\nSUMMARY:Holiday: office to on call\nEND:VEVENT
END:VCALENDAR`;
const data = ical.sync.parseICS(ICS);

test('a swap beats the weekly shift; an all-day holiday covers the Pacific day', async () => {
  const wed = await cal.readOnCall({ url: 'x', now: new Date('2026-11-25T20:00:00Z'), load: async () => data });
  assert.deepEqual(wed.people, ['Cindy']);
  assert.equal(wed.special.length, 0);
  const thu = await cal.readOnCall({ url: 'x', now: new Date('2026-11-26T09:00:00Z'), load: async () => data }); // 1 AM Thanksgiving
  assert.equal(thu.special[0].kind, 'holiday');
  assert.equal(thu.special[0].start.toISOString(), '2026-11-26T08:00:00.000Z');
  assert.deepEqual(wantedMode(thu), { kind: 'holiday' });
  const before = await cal.readOnCall({ url: 'x', now: new Date('2026-11-26T07:30:00Z'), load: async () => data }); // 11:30 PM Wed
  assert.deepEqual(wantedMode(before), { kind: 'normal' });
  assert.ok(before.upcomingSpecial.some(s => s.kind === 'holiday'));
});

test('events added from the pop-up count before the iCal feed shows them, and removed ones stop counting', async () => {
  const now = new Date('2026-12-02T20:00:00Z');
  cal.noteAdded({ id: 'new1', title: 'Paul off: Edgar answers', kind: 'dayoff', cover: 'Edgar', start: new Date('2026-12-02T08:00:00Z'), end: new Date('2026-12-03T08:00:00Z'), oneOff: true, tool: true }, now.getTime());
  let out = await cal.readOnCall({ url: 'x', now, load: async () => data });
  assert.deepEqual(wantedMode(out), { kind: 'dayoff', cover: 'Edgar' });
  cal.noteRemoved('new1', now.getTime());
  out = await cal.readOnCall({ url: 'x', now, load: async () => data });
  assert.deepEqual(wantedMode(out), { kind: 'normal' });
});

const PAUL = { id: 900, extension: 517, name: 'Paul T' }, EDGAR = { id: 901, extension: 507, name: 'Edgar' }, THAYNED = { id: 902, extension: 520, name: 'Thayned Office' };
const MAIN = { id: 100, name: 'Main', rules: [
  { filter: { type: 'schedule', schedule: { id: 5, name: 'Business Hours' } }, actions: [{ action: 'forward', items: [{ type: 'extension', extension: PAUL }, { type: 'extension', extension: EDGAR }], timeout: 20 }, { action: 'voicemail', extension: { id: 900 } }] },
  { actions: [{ action: 'menu', menu: { id: 9, name: 'On Call Plumber' } }] },
] };

test('holiday keeps only the after-hours rule; day off swaps Paul for the cover', () => {
  assert.deepEqual(holidayRules(MAIN), [MAIN.rules[1]]);
  assert.equal(holidayRules({ rules: [MAIN.rules[1]] }), null);
  const edgar = dayOffRules(MAIN, PAUL, EDGAR)[0].actions[0].items.map(i => i.extension.id);
  assert.deepEqual(edgar, [901]);
  const thayned = dayOffRules(MAIN, PAUL, THAYNED)[0].actions[0].items.map(i => i.extension.id);
  assert.deepEqual(thayned, [902, 901]);
});

function fakePhone() {
  const routes = [MAIN, { id: 200, name: 'Texting line', rules: [{ actions: [{ action: 'voicemail' }] }] }];
  const numbers = [{ id: 1, name: 'Office', phone_number: '+16195550100', route: { id: 100, name: 'Main' } }, { id: 2, name: 'SMS', phone_number: '+16194763116', route: { id: 200, name: 'Texting line' } }];
  const log = [];
  let next = 300;
  const phone = {
    ready: true,
    list: async r => r === 'phone-numbers' ? numbers : r === 'routes' ? routes : r === 'extensions' ? [PAUL, EDGAR, THAYNED] : [{ id: 9, name: 'On Call Plumber', timeout_handler: { id: 13177454 } }],
    get: async (r, id) => r === 'routes' ? routes.find(x => String(x.id) === String(id)) : r === 'phone-numbers' ? numbers.find(x => x.id === id) : { id: 9, name: 'On Call Plumber', timeout_handler: { id: 13177454 } },
    create: async (r, body) => { log.push(['create', r, body]); const x = { id: next++, ...body }; routes.push(x); return x; },
    patch: async (r, id, body) => {
      log.push(['patch', r, id, body]);
      if (r === 'phone-numbers') { const n = numbers.find(x => x.id === id); const rt = routes.find(x => x.id === body.route.id); n.route = { id: rt.id, name: rt.name }; }
      if (r === 'routes') Object.assign(routes.find(x => x.id === id), body);
      return { id };
    },
  };
  return { phone, log, numbers, routes };
}

test('office mode: holiday on, then back to normal, touching only the office number', async () => {
  const f = fakePhone();
  const dry = await applyOfficeMode({ phone: f.phone, want: { kind: 'holiday' }, dry: true });
  assert.deepEqual(dry.changes.map(c => c.number), ['Office +16195550100']);
  assert.equal(f.log.length, 0);
  await applyOfficeMode({ phone: f.phone, want: { kind: 'holiday' } });
  assert.equal(f.numbers[0].route.name, 'TPS holiday · normal route #100');
  assert.deepEqual(f.log[0][2].rules, [{ actions: [{ action: 'menu', menu: { id: 9 } }] }]);
  assert.equal(f.numbers[1].route.id, 200);
  assert.deepEqual(currentMode(f.numbers), { kind: 'holiday', count: 1 });
  assert.equal((await applyOfficeMode({ phone: f.phone, want: { kind: 'holiday' }, dry: true })).changes.length, 0);
  await applyOfficeMode({ phone: f.phone, want: { kind: 'normal' } });
  assert.equal(f.numbers[0].route.id, 100);
  // The holiday copy is reused next time, not created again.
  await applyOfficeMode({ phone: f.phone, want: { kind: 'holiday' } });
  assert.equal(f.log.filter(l => l[0] === 'create').length, 1);
});

test('office mode: Paul off with Thayned, then switching straight to holiday', async () => {
  const f = fakePhone();
  await applyOfficeMode({ phone: f.phone, want: { kind: 'dayoff', cover: 'Thayned' } });
  assert.equal(f.numbers[0].route.name, 'TPS day off (Thayned) · normal route #100');
  assert.deepEqual(currentMode(f.numbers), { kind: 'dayoff', cover: 'Thayned', count: 1 });
  await applyOfficeMode({ phone: f.phone, want: { kind: 'holiday' } });
  assert.equal(f.numbers[0].route.name, 'TPS holiday · normal route #100');
  const missing = await applyOfficeMode({ phone: { ...f.phone, list: async r => r === 'extensions' ? [PAUL] : f.phone.list(r) }, want: { kind: 'dayoff', cover: 'Edgar' }, dry: true });
  assert.match(missing.notes[0], /Edgar’s extension/);
});

test('sync: holiday on the calendar switches the office in live mode after two looks (or at once when forced)', async () => {
  const f = fakePhone(), posts = [], state = {};
  const oncall = async () => ({ connected: true, current: [{ kind: 'shift', person: 'Edgar', title: 'Edgar On Call' }], people: ['Edgar'], special: [{ kind: 'holiday', title: 'Holiday' }] });
  const a = await syncOnce({ phone: f.phone, oncall, post: async t => posts.push(t), state, syncMode: 'live' });
  assert.equal(a.office.action, 'wait');
  const b = await syncOnce({ phone: f.phone, oncall, post: async t => posts.push(t), state, syncMode: 'live' });
  assert.equal(b.office.action, 'switched');
  assert.match(posts[0], /Holiday mode is on/);
  const g = fakePhone(), reportPosts = [];
  const r = await syncOnce({ phone: g.phone, oncall, post: async t => reportPosts.push(t), state: {}, syncMode: 'report', force: true });
  assert.equal(r.office.action, 'report');
  assert.match(reportPosts[0], /report only.*holiday mode.*Nothing was changed/);
  assert.equal(g.log.length, 0);
});

test('form events: swap runs 8 AM to 8 AM, holiday and day off are all day', () => {
  const swap = eventFor({ kind: 'swap', person: 'Cindy', from: '2026-11-25', to: '2026-11-26' });
  assert.equal(swap.title, 'Cindy On Call (swap)');
  assert.equal(swap.start, '2026-11-25T16:00:00.000Z');
  assert.equal(swap.end, '2026-11-27T16:00:00.000Z');
  const hol = eventFor({ kind: 'holiday', from: '2026-12-25' });
  assert.deepEqual([hol.startDate, hol.endDate, hol.allDay], ['2026-12-25', '2026-12-26', true]);
  assert.equal(eventFor({ kind: 'dayoff', cover: 'Thayned', from: '2026-12-01' }).title, 'Paul off: Thayned answers');
  assert.match(eventFor({ kind: 'dayoff', cover: 'Bob', from: '2026-12-01' }).error, /Edgar or Thayned/);
  assert.match(eventFor({ kind: 'holiday', from: '2026-12-02', to: '2026-12-01' }).error, /before/);
});

test('calendar script calls carry the key and register the new event', async () => {
  const env = { ONCALL_CALENDAR_SCRIPT_URL: 'https://script.google.com/macros/s/x/exec', ONCALL_CALENDAR_SCRIPT_KEY: 'k' }, sent = [];
  const fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return { status: 200, text: async () => JSON.stringify({ ok: true, id: 'abc@google.com' }) }; };
  const ev = eventFor({ kind: 'holiday', from: '2026-12-25' });
  assert.equal(await addEvent(ev, { env, fetch }), 'abc@google.com');
  assert.equal(sent[0].key, 'k');
  assert.equal(sent[0].action, 'create');
  assert.ok(cal._recent.added.has('abc@google.com'));
  await removeEvent('abc@google.com', { env, fetch });
  assert.ok(cal._recent.removed.has('abc@google.com'));
  const bad = async () => ({ status: 200, text: async () => '<html>sign in</html>' });
  await assert.rejects(addEvent(ev, { env, fetch: bad }), /without JSON/);
});

const ADMIN = 'U0876C3TEGL', TEAM = 'T086X85G14N';
test('pop-up buttons push a form; saving without calendar writing says what to add by hand', async () => {
  resetPhoneCache();
  const calls = [];
  const fetch = async (url, init) => { calls.push({ method: url.split('/').pop(), body: JSON.parse(init.body) }); return { json: async () => ({ ok: true, view: { id: 'V2' } }) }; };
  const open = handlePhone({ type: 'block_actions', user: { id: ADMIN }, team: { id: TEAM }, trigger_id: 't1', view: { id: 'V1', type: 'modal' }, actions: [{ action_id: 'tps_phone_dayoff' }] }, { fetch, token: 'x' });
  await open.follow;
  assert.equal(calls[0].method, 'views.push');
  const form = calls[0].body.view;
  assert.equal(form.callback_id, 'tps_phone_form');
  assert.match(JSON.stringify(form.blocks), /Thayned/);
  const values = { who: { v: { selected_option: { value: 'Thayned' } } }, from: { v: { selected_date: '2099-01-02' } }, to: { v: {} } };
  const saved = handlePhone({ type: 'view_submission', user: { id: ADMIN, name: 'paul' }, team: { id: TEAM }, view: { id: 'V2', callback_id: 'tps_phone_form', private_metadata: form.private_metadata, state: { values } } }, { fetch, token: 'x' });
  assert.equal(saved.json.response_action, 'update');
  assert.match(JSON.stringify(saved.json.view), /Paul off: Thayned answers/);
  const past = handlePhone({ type: 'view_submission', user: { id: ADMIN }, team: { id: TEAM }, view: { id: 'V2', callback_id: 'tps_phone_form', private_metadata: form.private_metadata, state: { values: { ...values, from: { v: { selected_date: '2020-01-01' } } } } } }, { fetch, token: 'x' });
  assert.equal(past.json.response_action, 'errors');
  const outsider = handlePhone({ type: 'view_submission', user: { id: 'U0C2TELAYKE' }, team: { id: TEAM }, view: { id: 'V2', callback_id: 'tps_phone_form', private_metadata: form.private_metadata, state: { values } } }, { fetch, token: 'x' });
  assert.equal(outsider.json, undefined);
});

test('a day off with no office number ringing Paul says so instead of doing nothing quietly', async () => {
  const f = fakePhone();
  f.routes[0].rules[0].actions[0].items = [{ type: 'extension', extension: EDGAR }];
  const out = await applyOfficeMode({ phone: f.phone, want: { kind: 'dayoff', cover: 'Thayned' }, dry: true });
  assert.equal(out.changes.length, 0);
  assert.match(out.notes[0], /no office number rings Paul/);
});
