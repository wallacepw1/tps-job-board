// Block Kit layouts for the Home tab, the /jobs modal and single-job details.
const { dayKey, TZ } = require('./jobs');

const STATUS = {
  new: { emoji: '🆕', label: 'New' },
  assigned: { emoji: '👷', label: 'Assigned' },
  scheduled: { emoji: '📅', label: 'Scheduled' },
  done: { emoji: '✅', label: 'Done' },
};

const TABS = [
  { id: 'today', label: 'Today' },
  { id: 'tomorrow', label: 'Tomorrow' },
  { id: 'week', label: 'This week' },
  { id: 'unscheduled', label: 'Needs scheduling' },
  { id: 'recent', label: 'Done (7 days)' },
];

const MAX_JOBS = 30; // Slack allows 100 blocks per view; each job uses 3.

function workspaceUrl() {
  return process.env.SLACK_WORKSPACE_URL || 'https://tpsplumbing.slack.com';
}

function threadUrl(job) {
  const channel = process.env.INCOMING_CHANNEL_ID || 'C0C19TG3KJ6';
  return job.threadTs ? `${workspaceUrl()}/archives/${channel}/p${job.threadTs.replace('.', '')}` : null;
}

function mapsUrl(job) {
  return job.location ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(job.location)}` : null;
}

function fmtTime(job) {
  if (!job.when) return 'Not scheduled';
  const opts = { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' };
  if (!job.allDay) Object.assign(opts, { hour: 'numeric', minute: '2-digit' });
  return new Intl.DateTimeFormat('en-US', opts).format(job.when);
}

function filterJobs(jobs, { tab = 'today', tech = 'all' }, now = new Date()) {
  const today = dayKey(now);
  const tomorrow = dayKey(new Date(now.getTime() + 864e5));
  const weekEnd = dayKey(new Date(now.getTime() + 7 * 864e5));
  const weekAgo = now.getTime() - 7 * 864e5;
  let list = jobs.filter((j) => {
    const day = j.when ? dayKey(j.when) : null;
    switch (tab) {
      case 'today': return day === today;
      case 'tomorrow': return day === tomorrow;
      case 'week': return day && day >= today && day <= weekEnd && j.status !== 'done';
      case 'unscheduled': return !j.when && j.status !== 'done';
      case 'recent': return j.status === 'done' && (j.when || j.postedAt || 0) >= weekAgo;
      default: return true;
    }
  });
  if (tech === 'unassigned') list = list.filter((j) => !j.tech);
  else if (tech !== 'all') list = list.filter((j) => j.tech === tech);
  if (tab === 'unscheduled' || tab === 'recent') list.sort((a, b) => (b.postedAt || 0) - (a.postedAt || 0));
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
    job.filesUrl && button('Files', job.filesUrl, `files_${job.jobNumber}`),
    mapsUrl(job) && button('Map', mapsUrl(job), `map_${job.jobNumber}`),
    job.calendarLink && button('Calendar', job.calendarLink, `cal_${job.jobNumber}`),
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
  const today = dayKey(now);
  const todays = jobs.filter((j) => j.when && dayKey(j.when) === today);
  const count = (s) => todays.filter((j) => j.status === s).length;
  const backlog = jobs.filter((j) => !j.when && j.status !== 'done').length;
  return `*Today:* ${todays.length} jobs  ·  📅 ${count('scheduled') + count('assigned')} to go  ·  ✅ ${count('done')} done  ·  🗂️ ${backlog} need scheduling`;
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
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_No jobs here._' } });
  }
  for (const job of jobs.slice(0, MAX_JOBS)) blocks.push(...jobBlocks(job));
  if (jobs.length > MAX_JOBS) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `…and ${jobs.length - MAX_JOBS} more. Filter by tech to narrow the list.` }] });
  }
  const updated = store.updatedAt
    ? new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(store.updatedAt)
    : 'never';
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Updated ${updated} · from the TPS Jobs calendar and #incoming-calls · \`/jobs 132174\` to look up a job` }] });
  return blocks;
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

module.exports = { homeView, modalView, jobModal, filterJobs, jobBlocks, TABS };
