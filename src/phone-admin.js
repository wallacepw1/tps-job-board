'use strict';
// Phone settings pop-up for TPS admins, answered here on Render (no Latenode run).
// Opened by the "📞 Phone settings" button (action tps_phone_open) or the /phone command of TPS Assistant.
// Called only after the Assistant endpoint has verified Slack's signature.
const { ADMINS } = require('./assignment-policy');
const { loadSnapshot, statusBlocks } = require('./phone-status');
const { slackApi } = require('./job-files');
const { describeFeed } = require('./oncall-calendar');

const TEAM = 'T086X85G14N';
const OPEN = 'tps_phone_open', REFRESH = 'tps_phone_refresh', CALLBACK = 'tps_phone_settings';
let cached = null; // { at, snap }

function phoneRequest(body) {
  const base = { user: body?.user_id || body?.user?.id, team: body?.team_id || body?.team?.id, trigger: body?.trigger_id, responseUrl: body?.response_url };
  if (body?.command === '/phone' && /^\s*check\b/i.test(body.text || '')) return { ...base, kind: 'check' };
  if (body?.command === '/phone' || (body?.command === '/admin' && /^\s*phone\b/i.test(body.text || ''))) return { ...base, kind: 'open' };
  const action = body?.actions?.[0]?.action_id || '';
  if (body?.type === 'block_actions' && action === OPEN) return { ...base, kind: 'open' };
  if (body?.type === 'block_actions' && action === REFRESH) return { ...base, kind: 'refresh', viewId: body.view?.type === 'modal' ? body.view.id : null };
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

// Returns null when the request is not for the phone tool; otherwise the immediate answer for Slack
// and a follow-up promise that opens or fills the pop-up.
function handlePhone(body, { fetch: fetcher = global.fetch, load, token = process.env.TPS_ASSISTANT_BOT_TOKEN } = {}) {
  const req = phoneRequest(body);
  if (!req) return null;
  if (req.kind === 'ignore') return { status: 200, body: '' };
  const isCommand = !!body.command;
  const say = text => isCommand ? { status: 200, json: { response_type: 'ephemeral', text } } : { status: 200, body: '' };
  if (req.team !== TEAM || !ADMINS.includes(req.user)) return say('🔒 Phone settings are limited to TPS admins.');
  if (req.kind === 'check') {
    if (!/^https:\/\/hooks\.slack\.com\//.test(req.responseUrl || '')) return say('Slack sent no reply address.');
    const follow = (async () => {
      let text;
      try { text = '```' + (await describeFeed()).join('\n').slice(0, 3500) + '```'; } catch (e) { text = `⚠️ Couldn’t read the calendar (${e.message}).`; }
      await fetcher(req.responseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ response_type: 'ephemeral', text }), signal: AbortSignal.timeout(10000) });
    })().catch(e => console.error('phone check failed', e.message));
    return { ...say('Checking the On call calendar feed…'), follow };
  }
  if (!token) return say('📞 Phone settings need one more Render setting (TPS_ASSISTANT_BOT_TOKEN) before the pop-up can open.');
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
module.exports = { handlePhone, phoneRequest, resetPhoneCache, OPEN, REFRESH };
