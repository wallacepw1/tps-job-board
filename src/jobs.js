// Builds the job list by joining TPS Jobs calendar events with #incoming-calls threads.
const ical = require('node-ical');
const { parseIntake, parseReplies, statusOf, messageText } = require('./parse');
const { fetchCallsList } = require('./calls-list');

const TZ = process.env.TZ_NAME || 'America/Los_Angeles';
const CHANNEL_ID = process.env.INCOMING_CHANNEL_ID || 'C0C19TG3KJ6';
const FUTURE_CHANNEL_ID = process.env.FUTURE_CHANNEL_ID || 'C0C2XB4VD1N';
const FUTURE_LOOKBACK_DAYS = Number(process.env.FUTURE_LOOKBACK_DAYS || 60);
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
    const [events, posts, future, calls] = await Promise.all([
      fetchEvents(), this.fetchPosts(), this.fetchFutureCalls(), this.fetchCalls(),
    ]);

    const byNumber = new Map();
    for (const post of posts) {
      const intake = parseIntake(post.text);
      intake.jobNumber = intake.jobNumber || jobNumberIn(post.text);
      if (!intake.jobNumber || byNumber.has(intake.jobNumber)) continue; // newest post wins
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
      // Several events can share a job number; prefer a real appointment over an intake placeholder,
      // and among real appointments the latest one (a return visit or a move).
      if (job.event && !preferEvent(ev, job.event)) continue;
      job.event = ev;
      byNumber.set(num, job);
    }

    // #future-calls is the source of truth for a rescheduled job's day and time.
    for (const [num, f] of future) {
      const job = byNumber.get(num) || { ...f.intake, jobNumber: num, threadTs: f.threadTs };
      job.scheduledFor = f.scheduledFor;
      job.futureTs = f.futureTs;
      byNumber.set(num, job);
    }

    // The Calls list says who is assigned and whether the job is completed.
    for (const [num, row] of calls) {
      const job = byNumber.get(num);
      if (!job) continue; // only jobs that are on the calendar or in #incoming-calls
      if (row.assigneeId) job.tech = await this.userName(row.assigneeId);
      if (row.completed) job.completed = true;
      job.assignedMessageUrl = row.assignedMessageUrl;
      job.workDone = row.workDone;
    }

    this.jobs = [...byNumber.values()].map(finalize).sort((a, b) => (a.when || Infinity) - (b.when || Infinity));
    this.updatedAt = new Date();
    this.stats = {
      updatedAt: this.updatedAt,
      calendarEvents: events.length,
      incomingPosts: posts.length,
      futureCalls: future.size,
      futureError: this.futureError || null,
      callsListRows: calls.size,
      callsListError: this.callsError || null,
      jobs: this.jobs.length,
      withThread: this.jobs.filter((j) => j.threadTs).length,
      withTech: this.jobs.filter((j) => j.tech).length,
      done: this.jobs.filter((j) => j.status === 'done').length,
    };
    console.log('refreshed', JSON.stringify(this.stats));
    return this.jobs;
  }

  async fetchPosts() {
    const oldest = String(Date.now() / 1000 - LOOKBACK_DAYS * 86400);
    const posts = [];
    let cursor;
    do {
      const res = await this.slack.conversations.history({ channel: CHANNEL_ID, oldest, limit: 200, cursor });
      // Latenode posts can carry their content in blocks or attachments rather than `text`.
      for (const m of res.messages) {
        const text = messageText(m);
        if (jobNumberIn(text)) posts.push({ ...m, text });
      }
      cursor = res.response_metadata?.next_cursor;
    } while (cursor);
    return posts;
  }

  // Latest #future-calls post per job: job # -> { scheduledFor, intake, threadTs }.
  async fetchFutureCalls() {
    const found = new Map();
    this.futureError = null;
    const oldest = String(Date.now() / 1000 - FUTURE_LOOKBACK_DAYS * 86400);
    let cursor;
    try {
      do {
        const res = await this.slack.conversations.history({ channel: FUTURE_CHANNEL_ID, oldest, limit: 200, cursor });
        for (const m of res.messages) {
          const msg = { ...m, text: messageText(m) };
          if (!found.has(jobNumberIn(msg.text))) addFuture(found, msg);
        }
        cursor = res.response_metadata?.next_cursor;
      } while (cursor);
    } catch (e) {
      this.futureError = e.data?.error || e.message;
      console.error('could not read #future-calls (is the bot invited?)', this.futureError);
    }
    return found;
  }

  async fetchCalls() {
    this.callsError = null;
    try {
      return await fetchCallsList(this.slack);
    } catch (e) {
      this.callsError = e.data?.error || e.message;
      console.error('could not read the Calls list', this.callsError);
      return new Map();
    }
  }

  async userName(id) {
    this.names = this.names || new Map();
    if (!this.names.has(id)) {
      try {
        const { user } = await this.slack.users.info({ user: id });
        this.names.set(id, user.profile?.display_name || user.real_name || user.name);
      } catch {
        this.names.set(id, null);
      }
    }
    return this.names.get(id);
  }

  // Thread replies are only re-read when the thread has new activity.
  async threadState(post) {
    if (!post.reply_count) return parseReplies([]);
    const cached = this.threadCache.get(post.ts);
    if (cached && cached.latestReply === post.latest_reply) return cached.state;
    const res = await this.slack.conversations.replies({ channel: CHANNEL_ID, ts: post.ts, limit: 200 });
    const state = parseReplies((res.messages || []).slice(1).map((m) => ({ ts: m.ts, text: messageText(m) })));
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

function preferEvent(ev, current) {
  const evReal = !isIntakePlaceholder(ev);
  const curReal = !isIntakePlaceholder(current);
  if (evReal !== curReal) return evReal;
  const start = (e) => new Date(e.start.dateTime || e.start.date);
  return start(ev) > start(current);
}

function jobNumberIn(text) {
  return (text || '').match(/^\s*(\d{5,7})\s*$/m)?.[1] || null;
}

function addFuture(found, msg) {
  const num = jobNumberIn(msg.text);
  const { scheduledFor } = parseReplies([{ text: msg.text, ts: msg.ts }]);
  if (!num || !scheduledFor) return;
  const intake = parseIntake(msg.text);
  // Future-calls posts can lead with the client name instead of the job number.
  if (!intake.jobNumber) intake.client = msg.text.trim().split('\n')[0].trim();
  const threadTs = msg.text.match(/^\s*(\d{10}\.\d{6})\s*$/m)?.[1] || null;
  found.set(num, { scheduledFor, intake, threadTs, futureTs: msg.ts });
}

// New calls are treated as work for the day they came in, and their clock time is not meaningful.
// Only a reschedule (or a calendar event someone moved) gives a time worth showing.
function finalize(job) {
  const ev = job.event;
  const realAppointment = ev && !isIntakePlaceholder(ev);
  let when = null;
  let timed = false;
  if (job.scheduledFor) {
    when = zonedDate(job.scheduledFor.date, job.scheduledFor.time);
    timed = true;
  } else if (realAppointment) {
    timed = Boolean(ev.start.dateTime);
    when = new Date(ev.start.dateTime || `${ev.start.date}T08:00:00`);
  } else {
    when = job.postedAt || (ev && new Date(ev.start.dateTime || ev.start.date)) || null;
  }
  const calendarDay = realAppointment ? dayKey(new Date(ev.start.dateTime || ev.start.date)) : null;
  const mismatch = job.scheduledFor && calendarDay && calendarDay !== job.scheduledFor.date;
  const status = statusOf({ ...job, scheduledFor: timed || null });
  return {
    ...job,
    when,
    timed,
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

module.exports = { JobStore, addFuture, preferEvent, jobNumberIn, dayKey, isIntakePlaceholder, zonedDate, TZ };
