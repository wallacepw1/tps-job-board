// TPS Job Board: Slack Home tab, /jobs command and shortcut, all read-only.
const { App, ExpressReceiver } = require('@slack/bolt');
const { JobStore } = require('./jobs');
const { homeView, modalView, jobModal, TABS } = require('./views');

const REFRESH_MS = Number(process.env.REFRESH_SECONDS || 120) * 1000;

const receiver = new ExpressReceiver({ signingSecret: process.env.SLACK_SIGNING_SECRET });
receiver.router.get('/healthz', (_req, res) => res.send('ok'));

const app = new App({ token: process.env.SLACK_BOT_TOKEN, receiver });
const store = new JobStore(app.client);
const userFilters = new Map(); // userId -> { tab, tech }

function filtersFor(user) {
  return userFilters.get(user) || { tab: 'today', tech: 'all' };
}

let refreshing = null;
function refresh() {
  refreshing = refreshing || store.refresh().catch((e) => console.error('refresh failed', e)).finally(() => { refreshing = null; });
  return refreshing;
}

async function ready() {
  if (!store.updatedAt) await refresh();
  else if (Date.now() - store.updatedAt > REFRESH_MS) refresh(); // serve cached data, update in background
}

async function publishHome(client, user) {
  await client.views.publish({ user_id: user, view: homeView(store, filtersFor(user)) });
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

app.event('app_home_opened', async ({ event, client }) => {
  if (event.tab !== 'home') return;
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
  await refresh();
  await rerender(body, client);
});

// Link buttons still send an action; acknowledge them so Slack shows no error.
app.action(/^(thread|files|map|cal)_/, async ({ ack }) => ack());

app.command('/jobs', async ({ ack, command, client }) => {
  await ack();
  const arg = command.text.trim();
  if (!store.updatedAt) await refresh();
  if (/^\d{5,7}$/.test(arg)) {
    const job = store.find(arg);
    if (job) {
      await client.views.open({ trigger_id: command.trigger_id, view: jobModal(job) });
    } else {
      await client.chat.postEphemeral({ channel: command.channel_id, user: command.user_id, text: `I couldn't find job ${arg} in the last few weeks of #incoming-calls or the TPS Jobs calendar.` });
    }
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
