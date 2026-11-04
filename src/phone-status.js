'use strict';
// Read-only "where do calls go now" view for TPS admins: Phone.com routing next to the On call calendar.
const { createPhoneCom } = require('./phonecom');
const { readOnCall } = require('./oncall-calendar');

const TZ = process.env.TZ_NAME || 'America/Los_Angeles';
const ONCALL_MENU = process.env.PHONECOM_ONCALL_MENU || 'On Call Plumber';
// Extension routes the old Calendar-Oncall Routing scenario switches between.
const ONCALL_ROUTES = [
  { person: 'JR', ext: 518, routeId: 14747574 },
  { person: 'Edgar', ext: 507, routeId: 13177454 },
  { person: 'Eduardo', ext: 511, routeId: 6445341 },
  { person: 'Esteban', ext: 516, routeId: 12915184 },
  { person: 'Cindy', ext: 514, routeId: 12587515 },
  { person: 'Paul T', ext: 517, routeId: 13637664 },
];

const nameOf = x => (x && (x.name || x.full_name || x.extension || x.phone_number || x.number || (x.id != null ? `#${x.id}` : ''))) || '';
function fmtNumber(n) { const d = String(n || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(n || ''); }
function fmtWhen(date) { return new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date); }

function describeAction(a, ctx) {
  const t = a?.action || '?';
  const wait = a?.timeout ? ` (rings ${a.timeout}s)` : '';
  if (t === 'forward') {
    const to = (a.items || []).map(i => i.type === 'phone_number' ? fmtNumber(i.number) : i.extension ? `ext ${i.extension.extension || ''} ${nameOf(ctx.extensions.get(String(i.extension.id)) || i.extension)}`.replace(/\s+/g, ' ').trim() : nameOf(i)).filter(Boolean);
    return `ring ${to.join(' + ') || 'someone'}${wait}`;
  }
  if (t === 'menu') return `menu “${nameOf(ctx.menus.get(String(a.menu?.id)) || a.menu)}”`;
  if (t === 'queue') return `queue “${nameOf(a.queue)}”`;
  if (t === 'voicemail') return 'voicemail';
  if (t === 'greeting') return `play greeting “${nameOf(a.greeting)}”`;
  if (t === 'disconnect') return 'hang up';
  if (t === 'live_answer') return 'live receptionist';
  return t.replace(/_/g, ' ');
}
function describeRoute(route, ctx) {
  if (!route) return '_route details not available_';
  const rules = route.rules || [];
  if (!rules.length) return '_no rules_';
  return rules.map(r => {
    const f = r.filter;
    const when = f?.schedule ? `During “${nameOf(ctx.schedules.get(String(f.schedule.id)) || f.schedule)}”` : f?.contact ? `Caller ${nameOf(f.contact)}` : f?.group ? `Caller group ${nameOf(f.group)}` : f?.type ? `When ${f.type}` : 'Otherwise';
    return `• ${when}: ${(r.actions || []).map(a => describeAction(a, ctx)).join(', then ') || 'nothing'}`;
  }).join('\n');
}

// Who the On Call Plumber menu sends unanswered calls to, as a TPS name when it is one of the known routes.
function menuOnCall(menu, ctx) {
  const h = menu?.timeout_handler;
  if (!h) return null;
  const id = Number(h.id);
  const known = ONCALL_ROUTES.find(r => r.routeId === id);
  const route = ctx.routes.get(String(h.id));
  return { routeId: id, person: known?.person || null, ext: known?.ext || null, label: known ? `${known.person} (ext ${known.ext})` : nameOf(route || h) };
}

async function loadSnapshot({ phone = createPhoneCom(), oncall = readOnCall, now = new Date() } = {}) {
  const snap = { at: now, phone: { ready: phone.ready }, calendar: null, errors: [] };
  const cal = oncall({ now }).catch(e => { snap.errors.push(`On call calendar: ${e.message}`); return null; });
  if (phone.ready) {
    try {
      const [numbers, routes, menus, schedules, extensions] = await Promise.all(['phone-numbers', 'routes', 'menus', 'schedules', 'extensions'].map(r => phone.list(r).catch(e => { snap.errors.push(e.message); return []; })));
      const ctx = { routes: new Map(routes.map(x => [String(x.id), x])), menus: new Map(menus.map(x => [String(x.id), x])), schedules: new Map(schedules.map(x => [String(x.id), x])), extensions: new Map(extensions.map(x => [String(x.id), x])) };
      // Lists can be brief; read full details for the routes the office numbers use and the on-call menu.
      const needed = [...new Set(numbers.map(n => n.route?.id).filter(id => id != null && !ctx.routes.get(String(id))?.rules))];
      for (const id of needed.slice(0, 10)) { try { ctx.routes.set(String(id), await phone.get('routes', id)); } catch (e) { snap.errors.push(e.message); } }
      let menu = menus.find(m => String(m.name || '').trim().toLowerCase() === ONCALL_MENU.toLowerCase());
      if (menu && !menu.timeout_handler) { try { menu = await phone.get('menus', menu.id); } catch (e) { snap.errors.push(e.message); } }
      Object.assign(snap.phone, { numbers, ctx, menu: menu || null, onCall: menu ? menuOnCall(menu, ctx) : null });
    } catch (e) { snap.errors.push(e.message); }
  }
  snap.calendar = await cal;
  return snap;
}

const section = text => ({ type: 'section', text: { type: 'mrkdwn', text: text.length > 2900 ? text.slice(0, 2890) + '…' : text } });
function statusBlocks(snap) {
  const blocks = [{ type: 'header', text: { type: 'plain_text', text: '📞 Phone settings' } }];
  const cal = snap.calendar;
  const want = cal?.connected ? cal.current.map(s => s.person || s.title) : null;
  const have = snap.phone.onCall;

  // On call: calendar vs Phone.com.
  let oncall = '*On call right now*\n';
  if (!cal) oncall += '• Calendar: couldn’t be read (see below)\n';
  else if (!cal.connected) oncall += '• Calendar: not connected yet (ONCALL_CALENDAR_ICS_URL is not set)\n';
  else oncall += `• Calendar says: *${want.join(' + ') || 'nobody'}*${cal.current[0] ? ` until ${fmtWhen(cal.current[0].end)}` : ''}\n`;
  if (!snap.phone.ready) oncall += '• Phone.com: not connected yet (PHONECOM_API_TOKEN is not set)\n';
  else if (!snap.phone.menu) oncall += `• Phone.com: couldn’t find the “${ONCALL_MENU}” menu\n`;
  else oncall += `• Phone.com “${ONCALL_MENU}” sends unanswered calls to: *${have?.label || 'nothing set'}*\n`;
  if (want && have) {
    const match = want.length === 1 && have.person && want[0] === have.person;
    oncall += match ? '✅ They match.' : want.length > 1 ? `⚠️ The calendar has ${want.length} people on call at once. Check for overlapping shifts.` : want.length === 0 ? '⚠️ Nobody is on the calendar right now.' : '⚠️ *They don’t match.* Calls are not going to the person on the calendar.';
  }
  blocks.push(section(oncall));
  if (cal?.connected && cal.upcoming.length) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Next: ' + cal.upcoming.slice(0, 5).map(s => `${s.person || s.title} ${fmtWhen(s.start)}`).join(' · ') }] });

  // Office numbers and their routing rules.
  if (snap.phone.numbers?.length) {
    blocks.push({ type: 'divider' });
    const ctx = snap.phone.ctx;
    for (const n of snap.phone.numbers.slice(0, 12)) {
      const route = n.route?.id != null ? ctx.routes.get(String(n.route.id)) : null;
      blocks.push(section(`*${fmtNumber(n.phone_number || n.number || n.name)}*${n.name ? ` · ${n.name}` : ''}\nRoute: ${nameOf(route || n.route) || 'none'}\n${describeRoute(route, ctx)}`));
    }
    if (snap.phone.numbers.length > 12) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `…and ${snap.phone.numbers.length - 12} more numbers.` }] });
  }
  if (snap.errors.length) blocks.push(section('⚠️ ' + [...new Set(snap.errors)].slice(0, 5).join('\n⚠️ ')));
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Read only: nothing is changed in Phone.com. Checked ${fmtWhen(snap.at)}.` }] });
  blocks.push({ type: 'actions', elements: [{ type: 'button', action_id: 'tps_phone_refresh', text: { type: 'plain_text', text: '🔄 Refresh' }, value: 'refresh' }] });
  return blocks;
}

module.exports = { loadSnapshot, statusBlocks, describeRoute, describeAction, menuOnCall, ONCALL_ROUTES, fmtNumber };
