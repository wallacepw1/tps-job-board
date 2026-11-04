'use strict';
// "/admin phone" and the Phone buttons from TPS Assistant, answered here on Render (no Latenode run).
// Called only after the Assistant endpoint has verified Slack's signature.
const { ADMINS } = require('./assignment-policy');
const { loadSnapshot, statusBlocks } = require('./phone-status');

const TEAM = 'T086X85G14N';
const ACTION = /^tps_phone_/;
let cached = null; // { at, snap }

function phoneRequest(body) {
  if (body?.command === '/admin' && /^\s*phone\b/i.test(body.text || '')) return { user: body.user_id, team: body.team_id, responseUrl: body.response_url, kind: 'command' };
  const action = body?.actions?.[0]?.action_id || '';
  if (body?.type === 'block_actions' && ACTION.test(action)) return { user: body.user?.id, team: body.team?.id || body.team_id, responseUrl: body.response_url, kind: action };
  return null;
}

async function snapshot({ fresh = false, now = Date.now(), load = loadSnapshot } = {}) {
  // Keep Phone.com calls well under its 30-per-30s limit when several admins look at once.
  if (cached && now - cached.at < (fresh ? 15000 : 60000)) return cached.snap;
  const snap = await load();
  cached = { at: now, snap };
  return snap;
}

// Returns null when the request is not for the phone tool; otherwise the immediate answer for Slack
// and a follow-up that posts the status to the response URL.
function handlePhone(body, { fetch: fetcher = global.fetch, load } = {}) {
  const req = phoneRequest(body);
  if (!req) return null;
  if (req.team !== TEAM || !ADMINS.includes(req.user)) return { status: 200, json: { response_type: 'ephemeral', text: '🔒 Phone settings are limited to TPS admins.' } };
  if (!/^https:\/\/hooks\.slack\.com\//.test(req.responseUrl || '')) return { status: 200, json: { response_type: 'ephemeral', text: 'Slack did not send a reply address. Try /admin phone again.' } };
  const follow = (async () => {
    let message;
    try {
      const snap = await snapshot({ fresh: req.kind === 'tps_phone_refresh', load });
      message = { text: 'Phone settings', blocks: statusBlocks(snap) };
    } catch (e) {
      console.error('phone status failed', e.message);
      message = { text: `⚠️ Couldn’t read the phone settings (${e.message}).` };
    }
    await fetcher(req.responseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ response_type: 'ephemeral', replace_original: true, ...message }), signal: AbortSignal.timeout(10000) });
  })().catch(e => console.error('phone reply failed', e.message));
  if (req.kind === 'command') return { status: 200, json: { response_type: 'ephemeral', text: '📞 Checking Phone.com and the On call calendar…' }, follow };
  return { status: 200, body: '', follow };
}

function resetPhoneCache() { cached = null; }
module.exports = { handlePhone, phoneRequest, resetPhoneCache };
