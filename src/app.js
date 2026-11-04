// TPS Job Board: Slack Home, /jobs, notes and authenticated admin assignment requests.
const { App, ExpressReceiver } = require('@slack/bolt');
const { JobStore } = require('./jobs');
const { homeView, modalView, jobModal, noteModal, messageModal, findModal, TABS } = require('./views');

const { registerAssignmentHandlers } = require('./assignment');
const { registerCallActionsProxy } = require('./call-actions-proxy');
const { registerAssistantEventsProxy } = require('./assistant-events-proxy');
const { registerJobFilesGallery, postJobFilesCard } = require('./job-files');
const { registerHelperEvents } = require('./helper-events');
const { registerRundownRefresh } = require('./rundown-refresh');
const { summaryHome, registerSummarySurface } = require('./jobs-summary-surface');
const {TECHS}=require('./assignment-policy');
const {registerDescriptionHandlers}=require('./board-description');
const {boardRole,canViewJob,canAddNotes,scopedFilters}=require('./board-scope');

const REFRESH_MS = Number(process.env.REFRESH_SECONDS || 120) * 1000;

const receiver = new ExpressReceiver({ signingSecret: process.env.SLACK_SIGNING_SECRET });
// The store is created below; the job files panel only reads it when a card is clicked.
registerCallActionsProxy(receiver, { get store() { return store; } });
registerJobFilesGallery(receiver);
registerAssistantEventsProxy(receiver);
receiver.router.get('/healthz', (_req, res) => res.send('ok'));
receiver.router.get('/slack/jobs-summary/health', (_req, res) => res.json({ready:!!process.env.TPS_INTERNAL_KEY,version:5}));
receiver.router.get('/status', (_req, res) => res.json(store.stats || { status: 'not refreshed yet' }));

const app = new App({ token: process.env.SLACK_BOT_TOKEN, receiver });
const store = new JobStore(app.client);
const userFilters = new Map(); // userId -> { tab, tech }
const homeViewers=new Map();

// Techs open on their own jobs; everyone else on Today.
function filtersFor(user) {
  return scopedFilters({...((userFilters.get(user))||{tab:boardRole(user)==='plumber'?'mine':'today',tech:'all'}),user});
}

let refreshing = null;
let refreshAgain=false;
function refresh() {
  if(refreshing){refreshAgain=true;return refreshing;}
  refreshing = store.refresh().then(async()=>{store.refreshError=null;await Promise.allSettled([...homeViewers].filter(([,at])=>Date.now()-at<864e5).map(([user])=>publishHome(app.client,user)));}).catch((e) => {store.refreshError=e.message;console.error('refresh failed', e);}).finally(() => { refreshing = null;if(refreshAgain){refreshAgain=false;refresh();} });
  return refreshing;
}

async function ready() {
  if (!store.updatedAt) await refresh();
  else if (Date.now() - store.updatedAt > REFRESH_MS) await refresh();
}

async function publishHome(client, user) {
  await client.views.publish({ user_id: user, view: summaryHome(homeView(store, filtersFor(user)), user) });
}

// Re-render wherever the click came from: the Home tab or the /jobs modal.
async function rerender(body, client) {
  const user = body.user.id;
  if (body.view?.type === 'modal') {
    await client.views.update({ view_id: body.view.id, hash: body.view.hash, view: modalView(store, filtersFor(user)) });
  } else {
    await publishHome(client, user);
  }
}

registerAssignmentHandlers(app, { store, refresh, publishHome, messageModal });
registerDescriptionHandlers(app,{store});
registerHelperEvents(app);
registerRundownRefresh(app);
registerSummarySurface(app);

app.event('app_home_opened', async ({ event, client }) => {
  if (event.tab !== 'home') return;
  homeViewers.set(event.user,Date.now());
  await ready();
  await publishHome(client, event.user);
});

for (const tab of TABS) {
  app.action(`tab_${tab.id}`, async ({ ack, body, client }) => {
    await ack();
    userFilters.set(body.user.id, { ...filtersFor(body.user.id), tab: tab.id });
    await ready();
    await rerender(body, client);
  });
}

app.action('tech_filter', async ({ ack, body, action, client }) => {
  await ack();
  userFilters.set(body.user.id, { ...filtersFor(body.user.id), tech: action.selected_option.value });
  await rerender(body, client);
});

app.action('refresh', async ({ ack, body, client }) => {
  await ack();
  store.invalidateLeadActivity();
  await refresh();
  await rerender(body, client);
});

app.action('find_job', async ({ ack, body, client }) => {
  await ack();
  const view = findModal();
  if (body.view?.type === 'modal') await client.views.push({ trigger_id: body.trigger_id, view });
  else await client.views.open({ trigger_id: body.trigger_id, view });
});

app.view('job_find', async ({ ack, body, view }) => {
  const number = (view.state.values.job?.number?.value || '').replace(/\D/g, '');
  if (!/^\d{5,7}$/.test(number)) {
    await ack({ response_action: 'errors', errors: { job: 'Type a call number, like 132228.' } });
    return;
  }
  // Slack needs an answer within 3 seconds, so search the board as it stands.
  const job = store.find(number);
  if (!canViewJob(job,body.user.id)) {
    await ack({ response_action: 'errors', errors: { job: `I couldn't find ${number} in the last few weeks of #incoming-calls or the TPS Jobs calendar.` } });
    return;
  }
  await ack({ response_action: 'update', view: jobModal(job, body.user.id) });
});

app.action(/^addnote_/, async ({ ack, body, action, client }) => {
  await ack();
  const job = store.find(action.value);
  const view = canAddNotes(job,body.user.id,job?.assignedMessageUrl)
    ? noteModal(job)
    : messageModal('Add photos/notes', `Job ${action.value} isn't assigned to a tech channel yet, so there's no thread to send to.`);
  if (body.view?.type === 'modal') await client.views.push({ trigger_id: body.trigger_id, view });
  else await client.views.open({ trigger_id: body.trigger_id, view });
});

app.view('job_note', async ({ ack, body, view, client }) => {
  const { jobNumber, url } = JSON.parse(view.private_metadata);
  if(!canAddNotes(store.find(jobNumber),body.user.id,url)){await ack({response_action:'update',view:messageModal('Add photos/notes','This call is no longer assigned to you or its thread changed. Refresh the board before adding notes.')});return;}
  const files = view.state.values.photos?.files?.files || [];
  const notes = (view.state.values.notes?.text?.value || '').trim();
  if (!files.length && !notes) {
    await ack({ response_action: 'errors', errors: { notes: 'Add a photo or a note first.' } });
    return;
  }
  await ack({ response_action: 'update', view: messageModal(`Job ${jobNumber}`, '⏳ Sending to the call thread…') });
  let result;
  try {
    await postToThread(client, { url, user: body.user.id, notes, files });
    result = `✅ Sent to job ${jobNumber}'s thread in your channel.`;
  } catch (e) {
    console.error('could not post photos/notes', jobNumber, e.data?.error || e.message);
    result = `⚠️ Couldn't send that to job ${jobNumber} (${e.data?.error || e.message}). Please post it in the call thread yourself and tell Paul.`;
  }
  await client.views.update({ view_id: body.view.id, view: messageModal(`Job ${jobNumber}`, result) }).catch(() => {});
});

// "https://x.slack.com/archives/C0C1M4CRKSB/p1792691395739399" -> { channel, ts }
function parseMessageUrl(url) {
  const m = (url || '').match(/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/);
  if (!m) throw new Error('no tech-channel link for this call');
  return { channel: m[1], ts: `${m[2]}.${m[3]}` };
}

async function postToThread(client, { url, user, notes, files }) {
  const { channel, ts } = parseMessageUrl(url);
  await client.conversations.join({ channel }).catch(() => {}); // already a member, or a private channel it was invited to
  if (notes) await client.chat.postMessage({ channel, thread_ts: ts, text: `📝 Notes from <@${user}>:\n${notes}` });
  if (!files.length) return;
  // Files picked in the pop-up belong to the tech; copy them into the thread.
  const uploads = [];
  for (const f of files) {
    const { file } = await client.files.info({ file: f.id });
    const res = await fetch(file.url_private_download || file.url_private, { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    uploads.push({ file: Buffer.from(await res.arrayBuffer()), filename: file.name || `${f.id}.jpg` });
  }
  await client.filesUploadV2({ channel_id: channel, thread_ts: ts, initial_comment: `📸 Photos from <@${user}>`, file_uploads: uploads });
}

// Link buttons still send an action; acknowledge them so Slack shows no error.
app.action(/^(thread|techmsg|future|files|map|cal|completed)_/, async ({ ack }) => ack());

const watchedChannels=new Set(['C0C19TG3KJ6','C0C2XUL7ZHN','C0C2XB4VD1N','C0C2YDBHFFY','C0C5VVDCQ92','C0C5B0WGZ7H',...TECHS.map(t=>t.channel)]);
let boardRefreshTimer;
app.event('message',async({event})=>{if(!watchedChannels.has(event.channel))return;const message=event.message||event;store.invalidateThread(event.channel,message.thread_ts||event.thread_ts||message.ts);clearTimeout(boardRefreshTimer);boardRefreshTimer=setTimeout(()=>refresh(),2000);boardRefreshTimer.unref?.();});

app.command('/jobs', async ({ ack, command, client }) => {
  await ack();
  const arg = command.text.trim();
  if (!store.updatedAt) await refresh();
  if (/^(me|mine|my)$/i.test(arg)) {
    const filters = { ...filtersFor(command.user_id), tab: 'mine', user: command.user_id };
    userFilters.set(command.user_id, filters);
    await client.views.open({ trigger_id: command.trigger_id, view: modalView(store, filters) });
    return;
  }
  if (/^\d{5,7}$/.test(arg)) {
    const job = store.find(arg);
    if (canViewJob(job,command.user_id)) {
      await client.views.open({ trigger_id: command.trigger_id, view: jobModal(job, command.user_id) });
    } else {
      await client.chat.postEphemeral({ channel: command.channel_id, user: command.user_id, text: `I couldn't find job ${arg} in the last few weeks of #incoming-calls or the TPS Jobs calendar.` });
    }
    return;
  }
  // "/jobs files 132263": TPS Bot posts the job's files card here; clicking it opens the side panel.
  const filesArg = arg.match(/^files?\s+(\d{5,7})$/i);
  if (filesArg) {
    const job = store.find(filesArg[1]);
    let text;
    if (!canViewJob(job, command.user_id)) text = `I couldn't find job ${filesArg[1]} in the last few weeks of #incoming-calls or the TPS Jobs calendar.`;
    else if (!job.filesUrl) text = `Job ${filesArg[1]} has no Drive folder link yet.`;
    else {
      try { await postJobFilesCard({ channel: command.channel_id, jobNumber: job.jobNumber, filesUrl: job.filesUrl }); return; }
      catch (e) { text = /not_in_channel|channel_not_found/.test(e.message) ? 'Invite TPS Bot to this channel first, then try again.' : `Couldn't post the files card (${e.message}).`; }
    }
    await client.chat.postEphemeral({ channel: command.channel_id, user: command.user_id, text });
    return;
  }
  const techArg = store.techs().find((t) => t.toLowerCase() === arg.toLowerCase());
  const filters = { ...filtersFor(command.user_id), ...(techArg ? { tech: techArg } : {}) };
  userFilters.set(command.user_id, filters);
  await client.views.open({ trigger_id: command.trigger_id, view: modalView(store, filters) });
});

app.shortcut('open_job_board', async ({ ack, shortcut, client }) => {
  await ack();
  if (!store.updatedAt) await refresh();
  await client.views.open({ trigger_id: shortcut.trigger_id, view: modalView(store, filtersFor(shortcut.user.id)) });
});

(async () => {
  await app.start(Number(process.env.PORT || 8080));
  console.log('TPS Job Board running');
  refresh();
  setInterval(refresh, REFRESH_MS);
})();
