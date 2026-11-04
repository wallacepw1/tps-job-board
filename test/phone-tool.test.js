const test = require('node:test'), assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const ical = require('node-ical');
const { createPhoneCom } = require('../src/phonecom');
const { shiftsBetween, readOnCall, personFromTitle } = require('../src/oncall-calendar');
const { loadSnapshot, statusBlocks, describeRoute } = require('../src/phone-status');
const { handlePhone, phoneRequest, resetPhoneCache } = require('../src/phone-admin');
const { registerAssistantEventsProxy } = require('../src/assistant-events-proxy');

const VTZ = `BEGIN:VTIMEZONE\nTZID:America/Vancouver\nBEGIN:DAYLIGHT\nTZOFFSETFROM:-0800\nTZOFFSETTO:-0700\nTZNAME:PDT\nDTSTART:19700308T020000\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\nEND:DAYLIGHT\nBEGIN:STANDARD\nTZOFFSETFROM:-0700\nTZOFFSETTO:-0800\nTZNAME:PST\nDTSTART:19701101T020000\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\nEND:STANDARD\nEND:VTIMEZONE`;
const ICS = `BEGIN:VCALENDAR\nVERSION:2.0\n${VTZ}
BEGIN:VEVENT\nUID:esteban\nDTSTART;TZID=America/Vancouver:20250113T070000\nDTEND;TZID=America/Vancouver:20250114T070000\nRRULE:FREQ=WEEKLY;BYDAY=MO\nEXDATE;TZID=America/Vancouver:20261109T070000\nSUMMARY:Esteban On Call\nEND:VEVENT
BEGIN:VEVENT\nUID:esteban\nRECURRENCE-ID;TZID=America/Vancouver:20261116T070000\nDTSTART;TZID=America/Vancouver:20261116T070000\nDTEND;TZID=America/Vancouver:20261117T070000\nSUMMARY:Cindy On Call\nEND:VEVENT
BEGIN:VEVENT\nUID:edgar\nDTSTART;TZID=America/Vancouver:20250115T070000\nDTEND;TZID=America/Vancouver:20250116T070000\nRRULE:FREQ=WEEKLY;BYDAY=WE\nSUMMARY:Edgar On Call\nEND:VEVENT
END:VCALENDAR`;
const data = ical.sync.parseICS(ICS);

test('weekly shifts keep 7 AM Pacific across daylight saving, with skipped and traded days', () => {
  const shifts = shiftsBetween(data, new Date('2026-10-25T00:00:00Z'), new Date('2026-11-20T00:00:00Z'));
  const mondays = shifts.filter(s => s.id === 'esteban').map(s => `${s.person} ${s.start.toISOString()}`);
  assert.deepEqual(mondays, ['Esteban 2026-10-26T14:00:00.000Z', 'Esteban 2026-11-02T15:00:00.000Z', 'Cindy 2026-11-16T15:00:00.000Z']);
  const edgar = shifts.find(s => s.person === 'Edgar' && s.start.toISOString().startsWith('2026-11-04'));
  assert.equal(edgar.start.toISOString(), '2026-11-04T15:00:00.000Z');
  assert.equal(edgar.end.toISOString(), '2026-11-05T15:00:00.000Z');
});

test('current on-call person from the calendar', async () => {
  const out = await readOnCall({ url: 'x', now: new Date('2026-11-04T18:00:00Z'), load: async () => data });
  assert.deepEqual(out.current.map(s => s.person), ['Edgar']);
  assert.equal((await readOnCall({ url: '' })).connected, false);
  assert.equal(personFromTitle('JR On Call'), 'JR');
  assert.equal(personFromTitle('Paul T on call'), 'Paul T');
});

function fakePhone(handler) {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); const out = handler(new URL(url)); return { ok: out.status ? out.status < 400 : true, status: out.status || 200, headers: { get: () => out.retry || null }, text: async () => JSON.stringify(out.body ?? out) }; };
  return { calls, fetch };
}
const ACCOUNT = { items: [{ id: 999 }], total: 1 };
const API = u => {
  const p = u.pathname.replace('/v4', '');
  if (p === '/accounts') return ACCOUNT;
  if (p === '/accounts/999/phone-numbers') return { total: 1, items: [{ id: 1, name: 'Office', phone_number: '+15035550100', route: { id: 50, name: 'Main' } }] };
  if (p === '/accounts/999/routes') return { total: 1, items: [{ id: 50, name: 'Main' }] };
  if (p === '/accounts/999/routes/50') return { id: 50, name: 'Main', rules: [{ filter: { type: 'schedule', schedule: { id: 7 } }, actions: [{ action: 'forward', timeout: 20, items: [{ type: 'phone_number', number: '+15035550111' }, { type: 'extension', extension: { id: 3, extension: 507 } }] }] }, { actions: [{ action: 'menu', menu: { id: 9 } }] }] };
  if (p === '/accounts/999/menus') return { total: 1, items: [{ id: 9, name: 'On Call Plumber' }] };
  if (p === '/accounts/999/menus/9') return { id: 9, name: 'On Call Plumber', timeout_handler: { id: 13177454, name: 'Edgar' } };
  if (p === '/accounts/999/schedules') return { total: 1, items: [{ id: 7, name: 'Business Hours' }] };
  if (p === '/accounts/999/extensions') return { total: 1, items: [{ id: 3, extension: 507, name: 'Edgar' }] };
  return { status: 404, body: {} };
};

test('client only reads, sends the bearer token, finds the account and waits once on 429', async () => {
  let n = 0;
  const { calls, fetch } = fakePhone(u => (u.pathname.endsWith('/menus') && n++ === 0) ? { status: 429, retry: '1', body: {} } : API(u));
  const waits = [];
  const phone = createPhoneCom({ token: 'tok', fetch, sleep: async ms => waits.push(ms) });
  const menus = await phone.list('menus');
  assert.equal(menus[0].name, 'On Call Plumber');
  assert.deepEqual(waits, [1000]);
  assert.ok(calls.every(c => c.init.method === 'GET' && c.init.headers.Authorization === 'Bearer tok'));
  await assert.rejects(createPhoneCom({ token: '' }).list('menus'), /not connected/);
  await assert.rejects(createPhoneCom({ token: 't', fetch: fakePhone(u => u.pathname === '/v4/accounts' ? ACCOUNT : { status: 401, body: {} }).fetch }).list('routes'), /token was refused/);
});

test('status shows calendar vs Phone.com on-call and office routing', async () => {
  const phone = createPhoneCom({ token: 'tok', fetch: fakePhone(API).fetch });
  const snap = await loadSnapshot({ phone, now: new Date('2026-11-04T18:00:00Z'), oncall: () => readOnCall({ url: 'x', now: new Date('2026-11-04T18:00:00Z'), load: async () => data }) });
  const text = JSON.stringify(statusBlocks(snap));
  assert.match(text, /Calendar says: \*Edgar\*/);
  assert.match(text, /Edgar \(ext 507\)/);
  assert.match(text, /They match/);
  assert.match(text, /\(503\) 555-0100/);
  assert.match(describeRoute(snap.phone.ctx.routes.get('50'), snap.phone.ctx), /During “Business Hours”: ring \(503\) 555-0111 \+ ext 507 Edgar \(rings 20s\)\n• Otherwise: menu “On Call Plumber”/);
  assert.match(text, /Read only/);
  const off = statusBlocks({ ...snap, calendar: { connected: true, current: [{ person: 'Cindy', end: new Date() }], upcoming: [] } });
  assert.match(JSON.stringify(off), /don’t match/);
});

test('missing settings are reported instead of failing', async () => {
  const snap = await loadSnapshot({ phone: createPhoneCom({ token: '' }), oncall: () => readOnCall({ url: '' }) });
  const text = JSON.stringify(statusBlocks(snap));
  assert.match(text, /PHONECOM_API_TOKEN is not set/);
  assert.match(text, /ONCALL_CALENDAR_ICS_URL is not set/);
});

const ADMIN = 'U0876C3TEGL', TEAM = 'T086X85G14N', HOOK = 'https://hooks.slack.com/commands/T/1/x';
test('only /admin phone and tps_phone_ buttons are taken; non-admins are refused', async () => {
  assert.equal(phoneRequest({ command: '/admin', text: 'estimate' }), null);
  assert.equal(phoneRequest({ command: '/tps', text: 'phone' }), null);
  assert.equal(phoneRequest({ type: 'block_actions', actions: [{ action_id: 'qb:menu' }] }), null);
  const refused = handlePhone({ command: '/admin', text: 'phone', user_id: 'U0C2TELAYKE', team_id: TEAM, response_url: HOOK });
  assert.match(refused.json.text, /limited to TPS admins/);
  assert.equal(refused.follow, undefined);
});

test('admin command answers at once, then posts the status to the response URL', async () => {
  resetPhoneCache();
  const posts = [];
  const out = handlePhone({ command: '/admin', text: 'phone', user_id: ADMIN, team_id: TEAM, response_url: HOOK }, { fetch: async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return { ok: true }; }, load: async () => ({ at: new Date(), phone: { ready: false }, calendar: { connected: false }, errors: [] }) });
  assert.match(out.json.text, /Checking Phone.com/);
  await out.follow;
  assert.equal(posts[0].url, HOOK);
  assert.equal(posts[0].body.replace_original, true);
  assert.match(JSON.stringify(posts[0].body.blocks), /tps_phone_refresh/);
});

test('signed /admin phone through the Assistant endpoint never reaches Latenode', async () => {
  resetPhoneCache();
  const routes = {}, secret = 'fixture-signing', sent = [];
  registerAssistantEventsProxy({ router: { post: (p, h) => routes[p] = h, get: () => {} } }, { secret, fetch: async (url, init) => { sent.push(url); return { ok: true, status: 200, text: async () => '' }; }, loadPhone: async () => ({ at: new Date(), phone: { ready: false }, calendar: { connected: false }, errors: [] }) });
  const raw = new URLSearchParams({ command: '/admin', text: 'phone', user_id: ADMIN, team_id: TEAM, response_url: HOOK }).toString(), ts = String(Math.floor(Date.now() / 1000));
  const headers = { 'x-slack-request-timestamp': ts, 'x-slack-signature': 'v0=' + createHmac('sha256', secret).update('v0:' + ts + ':' + raw).digest('hex') };
  let json;
  const res = { status(n) { this.code = n; return this; }, json(b) { json = b; return this; }, send() { return this; }, type() { return this; } };
  await routes['/slack/assistant-events']({ rawBody: Buffer.from(raw), headers }, res);
  assert.equal(res.code, 200);
  assert.match(json.text, /Checking Phone.com/);
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(sent, [HOOK]);
});
