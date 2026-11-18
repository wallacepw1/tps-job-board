'use strict';
// Phone settings pop-up for TPS admins, answered here on Render (no Latenode run).
// Opened by the "📞 Phone settings" button (action tps_phone_open) or the /phone command of TPS Assistant.
// Called only after the Assistant endpoint has verified Slack's signature.
const { ADMINS } = require('./assignment-policy');
const { loadSnapshot, statusBlocks } = require('./phone-status');
const { slackApi } = require('./job-files');
const { writerReady, eventFor, addEvent, removeEvent } = require('./oncall-writer');
const { ONCALL_ROUTES } = require('./phone-status');
const { wall } = require('./oncall-calendar');

const TEAM = 'T086X85G14N';
const OPEN = 'tps_phone_open', REFRESH = 'tps_phone_refresh', CALLBACK = 'tps_phone_settings', FORM = 'tps_phone_form', REMOVE = 'tps_phone_remove';
const FORMS = { tps_phone_swap: 'swap', tps_phone_holiday: 'holiday', tps_phone_dayoff: 'dayoff' };
const TZ = process.env.TZ_NAME || 'America/Los_Angeles';
let cached = null; // { at, snap }

function phoneRequest(body) {
  const base = { user: body?.user_id || body?.user?.id, team: body?.team_id || body?.team?.id, trigger: body?.trigger_id, responseUrl: body?.response_url };
  if (body?.command === '/phone' || (body?.command === '/admin' && /^\s*phone\b/i.test(body.text || ''))) return { ...base, kind: 'open' };
  const action = body?.actions?.[0]?.action_id || '';
  if (body?.type === 'block_actions' && action === OPEN) return { ...base, kind: 'open' };
  if (body?.type === 'block_actions' && action === REFRESH) return { ...base, kind: 'refresh', viewId: body.view?.type === 'modal' ? body.view.id : null };
  if (body?.type === 'block_actions' && FORMS[action]) return { ...base, kind: 'form', form: FORMS[action], viewId: body.view?.id || null };
  if (body?.type === 'block_actions' && action === REMOVE) return { ...base, kind: 'remove', eventId: body.actions[0].value, viewId: body.view?.id || null };
  if (body?.type === 'view_submission' && body.view?.callback_id === FORM) return { ...base, kind: 'submit', view: body.view, by: body.user?.name || body.user?.username || '' };
  if (body?.type === 'block_actions' && /^tps_phone_/.test(action)) return { ...base, kind: 'ignore' };
  return null;
}

async function snapshot({ fresh = false, now = Date.now(), load = loadSnapshot } = {}) {
  // Keep Phone.com calls well under its 30-per-30s limit when several admins look at once.
  if (cached && now - cached.at < (fresh ? 15000 : 60000)) return cached.snap;
  const snap = await load();
  cached = { at: now, snap };
  return snap;
}

const modal = blocks => ({ type: 'modal', callback_id: CALLBACK, title: { type: 'plain_text', text: 'Phone settings' }, close: { type: 'plain_text', text: 'Close' }, blocks });
const loading = () => modal([{ type: 'section', text: { type: 'mrkdwn', text: '📞 Checking Phone.com and the On call calendar…' } }]);
async function contentBlocks(fresh, load) {
  try { return statusBlocks(await snapshot({ fresh, load })); }
  catch (e) { console.error('phone status failed', e.message); return [{ type: 'section', text: { type: 'mrkdwn', text: `⚠️ Couldn’t read the phone settings (${e.message}).` } }]; }
}

const today = (now = new Date()) => { const w = wall(now, TZ); return `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`; };
const opt = (text, value) => ({ text: { type: 'plain_text', text }, value });
const dateInput = (block, label, optional, initial) => ({ type: 'input', block_id: block, optional, label: { type: 'plain_text', text: label }, element: { type: 'datepicker', action_id: 'v', ...(initial ? { initial_date: initial } : {}) } });
const TITLES = { swap: 'Swap on call', holiday: 'Holiday', dayoff: 'Paul day off' };
function formView(kind, parent, now = new Date()) {
  const blocks = [];
  if (kind === 'swap') {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'Puts someone else on call for these days, from 8 AM on the first day to 8 AM the day after the last day. The normal rotation picks up again after that.' } });
    blocks.push({ type: 'input', block_id: 'who', label: { type: 'plain_text', text: 'Who is on call' }, element: { type: 'static_select', action_id: 'v', options: ONCALL_ROUTES.map(r => opt(`${r.person} (ext ${r.ext})`, r.person)) } });
  }
  if (kind === 'holiday') blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'All day on these days, office calls skip the office and go straight to the on-call plumber. Normal routing comes back the next morning.' } });
  if (kind === 'dayoff') {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'On these days, office-hours calls that would ring Paul ring Edgar or Thayned instead. After-hours calls still go to the on-call plumber.' } });
    blocks.push({ type: 'input', block_id: 'who', label: { type: 'plain_text', text: 'Who answers instead' }, element: { type: 'radio_buttons', action_id: 'v', options: [opt('Edgar', 'Edgar'), opt('Thayned', 'Thayned')] } });
  }
  blocks.push(dateInput('from', 'First day', false, today(now)), dateInput('to', 'Last day (leave empty for one day)', true));
  return { type: 'modal', callback_id: FORM, private_metadata: JSON.stringify({ kind, parent }), title: { type: 'plain_text', text: TITLES[kind] }, submit: { type: 'plain_text', text: 'Save' }, close: { type: 'plain_text', text: 'Cancel' }, blocks };
}
const note = (title, text) => ({ type: 'modal', title: { type: 'plain_text', text: title }, close: { type: 'plain_text', text: 'Done' }, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] });
function readForm(view) {
  const v = view.state?.values || {};
  const pick = b => v[b]?.v?.selected_option?.value || v[b]?.v?.selected_date || null;
  let meta = {}; try { meta = JSON.parse(view.private_metadata || '{}'); } catch {}
  return { kind: meta.kind, parent: meta.parent, who: pick('who'), from: pick('from'), to: pick('to') };
}
function fmtRange(ev) { return `${new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', ...(ev.allDay ? {} : { hour: 'numeric', minute: '2-digit' }) }).format(ev.startAt)} to ${new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', ...(ev.allDay ? {} : { hour: 'numeric', minute: '2-digit' }) }).format(ev.allDay ? new Date(ev.endAt.getTime() - 3600e3) : ev.endAt)}`; }

// Returns null when the request is not for the phone tool; otherwise the immediate answer for Slack
// and a follow-up promise that opens or fills the pop-up.
function handlePhone(body, { fetch: fetcher = global.fetch, load, token = process.env.TPS_ASSISTANT_BOT_TOKEN } = {}) {
  const req = phoneRequest(body);
  if (!req) return null;
  if (req.kind === 'ignore') return { status: 200, body: '' };
  const isCommand = !!body.command;
  const say = text => isCommand ? { status: 200, json: { response_type: 'ephemeral', text } } : { status: 200, body: '' };
  if (req.team !== TEAM || !ADMINS.includes(req.user)) return say('🔒 Phone settings are limited to TPS admins.');
  if (!token) return say('📞 Phone settings need one more Render setting (TPS_ASSISTANT_BOT_TOKEN) before the pop-up can open.');
  const sync = () => require('./oncall-sync').syncNow();
  const refreshParent = async viewId => { if (!viewId) return; cached = null; await slackApi('views.update', { view_id: viewId, view: modal(await contentBlocks(true, load)) }, token, fetcher); };
  if (req.kind === 'form') {
    const follow = slackApi('views.push', { trigger_id: req.trigger, view: formView(req.form, req.viewId) }, token, fetcher).catch(e => console.error('phone form failed', e.message));
    return { status: 200, body: '', follow };
  }
  if (req.kind === 'remove') {
    const follow = (async () => {
      try { await removeEvent(req.eventId, { fetch: fetcher }); await sync(); }
      catch (e) { await slackApi('views.update', { view_id: req.viewId, view: modal([{ type: 'section', text: { type: 'mrkdwn', text: `⚠️ Couldn’t remove it: ${e.message}.` } }]) }, token, fetcher); return; }
      await refreshParent(req.viewId);
    })().catch(e => console.error('phone remove failed', e.message));
    return { status: 200, body: '', follow };
  }
  if (req.kind === 'submit') {
    const f = readForm(req.view);
    if (f.from && f.from < today()) return { status: 200, json: { response_action: 'errors', errors: { from: 'Pick today or a later day.' } } };
    const ev = eventFor({ kind: f.kind, person: f.kind === 'swap' ? f.who : null, cover: f.kind === 'dayoff' ? f.who : null, from: f.from, to: f.to, by: req.by });
    if (ev.error) return { status: 200, json: { response_action: 'errors', errors: { [/who|Edgar|on call/i.test(ev.error) ? 'who' : /before/.test(ev.error) ? 'to' : 'from']: ev.error } } };
    if (!writerReady()) {
      return { status: 200, json: { response_action: 'update', view: note(TITLES[f.kind], `Calendar writing isn’t set up yet, so please add this in Google Calendar on the *On call* calendar:\n\n• Title: *${ev.title}*\n• ${ev.allDay ? 'All day' : 'From 8:00 AM'}: ${fmtRange(ev)}\n\nPhones follow it within 5 minutes.`) } };
    }
    const follow = (async () => {
      let text;
      try {
        await addEvent(ev, { fetch: fetcher });
        const out = await sync();
        const off = out?.office?.action === 'error' || out?.action === 'error';
        text = `✅ Added *${ev.title}* (${fmtRange(ev)}) to the On call calendar.\n${ev.startAt <= new Date() ? (off ? `⚠️ Phone.com didn’t switch yet: ${out?.office?.error || out?.error}. It retries every 5 minutes.` : 'Phone.com has been switched.') : 'Phone.com switches automatically when it starts.'}`;
      } catch (e) { text = `⚠️ Couldn’t add it to the calendar: ${e.message}. Nothing was changed.`; }
      await slackApi('views.update', { view_id: req.view.id, view: note(TITLES[f.kind], text) }, token, fetcher);
      await refreshParent(f.parent);
    })().catch(e => console.error('phone form save failed', e.message));
    return { status: 200, json: { response_action: 'update', view: note(TITLES[f.kind], '⏳ Saving to the On call calendar…') }, follow };
  }
  const follow = (async () => {
    if (req.kind === 'refresh' && req.viewId) {
      await slackApi('views.update', { view_id: req.viewId, view: modal(await contentBlocks(true, load)) }, token, fetcher);
      return;
    }
    if (!req.trigger) return;
    // Slack's trigger expires after 3 seconds, so open a loading pop-up first, then fill it.
    const opened = await slackApi('views.open', { trigger_id: req.trigger, view: loading() }, token, fetcher);
    await slackApi('views.update', { view_id: opened.view.id, view: modal(await contentBlocks(false, load)) }, token, fetcher);
  })().catch(e => console.error('phone pop-up failed', e.message));
  return { status: 200, body: '', follow };
}

function resetPhoneCache() { cached = null; }
module.exports = { handlePhone, phoneRequest, resetPhoneCache, formView, readForm, OPEN, REFRESH };
