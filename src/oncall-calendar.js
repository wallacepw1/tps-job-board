'use strict';
// Reads the Google "On call" calendar through its secret iCal address and works out who is on call.
// Shifts are weekly repeating events ("Edgar On Call", 7 AM to 7 AM); single edits and deleted days are respected.
const ical = require('node-ical');

const TZ = process.env.TZ_NAME || 'America/Los_Angeles';

// Calendar title -> TPS person. Same names the old Calendar-Oncall Routing scenario used.
const PEOPLE = [
  { key: 'JR', match: /\bjr\b/i },
  { key: 'Edgar', match: /edgar/i },
  { key: 'Eduardo', match: /eduardo/i },
  { key: 'Esteban', match: /esteban/i },
  { key: 'Cindy', match: /cindy/i },
  { key: 'Paul T', match: /paul/i },
];
function personFromTitle(title) {
  const p = PEOPLE.find(x => x.match.test(String(title || '')));
  return p ? p.key : null;
}

// What a calendar event means. Besides the weekly "<Name> On Call" shifts the calendar can hold:
//  - "Holiday" / "Office closed": office numbers go to the on-call plumber all day.
//  - "Paul off - Edgar" / "Paul off - Thayned": office calls that ring Paul go to Edgar or Thayned instead.
const COVER = [{ key: 'Edgar', match: /edgar/i }, { key: 'Thayned', match: /thayned/i }];
function kindOf(title) {
  const t = String(title || '');
  if (/holiday|office\s+closed/i.test(t)) return { kind: 'holiday' };
  if (/\bpaul\b[^a-z]*(is\s+)?(off|out|away)\b|day\s*off/i.test(t)) { const c = COVER.find(x => x.match.test(t)); return { kind: 'dayoff', cover: c ? c.key : null }; }
  if (/on\s*-?\s*call/i.test(t)) return { kind: 'shift' };
  return { kind: 'other' };
}

// Wall-clock parts of an instant in a time zone.
function wall(date, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date).map(p => [p.type, p.value]));
  return { y: +parts.year, m: +parts.month, d: +parts.day, h: +parts.hour, mi: +parts.minute, s: +parts.second };
}
function wallMs(date, tz) { const w = wall(date, tz); return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s); }
// The instant that shows wall-clock time (as a UTC-based ms value) in tz.
function fromWall(ms, tz) {
  let guess = ms;
  for (let i = 0; i < 3; i++) { const off = wallMs(new Date(guess), tz) - guess; const next = ms - off; if (next === guess) break; guess = next; }
  return new Date(guess);
}
function dayKey(date, tz) { const w = wall(date, tz); return `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`; }
function keysOf(obj) { return new Set(Object.keys(obj || {}).map(k => k.slice(0, 10))); }

// Expands the calendar into shifts overlapping [from, to].
function shiftsBetween(data, from, to) {
  const out = [];
  for (const ev of Object.values(data || {})) {
    if (ev.type !== 'VEVENT' || !ev.start || String(ev.status || '').toUpperCase() === 'CANCELLED') continue;
    // Shifts are office (Pacific) times. The calendar labels them America/Vancouver or Tijuana, but British Columbia
    // stays on daylight time from November 2026, so its clock no longer matches the office's.
    const tz = TZ;
    let start = new Date(ev.start), end = new Date(ev.end || ev.start);
    // All-day events arrive as midnight on the server's clock; make them midnight office time.
    if (ev.start.dateOnly || ev.datetype === 'date') { start = dateOnlyStart(ev.start, tz); end = ev.end ? dateOnlyStart(ev.end, tz) : new Date(start.getTime() + 864e5); }
    const add = (s, e, src, oneOff) => {
      if (!(e > from && s < to) || String(src.status || '').toUpperCase() === 'CANCELLED') return;
      const title = String(src.summary || '').trim(), k = kindOf(title);
      out.push({ title, ...k, person: k.kind === 'shift' ? personFromTitle(title) : null, start: s, end: e, id: src.uid, oneOff, tool: /TPS Assistant/.test(String(src.description || '')) });
    };
    if (!ev.rrule) { if (!ev.recurrenceid) add(start, end, ev, true); continue; }
    // rrule's times drift by an hour across daylight saving, so keep only its dates
    // and rebuild each start from the event's own wall-clock time.
    const startWall = wallMs(start, tz), length = wallMs(end, tz) - startWall, timeOfDay = startWall % 864e5;
    const skip = keysOf(ev.exdate), moved = ev.recurrences || {};
    const movedKeys = keysOf(moved);
    for (const raw of ev.rrule.between(new Date(from.getTime() - 8 * 864e5), new Date(to.getTime() + 864e5), true)) {
      const key = dayKey(raw, tz);
      if (skip.has(key) || movedKeys.has(key)) continue;
      const [y, m, d] = key.split('-').map(Number);
      const s = fromWall(Date.UTC(y, m - 1, d) + timeOfDay, tz), e = fromWall(Date.UTC(y, m - 1, d) + timeOfDay + length, tz);
      add(s, e, ev, false);
    }
    for (const r of Object.values(moved)) add(new Date(r.start), new Date(r.end || r.start), r, false);
  }
  return out.sort((a, b) => a.start - b.start);
}

function dateOnlyStart(d, tz) { const x = new Date(d); return fromWall(Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()), tz); }

// Events the phone tool just added or removed. Google's iCal feed can lag by several minutes,
// so these are laid over the feed until it catches up (6 hours at most).
const recent = { added: new Map(), removed: new Map() };
const HOLD_MS = 6 * 3600e3;
function noteAdded(ev, at = Date.now()) { recent.added.set(ev.id, { ev, at }); recent.removed.delete(ev.id); }
function noteRemoved(id, at = Date.now()) { recent.removed.set(id, at); recent.added.delete(id); }
function overlay(events, now) {
  for (const [id, x] of recent.added) if (now - x.at > HOLD_MS) recent.added.delete(id);
  for (const [id, at] of recent.removed) if (now - at > HOLD_MS) recent.removed.delete(id);
  const ids = new Set(events.map(e => e.id));
  const out = events.filter(e => !recent.removed.has(e.id));
  for (const [id, x] of recent.added) if (!ids.has(id)) out.push(x.ev);
  return out.sort((a, b) => a.start - b.start);
}

// Who is on call when the calendar has more than one shift at once: a one-off event (a swap)
// beats the weekly series it sits on top of.
function onCallPeople(current) {
  const shifts = current.filter(s => s.kind === 'shift');
  const people = [...new Set(shifts.map(s => s.person).filter(Boolean))];
  if (people.length <= 1) return people;
  const swaps = [...new Set(shifts.filter(s => s.oneOff).map(s => s.person).filter(Boolean))];
  return swaps.length === 1 ? swaps : people;
}

async function readOnCall({ url = process.env.ONCALL_CALENDAR_ICS_URL, now = new Date(), days = 7, load = u => ical.async.fromURL(u) } = {}) {
  if (!url) return { connected: false };
  const data = await load(url);
  const all = overlay(shiftsBetween(data, now, new Date(now.getTime() + days * 864e5)), now.getTime());
  const active = all.filter(s => s.start <= now && s.end > now);
  const current = active.filter(s => s.kind === 'shift');
  const special = active.filter(s => s.kind === 'holiday' || s.kind === 'dayoff');
  return {
    connected: true, current, special, people: onCallPeople(current),
    upcoming: all.filter(s => s.start > now && s.kind === 'shift'),
    upcomingSpecial: all.filter(s => s.start > now && (s.kind === 'holiday' || s.kind === 'dayoff' || (s.kind === 'shift' && s.oneOff))),
    unknown: active.filter(s => s.kind === 'other'),
  };
}

module.exports = { readOnCall, shiftsBetween, personFromTitle, kindOf, onCallPeople, noteAdded, noteRemoved, PEOPLE, COVER, fromWall, wall, _recent: recent };
