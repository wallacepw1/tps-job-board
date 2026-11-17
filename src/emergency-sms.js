'use strict';
const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { createPhoneCom } = require('./phonecom');

const OFFICE = '+16194763116';
const STOP = /^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT|REVOKE|OPTOUT)$/i;
const START = /^(START|UNSTOP)$/i;
const EMERGENCY = /(?<![\p{L}\p{N}_])(?:em{1,2}ergenc(?:y|ies)|emerg|e\s*\.\s*r\.?|er)(?![\p{L}\p{N}_])/giu;
const isEmergency = message => [...message.matchAll(EMERGENCY)].some(m =>
  !/\b(?:not(?:\s+an?)?|no(?:\s+real)?|non)[\s-]*$/i.test(message.slice(0,m.index)));
const number = value => {
  const digits = String(value?.id || value?.number || value || '').replace(/\D/g,'');
  return digits.length === 10 ? '+1'+digits : digits.length === 11 && digits.startsWith('1') ? '+'+digits : '';
};
const messageText = row => String(row.text ?? row.message ?? '').normalize('NFKC').replace(/\r\n/g,'\n').trim();
const fingerprint = row => createHash('sha256').update(messageText(row)).digest('hex');
function messageTime(value){const n=Number(value);return Number.isFinite(n)&&n>0?(n<1e12?n*1000:n):Date.parse(value);}
const ids = row => [row.id,row.uuid,row.message_id,row.messageId].filter(v=>v!=null).map(String);

function validSignature(raw, signature, secret) {
  if (!secret || !/^[a-f0-9]{64}$/.test(signature || '')) return false;
  const expected = createHmac('sha256',secret).update(raw).digest();
  return timingSafeEqual(expected,Buffer.from(signature,'hex'));
}
function acknowledgment(route, acceptedBy) {
  const footer=' Reply STOP to opt out or HELP for help.';
  // Business hours (office_emergency) -> office; after hours (emergency) -> on-call plumber (Paul 2026-11-09).
  if (route !== 'emergency_accepted') return 'TPS Plumbing Inc: Your emergency request has been sent to '+(route==='emergency'?'our on-call plumber':'the office')+'. You will receive confirmation when it is accepted. A visit has not been confirmed.'+footer;
  const raw=typeof acceptedBy==='string'?acceptedBy.trim():'';
  const name=/\bedgar\b/i.test(raw)||/^j\.?\s*r\.?$/i.test(raw)?'JR':raw;
  const attribution=/^[\p{L}\p{M}][\p{L}\p{M} .’'-]{0,49}$/u.test(name)?' by '+name:'';
  return 'TPS Plumbing Inc: Your emergency message has been accepted'+attribution+'. You will be contacted if necessary. Office may reply by txt. Thank you for using TPS Emergency Services.'+footer;
}
const pause = ms => new Promise(r => setTimeout(r, ms));
// Phone.com can take a few seconds to list a text it just delivered. The daytime ER path reaches
// Render within ~2 s of the text, so the first lookup can miss it (11-17 test: inbound_unverified).
const LOOKUP_DELAYS = [0, 3000, 4000, 5000];
async function sendEmergencyAcknowledgment(input, phone, send, now = Date.now(), { delays = LOOKUP_DELAYS, sleep = pause } = {}) {
  const {eventId, recipient, route, issuedAt, inboundHash, inboundAt, replyId, acceptedBy} = input || {};
  const manual=route==='staff_reply', reply=typeof input?.text==='string'?input.text.trim():'';
  if(manual&&(!reply||reply.length>1200||!/^[A-Za-z0-9_-]{6,80}$/.test(replyId||'')))return {status:'invalid'};
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(eventId || '') ||
      !/^\+1\d{10}$/.test(recipient || '') || recipient === OFFICE ||
      !['office_emergency','emergency','emergency_accepted','staff_reply'].includes(route) ||
      !Number.isFinite(issuedAt) || Math.abs(now-issuedAt)>120000) return {status:'invalid'};
  const account = await phone.accountId();
  const path = '/accounts/'+encodeURIComponent(account)+'/messages';
  const verifiedFingerprint=/^[a-f0-9]{64}$/.test(inboundHash||'')&&Number.isFinite(inboundAt)&&inboundAt>0;
  let history, rows, matching=[], original=null;
  for (let i=0; i<delays.length && !original; i++) {
    if (delays[i]) await sleep(delays[i]);
    history = await phone.request(path, {
      limit:500,'sort[id]':'desc','filters[direction]':'in','filters[from]':recipient,'filters[to]':OFFICE
    });
    if (!Array.isArray(history.items)) return {status:'history_unavailable'};
    rows = history.items;
    const bound=rows.filter(row=>number(row.from)===recipient &&
      (Array.isArray(row.to)?row.to:[row.to]).some(v=>number(v)===OFFICE));
    const exact=bound.find(row=>ids(row).includes(eventId));
    matching=verifiedFingerprint?bound.filter(row=>fingerprint(row)===inboundHash &&
      Math.abs(messageTime(row.created_at)-inboundAt)<=120000):[];
    original=exact||(matching.length===1?matching[0]:null);
    if (input.diagnostic === true) break;
  }
  if (input.diagnostic === true) return {
    status:'diagnostic',count:rows.length,fields:Object.keys(rows[0]||{}),
    matchingId:rows.some(row=>ids(row).includes(eventId)),
    matchingSender:rows.some(row=>number(row.from)===recipient),
    matchingOffice:rows.some(row=>(Array.isArray(row.to)?row.to:[row.to]).some(v=>number(v)===OFFICE)),
    emergencyFound:rows.some(row=>isEmergency(messageText(row))),fingerprintMatches:matching.length,templateVersion:2
  };
  if (!original || (!manual&&!isEmergency(messageText(original))) ||
      /^\s*reminder:\s*work order\b/i.test(messageText(original))) return {status:'inbound_unverified'};
  const keyword = rows.map(messageText).find(text=>STOP.test(text)||START.test(text));
  if (STOP.test(keyword || '')) return {status:'opted_out'};
  if (!keyword && (rows.length>=500 || Number(history.total)>rows.length)) return {status:'consent_history_incomplete'};
  await send(path,{from:OFFICE,to:[recipient],text:manual?'TPS Plumbing Inc: '+reply+' Reply STOP to opt out or HELP for help.':acknowledgment(route,acceptedBy),tag:manual?'tps-staff-'+replyId:(route==='emergency_accepted'?'tps-er-accepted-':'tps-er-')+eventId});
  return {status:'accepted'};
}
// Daytime ER texts are rare, so Paul and Edgar also get a text on their own phones (Paul 2026-11-17).
// Numbers come from TPS_ER_ALERT_NUMBERS on Render (comma separated), never from the request.
const pretty = p => p.replace(/^\+1(\d{3})(\d{3})(\d{4})$/,'($1) $2-$3');
function staffAlertNumbers(value = process.env.TPS_ER_ALERT_NUMBERS) {
  return [...new Set(String(value||'').split(',').map(number).filter(n=>/^\+1\d{10}$/.test(n) && n!==OFFICE))];
}
async function sendStaffAlert(input, send, path, { now = Date.now(), numbers = staffAlertNumbers() } = {}) {
  const {eventId, from, excerpt, issuedAt} = input || {};
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(eventId || '') || !/^\+1\d{10}$/.test(from || '') ||
      typeof excerpt !== 'string' || !Number.isFinite(issuedAt) || Math.abs(now-issuedAt)>120000) return {status:'invalid'};
  if (!numbers.length) return {status:'no_numbers'};
  const body = excerpt.replace(/\s+/g,' ').trim().slice(0,300);
  const text = 'TPS ALERT: Emergency text from '+pretty(from)+': "'+body+'" Open the TPS Assistant in Slack and press Accept so the customer gets a confirmation.';
  const results = await Promise.allSettled(numbers.map(to => send(path, {from:OFFICE,to:[to],text,tag:'tps-er-staff-'+eventId})));
  const sent = results.filter(r=>r.status==='fulfilled').length;
  return {status: sent===numbers.length ? 'accepted' : sent ? 'partial' : 'unconfirmed', sent, of: numbers.length};
}
async function readSigned(req, res, options) {
  let raw=req.rawBody?.toString() || '';
  if (!raw) for await(const chunk of req) {
    raw+=chunk.toString();
    if(Buffer.byteLength(raw)>4096){res.status(413).json({status:'too_large'});return null;}
  }
  if(Buffer.byteLength(raw)>4096){res.status(413).json({status:'too_large'});return null;}
  if(!validSignature(raw,req.headers['x-tps-signature'],options.secret || process.env.TPS_INTERNAL_KEY)){
    res.status(401).json({status:'unauthorized'});return null;}
  try{return JSON.parse(raw);}catch{res.status(400).json({status:'invalid'});return null;}
}
function phoneSender(options) {
  const token=process.env.PHONECOM_API_TOKEN;
  return options.send || (async(path,body)=>{
    // A timeout can mean the provider accepted the message. Never retry a POST here.
    const r=await fetch('https://api.phone.com/v4'+path,{method:'POST',
      headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body:JSON.stringify(body),signal:AbortSignal.timeout(12000),redirect:'error'});
    if(r.status!==201)throw Error('Phone.com send was not accepted');
  });
}
function registerEmergencySms(receiver, options={}) {
  receiver.router.post('/internal/phone/emergency-ack', async(req,res)=>{
    try {
      const input=await readSigned(req,res,options);
      if(!input)return;
      const phone=options.phone || createPhoneCom();
      return res.json(await sendEmergencyAcknowledgment(input,phone,phoneSender(options)));
    }catch{return res.status(502).json({status:'unconfirmed'});}
  });
  receiver.router.post('/internal/phone/office-er-alert', async(req,res)=>{
    try {
      const input=await readSigned(req,res,options);
      if(!input)return;
      const phone=options.phone || createPhoneCom();
      const path='/accounts/'+encodeURIComponent(await phone.accountId())+'/messages';
      return res.json(await sendStaffAlert(input,phoneSender(options),path,options.numbers?{numbers:options.numbers}:{}));
    }catch{return res.status(502).json({status:'unconfirmed'});}
  });
}
module.exports={registerEmergencySms,sendEmergencyAcknowledgment,sendStaffAlert,staffAlertNumbers,validSignature};
