// Reads Paul's "Calls" Slack list: one row per job, with the assigned tech and the Completed checkbox.
const LIST_ID = process.env.CALLS_LIST_ID || 'F0C39RE7HDK';
const OFFICE_USER = process.env.OFFICE_USER_ID || 'U0876C3TEGL'; // default assignee before a tech is picked

// Each column has a key and a separate column id; the Call Route scenario writes by column id.
const COL = {
  name: ['name', 'Col00'],
  assignee: ['todo_assignee', 'Col01'],
  description: ['Col0C4DQV3BUK'],
  assigned: ['Col0C4EUSL2BF', 'Col0C5ECNLSBS'],
  completed: ['Col0C5ECQNS56', 'Col0C4PMWD5T6'], // the job's own Completed checkbox, not the to-do one
  assignedMessage: ['Col0C56LDTN9Z', 'Col0C5CNVAHH8'],
  workDone: ['Col0C5S35HL0J'],
};

// Slack list fields arrive as { key, column_id, value, text, checkbox, user, ... } depending on type.
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
  const jobNumber = textOf(f.name).trim().match(/^\d{5,7}$/)?.[0];
  if (!jobNumber) return null;
  const assignee = userOf(f.assignee);
  const isAssigned = checked(f.assigned);
  return {
    jobNumber,
    recordId: item.id,
    assigneeId: isAssigned && assignee !== OFFICE_USER ? assignee : null,
    completed: checked(f.completed),
    description: textOf(f.description),
    // A reschedule clears Assigned, so an old tech message no longer counts.
    assignedMessageUrl: isAssigned ? messageLink(f.assignedMessage) : null,
    workDone: textOf(f.workDone) || null,
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
