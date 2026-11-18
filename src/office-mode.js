'use strict';
// Office number modes in Phone.com, driven by the On call calendar:
//  - holiday: the office numbers use only their after-hours rule all day, so calls go to the on-call plumber.
//  - dayoff:  calls that would ring Paul (ext 517) during office hours ring Edgar or Thayned instead.
//  - normal:  every office number is back on its own route.
// Nothing is edited in the office's own routes. For a mode the tool keeps a separate route named
// "TPS holiday · normal route #123" (a copy of route 123 with the change) and points the number at it.
// The normal route's id is in that name, so going back to normal needs no saved state, even after a restart.
const PAUL_EXT = Number(process.env.PHONECOM_PAUL_EXT || 517);
const TAG = /^TPS (holiday|day off)\b.*#(\d+)\s*$/i;

const id = x => (x && typeof x === 'object' ? x.id : x);
const ref = x => (x == null ? x : { id: Number(id(x)) });

// Phone.com accepts references as { id }; strip the read-only details it sends back.
function cleanRules(rules) {
  return (rules || []).map(r => {
    const out = {};
    if (r.filter) {
      out.filter = { type: r.filter.type || (r.filter.schedule ? 'schedule' : r.filter.contact ? 'contact' : r.filter.group ? 'contact_group' : undefined) };
      for (const k of ['schedule', 'contact', 'group']) if (r.filter[k]) out.filter[k] = ref(r.filter[k]);
    }
    out.actions = (r.actions || []).map(a => {
      const b = { action: a.action };
      for (const [k, v] of Object.entries(a)) {
        if (k === 'action') continue;
        if (k === 'items') b.items = (v || []).map(i => i.type === 'phone_number' || i.number ? { type: 'phone_number', number: i.number, ...(i.caller_id ? { caller_id: i.caller_id } : {}), ...(i.voice_tag ? { voice_tag: i.voice_tag } : {}), ...(i.screening != null ? { screening: i.screening } : {}), ...(i.distinctive_ring ? { distinctive_ring: i.distinctive_ring } : {}) } : { type: i.type || 'extension', extension: ref(i.extension) });
        else if (v && typeof v === 'object' && !Array.isArray(v) && v.id != null) b[k] = ref(v);
        else b[k] = v;
      }
      return b;
    });
    return out;
  });
}

const isTimed = r => !!r.filter?.schedule;
function holidayRules(route) {
  const rules = route?.rules || [];
  if (!rules.some(isTimed) || !rules.some(r => !isTimed(r))) return null; // no office-hours/after-hours split
  return rules.filter(r => !isTimed(r));
}
function ringsPaul(item, paul) { const e = item?.extension; return !!e && (Number(e.id) === Number(paul?.id) || Number(e.extension) === PAUL_EXT); }
function dayOffRules(route, paul, cover) {
  const rules = route?.rules || [];
  let changed = false;
  const out = rules.map(r => {
    if (!isTimed(r)) return r;
    return { ...r, actions: (r.actions || []).map(a => {
      if (a.action !== 'forward' || !(a.items || []).some(i => ringsPaul(i, paul))) return a;
      changed = true;
      const items = [];
      for (const i of a.items) {
        if (!ringsPaul(i, paul)) { if (Number(i.extension?.id) !== Number(cover.id)) items.push(i); continue; }
        if (!items.some(x => Number(x.extension?.id) === Number(cover.id))) items.push({ type: 'extension', extension: { id: cover.id, extension: cover.extension, name: cover.name } });
      }
      // Keep any later cover already in the list once.
      return { ...a, items: items.filter((x, n) => !x.extension || items.findIndex(y => Number(y.extension?.id) === Number(x.extension.id)) === n) };
    }) };
  });
  return changed ? out : null;
}

function modeName(want, normalId) { return want.kind === 'holiday' ? `TPS holiday · normal route #${normalId}` : `TPS day off (${want.cover}) · normal route #${normalId}`; }
function wantLabel(want) { return want.kind === 'holiday' ? 'holiday mode' : want.kind === 'dayoff' ? `Paul off, ${want.cover} answers` : 'normal'; }

// Works out (and in live mode makes) the changes for one wanted mode.
// want = { kind: 'normal' } | { kind: 'holiday' } | { kind: 'dayoff', cover: 'Edgar' | 'Thayned' }
async function applyOfficeMode({ phone, want, dry = false }) {
  const numbers = await phone.list('phone-numbers');
  const onTps = numbers.filter(n => TAG.test(String(n.route?.name || '')));
  if (want.kind === 'normal' && !onTps.length) return { changes: [], notes: [] };
  const [routes, extensions] = await Promise.all([phone.list('routes'), want.kind === 'dayoff' ? phone.list('extensions') : []]);
  const byId = new Map(routes.map(r => [String(r.id), r]));
  const notes = [];
  let paul = null, cover = null;
  if (want.kind === 'dayoff') {
    paul = extensions.find(e => Number(e.extension) === PAUL_EXT) || null;
    cover = extensions.find(e => new RegExp(want.cover, 'i').test(String(e.name || ''))) || null;
    if (!cover) return { changes: [], notes: [`couldn’t find ${want.cover}’s extension in Phone.com`] };
  }
  const full = new Map();
  const load = async rid => { if (!full.has(rid)) { const brief = byId.get(rid); full.set(rid, brief?.rules ? brief : await phone.get('routes', rid)); } return full.get(rid); };
  const changes = [];
  let eligible = 0;
  for (const n of numbers) {
    const current = String(n.route?.id ?? '');
    const tag = TAG.exec(String(n.route?.name || byId.get(current)?.name || ''));
    const normalId = tag ? tag[2] : current;
    if (!normalId) continue;
    let targetName = null, rules = null;
    if (want.kind !== 'normal') {
      const normal = await load(normalId);
      rules = want.kind === 'holiday' ? holidayRules(normal) : dayOffRules(normal, paul, cover);
      if (rules) { targetName = modeName(want, normalId); eligible++; }
    }
    const target = targetName ? routes.find(r => r.name === targetName) : null;
    const goNormal = !targetName;
    if (goNormal && !tag) continue; // not an office number for this mode, and already normal
    if (!goNormal && target && String(target.id) === current) continue; // already in this mode
    const label = `${n.name ? n.name + ' ' : ''}${n.phone_number || n.number || n.id}`.trim();
    if (dry) { changes.push({ number: label, to: goNormal ? 'normal' : wantLabel(want) }); continue; }
    let routeId = normalId;
    if (!goNormal) {
      const saved = target ? await phone.patch('routes', target.id, { name: targetName, rules: cleanRules(rules) }) : await phone.create('routes', { name: targetName, rules: cleanRules(rules) });
      routeId = String(saved?.id ?? target?.id);
      if (!target) routes.push({ id: saved.id, name: targetName });
    }
    await phone.patch('phone-numbers', n.id, { route: { id: Number(routeId) } });
    const check = await phone.get('phone-numbers', n.id);
    const ok = String(id(check.route)) === String(routeId);
    changes.push({ number: label, to: goNormal ? 'normal' : wantLabel(want), ok });
    if (!ok) notes.push(`${label} still shows route ${id(check.route)}`);
  }
  if (want.kind !== 'normal' && !eligible) notes.push(want.kind === 'holiday' ? 'no office number has an office-hours rule plus an after-hours rule, so holiday mode had nothing to switch' : `no office number rings Paul (ext ${PAUL_EXT}) during office hours, so nothing was switched to ${want.cover}`);
  return { changes, notes };
}

// Which office mode the calendar asks for right now.
function wantedMode(cal) {
  const special = cal?.special || [];
  if (special.some(s => s.kind === 'holiday')) return { kind: 'holiday' };
  const off = special.find(s => s.kind === 'dayoff');
  if (off) return off.cover ? { kind: 'dayoff', cover: off.cover } : { kind: 'unclear', title: off.title };
  return { kind: 'normal' };
}

// Mode the office numbers are in now, from their route names (for the pop-up).
function currentMode(numbers) {
  const tagged = (numbers || []).map(n => TAG.exec(String(n.route?.name || ''))).filter(Boolean);
  if (!tagged.length) return { kind: 'normal' };
  const name = tagged[0][0];
  if (/holiday/i.test(name)) return { kind: 'holiday', count: tagged.length };
  const cover = /\(([^)]+)\)/.exec(name)?.[1];
  return { kind: 'dayoff', cover, count: tagged.length };
}

module.exports = { applyOfficeMode, wantedMode, currentMode, wantLabel, holidayRules, dayOffRules, cleanRules, TAG };
