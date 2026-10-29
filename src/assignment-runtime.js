'use strict';
const {createHash}=require('node:crypto');
const {TECHS}=require('./assignment-policy');
const {parseReplies,messageText}=require('./parse');
const {createHelperService}=require('./assignment-helper');
const LIST='F0C39RE7HDK',INCOMING='C0C19TG3KJ6',ASSIGN='C0C2XUL7ZHN',FUTURE='C0C2XB4VD1N',COMPLETED='C0C2YDBHFFY';
const ROUTE='https://webhook.latenode.com/27333/prod/eb873fbf-b964-4cf3-a704-adeb16274831';
const hash=v=>createHash('sha256').update(String(v)).digest('hex');
function createRuntime({store,slack,fetch:fetcher=global.fetch,key,actor,serialized=false,token,now=()=>new Date(),copyContribution,adminSlack}){
 const get=async k=>{const v=await store.getGlobalVariable(k);if(!v)return null;return typeof v==='string'?JSON.parse(v):v;};
 const set=async(k,v)=>store.setGlobalVariable(k,JSON.stringify(v));
 const api=async(method,p)=>{const r=await slack(method,p);if(!r?.ok){const e=Error('Slack '+method+' failed: '+(r?.error||'no result'));e.slackError=r?.error;throw e;}return r;};
 async function pages(method,p,field){const found=[];let cursor;do{const r=await api(method,{...p,limit:200,...(cursor?{cursor}:{})});found.push(...r[field]||[]);cursor=r.response_metadata?.next_cursor;if(r.has_more&&!cursor)throw Error('Slack history was incomplete.');if(found.length>10000)throw Error('History exceeds the verified scan limit.');}while(cursor);return found;}
 const readThread=h=>pages('conversations.replies',{channel:h.channel,ts:h.ts},'messages');
 function field(record,id){return(record.fields||[]).find(f=>f.column_id===id||f.key===id);}
 function checked(record,id){const f=field(record,id);return f?.checkbox===true||f?.value===true||f?.value==='true';}
 const threadKey=(ch,ts)=>'TPS_HELPER_THREAD_'+ch+'_'+ts.replace('.','');
 async function sourceFromRecord(record,lead,r){
  const f=field(record,'Col0C5CNVAHH8')||field(record,'Col0C56LDTN9Z');
  const m=Array.isArray(f?.message)?f.message[0]:f?.message;
  const link=m?.value||m?.url||f?.value||f?.text||'';
  const match=String(link).match(/archives\/(C[A-Z0-9]+)\/p(\d{10})(\d{6})/);
  const expected=TECHS.find(t=>t.id===lead);
  if(lead&&match&&match[1]===expected?.channel){const messages=await readThread({channel:match[1],ts:match[2]+'.'+match[3]});const message=messages.find(m=>m.ts===match[2]+'.'+match[3]);if(!message)throw Error('Current plumber card missing.');return{channel:match[1],ts:message.ts,message};}
  const channels=lead?[expected?.channel]:[ASSIGN,FUTURE];
  for(const channel of channels.filter(Boolean)){
   const rows=await pages('conversations.history',{channel},'messages');
   const message=rows.find(m=>JSON.stringify(m.blocks||[]).includes('tpsref:'+r.recordId+':'+r.incomingTs)||messageText(m).includes(r.recordId)&&messageText(m).includes(r.incomingTs));
   if(message)return{channel,ts:message.ts,message};
  }
  throw Error('The current assignment source card could not be verified.');
 }
 async function loadCall(r){
  const info=await api('slackLists.items.info',{list_id:LIST,id:r.recordId});const record=info.record;
  if(!record||record.id!==r.recordId)throw Error('Calls record missing.');
  const named=(record.fields||[]).find(f=>f.key==='name')||field(record,'Col0C38GZ8N4T')||(record.fields||[]).find(f=>/^\d{5,7}$/.test(f.text||''));
  const jobNumber=String(named?.text||named?.value||'').trim();if(!/^\d{5,7}$/.test(jobNumber))throw Error('Invoice number missing.');
  const replies=await readThread({channel:INCOMING,ts:r.incomingTs}),parent=replies.find(m=>m.ts===r.incomingTs);
  if(!parent||!new RegExp('(^|\\D)'+jobNumber+'(\\D|$)').test(messageText(parent)))throw Error('Incoming identity mismatch.');
  const history=parseReplies(replies.slice(1).map(m=>({ts:m.ts,text:messageText(m)})));
  const who=field(record,'Col01')||field(record,'todo_assignee');const user=Array.isArray(who?.user)?who.user[0]:who?.user||who?.value;
  const assigned=checked(record,'Col0C5ECNLSBS')||checked(record,'Col0C4EUSL2BF');
  const lead=assigned&&TECHS.some(t=>t.id===user)?user:null;
  const closed=checked(record,'Col00')||checked(record,'Col0C4PN1VB36');
  const stage=history.canceled?'cancelled':closed?'closed':checked(record,'Col0C5ECTA9TJ')?'closing':checked(record,'Col0C4PMWD5T6')?'completed':lead?'plumber':'unassigned';
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(now());
  const c={readVerified:true,recordId:record.id,incomingTs:r.incomingTs,jobNumber,lead,helper:null,stage,today,appointmentDate:history.scheduledFor?.date||null,address:messageText(parent).slice(0,1500)};
  // Ineligible stages must reach policy refusal without resolving a stale source card.
  if(['plumber','unassigned'].includes(stage)){c.source=await sourceFromRecord(record,lead,r);const sourceSchedule=parseReplies([{text:messageText(c.source.message),ts:c.source.ts}]).scheduledFor;if(sourceSchedule)c.appointmentDate=sourceSchedule.date;}
  return c;
 }
 const ctx={authenticated:!!key,serialized,actor,now:()=>now().getTime(),requests:{get:id=>get('TPS_ASSIGN_REQUEST_'+id),set:(id,v)=>set('TPS_ASSIGN_REQUEST_'+id,v)},state:{get:id=>get('TPS_ASSIGN_STATE_'+id),set:(id,v)=>set('TPS_ASSIGN_STATE_'+id,v)},loadCall};
 const files={read:async f=>{const u=new URL(f.url_private_download||f.url_private);if(u.protocol!=='https:'||u.hostname!=='files.slack.com')throw Error('Unexpected Slack file URL.');const res=await fetcher(u.href,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(30000)});if(!res.ok)throw Error('Helper file could not be downloaded.');return Buffer.from(await res.arrayBuffer());}};ctx.files=files;
 const adapter={
  get,set,digest:hash,readThread,
  findCard:async(c,h)=>{
   const tag='tps_helper:'+c.recordId+':'+h.requestId;
   const channel=TECHS.find(t=>t.id===h.user)?.channel;if(!channel)throw Error('Unknown helper.');
   const messages=await pages('conversations.history',{channel},'messages');const m=messages.find(m=>(m.blocks||[]).some(b=>b.block_id===tag));
   if(!m)return null;await set(threadKey(channel,m.ts),{call:c,helper:{...h,channel,ts:m.ts}});return{channel,ts:m.ts};
  },
  postCard:async(c,h,blocks)=>{
   const channel=TECHS.find(t=>t.id===h.user)?.channel;if(!channel)throw Error('Unknown helper.');
   blocks[0].block_id='tps_helper:'+c.recordId+':'+h.requestId;
   const r=await api('chat.postMessage',{channel,text:'Helper — call '+c.jobNumber,blocks,unfurl_links:false,client_msg_id:h.requestId});
   if(!r.ts)throw Error('Helper post has no message ID.');
   await set(threadKey(channel,r.ts),{call:c,helper:{...h,channel,ts:r.ts}});
   return{channel,ts:r.ts};
  },
  updateCard:async(h,blocks)=>{await api('chat.update',{channel:h.channel,ts:h.ts,text:'Helper call',blocks});const idx=await get(threadKey(h.channel,h.ts));if(idx){idx.helper=h;await set(threadKey(h.channel,h.ts),idx);}},
  currentLeadSource:async(c,lead)=>{const latest=await loadCall(c);if(latest.lead!==lead)throw Error('New lead not verified.');return latest.source;},
  deleteCard:async(h,snapshot,c,beforeParentDelete)=>{
   const {cleanupHelperThread}=require('./assignment-cleanup');
   let adminVerified=false;
   await cleanupHelperThread(h,snapshot,c,{readThread,digest:hash,beforeParentDelete,deleteMessage:async(channel,ts,parent)=>{
    if(parent){await api('chat.delete',{channel,ts});return;}
    if(!adminSlack)throw Error('Userbot cleanup connection unavailable.');
    if(!adminVerified){const who=await adminSlack('auth.test',{});if(!who?.ok||who.user_id!=='U0876C3TEGL')throw Error('Cleanup requires the verified Paul Userbot connection.');adminVerified=true;}
    const result=await adminSlack('chat.delete',{channel,ts});if(!result?.ok)throw Error('Helper reply cleanup failed; retain the card for retry.');
   }});
  },
  copy:copyContribution||(async(m,d,ref)=>{const {copyHelperContribution}=require('./assignment-files');return copyHelperContribution(m,d,ref,{api,pages,get,set,hash,files,fetch:fetcher});}),
  verifyCopies:async(c,h)=>{
   const {copyHelperContribution}=require('./assignment-files');
   for(const m of (await readThread(h)).slice(1))for(const d of [{channel:INCOMING,ts:c.incomingTs},...(c.source?[c.source]:[])]){const check=await copyHelperContribution(m,d,{sourceChannel:h.channel,sourceTs:m.ts,revision:hash(JSON.stringify([m.ts,m.user||'',m.text||'',m.blocks||[],(m.files||[]).map(f=>f.id).sort()])),helper:h.user,recordId:c.recordId},{api,pages,get,set,hash,files,fetch:fetcher,verifyOnly:true});if(!check.verified)return false;}return true;
  }
 };
 ctx.helper=createHelperService(adapter);
 ctx.dispatch=async(r,c)=>{
  const tech=TECHS.find(t=>t.id===r.target);
  const action=r.operation==='lead_complete'?'complete_call':r.operation==='reassign'?'reassign_to_'+tech.name.toLowerCase():'assign_'+tech.name.toLowerCase();
  const payload={type:'block_actions',user:{id:r.actor},channel:{id:c.source.channel},container:{channel_id:c.source.channel,message_ts:c.source.ts},message:c.source.message,actions:[{type:'button',action_id:action,text:{type:'plain_text',text:tech?.name||'Complete'},value:'Submit'}]};
  const capKey='TPS_ASSIGN_DISPATCH_'+r.requestId;
  const existing=await get(capKey);
  if(existing?.used)throw Error('A dispatched change must be reconciled, never repeated.');
  await set(capKey,{used:false,expires:now().getTime()+10*60e3,requestId:r.requestId,payload});
  const response=await fetcher(ROUTE,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload:JSON.stringify({tps_assignment_dispatch:r.requestId,key})}),signal:AbortSignal.timeout(90000)});
  if(!response.ok)throw Error('The routing response was interrupted.');
 };
 ctx.verifyDispatch=async(r,c)=>{
  const latest=await loadCall(r);
  if(r.operation!=='lead_complete')return latest.stage==='plumber'&&latest.lead===r.target&&latest.source.channel===TECHS.find(t=>t.id===r.target)?.channel;
  if(latest.stage!=='completed')return false;
  const rows=await pages('conversations.history',{channel:COMPLETED},'messages');
  return rows.some(m=>JSON.stringify(m.blocks||[]).includes('tpsref:'+r.recordId+':'+r.incomingTs)||messageText(m).includes(r.recordId)&&messageText(m).includes(r.incomingTs));
 };
 ctx.audit=async(r,c,state)=>{
  const marker='tps_assignment_audit:'+r.requestId;const replies=await readThread({channel:INCOMING,ts:c.incomingTs});
  if(replies.some(m=>(m.blocks||[]).some(b=>b.block_id===marker)))return;
  const text=r.operation==='helper_add'?'TPS helper assigned: <@'+r.target+'> <https://tpsplumbing.slack.com/archives/'+state.helper.channel+'/p'+state.helper.ts.replace('.','')+'|Helper thread>':r.operation==='helper_remove'||r.operation==='helper_done'?'TPS helper removed':r.operation==='lead_complete'?'TPS helper removed — work archived before lead completion':'TPS lead assigned: <@'+r.target+'>';
  await api('chat.postMessage',{channel:INCOMING,thread_ts:c.incomingTs,text:text+' by <@'+r.actor+'>',blocks:[{type:'section',block_id:marker,text:{type:'mrkdwn',text:text+' by <@'+r.actor+'>'}}],unfurl_links:false});
 };
 ctx.reconcileEvent=async event=>{
  if(!event.thread_ts||!event.channel)return{status:'done',ignored:true};
  const idx=await get(threadKey(event.channel,event.thread_ts));if(!idx)return{status:'done',ignored:true};
  const m=event.subtype==='message_changed'?event.message:event;
  if(!m?.ts||m.ts===event.thread_ts)return{status:'done',ignored:true};
  await ctx.helper.reconcile(idx.call,idx.helper,m);return{status:'done'};
 };
 return ctx;
}
module.exports={createRuntime};
