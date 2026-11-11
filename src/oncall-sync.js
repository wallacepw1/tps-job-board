'use strict';
// Keeps Phone.com's "On Call Plumber" menu in step with the Google "On call" calendar.
// Mode (PHONECOM_SYNC_MODE): "off", "report" (default: posts what it would change, changes nothing),
// or "live" (switches the menu). Live replaces the Latenode Calendar-Oncall Routing scenario,
// so turn that scenario off at the same time; never run both.
const { createPhoneCom } = require('./phonecom');
const { readOnCall } = require('./oncall-calendar');
const { ONCALL_ROUTES } = require('./phone-status');
const { slackApi } = require('./job-files');

const MENU = process.env.PHONECOM_ONCALL_MENU || 'On Call Plumber';
const CHANNEL = process.env.ONCALL_REPORT_CHANNEL || 'C086PAU2BM5'; // where the old scenario posts its changes
const EVERY_MS = 5 * 60 * 1000;

function mode() { const m = String(process.env.PHONECOM_SYNC_MODE || 'report').toLowerCase(); return ['off', 'report', 'live'].includes(m) ? m : 'report'; }

// One check. state carries what was seen last time, so a mismatch must be seen twice in a row
// (the old scenario switches right at 8:00; this avoids reporting a race) and each problem is posted once.
async function syncOnce({ phone = createPhoneCom(), oncall = readOnCall, post, now = new Date(), state = {}, syncMode = mode() } = {}) {
  if (syncMode === 'off') return { action: 'off' };
  if (!phone.ready) return { action: 'skip', reason: 'Phone.com not connected' };
  const cal = await oncall({ now });
  if (!cal.connected) return { action: 'skip', reason: 'calendar not connected' };
  const people = [...new Set(cal.current.map(s => s.person).filter(Boolean))];
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
  if (state.pending !== key) { state.pending = key; return { action: 'wait', person: want.person }; }
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
const visible = { lastSwitch: null, postError: null, last: null };
async function say(post, text) {
  if (!post) { visible.postError = 'TPS_BOT_TOKEN is not set, so nothing is posted'; return; }
  try { await post(text); visible.postError = null; }
  catch (e) { visible.postError = `${e.message} (${new Date().toISOString()})`; console.error('on-call sync post failed', e.message); }
}
function getSyncStatus() { return { mode: mode(), ...visible }; }
async function note(state, post, key, text) {
  if (state.reported !== key) { state.reported = key; await say(post, text); }
  return { action: 'report', key };
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
  return { status: () => ({ mode: mode(), ...state.last }) };
}

module.exports = { syncOnce, startOnCallSync, slackPoster, mode, getSyncStatus, _visible: visible };
