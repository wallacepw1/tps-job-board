// Builds the job list by joining TPS Jobs calendar events with #incoming-calls threads.
const ical = require('node-ical');
const { parseIntake, parseReplies, statusOf } = require('./parse');

const TZ = process.env.TZ_NAME || 'America/Los_Angeles';
const CHANNEL_ID = process.env.INCOMING_CHANNEL_ID || 'C0C19TG3KJ6';
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 21);
const LOOKAHEAD_DAYS = Number(process.env.LOOKAHEAD_DAYS || 14);

// Reads the calendar through its private iCal address (Google Calendar > Settings > Integrate calendar),
// and maps each entry to the same shape the Google Calendar API uses.
async function fetchEvents() {
  const data = await ical.async.fromURL(process.env.CALENDAR_ICS_URL);
  const from = Date.now() - LOOKBACK_DAYS * 864e5;
  const to = Date.now() + LOOKAHEAD_DAYS * 864e5;
  const events = [];
  for (const ev of Object.values(data)) {
    if (ev.type !== 'VEVENT' || !ev.start) continue;
    const start = new Date(ev.start);
    if (start < from || start > to) continue;
    const allDay = ev.datetype === 'date';
    events.push({
      id: ev.uid,
      summary: textOf(ev.summary),
      description: textOf(ev.description),
      location: textOf(ev.location) || null,
      status: String(ev.status || 'CONFIRMED').toLowerCase(),
      created: ev.created ? new Date(ev.created).toISOString() : null,
      start: allDay ? { date: dayKey(start) } : { dateTime: start.toISOString() },
      htmlLink: null,
    });
  }
  return events;
}

function textOf(v) {
  return typeof v === 'object' && v ? v.val : v || '';
}

// An event the intake automation dropped at the moment the call came in, rather than a real appointment.
function isIntakePlaceholder(ev) {
  if (!ev.start?.dateTime || !ev.created) return false;
  return Math.abs(new Date(ev.start.dateTime) - new Date(ev.created)) < 5 * 60e3;
}

class JobStore {
  constructor(slackClient) {
    this.slack = slackClient;
    this.jobs = [];
    this.threadCache = new Map(); // ts -> { latestReply, state }
    this.updatedAt = null;
  }

  async refresh() {
    const [events, posts] = await Promise.all([fetchEvents(), this.fetchPosts()]);

    const byNumber = new Map();
    for (const post of posts) {
      const intake = parseIntake(post.text);
      if (!intake.jobNumber) continue;
      const state = await this.threadState(post);
      byNumber.set(intake.jobNumber, {
        ...intake,
        ...state,
        threadTs: post.ts,
        postedAt: new Date(Number(post.ts) * 1000),
      });
    }

    for (const ev of events) {
      if (ev.status === 'cancelled') continue;
      const num = (ev.summary || '').match(/\b(\d{5,7})\b/)?.[1];
      if (!num) continue;
      const job = byNumber.get(num) || { ...parseIntake(ev.description || ''), jobNumber: num };
      // Several events can share a job number; prefer a real appointment over an intake placeholder.
      if (job.event && !isIntakePlaceholder(job.event) && isIntakePlaceholder(ev)) continue;
      job.event = ev;
      byNumber.set(num, job);
    }

    this.jobs = [...byNumber.values()].map(finalize).sort((a, b) => (a.when || Infinity) - (b.when || Infinity));
    this.updatedAt = new Date();
    return this.jobs;
  }

  async fetchPosts() {
    const oldest = String(Date.now() / 1000 - LOOKBACK_DAYS * 86400);
    const posts = [];
    let cursor;
    do {
      const res = await this.slack.conversations.history({ channel: CHANNEL_ID, oldest, limit: 200, cursor });
      posts.push(...res.messages.filter((m) => m.bot_id && /^\s*\d{5,7}\s*\n/.test(m.text || '')));
      cursor = res.response_metadata?.next_cursor;
    } while (cursor);
    return posts;
  }

  // Thread replies are only re-read when the thread has new activity.
  async threadState(post) {
    if (!post.reply_count) return parseReplies([]);
    const cached = this.threadCache.get(post.ts);
    if (cached && cached.latestReply === post.latest_reply) return cached.state;
    const res = await this.slack.conversations.replies({ channel: CHANNEL_ID, ts: post.ts, limit: 200 });
    const state = parseReplies((res.messages || []).slice(1));
    this.threadCache.set(post.ts, { latestReply: post.latest_reply, state });
    return state;
  }

  find(number) {
    return this.jobs.find((j) => j.jobNumber === String(number));
  }

  techs() {
    return [...new Set(this.jobs.map((j) => j.tech).filter(Boolean))].sort();
  }
}

function finalize(job) {
  const ev = job.event;
  const realAppointment = ev && !isIntakePlaceholder(ev);
  let when = null;
  let allDay = false;
  if (job.scheduledFor) {
    when = zonedDate(job.scheduledFor.date, job.scheduledFor.time);
  } else if (realAppointment) {
    allDay = !ev.start.dateTime;
    when = new Date(ev.start.dateTime || `${ev.start.date}T08:00:00`);
  }
  const calendarDay = realAppointment ? dayKey(new Date(ev.start.dateTime || ev.start.date)) : null;
  const mismatch = job.scheduledFor && calendarDay && calendarDay !== job.scheduledFor.date;
  const status = statusOf({ ...job, scheduledFor: job.scheduledFor || (realAppointment ? true : null) });
  return {
    ...job,
    when,
    allDay,
    status,
    mismatch: Boolean(mismatch),
    calendarLink: ev?.htmlLink || null,
    location: job.address || ev?.location || null,
  };
}

function dayKey(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// "2026-10-23", "09:00" in TZ -> Date
function zonedDate(date, time) {
  const guess = new Date(`${date}T${time.padStart(5, '0')}:00Z`);
  const local = new Date(guess.toLocaleString('en-US', { timeZone: TZ }));
  return new Date(guess.getTime() + (guess - local));
}

module.exports = { JobStore, dayKey, isIntakePlaceholder, zonedDate, TZ };
