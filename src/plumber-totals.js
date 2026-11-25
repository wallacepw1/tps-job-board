'use strict';
// Admin report: how much a plumber billed between two dates, from Paul's "Calls" Slack list.
// QuickBooks has no plumber, so the list (Assignee + Price + Due Date) is the source.
// Runs only when an admin asks for it; nothing here runs on a timer.
const { TECHS } = require('./assignment-policy');
const { boardRole } = require('./board-scope');
const { TZ } = require('./jobs');

const LIST_ID = process.env.CALLS_LIST_ID || 'F0C39RE7HDK';
const OFFICE_USER = process.env.OFFICE_USER_ID || 'U0876C3TEGL';

// Each column has a key and a separate column id; the scenarios write by column id.
const COL = {
  name: ['name', 'Col0C38GZ8N4T'],
  assignee: ['todo_assignee', 'Col01'],
  dueDate: ['todo_due_date', 'Col02'],
  description: ['Col0C4DQV3BUK', 'Col0C4N06KACR', 'Col0C6LJE7MS4'],
  completed: ['Col0C5ECQNS56', 'Col0C4PMWD5T6'],
  priced: ['Col0C4N0H9P41', 'Col0C5ECTA9TJ'],
  price: ['Col0C5L470C5R', 'Col0C5QC3UGJ2'],
};

function fieldMap(item) {
  const byId = {};
  for (const f of item.fields || []) {
    if (f.key) byId[f.key] = f;
    if (f.column_id) byId[f.column_id] = f;
  }
  const out = {};
  for (const [name, ids] of Object.entries(COL)) out[name] = ids.map((id) => byId[id]).find(Boolean);
  return out;
}

function richText(rt) {
  const walk = (n) => (n == null ? '' : typeof n === 'string' ? n : Array.isArray(n) ? n.map(walk).join('') : typeof n.text === 'string' && !n.elements ? n.text : walk(n.elements));
  return walk(rt);
}

function textOf(f) {
  if (!f) return '';
  if (typeof f.text === 'string' && f.text) return f.text;
  if (typeof f.value === 'string') return f.value;
  if (f.rich_text) return richText(f.rich_text);
  return '';
}

function checked(f) {
  if (!f) return false;
  if (typeof f.checkbox === 'boolean') return f.checkbox;
  return f.value === true || f.value === 'true';
}

function userOf(f) {
  if (!f) return null;
  if (Array.isArray(f.user)) return f.user[0] || null;
  if (typeof f.user === 'string') return f.user;
  if (Array.isArray(f.value)) return f.value[0] || null;
  return typeof f.value === 'string' ? f.value : null;
}

function dateOf(f) {
  if (!f) return null;
  const raw = Array.isArray(f.date) ? f.date[0] : f.date || (Array.isArray(f.value) ? f.value[0] : f.value);
  const m = String(raw || '').match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

function dayKey(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// "$1,250.00" -> 1250; anything else (blank, "?", "cancel") -> null.
function parsePrice(text) {
  const m = String(text || '').replace(/[,\s]/g, '').match(/^\$?(\d+(?:\.\d{1,2})?)$/);
  return m ? Number(m[1]) : null;
}

// Street line from the call description: the first line that starts with a house number
// and is not the call number or a work order number like "388419-1".
function addressOf(description, jobNumber) {
  for (const line of String(description || '').split('\n').map((l) => l.trim())) {
    if (!line || line === jobNumber || /^\d+-\d+$/.test(line)) continue;
    if (/^\d+[\w/ ]*\s+[A-Za-z]/.test(line)) return line.slice(0, 60);
  }
  return '';
}

function parseRow(item) {
  const f = fieldMap(item);
  const jobNumber = textOf(f.name).trim().match(/^\d{5,7}$/)?.[0];
  if (!jobNumber) return null;
  const assignee = userOf(f.assignee);
  const priceText = textOf(f.price).trim();
  const created = Number(item.date_created) ? dayKey(new Date(Number(item.date_created) * 1000)) : null;
  return {
    jobNumber,
    techId: assignee && assignee !== OFFICE_USER ? assignee : null,
    date: dateOf(f.dueDate) || created,
    completed: checked(f.completed),
    priceText,
    price: parsePrice(priceText),
    address: addressOf(textOf(f.description), jobNumber),
  };
}

async function fetchRows(client) {
  const rows = new Map();
  let cursor;
  do {
    const res = await client.apiCall('slackLists.items.list', { list_id: LIST_ID, limit: 200, cursor });
    for (const item of res.items || []) {
      const row = parseRow(item);
      if (row && !rows.has(row.jobNumber)) rows.set(row.jobNumber, row);
    }
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  return [...rows.values()];
}

// tech: a TECHS id, or 'all'. from/to: "YYYY-MM-DD", inclusive.
function summarize(rows, { tech, from, to }) {
  const inRange = rows.filter((r) => r.techId && r.date && r.date >= from && r.date <= to && (tech === 'all' || r.techId === tech));
  const priced = inRange.filter((r) => r.price != null).sort((a, b) => a.date.localeCompare(b.date) || a.jobNumber.localeCompare(b.jobNumber));
  const unpriced = inRange.filter((r) => r.price == null && r.completed).sort((a, b) => a.date.localeCompare(b.date));
  const byTech = new Map();
  for (const r of priced) {
    const t = byTech.get(r.techId) || { techId: r.techId, total: 0, calls: 0 };
    t.total += r.price; t.calls += 1;
    byTech.set(r.techId, t);
  }
  return {
    total: priced.reduce((s, r) => s + r.price, 0),
    priced,
    unpriced,
    byTech: [...byTech.values()].sort((a, b) => b.total - a.total),
  };
}

const money = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
const techName = (id) => TECHS.find((t) => t.id === id)?.name || `<@${id}>`;
const shortDate = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });

function defaultRange(now = new Date()) {
  const today = dayKey(now);
  return { from: today.slice(0, 8) + '01', to: today };
}

function formView(values = {}, error) {
  const range = { ...defaultRange(), ...values };
  const options = [{ text: { type: 'plain_text', text: 'All plumbers' }, value: 'all' }, ...TECHS.map((t) => ({ text: { type: 'plain_text', text: t.name }, value: t.id }))];
  const initial = options.find((o) => o.value === (values.tech || 'all')) || options[0];
  return {
    type: 'modal',
    callback_id: 'plumber_totals',
    title: { type: 'plain_text', text: 'Plumber totals' },
    submit: { type: 'plain_text', text: 'Add it up' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [
      { type: 'input', block_id: 'tech', label: { type: 'plain_text', text: 'Plumber' }, element: { type: 'static_select', action_id: 'v', options, initial_option: initial } },
      { type: 'input', block_id: 'from', label: { type: 'plain_text', text: 'From' }, element: { type: 'datepicker', action_id: 'v', initial_date: range.from } },
      { type: 'input', block_id: 'to', label: { type: 'plain_text', text: 'To' }, element: { type: 'datepicker', action_id: 'v', initial_date: range.to } },
      ...(error ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `⚠️ ${error}` }] }] : []),
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Uses the *Calls* list: the call\'s plumber (Assignee), its visit date (Due Date) and its price. Both dates count.' }] },
    ],
  };
}

// Section texts must stay under 3000 characters, so long call lists are split.
function chunkLines(lines, max = 2800) {
  const out = [];
  let cur = '';
  for (const line of lines) {
    if (cur && cur.length + line.length + 1 > max) { out.push(cur); cur = ''; }
    cur = cur ? cur + '\n' + line : line;
  }
  if (cur) out.push(cur);
  return out;
}

function resultView(summary, { tech, from, to }) {
  const who = tech === 'all' ? 'All plumbers' : techName(tech);
  const range = from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`;
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${who}* · ${range}\n*${money(summary.total)}* billed on *${summary.priced.length}* priced call${summary.priced.length === 1 ? '' : 's'}` } },
  ];
  if (tech === 'all' && summary.byTech.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: summary.byTech.map((t) => `• *${techName(t.techId)}*: ${money(t.total)} (${t.calls} call${t.calls === 1 ? '' : 's'})`).join('\n') } });
  }
  if (summary.unpriced.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `⏳ ${summary.unpriced.length} completed call${summary.unpriced.length === 1 ? ' is' : 's are'} not priced yet, so ${summary.unpriced.length === 1 ? 'it is' : 'they are'} not in the total: ${summary.unpriced.slice(0, 40).map((r) => r.jobNumber).join(', ')}${summary.unpriced.length > 40 ? '…' : ''}` }] });
  }
  blocks.push({ type: 'divider' });
  const lines = summary.priced.map((r) => `${shortDate(r.date)} · *${r.jobNumber}* · ${money(r.price)}${tech === 'all' ? ` · ${techName(r.techId)}` : ''}${r.address ? ` · ${r.address}` : ''}`);
  if (!lines.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_No priced calls in these dates._' } });
  for (const text of chunkLines(lines).slice(0, 90)) blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
  blocks.push({ type: 'actions', elements: [{ type: 'button', action_id: 'plumber_totals_again', text: { type: 'plain_text', text: 'Change plumber or dates' }, value: JSON.stringify({ tech, from, to }) }] });
  return { type: 'modal', callback_id: 'plumber_totals_result', title: { type: 'plain_text', text: 'Plumber totals' }, close: { type: 'plain_text', text: 'Close' }, blocks };
}

function loadingView(text) {
  return { type: 'modal', title: { type: 'plain_text', text: 'Plumber totals' }, close: { type: 'plain_text', text: 'Close' }, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}

const isAdmin = (user) => boardRole(user) === 'admin';

async function openTotals(client, triggerId, user, inModal) {
  const view = isAdmin(user) ? formView() : loadingView('Plumber totals are for TPS admins.');
  if (inModal) await client.views.push({ trigger_id: triggerId, view });
  else await client.views.open({ trigger_id: triggerId, view });
}

function registerPlumberTotals(app) {
  app.action('plumber_totals_open', async ({ ack, body, client }) => {
    await ack();
    await openTotals(client, body.trigger_id, body.user.id, body.view?.type === 'modal');
  });

  app.action('plumber_totals_again', async ({ ack, body, action, client }) => {
    await ack();
    if (!isAdmin(body.user.id)) return;
    let values = {};
    try { values = JSON.parse(action.value); } catch {}
    await client.views.update({ view_id: body.view.id, view: formView(values) });
  });

  app.view('plumber_totals', async ({ ack, body, view, client }) => {
    if (!isAdmin(body.user.id)) { await ack({ response_action: 'update', view: loadingView('Plumber totals are for TPS admins.') }); return; }
    const v = view.state.values;
    const params = { tech: v.tech?.v?.selected_option?.value || 'all', from: v.from?.v?.selected_date, to: v.to?.v?.selected_date };
    if (!params.from || !params.to) { await ack({ response_action: 'errors', errors: { from: 'Pick both dates.' } }); return; }
    if (params.from > params.to) { await ack({ response_action: 'errors', errors: { to: 'The To date must be on or after the From date.' } }); return; }
    if (params.tech !== 'all' && !TECHS.some((t) => t.id === params.tech)) { await ack({ response_action: 'errors', errors: { tech: 'Choose a plumber.' } }); return; }
    // Slack wants an answer within 3 seconds; reading the whole list can take longer.
    await ack({ response_action: 'update', view: loadingView('⏳ Adding up the Calls list…') });
    let next;
    try {
      next = resultView(summarize(await fetchRows(client), params), params);
    } catch (e) {
      console.error('plumber totals failed', e.data?.error || e.message);
      next = formView(params, `Couldn't read the Calls list (${e.data?.error || e.message}). Try again in a minute.`);
    }
    await client.views.update({ view_id: body.view.id, view: next }).catch((e) => console.error('plumber totals update failed', e.data?.error || e.message));
  });
}

module.exports = { registerPlumberTotals, openTotals, parseRow, summarize, resultView, formView, parsePrice, addressOf, chunkLines, isAdmin, COL };
