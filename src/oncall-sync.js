'use strict';
// Keeps Phone.com's "On Call Plumber" menu in step with the Google "On call" calendar.
// Mode (PHONECOM_SYNC_MODE): "off", "report" (default: posts what it would change, changes nothing),
// or "live" (switches the menu). Live replaces the Latenode Calendar-Oncall Routing scenario,
// so turn that scenario off at the same time; never run both.
const { createPhoneCom } = require('./phonecom');
const { readOnCall, onCallPeople } = require('./oncall-calendar');
const { applyOfficeMode, wantedMode, wantLabel } = require('./office-mode');
const { ONCALL_ROUTES } = require('./phone-status');
const { slackApi } = require('./job-files');

const MENU = process.env.PHONECOM_ONCALL_MENU || 'On Call Plumber';
const CHANNEL = process.env.ONCALL_REPORT_CHANNEL || 'C086PAU2BM5'; // where the old scenario posts its changes
const EVERY_MS = 5 * 60 * 1000;

function mode() { const m = String(process.env.PHONECOM_SYNC_MODE || 'report').toLowerCase(); return ['off', 'report', 'live'].includes(m) ? m : 'report'; }

// One check. state carries what was seen last time, so a mismatch must be seen twice in a row
// (the old scenario switches right at 8:00; this avoids reporting a race) and each problem is posted once.
// force (after an admin change in the pop-up) skips the second look.
async function syncOnce({ phone = createPhoneCom(), oncall = readOnCall, post, now = new Date(), state = {}, syncMode = mode(), force = false } = {}) {
  if (syncMode === 'off') return { action: 'off' };
  if (!phone.ready) return { action: 'skip', reason: 'Phone.com not connected' };
  const cal = await oncall({ now });
  if (!cal.connected) return { action: 'skip', reason: 'calendar not connected' };
  let office;
  try { office = await syncOffice({ phone, cal, post, state, syncMode, force }); }
  catch (e) { office = { action: 'error', error: e.message }; await note(state, post, `office-error:${e.message}`, `⚠️ Office phone mode check failed: ${e.message}`, 'officeReported'); }
  return { ...(await syncMenu({ phone, cal, post, now, state, syncMode, force })), office };
}

async function syncMenu({ phone, cal, post, now, state, syncMode, force }) {
  const people = cal.people || onCallPeople((cal.current || []).map(s => ({ kind: 'shift', ...s })));
  const menus = await phone.list('menus');
  let menu = menus.find(m => String(m.name || '').trim().toLowerCase() === MENU.toLowerCase());
  if (!menu) return note(state, post, `no-menu`, `⚠️ On-call sync: couldn’t find the “${MENU}” menu in Phone.com.`);
  if (!menu.timeout_handler) menu = await phone.get('menus', menu.id);
  const haveId = Number(menu.timeout_handler?.id);
  const have = ONCALL_ROUTES.find(r => r.routeId === haveId);

  if (people.length !== 1) {
    const why = people.length ? `the calendar has ${people.join(' and ')} on call at the same time` : (cal.current.length ? `the calendar title “${cal.current[0].title}” doesn’t name a TPS plumber` : 'nobody is on the calendar right now');
    return note(state, post, `unclear:${people.join(',')}:${cal.current.map(s => s.title).join(',')}`, `⚠️ On-call sync: ${why}. Phone.com was left on ${have ? have.person : `route ${haveId}`}.`);
  }
  const want = ONCALL_ROUTES.find(r => r.person === people[0]);
  if (!want) return note(state, post, `unknown:${people[0]}`, `⚠️ On-call sync: ${people[0]} has no Phone.com extension in the list.`);
  if (want.routeId === haveId) { state.pending = null; state.reported = null; return { action: 'ok', person: want.person }; }

  const key = `${want.routeId}<-${haveId}`;
  if (state.pending !== key && !force) { state.pending = key; return { action: 'wait', person: want.person }; }
  const from = have ? `${have.person} (ext ${have.ext})` : `route ${haveId}`;
  if (syncMode === 'report') return note(state, post, `would:${key}`, `🧪 On-call sync (report only): the calendar has *${want.person}* on call, but Phone.com “${MENU}” still sends unanswered calls to *${from}*. In live mode I would switch it to ${want.person} (ext ${want.ext}). Nothing was changed.`);

  // Live: switch, then read back to confirm.
  await phone.patch('menus', menu.id, { timeout_handler: { id: want.routeId } });
  const check = await phone.get('menus', menu.id);
  state.pending = null;
  const ok = Number(check.timeout_handler?.id) === want.routeId;
  if (ok) visible.lastSwitch = { at: now.toISOString(), person: want.person, from: have ? have.person : String(haveId) };
  await say(post, ok ? `${MENU} Has been changed to: ${want.person} (was ${from}).` : `⚠️ On-call sync tried to switch ${MENU} to ${want.person}, but Phone.com still shows route ${check.timeout_handler?.id}. Please check Phone.com.`);
  return { action: ok ? 'switched' : 'failed', person: want.person, from: haveId };
}

// Shown in the /phone pop-up, so a missed #office post is still visible.
const visible = { lastSwitch: null, lastOffice: null, postError: null, last: null };
async function say(post, text) {
  if (!post) { visible.postError = 'TPS_BOT_TOKEN is not set, so nothing is posted'; return; }
  try { await post(text); visible.postError = null; }
  catch (e) { visible.postError = `${e.message} (${new Date().toISOString()})`; console.error('on-call sync post failed', e.message); }
}
function getSyncStatus() { return { mode: mode(), ...visible }; }
async function note(state, post, key, text, slot = 'reported') {
  if (state[slot] !== key) { state[slot] = key; await say(post, text); }
  return { action: 'report', key };
}

// Holiday mode and Paul's days off: office numbers follow the calendar's "Holiday" and "Paul off - Edgar/Thayned" events.
async function syncOffice({ phone, cal, post, state, syncMode, force }) {
  const want = wantedMode(cal);
  if (want.kind === 'unclear') return note(state, post, `office-unclear:${want.title}`, `⚠️ The calendar has “${want.title}” today but doesn’t say who answers (Edgar or Thayned). Office phones were left as they are.`, 'officeReported');
  const plan = await applyOfficeMode({ phone, want, dry: true });
  if (!plan.changes.length) {
    state.officePending = null;
    if (plan.notes.length) return note(state, post, `office-note:${plan.notes.join()}`, `⚠️ Office phones: ${plan.notes.join('; ')}.`, 'officeReported');
    state.officeReported = null;
    return { action: 'ok', mode: want.kind };
  }
  const key = `${wantLabel(want)}:${plan.changes.map(c => c.number).join()}`;
  if (state.officePending !== key && !force) { state.officePending = key; return { action: 'wait', mode: want.kind }; }
  const list = plan.changes.map(c => c.number).join(', ');
  if (syncMode === 'report') return note(state, post, `office-would:${key}`, `🧪 Office phones (report only): the calendar asks for *${wantLabel(want)}*. In live mode I would switch ${list}. Nothing was changed.`, 'officeReported');
  const done = await applyOfficeMode({ phone, want });
  state.officePending = null;
  const bad = done.changes.filter(c => c.ok === false);
  const text = want.kind === 'holiday' ? `🎉 Holiday mode is on: ${list} now go straight to the on-call plumber all day.`
    : want.kind === 'dayoff' ? `🏖️ Paul is off: office calls that ring Paul now ring ${want.cover} (${list}).`
    : `📞 Office phones are back to normal routing (${list}).`;
  visible.lastOffice = { at: new Date().toISOString(), mode: wantLabel(want) };
  await say(post, bad.length ? `⚠️ ${text} But Phone.com didn’t confirm: ${done.notes.join('; ')}. Please check Phone.com.` : text);
  return { action: bad.length ? 'failed' : 'switched', mode: want.kind };
}

function slackPoster({ token = process.env.TPS_BOT_TOKEN, channel = CHANNEL, fetch: fetcher = global.fetch } = {}) {
  if (!token) return null;
  return async text => {
    try { await slackApi('chat.postMessage', { channel, text }, token, fetcher); }
    catch (e) { if (!/not_in_channel/.test(e.message)) throw e; await slackApi('conversations.join', { channel }, token, fetcher); await slackApi('chat.postMessage', { channel, text }, token, fetcher); }
  };
}

function startOnCallSync() {
  const state = {}, post = slackPoster();
  let running = false;
  const tick = async () => {
    if (running || mode() === 'off') return;
    running = true;
    try { state.last = { at: new Date().toISOString(), ...(await syncOnce({ post, state })) }; }
    catch (e) { state.last = { at: new Date().toISOString(), action: 'error', error: e.message }; console.error('on-call sync failed', e.message); }
    finally { running = false; visible.last = state.last; }
  };
  setTimeout(tick, 30000).unref?.();
  setInterval(tick, EVERY_MS).unref?.();
  // Runs a check straight away after an admin change in the pop-up (waits for a check already running).
  runNow = async () => {
    for (let i = 0; running && i < 60; i++) await new Promise(r => setTimeout(r, 500));
    if (mode() === 'off') return { action: 'off' };
    running = true;
    try { state.last = { at: new Date().toISOString(), ...(await syncOnce({ post, state, force: true })) }; return state.last; }
    catch (e) { state.last = { at: new Date().toISOString(), action: 'error', error: e.message }; return state.last; }
    finally { running = false; visible.last = state.last; }
  };
  return { status: () => ({ mode: mode(), ...state.last }), runNow };
}
let runNow = async () => ({ action: 'skip', reason: 'sync not started' });
function syncNow() { return runNow(); }

module.exports = { syncOnce, syncNow, startOnCallSync, slackPoster, mode, getSyncStatus, _visible: visible };
