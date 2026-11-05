'use strict';
const {createHash,createHmac,timingSafeEqual,randomUUID}=require('node:crypto');
const {deflateRawSync,inflateRawSync}=require('node:zlib');
const {slackApi}=require('./job-files');
const {cardIdentity,messageUrl}=require('./workflow');
const {messageText}=require('./parse');
const {ADMINS,TECHS}=require('./assignment-policy');
const REVIEW='C0CEUFVA3FX',INCOMING='C0C19TG3KJ6',BOT='U0C52NTH4LW';
const TESTING='C0C2ZVB32RG';
const SOURCES=[INCOMING,'C0C2XUL7ZHN','C0C2XB4VD1N','C0C2YDBHFFY','C0C5VVDCQ92','C0C5B0WGZ7H',...TECHS.map(t=>t.channel)];
const CALLBACK='tps_cancel_request_modal',EVENT='tps_cancel_review',locks=new Set();
const pt=text=>({type:'plain_text',text:String(text).slice(0,150)});
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const key=o=>o.TPS_INTERNAL_KEY||o.key||process.env.TPS_INTERNAL_KEY;
const action=p=>p.actions?.[0]?.selected_option?.value||p.actions?.[0]?.action_id||'';
const channel=p=>p.channel?.id||p.container?.channel_id;
const stamp=p=>p.container?.message_ts||p.message?.ts;
const snapshot=m=>({text:m.text||'',blocks:m.blocks||[]});
const fingerprint=m=>hash(snapshot(m));
const childBlocks=blocks=>JSON.parse(JSON.stringify(blocks||[],(k,v)=>k==='block_id'?undefined:v));
const fileRevision=m=>(m.files||[]).map(f=>({id:f.id,name:f.name,title:f.title,size:f.size,mimetype:f.mimetype,mode:f.mode,permalink:f.permalink}));
// Slack regenerates block IDs for plain-text replies between reads; content and file identities are stable.
const contribution=m=>({ts:m.ts,text:m.text||'',blocks:childBlocks(m.blocks),files:fileRevision(m),attachments:m.attachments||[],pinned_to:m.pinned_to||[]});
const revision=rows=>hash(rows.map((m,i)=>i?contribution(m):{ts:m.ts,...snapshot(m),files:fileRevision(m),attachments:m.attachments||[],pinned_to:m.pinned_to||[]}));
const resultView=text=>({type:'modal',title:pt('Cancellation'),close:pt('Close'),blocks:[{type:'section',text:{type:'plain_text',text:String(text).slice(0,2900)}}]});
function sign(data,o){const body=Buffer.from(JSON.stringify({...data,expires:Date.now()+15*60000})).toString('base64url');return body+'.'+createHmac('sha256',key(o)).update(body).digest('hex');}
function decode(value,actor,o){const [body,sig,...extra]=String(value||'').split('.'),expected=createHmac('sha256',key(o)).update(body||'').digest('hex');if(extra.length||!/^[a-f0-9]{64}$/.test(sig||'')||!timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))throw Error('Reopen the cancellation tool.');const d=JSON.parse(Buffer.from(body,'base64url'));if(d.actor!==actor||d.expires<Date.now())throw Error('This form expired or belongs to another person.');return d;}
function packed(m){const value=deflateRawSync(Buffer.from(JSON.stringify(snapshot(m)))).toString('base64');if(value.length>3500)throw Error('This card is too large to move safely. It has been kept in its original channel.');return value;}
function unpacked(value){return JSON.parse(inflateRawSync(Buffer.from(value,'base64'),{maxOutputLength:200000}).toString());}
function intercepts(p){return [CALLBACK,'cancel_call_modal'].includes(p.view?.callback_id)||['cancel_call','cancel_open','cancel_confirm','cancel_submit','tps_cancel_request','tps_cancel_review_approve','tps_cancel_restore'].includes(action(p))||action(p)==='cancel_keep'&&channel(p)===REVIEW;}
function submissionError(p){if(p.view?.callback_id!==CALLBACK)return null;const reason=String(p.view?.state?.values?.cancel_reason?.reason?.value||'').trim();return reason.length>1000?'Keep the reason within 1,000 characters.':null;}
function runtime(o){const token=o.TPS_BOT_TOKEN||process.env.TPS_BOT_TOKEN,fetcher=o.fetch||global.fetch;const api=async(m,p)=>{if(!['conversations.history','conversations.replies','pins.list','slackLists.items.info'].includes(m))return slackApi(m,p,token,fetcher);const url=new URL('https://slack.com/api/'+m);for(const[k,v]of Object.entries(p||{}))url.searchParams.set(k,String(v));const r=await fetcher(url.href,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)}),j=await r.json();if(!j.ok)throw Error(m+': '+j.error);return j;};return{api,async pages(method,p){const all=[];let cursor;do{const r=await api(method,{...p,limit:200,...(cursor?{cursor}:{})});all.push(...r.messages||[]);cursor=r.response_metadata?.next_cursor;if(r.has_more&&!cursor)throw Error('Slack history was incomplete. Nothing else was removed.');if(all.length>10000)throw Error('Review history is too large to verify safely.');}while(cursor);return all;}};}
async function read(a,ch,ts){const r=await a.api('conversations.history',{channel:ch,oldest:ts,latest:ts,inclusive:true,limit:1,include_all_metadata:true});return(r.messages||[]).find(m=>m.ts===ts);}
function requireSource(m,ch,actor){const test=ch===TESTING&&cardIdentity(m||{}).jobNumber==='999991'&&(m.blocks||[]).some(b=>b.block_id==='tps_cancel_test');if(!m||m.user!==BOT||!(SOURCES.includes(ch)||test)||!cardIdentity(m).jobNumber)throw Error('The current call card could not be verified.');if((m.files||[]).length||(m.attachments||[]).length)throw Error('This card has files or attachments on the main post. The source was kept for manual review.');if(!ADMINS.includes(actor)&&!TECHS.some(t=>t.id===actor&&t.channel===ch))throw Error('You may request cancellation only on your own assigned calls.');return{...cardIdentity(m),test};}
async function review(a,ts){const m=await read(a,REVIEW,ts);if(!m||m.user!==BOT||m.metadata?.event_type!==EVENT)throw Error('The cancellation review card is no longer available.');return m;}
async function currentCards(a,job){const sources=await Promise.all((job==='999991'?[TESTING]:SOURCES.filter(ch=>ch!==INCOMING)).map(async ch=>({ch,messages:await a.pages('conversations.history',{channel:ch,include_all_metadata:true})})));return sources.flatMap(s=>s.messages.filter(m=>m.user===BOT&&(!m.thread_ts||m.thread_ts===m.ts)&&!(m.blocks||[]).some(b=>String(b.block_id||'').startsWith('tps_helper:'))&&cardIdentity(m).jobNumber===job).map(m=>({channel:s.ch,message:m}))).sort((a,b)=>Number(b.message.ts)-Number(a.message.ts));}
function queueBlocks(m,d){const keep=(m.blocks||[]).filter(b=>b.type!=='input'&&(b.type!=='actions'||b.block_id==='tps_card_resource_links'));return[{type:'section',block_id:'tps_cancel_review_status',text:{type:'mrkdwn',text:`*Cancellation requested · ${d.jobNumber}*\nReason: ${d.reason.replace(/[<>&]/g,'')}\nRequested by <@${d.actor}>. QuickBooks is unchanged.`}},...keep,{type:'actions',block_id:'tps_cancel_review_actions',elements:[{type:'button',action_id:'tps_cancel_review_approve',text:pt('Review final cancellation'),style:'danger',value:d.requestId},{type:'button',action_id:'tps_cancel_restore',text:pt('Restore call'),value:d.requestId}]}];}
async function archiveReplies(a,source,target){
 const rows=await a.pages('conversations.replies',{channel:source.channel,ts:source.ts});const children=rows.filter(m=>m.ts!==source.ts),existing=await a.pages('conversations.replies',{channel:target.channel,ts:target.ts});
 for(const m of children){if((m.attachments||[]).length||/"type":"(?:image|video|file|audio|actions)"/.test(JSON.stringify(m.blocks||[])))throw Error('A reply has attached content that needs manual review. The source was kept.');const marker='tps_cancel_archive:'+hash([source.channel,contribution(m)]).slice(0,40);if(existing.some(x=>(x.blocks||[]).some(b=>b.block_id===marker)))continue;
  const files=(m.files||[]).map(f=>{if(!f.permalink)throw Error('A file could not be archived safely. The source card was kept.');return'<'+f.permalink+'|'+String(f.name||'File').replace(/[<>&|]/g,'')+'>';});
  const body=messageText(m).trim();if(!body&&!files.length&&(m.blocks||[]).length)throw Error('A reply could not be archived as readable text. The source was kept.');const text=[m.user?'From <@'+m.user+'>:':'Call comment:',body,...files].filter(Boolean).join('\n');const parts=text.match(/[\s\S]{1,2800}/g)||['Call comment'];
  await a.api('chat.postMessage',{channel:target.channel,thread_ts:target.ts,text,blocks:parts.map((part,i)=>({type:'section',block_id:i?marker+':'+i:marker,text:{type:'mrkdwn',text:part}})),unfurl_links:false,unfurl_media:false});
  const checked=await a.pages('conversations.replies',{channel:target.channel,ts:target.ts});if(!checked.some(x=>(x.blocks||[]).some(b=>b.block_id===marker)))throw Error('Archived comments are not verified. The source card was kept.');
 }
 const after=await a.pages('conversations.replies',{channel:source.channel,ts:source.ts});if(revision(after)!==revision(rows))throw Error('A comment or attachment changed. Reopen the tool before moving this card.');return revision(after);
}
async function unchanged(a,source,expected){const pins=await a.api('pins.list',{channel:source.channel});if((pins.items||[]).some(x=>x.message?.ts===source.ts))throw Error('This card is pinned. Unpin it before moving it.');const parent=await read(a,source.channel,source.ts);if(!parent||(parent.files||[]).length||(parent.attachments||[]).length||(parent.pinned_to||[]).length)throw Error('The source post changed or has attachments. It was kept.');const now=await a.pages('conversations.replies',{channel:source.channel,ts:source.ts});if(revision(now)!==expected)throw Error('A new comment or attachment arrived before removal. The source was kept.');}
async function history(a,ids,text,id){if(ids.test||!ids.incomingTs)return;const parent=await read(a,INCOMING,ids.incomingTs);if(cardIdentity(parent||{}).jobNumber!==ids.jobNumber)throw Error('Incoming call history could not be verified. Source kept.');const rows=await a.pages('conversations.replies',{channel:INCOMING,ts:ids.incomingTs}),marker='tps_cancel_history:'+id;if(!rows.some(m=>(m.blocks||[]).some(b=>b.block_id===marker)))await a.api('chat.postMessage',{channel:INCOMING,thread_ts:ids.incomingTs,text,blocks:[{type:'section',block_id:marker,text:{type:'mrkdwn',text}}]});}
async function requestCancellation(p,d,o){
 const a=runtime(o),reason=String(p.view.state?.values?.cancel_reason?.reason?.value||'').trim();if(!reason)throw Error('Enter a cancellation reason.');
 const m=await read(a,d.channel,d.ts),ids=requireSource(m,d.channel,p.user.id);if(fingerprint(m)!==d.hash||ids.jobNumber!==d.jobNumber)throw Error('This call changed. Reopen its current card.');if(!ids.incomingTs)throw Error('The Incoming Calls reference is missing. The card was kept.');
 const latest=(await currentCards(a,ids.jobNumber))[0];if(latest&&(latest.channel!==d.channel||latest.message.ts!==d.ts))throw Error('This is an older card. Open the current call from the Job Board to request cancellation.');
 const all=await a.pages('conversations.history',{channel:REVIEW,include_all_metadata:true});let q=all.find(x=>x.user===BOT&&x.metadata?.event_type===EVENT&&x.metadata.event_payload?.source_channel===d.channel&&x.metadata.event_payload?.source_ts===d.ts);
 if(q&&q.metadata.event_payload.reason!==reason)throw Error('A different cancellation request already exists. Review it in #cancellation-review.');
 if(!q){const saved={request_id:d.requestId,source_channel:d.channel,source_ts:d.ts,job_number:ids.jobNumber,incoming_ts:ids.incomingTs,record_id:ids.recordId||'',snapshot:packed(m),reason,actor:p.user.id,status:'pending',test:ids.test};if(Buffer.byteLength(JSON.stringify(saved))>4000)throw Error('This card cannot be safely stored for review. The source was kept.');const r=await a.api('chat.postMessage',{channel:REVIEW,text:`${ids.jobNumber} — cancellation requested: ${reason}`,blocks:queueBlocks(m,{...d,...ids,reason}),metadata:{event_type:EVENT,event_payload:saved},unfurl_links:false,unfurl_media:false});q=await review(a,r.ts);}
 const queued=q.metadata.event_payload;if(queued.status!=='pending')throw Error('This request is already under review. The source was kept.');
 const archived=await archiveReplies(a,{channel:d.channel,ts:d.ts},{channel:REVIEW,ts:q.ts});
 await history(a,ids,`Cancellation requested by <@${p.user.id}>: ${reason}\n<${messageUrl(REVIEW,q.ts)}|Cancellation review>. QuickBooks is unchanged.`,queued.request_id);
 const current=await read(a,d.channel,d.ts);if(!current||fingerprint(current)!==d.hash)throw Error('The source changed before removal. Review copy saved; source kept.');
 if(d.channel!==INCOMING){await unchanged(a,{channel:d.channel,ts:d.ts},archived);await a.api('chat.delete',{channel:d.channel,ts:d.ts});}
 return'Cancellation requested. The call is in #cancellation-review. Its QuickBooks invoice has not been changed.';
}
async function restore(p,d,o){
 if(!ADMINS.includes(p.user.id))throw Error('Only admins may restore calls.');const a=runtime(o),q=await review(a,d.ts),meta=q.metadata.event_payload;
 if(!['pending','reviewing','restoring'].includes(meta.status)||meta.request_id!==d.requestId)throw Error('This cancellation has already changed. Check its current review card.');
 await a.api('chat.update',{channel:REVIEW,ts:q.ts,text:q.text,blocks:q.blocks,metadata:{...q.metadata,event_payload:{...meta,status:'restoring'}}});
 const elsewhere=await currentCards(a,meta.job_number);if(elsewhere.some(x=>!(x.channel===meta.source_channel&&(x.message.ts===meta.source_ts||x.message.metadata?.event_payload?.request_id===meta.request_id))))throw Error('Another current card for this call is already present. Review it before restoring.');
 const original=unpacked(meta.snapshot),rows=await a.pages('conversations.history',{channel:meta.source_channel});
 if(rows.some(m=>m.user===BOT&&cardIdentity(m).jobNumber===meta.job_number&&m.ts!==meta.source_ts&&m.metadata?.event_payload?.request_id!==meta.request_id))throw Error('Another current card for this call is already present. Review it before restoring.');
 let found=rows.find(m=>m.user===BOT&&m.metadata?.event_type==='tps_cancel_restored'&&m.metadata.event_payload?.request_id===meta.request_id)||rows.find(m=>m.ts===meta.source_ts&&fingerprint(m)===hash(original));
 if(!found){const r=await a.api('chat.postMessage',{channel:meta.source_channel,...original,metadata:{event_type:'tps_cancel_restored',event_payload:{request_id:meta.request_id}},unfurl_links:false,unfurl_media:false});found=await read(a,meta.source_channel,r.ts);if(!found||fingerprint(found)!==hash(original))throw Error('Restored card is not yet verified. Review card kept.');}
 const archived=await archiveReplies(a,{channel:REVIEW,ts:q.ts},{channel:meta.source_channel,ts:found.ts});
 if(meta.record_id&&TECHS.some(t=>t.channel===meta.source_channel))await a.api('slackLists.items.update',{list_id:'F0C39RE7HDK',cells:[{row_id:meta.record_id,column_id:'Col0C5CNVAHH8',message:[messageUrl(meta.source_channel,found.ts)]}]});
 await history(a,{jobNumber:meta.job_number,incomingTs:meta.incoming_ts,test:meta.test},`Cancellation request withdrawn by <@${p.user.id}>. <${messageUrl(meta.source_channel,found.ts)}|Call restored>. QuickBooks is unchanged.`,meta.request_id+':restored');
 await unchanged(a,{channel:REVIEW,ts:q.ts},archived);await a.api('chat.delete',{channel:REVIEW,ts:q.ts});return'Call restored to its original channel. QuickBooks is unchanged.';
}
async function route(p,o={}){
 const a=runtime(o),actor=p.user?.id,act=action(p);
 if(p.view?.callback_id==='cancel_call_modal'||['cancel_confirm','cancel_submit'].includes(act)){
  let loc;try{loc=JSON.parse(p.view?.private_metadata||p.actions?.[0]?.value||'{}');}catch{throw Error('Reopen the final cancellation review.');}
  if(loc.channel!==REVIEW||!ADMINS.includes(actor))throw Error('Final cancellation is available only to admins in #cancellation-review. Use Request cancellation first.');
  const id='review:'+loc.ts;if(locks.has(id))throw Error('This review is already being processed.');locks.add(id);
  try{const q=await review(a,loc.ts),meta=q.metadata.event_payload;if(meta.test)throw Error('This is a test card. Final invoice cancellation is disabled.');if(!['pending','reviewing'].includes(meta.status)||String(loc.job)!==meta.job_number||loc.thread!==meta.incoming_ts||String(loc.rec||'')!==String(meta.record_id||''))throw Error('This final confirmation is stale or does not match the review request.');
   const values=p.view?.state?.values||p.state?.values;if(!String(values?.cancel_note_block?.cancel_note_input?.value||'').trim())throw Error('Enter the final cancellation reason first.');
   await a.api('chat.update',{channel:REVIEW,ts:loc.ts,text:q.text,blocks:[...q.blocks.filter(b=>b.type!=='actions'&&b.type!=='input'),{type:'section',text:{type:'plain_text',text:'Final cancellation requested. Check Incoming Calls for the result before repeating or restoring this call.'}}],metadata:{...q.metadata,event_payload:{...meta,status:'approved',approved_by:actor}}});return{forward:p};
  }finally{locks.delete(id);}
 }
 if(p.type==='view_submission'){
  const d=decode(p.view.private_metadata,actor,o),id=d.operation==='restore'?'review:'+d.ts:d.channel+':'+d.ts;if(locks.has(id))throw Error('This request is already being processed.');locks.add(id);let text;
  try{text=d.operation==='restore'?await restore(p,d,o):await requestCancellation(p,d,o);}catch(e){text=e.message;}finally{locks.delete(id);}
  await a.api('views.update',{view_id:p.view.id,view:resultView(text)});return{};
 }
 const ch=channel(p),ts=stamp(p);
 if(act==='cancel_keep'){
  if(ch!==REVIEW||!ADMINS.includes(actor))throw Error('Only admins may change cancellation reviews.');const q=await review(a,ts),meta=q.metadata.event_payload;
  if(!['pending','reviewing'].includes(meta.status))throw Error('This review is already being processed. Check Incoming Calls for its result.');
  await a.api('chat.update',{channel:REVIEW,ts,text:q.text,blocks:queueBlocks(unpacked(meta.snapshot),{jobNumber:meta.job_number,actor:meta.actor,reason:meta.reason,requestId:meta.request_id}),metadata:{...q.metadata,event_payload:{...meta,status:'pending'}}});return{};
 }
 if(act==='tps_cancel_review_approve'){
  if(ch!==REVIEW||!ADMINS.includes(actor))throw Error('Only admins may approve cancellation requests.');
  const q=await review(a,ts);if(!['pending','reviewing'].includes(q.metadata.event_payload.status))throw Error('This request is already being reviewed.');
  if(q.metadata.event_payload.test){await a.api('views.open',{trigger_id:p.trigger_id,view:resultView('TEST — The real tool would open the final cancellation confirmation here. No invoice was changed. Use Restore call to put this test card back.')});return{};}
  await a.api('chat.update',{channel:REVIEW,ts,text:q.text,blocks:q.blocks,metadata:{...q.metadata,event_payload:{...q.metadata.event_payload,status:'reviewing'}}});
  return{forward:{...p,message:q,actions:[{type:'button',action_id:'cancel_call',value:'cancel_call'}]}};
 }
 const opened=await a.api('views.open',{trigger_id:p.trigger_id,view:resultView('Checking the current call…')});
 try{
  let d,blocks;
  if(act==='tps_cancel_restore'){
   if(ch!==REVIEW||!ADMINS.includes(actor))throw Error('Only admins may restore calls.');const q=await review(a,ts),meta=q.metadata.event_payload;if(!['pending','reviewing','restoring'].includes(meta.status))throw Error('This request is already under review.');d={operation:'restore',actor,ts,requestId:meta.request_id};blocks=[{type:'section',text:{type:'plain_text',text:`Restore ${meta.job_number} to its original channel? Its invoice will remain unchanged.`}}];
  }else{
   const m=await read(a,ch,ts),ids=requireSource(m,ch,actor);d={operation:'request',actor,channel:ch,ts,...ids,hash:fingerprint(m),requestId:randomUUID()};blocks=[{type:'section',text:{type:'mrkdwn',text:`*Request cancellation · ${ids.jobNumber}*\nMoves this call to #cancellation-review. QuickBooks remains unchanged until an admin approves final cancellation.`}},{type:'input',block_id:'cancel_reason',label:pt('Cancellation reason'),element:{type:'plain_text_input',action_id:'reason',multiline:true,max_length:1000}}];
  }
  const view={type:'modal',callback_id:CALLBACK,private_metadata:sign(d,o),title:pt(d.operation==='restore'?'Restore call':'Request cancellation'),submit:pt(d.operation==='restore'?'Restore call':'Send for review'),close:pt('Close'),blocks};await a.api('views.update',{view_id:opened.view.id,view});
 }catch(e){await a.api('views.update',{view_id:opened.view.id,view:resultView(e.message)});}
 return{};
}
module.exports={REVIEW,CALLBACK,EVENT,action,intercepts,submissionError,route,sign,decode,packed,unpacked,queueBlocks,requestCancellation,restore,resultView};
