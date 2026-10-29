'use strict';
const {messageText,parseReplies}=require('./parse');
const workspace=()=>process.env.SLACK_WORKSPACE_URL||'https://tpsplumbing.slack.com';
const messageUrl=(channel,ts)=>workspace()+'/archives/'+channel+'/p'+ts.replace('.','');
function cardIdentity(message){
 const raw=JSON.stringify(message.blocks||[]),text=messageText(message);
 const title=(message.blocks||[]).find(b=>/^\d{5,7}$/.test(b.title?.text||''))?.title.text;
 const jobNumber=title||raw.match(/tpsbox\|(\d{5,7})\|/)?.[1]||text.match(/^\s*(\d{5,7})\s*(?:$|[\n·-])/m)?.[1];
 const ref=raw.match(/tpsref:(Rec[A-Za-z0-9]+):(\d{10}\.\d{6})/);
 const recordId=ref?.[1]||(raw+' '+text).match(/\bRec[A-Za-z0-9]+\b/)?.[0];
 const link=(raw+' '+text).match(/archives\/C0C19TG3KJ6\/p(\d{10})(\d{6})/);
 const incomingTs=ref?.[2]||(link?link[1]+'.'+link[2]:raw.match(/"text":"(\d{10}\.\d{6})"/)?.[1]||text.match(/^\s*(\d{10}\.\d{6})\s*$/m)?.[1]);
 return{jobNumber,recordId,incomingTs};
}
function indexWorkflow(sources){
 const found=new Map();
 for(const source of sources)for(const message of source.messages||[]){
  if((message.blocks||[]).some(b=>(b.block_id||'').startsWith('tps_helper:')))continue;
  if(message.thread_ts&&message.thread_ts!==message.ts)continue;
  const ids=cardIdentity(message);if(!ids.jobNumber)continue;
  const prior=found.get(ids.jobNumber);
  if(!prior||Number(message.ts)>Number(prior.message.ts))found.set(ids.jobNumber,{...source,messages:undefined,message,...ids});
 }
 return found;
}
function applyWorkflow(job,card){
 const message=card.message,ids=cardIdentity(message),text=messageText(message);
 const next={...job,recordId:job.recordId||ids.recordId,threadTs:job.threadTs||ids.incomingTs,workflowChannel:card.channel,workflowTs:message.ts};
 if(card.role==='completed')return{...next,workflowStage:'done',completed:true,reopened:false,completedAt:new Date(Number(message.ts)*1000),completedMessageUrl:messageUrl(card.channel,message.ts),assignedMessageUrl:null};
 // A leftover older source card must not reopen a completion already recorded in Incoming.
 if(job.completedAt&&Number(message.ts)*1000<=new Date(job.completedAt).getTime())return next;
 next.completed=false;next.reopened=Boolean(job.completed);
 if(card.role==='assign')return{...next,workflowStage:'new',tech:null,techId:null,assignedMessageUrl:null,scheduledFor:null,needsDate:false};
 if(card.role==='future'){
  const schedule=parseReplies([{text,ts:message.ts}]).scheduledFor;
  return{...next,workflowStage:'scheduled',tech:null,techId:null,assignedMessageUrl:null,futureTs:message.ts,scheduledFor:schedule,needsDate:!schedule};
 }
 if(card.role==='plumber'){
  const schedule=parseReplies([{text,ts:message.ts}]).scheduledFor;
  const start=job.visitStartedAt||job.assignedAt||new Date(Number(message.ts)*1000);
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:process.env.TZ_NAME||'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(start);
  const visitDate=schedule?.date||job.visitDate||day;
  const inherited=job.scheduledFor?.date>=visitDate?job.scheduledFor:null;
  return{...next,workflowStage:'assigned',tech:card.tech.name,techId:card.tech.id,visitDate,assignedAt:start,assignedMessageUrl:messageUrl(card.channel,message.ts),scheduledFor:schedule||inherited,needsDate:false};
 }
 return next;
}
function pendingActivity(messages){
 const replies=messages.slice(1).filter(m=>!/^\s*(?:Call (?:completed|assigned|reassigned)|TPS (?:lead|helper)|:white_check_mark:|⏳|⚠️)/i.test(m.text||''));
 const comment=m=>messageText(m).split('\n').filter(t=>!/^\s*(?:📸 Photos from|📷?\s*WhatsApp (?:media|photo|video) (?:from|·)|Forwarded (?:photo|video) from)/i.test(t)).join('\n').trim();
 return replies.some(m=>(m.files||[]).some(f=>/^image\/|^video\//.test(f.mimetype||'')||/\.(?:jpe?g|png|heic|gif|webp|mp4|mov)$/i.test(f.name||'')||!f.mimetype&&!f.name))&&replies.some(m=>comment(m).length>0);
}
module.exports={cardIdentity,indexWorkflow,applyWorkflow,pendingActivity,messageUrl};
