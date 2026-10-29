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

// Full readable text of a Slack message: `text` plus anything in blocks and attachments.
function messageText(m) {
  const collect = (node, out) => {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { node.forEach((n) => collect(n, out)); return out; }
    if (typeof node.text === 'string') out.push(node.text);
    if (node.type === 'link' && node.url) out.push(node.url);
    // Rich-text dates carry a timestamp instead of text.
    if (node.type === 'date' && node.timestamp) out.push(node.fallback || formatSlackDate(node.timestamp));
    // Latenode posts use collapsible "container" blocks with a title, subtitle and child_blocks.
    for (const key of ['title', 'subtitle', 'text', 'elements', 'fields', 'blocks', 'child_blocks', 'accessory']) {
      if (typeof node[key] === 'object') collect(node[key], out);
    }
    return out;
  };
  const attachments = (m.attachments || []).flatMap((a) => [
    a.pretext, a.title, a.text, ...(a.fields || []).map((f) => `${f.title || ''}\n${f.value || ''}`), ...collect(a.blocks, []),
  ]);
  // Blocks usually repeat `text`, so use whichever version carries the most.
  const candidates = [m.text || '', collect(m.blocks, []).join('\n'), attachments.filter(Boolean).join('\n')];
  const best = candidates.reduce((b, c) => (c.length > b.length ? c : b), '');
  // mrkdwn date tokens: <!date^1792761600^{date_short} at {time}|fallback>
  return best.replace(/<!date\^(\d+)\^[^|>]*(?:\|([^>]*))?>/g, (_, ts, fb) => fb || formatSlackDate(ts));
}

function formatSlackDate(ts) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.TZ_NAME || 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(Number(ts) * 1000)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} at ${parts.hour}:${parts.minute}`;
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

  // Address: the line containing ", CA", plus the street line above it and any unit line in between.
  let address = null;
  let addressIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (ADDRESS_LINE.test(lines[i])) {
      addressIdx = i;
      const above = [];
      for (let j = i - 1; j >= Math.max(0, i - 3) && lines[j]; j--) {
        above.unshift(lines[j]);
        if (/^\d/.test(lines[j])) break;
      }
      const hasStreet = above.length && /^\d/.test(above[0]);
      address = [...(hasStreet ? above : above.slice(-1)), lines[i]].join(', ');
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

// Thread notes Call Route posts when a call is sent back or (re)assigned.
const REOPEN = /^\s*(?:Call (?:re)?assigned |:arrows_counterclockwise: Sent to <#|:calendar: \*Rescheduled:|:hourglass_flowing_sand: \*Needs to be scheduled)/;

function parseReplies(replies) {
  const state = { helperId: null, helperThreads: [], tech: null, assignedAt: null, visitStartedAt:null,visitDate:null,scheduledFor: null, completed: false, completedAt: null, canceled: false, reopened: false };
  for (const r of replies) {
    const t = (r.text || '').replace(/\*/g,'');
    const returned=t.match(/Return on the same unbilled invoice assigned to ([^:]+):/);
    if(returned&&r.ts){
      state.completed=false;state.completedAt=null;state.reopened=true;
      state.tech=returned[1].trim();state.techId=null;
      state.assignedAt=new Date(Number(r.ts)*1000);state.visitStartedAt=state.assignedAt;
      state.visitDate=formatSlackDate(r.ts).slice(0,10);state.scheduledFor=null;state.needsDate=false;
    }
    const helper=t.match(/^TPS helper assigned: <@(U[A-Z0-9]+)>/);
    if(helper){state.helperId=helper[1];const link=t.match(/archives\/(C[A-Z0-9]+)\/p(\d{10})(\d{6})/);if(link)state.helperThreads.push({channel:link[1],ts:link[2]+'.'+link[3]});}
    if(/^TPS helper removed\b/.test(t))state.helperId=null;

    // A send-back or (re)assign after a completion means the job was not really finished (Paul 2026-10-26,
    // 132099 needs a return visit): it is open again until the next "Call completed".
    if (state.completed && REOPEN.test(r.text||'')) {
      state.completed = false;
      state.completedAt = null;
      state.reopened = true;
      // "No date yet" drops the old appointment so it does not stay on that day. A later schedule replaces this.
      if (/needs to be scheduled/i.test(t)) {
        state.scheduledFor = null;
        state.needsDate = true;
      }
    }
    const a = t.match(/^Call (?:assigned|reassigned(?: from [\w .'-]+?)?) (?:to )?([\w .'-]+?)(?: on | by |\n|$)/);
    if (a) {
      state.tech = a[1].trim();
      const at=r.ts?new Date(Number(r.ts)*1000):null;
      const date=at?formatSlackDate(r.ts).slice(0,10):null;
      if(/^Call assigned\b/.test(t)){
        state.visitStartedAt=at;
        if(date){state.visitDate=state.scheduledFor?.date>=date?state.scheduledFor.date:date;if(state.scheduledFor?.date<date)state.scheduledFor=null;}
      }else if(!state.visitDate){state.visitDate=state.scheduledFor?.date||date;state.visitStartedAt=state.visitStartedAt||state.assignedAt||at;}
      state.assignedAt = r.ts ? new Date(Number(r.ts)*1000) : null;
    }
    const lead=t.match(/TPS lead assigned: <@(U[A-Z0-9]+)>/);
    if(lead){state.techId=lead[1];state.assignedAt=r.ts?new Date(Number(r.ts)*1000):null;if(!state.visitDate&&r.ts){state.visitDate=state.scheduledFor?.date||formatSlackDate(r.ts).slice(0,10);state.visitStartedAt=state.assignedAt;}}
    const s = t.match(/(?:Scheduled for|Rescheduled:)\s+(\d{4}-\d{2}-\d{2})\s+at\s+(\d{1,2}:\d{2})/);
    if (s) {
      state.scheduledFor = { date: s[1], time: s[2] };
      state.visitDate=s[1];state.visitStartedAt=null;
      state.needsDate = false;
      if(/Rescheduled:/i.test(t)){state.tech=null;state.techId=null;state.assignedAt=null;}
    }
    const rs = t.match(/(?:Rescheduled:|Scheduled for)\s+\w+, (\w{3}) (\d{1,2}) at (\d{1,2}):(\d{2}) ([AP]M)/);
    if (rs) {
      state.scheduledFor = fromRescheduled(rs, r.ts);
      state.visitDate=state.scheduledFor.date;state.visitStartedAt=null;
      state.needsDate = false;
      if(/Rescheduled:/i.test(t)){state.tech=null;state.techId=null;state.assignedAt=null;}
    }
    if(/needs to be scheduled/i.test(t)){state.scheduledFor=null;state.needsDate=true;state.tech=null;state.techId=null;state.assignedAt=null;state.visitDate=null;state.visitStartedAt=null;}
    if (/Call completed/i.test(t)) {
      state.completed = true;
      state.reopened = false;
      // When the Complete button was pressed (the reply's own time), so a job finished early drops off its booked day.
      if (r.ts) state.completedAt = new Date(Number(r.ts) * 1000);
    }
    if (/Call (?:was )?cancell?ed/i.test(t)) state.canceled = true;
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
  if (job.needsDate) return 'needs_date';
  if (job.pendingCompletion) return 'pending';
  if (job.tech) return 'assigned';
  if (job.scheduledFor) return 'scheduled';
  return 'new';
}

module.exports = { parseIntake, parseReplies, statusOf, clean, messageText };
