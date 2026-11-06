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
  if (route !== 'emergency_accepted') return "TPS Plumbing Inc: Your emergency request has been sent to the office. You will receive confirmation when it is accepted. A visit has not been confirmed. Reply STOP to opt out or HELP for help.";
  const raw=typeof acceptedBy==='string'?acceptedBy.trim():'';
  const name=/\bedgar\b/i.test(raw)||/^j\.?\s*r\.?$/i.test(raw)?'JR':raw;
  const attribution=/^[\p{L}\p{M}][\p{L}\p{M} .’'-]{0,49}$/u.test(name)?' by '+name:'';
  return 'TPS Plumbing Inc: Your emergency message has been accepted'+attribution+'. You will be contacted if necessary. Office may reply by txt. Thank you for using TPS Emergency Services.'+footer;
}
async function sendEmergencyAcknowledgment(input, phone, send, now = Date.now()) {
  const {eventId, recipient, route, issuedAt, inboundHash, inboundAt, replyId, acceptedBy} = input || {};
  const manual=route==='staff_reply', reply=typeof input?.text==='string'?input.text.trim():'';
  if(manual&&(!reply||reply.length>1200||!/^[A-Za-z0-9_-]{6,80}$/.test(replyId||'')))return {status:'invalid'};
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(eventId || '') ||
      !/^\+1\d{10}$/.test(recipient || '') || recipient === OFFICE ||
      !['office_emergency','emergency','emergency_accepted','staff_reply'].includes(route) ||
      !Number.isFinite(issuedAt) || Math.abs(now-issuedAt)>120000) return {status:'invalid'};
  const account = await phone.accountId();
  const path = '/accounts/'+encodeURIComponent(account)+'/messages';
  const history = await phone.request(path, {
    limit:500,'sort[id]':'desc','filters[direction]':'in','filters[from]':recipient,'filters[to]':OFFICE
  });
  if (!Array.isArray(history.items)) return {status:'history_unavailable'};
  const rows = history.items;
  const bound=rows.filter(row=>number(row.from)===recipient &&
    (Array.isArray(row.to)?row.to:[row.to]).some(v=>number(v)===OFFICE));
  const exact=bound.find(row=>ids(row).includes(eventId));
  const verifiedFingerprint=/^[a-f0-9]{64}$/.test(inboundHash||'')&&Number.isFinite(inboundAt)&&inboundAt>0;
  const matching=verifiedFingerprint?bound.filter(row=>fingerprint(row)===inboundHash &&
    Math.abs(messageTime(row.created_at)-inboundAt)<=120000):[];
  const original=exact||(matching.length===1?matching[0]:null);
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
function registerEmergencySms(receiver, options={}) {
  receiver.router.post('/internal/phone/emergency-ack', async(req,res)=>{
    try {
      let raw=req.rawBody?.toString() || '';
      if (!raw) for await(const chunk of req) {
        raw+=chunk.toString();
        if(Buffer.byteLength(raw)>4096)return res.status(413).json({status:'too_large'});
      }
      if(Buffer.byteLength(raw)>4096)return res.status(413).json({status:'too_large'});
      if(!validSignature(raw,req.headers['x-tps-signature'],options.secret || process.env.TPS_INTERNAL_KEY))
        return res.status(401).json({status:'unauthorized'});
      let input;
      try{input=JSON.parse(raw);}catch{return res.status(400).json({status:'invalid'});}
      const phone=options.phone || createPhoneCom();
      const token=process.env.PHONECOM_API_TOKEN;
      const send=options.send || (async(path,body)=>{
        // A timeout can mean the provider accepted the message. Never retry a POST here.
        const r=await fetch('https://api.phone.com/v4'+path,{method:'POST',
          headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
          body:JSON.stringify(body),signal:AbortSignal.timeout(12000),redirect:'error'});
        if(r.status!==201)throw Error('Phone.com send was not accepted');
      });
      return res.json(await sendEmergencyAcknowledgment(input,phone,send));
    }catch{return res.status(502).json({status:'unconfirmed'});}
  });
}
module.exports={registerEmergencySms,sendEmergencyAcknowledgment,validSignature};
