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
    const start = new Date(ev.start), end = new Date(ev.end || ev.start);
    const add = (s, e, src) => { if (e > from && s < to && String(src.status || '').toUpperCase() !== 'CANCELLED') out.push({ title: String(src.summary || '').trim(), person: personFromTitle(src.summary), start: s, end: e, id: src.uid }); };
    if (!ev.rrule) { if (!ev.recurrenceid) add(start, end, ev); continue; }
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
      add(s, e, ev);
    }
    for (const r of Object.values(moved)) add(new Date(r.start), new Date(r.end || r.start), r);
  }
  return out.sort((a, b) => a.start - b.start);
}

async function readOnCall({ url = process.env.ONCALL_CALENDAR_ICS_URL, now = new Date(), days = 7, load = u => ical.async.fromURL(u) } = {}) {
  if (!url) return { connected: false };
  const data = await load(url);
  const shifts = shiftsBetween(data, now, new Date(now.getTime() + days * 864e5));
  const current = shifts.filter(s => s.start <= now && s.end > now);
  return { connected: true, current, upcoming: shifts.filter(s => s.start > now) };
}

// What the feed itself says about each on-call series, for checking times (/phone check).
async function describeFeed({ url = process.env.ONCALL_CALENDAR_ICS_URL, load = u => ical.async.fromURL(u) } = {}) {
  if (!url) return ['ONCALL_CALENDAR_ICS_URL is not set.'];
  const data = await load(url);
  const lines = [];
  const cal = Object.values(data).find(x => x.type === 'VCALENDAR');
  if (cal) lines.push(`Calendar tz: ${cal['WR-TIMEZONE'] || cal['X-WR-TIMEZONE'] || '?'}`);
  lines.push('Zones in feed: ' + (Object.values(data).filter(x => x.type === 'VTIMEZONE').map(x => x.tzid).join(', ') || 'none'));
  for (const ev of Object.values(data)) {
    if (ev.type !== 'VEVENT' || !ev.rrule) continue;
    const until = ev.rrule.options?.until;
    if (until && until < new Date()) continue;
    lines.push(`${String(ev.summary || '').trim()} | start ${new Date(ev.start).toISOString()} tz=${ev.start.tz || '-'} | end ${new Date(ev.end).toISOString()} | ${String(ev.rrule.toString()).replace(/\n/g, ' ')} | overrides ${Object.keys(ev.recurrences || {}).length}`);
  }
  return lines;
}

module.exports = { describeFeed, readOnCall, shiftsBetween, personFromTitle, PEOPLE, fromWall, wall };
