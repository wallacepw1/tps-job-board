// Reads Paul's "Calls" Slack list: one row per job, with the assigned tech and the Completed checkbox.
const LIST_ID = process.env.CALLS_LIST_ID || 'F0C39RE7HDK';
const OFFICE_USER = process.env.OFFICE_USER_ID || 'U0876C3TEGL'; // default assignee before a tech is picked

const COL = {
  name: 'name',
  assignee: 'todo_assignee',
  description: 'Col0C4DQV3BUK',
  assigned: 'Col0C4EUSL2BF',
  completed: 'Col0C5ECQNS56', // the job's own Completed checkbox, not the to-do one
  assignedMessage: 'Col0C56LDTN9Z',
  workDone: 'Col0C5S35HL0J',
};

// Slack list fields arrive as { key | column_id, value, text, checkbox, user, ... } depending on type.
function fieldMap(item) {
  const out = {};
  for (const f of item.fields || []) out[f.key || f.column_id] = f;
  return out;
}

function textOf(f) {
  if (!f) return '';
  if (typeof f.text === 'string') return f.text;
  if (typeof f.value === 'string') return f.value;
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

function messageLink(f) {
  if (!f) return null;
  const m = Array.isArray(f.message) ? f.message[0] : f.message;
  return m?.value || m?.url || (textOf(f).startsWith('https://') ? textOf(f) : null);
}

function parseListItem(item) {
  const f = fieldMap(item);
  const jobNumber = textOf(f[COL.name]).trim().match(/^\d{5,7}$/)?.[0];
  if (!jobNumber) return null;
  const assignee = userOf(f[COL.assignee]);
  return {
    jobNumber,
    recordId: item.id,
    assigneeId: checked(f[COL.assigned]) && assignee !== OFFICE_USER ? assignee : null,
    completed: checked(f[COL.completed]),
    description: textOf(f[COL.description]),
    assignedMessageUrl: messageLink(f[COL.assignedMessage]),
    workDone: textOf(f[COL.workDone]) || null,
  };
}

async function fetchCallsList(client) {
  const rows = new Map();
  let cursor;
  do {
    const res = await client.apiCall('slackLists.items.list', { list_id: LIST_ID, limit: 200, cursor });
    for (const item of res.items || []) {
      const row = parseListItem(item);
      if (row && !rows.has(row.jobNumber)) rows.set(row.jobNumber, row);
    }
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  return rows;
}

module.exports = { fetchCallsList, parseListItem, COL };
