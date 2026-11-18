'use strict';
// Adds and removes events on the Google "On call" calendar for the /phone pop-up's Swap, Holiday and Day off buttons.
// Render can only read the calendar's iCal feed, so writes go through a small Google Apps Script web app that Paul
// owns (docs/oncall-calendar-script.gs). It runs as Paul and only touches the On call calendar.
// Env: ONCALL_CALENDAR_SCRIPT_URL (the web app URL) and ONCALL_CALENDAR_SCRIPT_KEY (a password Paul picks, also saved in the script).
const { fromWall, noteAdded, noteRemoved, kindOf, personFromTitle } = require('./oncall-calendar');

const TZ = process.env.TZ_NAME || 'America/Los_Angeles';
const SHIFT_HOUR = 8; // shifts change at 8 AM, when the office opens

function writerReady(env = process.env) { return !!(env.ONCALL_CALENDAR_SCRIPT_URL && env.ONCALL_CALENDAR_SCRIPT_KEY); }

const parseDay = d => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };
const fmtDay = ms => new Date(ms).toISOString().slice(0, 10);

// The calendar event a form asks for. from/to are YYYY-MM-DD (to is inclusive, optional).
function eventFor({ kind, person, cover, from, to, by }) {
  const a = parseDay(from), b = to ? parseDay(to) : a;
  if (Number.isNaN(a) || Number.isNaN(b)) return { error: 'Pick a date.' };
  if (b < a) return { error: 'The last day is before the first day.' };
  if ((b - a) / 864e5 > 30) return { error: 'Keep it to 31 days or less.' };
  const description = `Added from TPS Assistant /phone${by ? ` by ${by}` : ''}. Remove it from the Phone settings pop-up or here.`;
  if (kind === 'swap') {
    if (!person) return { error: 'Pick who is on call.' };
    const start = fromWall(a + SHIFT_HOUR * 3600e3, TZ), end = fromWall(b + 864e5 + SHIFT_HOUR * 3600e3, TZ);
    return { title: `${person} On Call (swap)`, allDay: false, start: start.toISOString(), end: end.toISOString(), description, startAt: start, endAt: end };
  }
  const startDate = fmtDay(a), endDate = fmtDay(b + 864e5); // all-day, end date exclusive
  const startAt = fromWall(a, TZ), endAt = fromWall(b + 864e5, TZ);
  if (kind === 'holiday') return { title: 'Holiday: office to on call', allDay: true, startDate, endDate, description, startAt, endAt };
  if (kind === 'dayoff') {
    if (!['Edgar', 'Thayned'].includes(cover)) return { error: 'Pick Edgar or Thayned.' };
    return { title: `Paul off: ${cover} answers`, allDay: true, startDate, endDate, description, startAt, endAt };
  }
  return { error: 'Unknown change.' };
}

async function callScript(body, { env = process.env, fetch: fetcher = global.fetch } = {}) {
  if (!writerReady(env)) throw new Error('calendar writing is not set up yet');
  const res = await fetcher(env.ONCALL_CALENDAR_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: env.ONCALL_CALENDAR_SCRIPT_KEY, ...body }), redirect: 'follow', signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let out;
  try { out = JSON.parse(text); } catch { throw new Error(`the calendar script answered HTTP ${res.status} without JSON (check that it is deployed with access “Anyone”)`); }
  if (!out.ok) throw new Error(`the calendar script said: ${out.error || 'failed'}`);
  return out;
}

// Creates the event and shows it to the sync straight away (the iCal feed can lag).
async function addEvent(ev, opts = {}) {
  const out = await callScript({ action: 'create', title: ev.title, allDay: ev.allDay, start: ev.start, end: ev.end, startDate: ev.startDate, endDate: ev.endDate, description: ev.description }, opts);
  const k = kindOf(ev.title);
  noteAdded({ id: out.id, title: ev.title, ...k, person: k.kind === 'shift' ? personFromTitle(ev.title) : null, start: ev.startAt, end: ev.endAt, oneOff: true, tool: true });
  return out.id;
}
async function removeEvent(id, opts = {}) {
  await callScript({ action: 'delete', id }, opts);
  noteRemoved(id);
}

module.exports = { writerReady, eventFor, addEvent, removeEvent, callScript };
