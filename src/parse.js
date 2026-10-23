// Parsers for the PaulLatenode intake posts and thread replies in #incoming-calls.

const ADDRESS_LINE = /,\s*CA\b/i;

function clean(text) {
  return (text || '')
    .replace(/<tel:[^|>]+\|([^>]+)>/g, '$1')
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseIntake(rawText) {
  const text = clean(rawText);
  const lines = text.split('\n').map((l) => l.trim());
  const nonEmpty = lines.filter((l) => l && l !== 'null');

  const jobNumber = (nonEmpty[0] || '').match(/^\d{5,7}$/) ? nonEmpty[0] : null;
  const woMatch = text.match(/^\s*(\d{4,7}-\d+)\s*$/m);
  const workOrder = woMatch ? woMatch[1] : null;

  const driveMatch = rawText.match(/<(https:\/\/drive\.google\.com\/[^|>]+)\|Work Order Files>/)
    || rawText.match(/(https:\/\/drive\.google\.com\/drive\/folders\/[\w-]+)/);
  const filesUrl = driveMatch ? driveMatch[1] : null;

  // Address: the line containing ", CA", plus the street line just above it.
  let address = null;
  let addressIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (ADDRESS_LINE.test(lines[i])) {
      addressIdx = i;
      const street = lines[i - 1] && /^\d/.test(lines[i - 1]) ? lines[i - 1] : null;
      address = street ? `${street}, ${lines[i]}` : lines[i];
      if (!/^\d/.test(address) && lines[i - 1]) address = `${lines[i - 1]}, ${lines[i]}`;
      break;
    }
  }
  // Answering-service format: "Address: 814 Tamayo Dr"
  const svcAddr = text.match(/Address:\s*(.+)/);
  if (!address && svcAddr) address = svcAddr[1].trim();

  // Client: first line after the job/WO header that is not a number and not the address block.
  const skip = new Set([jobNumber, workOrder].filter(Boolean));
  let client = null;
  for (const l of nonEmpty.slice(1, 8)) {
    if (skip.has(l) || /^\d/.test(l) || ADDRESS_LINE.test(l)) continue;
    client = l;
    break;
  }

  let issue = null;
  const issueMatch = text.match(/^Issue[:\s]+(.+)$/m);
  if (issueMatch) {
    issue = issueMatch[1].trim();
  } else if (addressIdx >= 0) {
    issue = lines.slice(addressIdx + 1).find((l) => l && l !== 'null' && !/^(unit|suite|united states)/i.test(l)) || null;
  }
  if (issue && /^WORK ORDER/i.test(issue)) issue = null;

  const emergency = /\bemergency\b/i.test(text);

  return { jobNumber, workOrder, client, address, issue, filesUrl, emergency };
}

function parseReplies(replies) {
  const state = { tech: null, assignedAt: null, scheduledFor: null, completed: false };
  for (const r of replies) {
    const t = r.text || '';
    const a = t.match(/Call assigned to ([\w .'-]+?) on (\S+)/);
    if (a) {
      state.tech = a[1].trim();
      state.assignedAt = a[2];
    }
    const s = t.match(/Scheduled for (\d{4}-\d{2}-\d{2}) at (\d{1,2}:\d{2})/);
    if (s) state.scheduledFor = { date: s[1], time: s[2] };
    const rs = t.match(/(?:Rescheduled:|Scheduled for) \w+, (\w{3}) (\d{1,2}) at (\d{1,2}):(\d{2}) ([AP]M)/);
    if (rs) state.scheduledFor = fromRescheduled(rs, r.ts);
    if (/Call completed/i.test(t)) state.completed = true;
  }
  return state;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Rescheduled: Friday, Oct 23 at 9:00 AM" has no year; take the year the reply was posted,
// rolling forward when a December reply schedules a January visit.
function fromRescheduled([, mon, day, hour, min, ampm], replyTs) {
  const posted = replyTs ? new Date(Number(replyTs) * 1000) : new Date();
  const month = MONTHS.indexOf(mon);
  let year = posted.getUTCFullYear();
  if (month < posted.getUTCMonth() - 6) year += 1;
  let h = Number(hour) % 12;
  if (ampm === 'PM') h += 12;
  const pad = (n) => String(n).padStart(2, '0');
  return { date: `${year}-${pad(month + 1)}-${pad(day)}`, time: `${pad(h)}:${min}` };
}

function statusOf(job) {
  if (job.completed) return 'done';
  if (job.scheduledFor) return 'scheduled';
  if (job.tech) return 'assigned';
  return 'new';
}

module.exports = { parseIntake, parseReplies, statusOf, clean };
