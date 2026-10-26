// Block Kit layouts for the Home tab, the /jobs modal and single-job details.
const { dayKey, TZ } = require('./jobs');

const STATUS = {
  new: { emoji: '🆕', label: 'New' },
  assigned: { emoji: '👷', label: 'Assigned' },
  scheduled: { emoji: '📅', label: 'Scheduled' },
  done: { emoji: '✅', label: 'Done' },
};

const TABS = [
  { id: 'mine', label: 'My jobs' },
  { id: 'today', label: 'Today' },
  { id: 'tomorrow', label: 'Tomorrow' },
  { id: 'week', label: 'This week' },
  { id: 'open', label: 'All open' },
  { id: 'recent', label: 'Done (7 days)' },
];

const MAX_JOBS = 28; // Slack allows 100 blocks per view; each job uses 3, plus headers.

function workspaceUrl() {
  return process.env.SLACK_WORKSPACE_URL || 'https://tpsplumbing.slack.com';
}

function threadUrl(job) {
  const channel = process.env.INCOMING_CHANNEL_ID || 'C0C19TG3KJ6';
  return job.threadTs ? `${workspaceUrl()}/archives/${channel}/p${job.threadTs.replace('.', '')}` : null;
}

function futureUrl(job) {
  const channel = process.env.FUTURE_CHANNEL_ID || 'C0C2XB4VD1N';
  return job.futureTs ? `${workspaceUrl()}/archives/${channel}/p${job.futureTs.replace('.', '')}` : null;
}

function mapsUrl(job) {
  return job.location ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(job.location)}` : null;
}

function fmtTime(job, now = new Date()) {
  if (!job.when) return 'No date';
  const day = (d) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  const clock = (d) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(d);
  const isToday = dayKey(job.when) === dayKey(now);
  if (job.timed) return isToday ? clock(job.when) : `${day(job.when)} ${clock(job.when)}`;
  return isToday ? `Came in ${clock(job.when)}` : `Open since ${day(job.when)}`;
}

const CARRY_DAYS = Number(process.env.CARRY_OVER_DAYS || 7);

// A done job only belongs to the day it was finished (the "Call completed" reply's time). A job finished
// early, or ticked Completed with no reply, drops off its booked day instead of showing as today's work.
function doneOn(job, day) {
  return job.status === 'done' && Boolean(job.completedAt) && dayKey(job.completedAt) === day;
}

// A call from the last few days that was never completed shows under All open. Only calls with an
// #incoming-calls thread qualify, since otherwise nothing could ever mark them done.
function carriedOver(job, today) {
  if (job.status === 'done' || !job.when || !job.threadTs) return false;
  const day = dayKey(job.when);
  return day < today && Date.now() - job.when < CARRY_DAYS * 864e5;
}

function filterJobs(jobs, { tab = 'today', tech = 'all', user = null }, now = new Date()) {
  const today = dayKey(now);
  const tomorrow = dayKey(new Date(now.getTime() + 864e5));
  const weekEnd = dayKey(new Date(now.getTime() + 7 * 864e5));
  const weekAgo = now.getTime() - 7 * 864e5;
  let list = jobs.filter((j) => {
    const day = j.when ? dayKey(j.when) : null;
    switch (tab) {
      // The viewer's own jobs: everything still open, plus what they finished today.
      case 'mine': return j.techId === user && (j.status !== 'done' || doneOn(j, today));
      // Today: open jobs for today, then the ones finished today (shown apart, under "Done today").
      case 'today': return j.status === 'done' ? doneOn(j, today) : day === today;
      case 'tomorrow': return day === tomorrow && j.status !== 'done';
      case 'week': return day && day >= today && day <= weekEnd && j.status !== 'done';
      case 'open': return j.status !== 'done' && (day >= today || carriedOver(j, today) || Boolean(j.needsDate));
      case 'recent': return j.status === 'done' && (j.completedAt || j.when || j.postedAt || 0) >= weekAgo;
      default: return true;
    }
  });
  if (tab === 'mine') {
    // Open work first (booked times in order, then the rest oldest first), today's finished jobs last.
    const rank = (j) => (j.status === 'done' ? 2 : j.timed ? 0 : 1);
    list.sort((a, b) => rank(a) - rank(b) || (a.when || 0) - (b.when || 0));
    return list;
  }
  if (tech === 'unassigned') list = list.filter((j) => !j.tech);
  else if (tech !== 'all') list = list.filter((j) => j.tech === tech);
  if (tab === 'today') {
    // Booked times in time order, then today's new calls, then what was finished today.
    const rank = (j) => (j.status === 'done' ? 2 : j.timed ? 0 : 1);
    list.sort((a, b) => rank(a) - rank(b) || (a.when || 0) - (b.when || 0));
  }
  if (tab === 'recent') list.sort((a, b) => (b.completedAt || b.when || 0) - (a.completedAt || a.when || 0));
  return list;
}

function jobBlocks(job) {
  const st = STATUS[job.status];
  const title = [`*${job.jobNumber}*`, job.emergency ? '🚨' : null, job.client ? `· ${job.client}` : null]
    .filter(Boolean).join(' ');
  const lines = [
    `${title}`,
    job.location ? `📍 ${job.location}` : null,
    job.issue ? `🔧 ${truncate(job.issue, 140)}` : null,
  ].filter(Boolean);

  const buttons = [
    threadUrl(job) && button('Thread', threadUrl(job), `thread_${job.jobNumber}`),
    // Waiting in #future-calls until a tech is picked; then the tech's channel message takes over.
    job.assignedMessageUrl
      ? button('Tech chat', job.assignedMessageUrl, `techmsg_${job.jobNumber}`)
      : futureUrl(job) && button('Future calls', futureUrl(job), `future_${job.jobNumber}`),
    job.filesUrl && button('Files', job.filesUrl, `files_${job.jobNumber}`),
    mapsUrl(job) && button('Map', mapsUrl(job), `map_${job.jobNumber}`),
    job.calendarLink && button('Calendar', job.calendarLink, `cal_${job.jobNumber}`),
    // Posts photos and notes into the call's thread in the tech's channel.
    job.assignedMessageUrl && job.status !== 'done' && {
      type: 'button', text: { type: 'plain_text', text: '📸 Add photos/notes' }, action_id: `addnote_${job.jobNumber}`, value: job.jobNumber,
    },
  ].filter(Boolean);

  const meta = [
    `${st.emoji} *${st.label}*`,
    `🕘 ${fmtTime(job)}`,
    `👷 ${job.tech || '_Unassigned_'}`,
    job.workOrder ? `WO ${job.workOrder}` : null,
    job.mismatch ? '⚠️ Slack and calendar dates differ' : null,
  ].filter(Boolean);

  return [
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: meta.join('   ') }] },
    buttons.length ? { type: 'actions', elements: buttons } : { type: 'divider' },
  ];
}

function button(text, url, action_id) {
  return { type: 'button', text: { type: 'plain_text', text }, url, action_id };
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function summary(jobs, now = new Date()) {
  const todays = filterJobs(jobs, { tab: 'today', tech: 'all' }, now);
  const open = todays.filter((j) => j.status !== 'done');
  const done = todays.length - open.length;
  const unassigned = open.filter((j) => !j.tech).length;
  return `*Today:* ${open.length} to do  ·  👷 ${unassigned} unassigned  ·  ✅ ${done} done`;
}

function boardBlocks(store, filters) {
  const jobs = filterJobs(store.jobs, filters);
  const tabButtons = TABS.map((t) => ({
    type: 'button',
    text: { type: 'plain_text', text: t.label },
    action_id: `tab_${t.id}`,
    value: t.id,
    ...(t.id === filters.tab ? { style: 'primary' } : {}),
  }));
  const techOptions = [
    { text: { type: 'plain_text', text: 'All techs' }, value: 'all' },
    { text: { type: 'plain_text', text: 'Unassigned' }, value: 'unassigned' },
    ...store.techs().map((t) => ({ text: { type: 'plain_text', text: t }, value: t })),
  ];
  const selected = techOptions.find((o) => o.value === filters.tech) || techOptions[0];

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: '🔧 TPS Job Board' } },
    { type: 'section', text: { type: 'mrkdwn', text: summary(store.jobs) } },
    { type: 'actions', block_id: 'tabs', elements: tabButtons },
    {
      type: 'actions',
      block_id: 'filters',
      elements: [
        { type: 'static_select', action_id: 'tech_filter', options: techOptions, initial_option: selected },
        { type: 'button', action_id: 'refresh', text: { type: 'plain_text', text: '🔄 Refresh' } },
      ],
    },
    { type: 'divider' },
  ];

  if (!jobs.length) {
    const empty = filters.tab === 'mine' ? '_No jobs assigned to you right now._' : '_No jobs here._';
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: empty } });
  }
  const today = dayKey(new Date());
  let lastGroup = null;
  for (const job of jobs.slice(0, MAX_JOBS)) {
    if (filters.tab === 'today') {
      const group = job.status === 'done' ? '✅ Done today' : job.timed ? '📅 Booked times' : '🆕 Today\'s calls';
      if (group !== lastGroup) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${group}*` } });
      lastGroup = group;
    }
    blocks.push(...jobBlocks(job));
  }
  if (jobs.length > MAX_JOBS) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `…and ${jobs.length - MAX_JOBS} more. Filter by tech to narrow the list.` }] });
  }
  const updated = store.updatedAt
    ? new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(store.updatedAt)
    : 'never';
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Updated ${updated} · from the TPS Jobs calendar and #incoming-calls · \`/jobs 132174\` to look up a job` }] });
  return blocks;
}

// Pop-up for a tech to send photos and notes to the call's thread in their channel.
function noteModal(job) {
  return {
    type: 'modal',
    callback_id: 'job_note',
    private_metadata: JSON.stringify({ jobNumber: job.jobNumber, url: job.assignedMessageUrl }),
    title: { type: 'plain_text', text: `Job ${job.jobNumber}` },
    submit: { type: 'plain_text', text: 'Send' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: [`*${job.jobNumber}*${job.client ? ` · ${job.client}` : ''}`, job.location ? `📍 ${job.location}` : null].filter(Boolean).join('\n') } },
      {
        type: 'input', block_id: 'photos', optional: true, label: { type: 'plain_text', text: 'Photos or videos' },
        element: { type: 'file_input', action_id: 'files', max_files: 10, filetypes: ['jpg', 'jpeg', 'png', 'heic', 'gif', 'mp4', 'mov', 'pdf'] },
      },
      {
        type: 'input', block_id: 'notes', optional: true, label: { type: 'plain_text', text: 'Notes' },
        element: { type: 'plain_text_input', action_id: 'text', multiline: true, placeholder: { type: 'plain_text', text: 'What you found, what you did, parts used…' } },
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Goes into this call\'s thread in your channel.' }] },
    ],
  };
}

function messageModal(title, text) {
  return {
    type: 'modal',
    title: { type: 'plain_text', text: title },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  };
}

function homeView(store, filters) {
  return { type: 'home', private_metadata: JSON.stringify(filters), blocks: boardBlocks(store, filters) };
}

function modalView(store, filters) {
  return {
    type: 'modal',
    callback_id: 'job_board_modal',
    private_metadata: JSON.stringify(filters),
    title: { type: 'plain_text', text: 'TPS Job Board' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: boardBlocks(store, filters),
  };
}

function jobModal(job) {
  return {
    type: 'modal',
    title: { type: 'plain_text', text: `Job ${job.jobNumber}` },
    close: { type: 'plain_text', text: 'Close' },
    blocks: jobBlocks(job),
  };
}

module.exports = { homeView, modalView, jobModal, noteModal, messageModal, filterJobs, jobBlocks, TABS };
