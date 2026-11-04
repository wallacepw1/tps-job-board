'use strict';
// "Write description" pop-up for #completed cards (Paul, Nov 4 2026). Opens from a button on the TPS Bot card and shows
// the plumber's notes, the Call Description box (already holding the card's text or the AI draft), the work order PDF and
// the job photos. Submitting uses the same Call Route action as Complete on the card.
const jf=require('./job-files');
const {ADMINS}=require('./assignment-policy');
const COMPLETED='C0C2YDBHFFY',ROUTE='https://webhook.latenode.com/27333/prod/eb873fbf-b964-4cf3-a704-adeb16274831';

const OPEN_ACTION='tps_desc_open',CALLBACK='tps_desc_modal';
const INPUT_BLOCK='notes_input_block',INPUT_ACTION='notes_input_action';
const MAX_PHOTOS=30,MAX_BLOCKS=100;
const env=(o,k)=>o[k]??process.env[k];
const plain=t=>({type:'plain_text',text:String(t).slice(0,150),emoji:true});
const clean=s=>String(s||'').replace(/[*_~`<>&]/g,'');

// ---- reading the card ----
function walk(x,fn){if(Array.isArray(x))x.forEach(v=>walk(v,fn));else if(x&&typeof x==='object'){fn(x);Object.values(x).forEach(v=>walk(v,fn));}}
function cardRefs(blocks=[]){
 let folderId=null,incoming=null,jobNumber='';
 walk(blocks,b=>{
  if(typeof b.url==='string'){
   folderId=folderId||jf.folderIdFrom(b.url);
   const m=b.url.match(/\/archives\/(C[A-Z0-9]+)\/p(\d{10})(\d{6})/);if(m&&!incoming)incoming={channel:m[1],ts:`${m[2]}.${m[3]}`};
  }
 });
 const b0=blocks[0]||{};
 jobNumber=([b0.title?.text,b0.text?.text].map(t=>String(t||'').match(/\b(\d{6})\b/)).find(Boolean)||[])[1]||'';
 if(!jobNumber)walk(blocks,b=>{if(!jobNumber&&typeof b.text==='string'){const m=b.text.match(/^\s*(\d{6})\b/);if(m)jobNumber=m[1];}});
 return{folderId,incoming,jobNumber};
}
function plumberNotes(blocks=[]){
 for(const b of blocks){
  if(b?.type!=='rich_text')continue;
  const els=b.elements?.[0]?.elements||[];
  if(!/^Plumber Notes/.test(els[0]?.text||''))continue;
  return els.slice(1).map(e=>e.text||(e.type==='user'?`@${e.user_id}`:'')).join('').trim();
 }
 return'';
}
const inputBlock=blocks=>(blocks||[]).find(b=>b?.type==='input'&&b.block_id===INPUT_BLOCK);
function currentText(payload){
 const sv=payload?.state?.values?.[INPUT_BLOCK]?.[INPUT_ACTION];
 if(sv&&sv.value!=null)return String(sv.value);
 return String(inputBlock(payload?.message?.blocks)?.element?.initial_value||'');
}

// ---- files: the Incoming Calls thread (where Complete copied the plumber's files) + the Drive job folder ----
async function slackFiles(incoming,o){
 const token=env(o,'TPS_BOT_TOKEN');if(!incoming||!token)return[];
 const out=[];let cursor='';
 for(let i=0;i<5;i++){
  const j=await jf.slackApi('conversations.replies',{channel:incoming.channel,ts:incoming.ts,limit:200,...(cursor?{cursor}:{})},token,o.fetch||global.fetch);
  for(const m of j.messages||[])for(const f of m.files||[])if(f.id&&f.mode!=='tombstone')out.push({src:'slack',id:f.id,name:f.name||f.title||'file',mimeType:f.mimetype||'',permalink:f.permalink,created:String(f.created||m.ts)});
  cursor=j.response_metadata?.next_cursor;if(!cursor)break;
 }
 return out;
}
async function driveFiles(folderId,o){
 if(!folderId||!env(o,'GOOGLE_API_KEY'))return[];
 return(await jf.listFolder(folderId,o)).map(f=>({src:'drive',...f,created:f.createdTime||''}));
}
async function gatherFiles(refs,o){
 const [d,s]=await Promise.all([driveFiles(refs.folderId,o).catch(e=>(console.warn('desc modal drive',e.message),[])),slackFiles(refs.incoming,o).catch(e=>(console.warn('desc modal slack',e.message),[]))]);
 const seen=new Set(),files=[];
 for(const f of[...d,...s]){const k=`${jf.kindOf(f)}|${String(f.name).toLowerCase()}`;if(seen.has(k))continue;seen.add(k);files.push(f);}
 return files;
}

// ---- the pop-up ----
function loadingView(jobNumber){return{type:'modal',callback_id:CALLBACK+'_loading',title:plain(jobNumber?`Job ${jobNumber}`:'Call description'),close:plain('Cancel'),blocks:[{type:'section',text:{type:'mrkdwn',text:':hourglass_flowing_sand: Loading the notes and photos…'}}]};}
function descView({jobNumber,notes,text,hint,files=[],folderId,meta},o={},now=Date.now()){
 const blocks=[];
 blocks.push({type:'section',block_id:'tps_desc_notes',text:{type:'mrkdwn',text:`*Plumber Notes*\n${clean(notes)||'_(no comment left)_'}`.slice(0,3000)}});
 const el={type:'plain_text_input',action_id:INPUT_ACTION,multiline:true,placeholder:plain('Required to Complete. Goes on the QuickBooks invoice')};
 if(text)el.initial_value=String(text).slice(0,3000);
 blocks.push({type:'input',block_id:INPUT_BLOCK,label:plain('Call Description'),element:el,optional:false,hint:plain('Submit sends this description to pricing, just like Complete on the card.')});
 const order={pdf:0,photo:1,video:2,file:3,folder:4};
 const sorted=files.filter(f=>jf.kindOf(f)!=='folder').sort((a,b)=>order[jf.kindOf(a)]-order[jf.kindOf(b)]||String(a.created).localeCompare(String(b.created)));
 const counts=sorted.reduce((c,f)=>(c[jf.kindOf(f)]=(c[jf.kindOf(f)]||0)+1,c),{});
 const label=(n,w)=>n?`${n} ${w}${n===1?'':'s'}`:'';
 const summary=[label(counts.pdf,'PDF'),label(counts.photo,'photo'),label(counts.video,'video'),label(counts.file,'other file')].filter(Boolean).join(' · ')||'No files yet';
 blocks.push({type:'divider'},{type:'context',elements:[{type:'mrkdwn',text:`*Job files:* ${summary}`}]});
 const img=folderId&&jf.signedQuery(folderId,jobNumber,o,now,jf.MODAL_IMG_TTL),link=folderId&&jf.signedQuery(folderId,jobNumber,o,now,jf.MODAL_LINK_TTL),base=jf.baseUrl(o);
 const thumb=f=>`${base}/job-files/${folderId}/thumb/${encodeURIComponent(f.id)}?${img}&w=1000`;
 let photos=0,hidden=0;
 for(const f of sorted){
  if(blocks.length>=MAX_BLOCKS-3){hidden++;continue;}
  const k=jf.kindOf(f),name=String(f.name||'file');
  if(k==='photo'){
   if(photos>=MAX_PHOTOS){hidden++;continue;}
   photos++;
   blocks.push(f.src==='slack'?{type:'image',slack_file:{id:f.id},alt_text:name.slice(0,200)}:{type:'image',image_url:thumb(f),alt_text:name.slice(0,200)});
  }else if(k==='pdf'&&f.src==='drive'){
   blocks.push({type:'section',text:{type:'mrkdwn',text:`:page_facing_up: *${clean(name)}*`},accessory:{type:'button',action_id:`tps_desc_pdf_${f.id}`.slice(0,255),text:plain('View PDF'),url:`${base}/job-files/${folderId}/view/${encodeURIComponent(f.id)}?${link}`}},{type:'image',image_url:thumb(f),alt_text:`First page of ${name}`.slice(0,200)});
  }else{
   const url=f.src==='slack'?f.permalink:jf.viewLink(f);
   const icon=k==='pdf'?':page_facing_up:':k==='video'?':movie_camera:':':paperclip:';
   blocks.push({type:'section',text:{type:'mrkdwn',text:`${icon} ${clean(name)}`},...(url?{accessory:{type:'button',action_id:`tps_desc_link_${f.id}`.slice(0,255),text:plain(k==='video'?'Play':'Open'),url}}:{})});
  }
 }
 if(hidden)blocks.push({type:'context',elements:[{type:'mrkdwn',text:`${hidden} more not shown.${folderId?` <${jf.folderUrl(folderId)}|Open the job folder in Drive>`:''}`}]});
 return{type:'modal',callback_id:CALLBACK,private_metadata:JSON.stringify(meta||{}),title:plain(jobNumber?`Job ${jobNumber}`:'Call description'),submit:plain('Submit description'),close:plain('Cancel'),blocks:blocks.slice(0,MAX_BLOCKS)};
}

async function openDescModal(payload,o={}){
 const token=o.modalToken||env(o,'TPS_BOT_TOKEN');if(!token)return'TPS_BOT_TOKEN is not set';
 if(!ADMINS.includes(payload.user?.id))throw Error('Only TPS admins may submit work descriptions.');
 const fetcher=o.fetch||global.fetch;
 const blocks=payload.message?.blocks||[];
 const refs=cardRefs(blocks);
 const opened=o.openedView?{view:o.openedView}:await jf.slackApi(payload.view?.type==='modal'?'views.push':'views.open',{trigger_id:payload.trigger_id,view:loadingView(refs.jobNumber)},token,fetcher);
 const meta={c:payload.channel?.id||payload.container?.channel_id,ts:payload.message?.ts||payload.container?.message_ts,j:refs.jobNumber};
 const files=await gatherFiles(refs,o);
 const hint=inputBlock(blocks)?.hint?.text;
 const view=descView({jobNumber:refs.jobNumber,notes:plumberNotes(blocks),text:currentText(payload),hint,files,folderId:refs.folderId,meta},o);
 await jf.slackApi('views.update',{view_id:opened.view.id,hash:opened.view.hash,view},token,fetcher).catch(async e=>{
  // A rejected image (for example a Slack file the bot can't see) shouldn't lose the description box.
  console.warn('desc modal update',e.message);
  await jf.slackApi('views.update',{view_id:opened.view.id,view:{...view,blocks:view.blocks.filter(b=>b.type!=='image')}},token,fetcher);
 });
 return`opened ${refs.jobNumber} files=${files.length}`;
}

// Always re-read the source before submitting. A cached modal may outlive its card.
const submissions=new Map();
function submissionText(p){return String(p.view?.state?.values?.[INPUT_BLOCK]?.[INPUT_ACTION]?.value||'').trim();}
function submissionError(p){const text=submissionText(p);return !text?'Write the description first.':text.length>3000?'Keep the description within 3,000 characters.':null;}
function resultView(job,text){return{type:'modal',title:plain(job?'Job '+job:'Call description'),close:plain('Close'),blocks:[{type:'section',text:{type:'plain_text',text}}]};}
async function readSource(meta,o){
 if(meta.c!==COMPLETED||!/^\d{10}\.\d{6}$/.test(meta.ts||'')||!/^\d{5,7}$/.test(meta.j||''))throw Error('This is not a current Completed call.');
 const h=await jf.slackApi('conversations.history',{channel:meta.c,latest:meta.ts,oldest:meta.ts,inclusive:true,limit:1},env(o,'TPS_BOT_TOKEN'),o.fetch||global.fetch);
 const m=(h.messages||[]).find(x=>x.ts===meta.ts);
 if(!m||cardRefs(m.blocks).jobNumber!==meta.j)throw Error('The Completed card changed. Refresh the board and reopen it.');
 if(!inputBlock(m.blocks)||!(m.blocks||[]).some(b=>(b.elements||[]).some(e=>e.action_id==='submitnotes'))||(m.blocks||[]).some(b=>b.block_id==='tps_desc_queued'))throw Error('This description was already submitted or is being verified. Check the Job Board before retrying.');
 return m;
}
async function submitDescription(payload,o={}){
 let meta={};try{meta=JSON.parse(payload.view?.private_metadata||'{}');}catch{}
 const id=meta.c+'|'+meta.ts,err=submissionError(payload),user=payload.user?.id;
 if(err)return{error:err};
 if(!ADMINS.includes(user))return{error:'Only TPS admins may submit work descriptions.'};
 if(!env(o,'TPS_BOT_TOKEN')||!env(o,'TPS_INTERNAL_KEY'))return{error:'Description submission is not connected.'};
 if(submissions.has(id))return{uncertain:true,error:'This description was already submitted or is being verified. Check the Job Board before retrying.'};
 submissions.set(id,'checking');let dispatched=false,marked=false;
 try{
  const m=await readSource(meta,o),text=submissionText(payload);
  const updated=m.blocks.map(b=>b.block_id===INPUT_BLOCK?{...b,element:{...b.element,initial_value:text}}:b);
  const waiting=updated.filter(b=>b.type!=='input'&&!(b.type==='actions'&&(b.elements||[]).some(e=>e.action_id==='submitnotes')));
  waiting.push({type:'rich_text',block_id:'tps_desc_saved',elements:[{type:'rich_text_section',elements:[{type:'text',text}]}]},{type:'section',block_id:'tps_desc_queued',text:{type:'plain_text',text:'Description saved above. Sending to pricing. Please do not submit again.'}});
  // Persist the pending marker before dispatch, so a restart cannot replay an uncertain request.
  await jf.slackApi('chat.update',{channel:meta.c,ts:meta.ts,text:m.text||meta.j,blocks:waiting},env(o,'TPS_BOT_TOKEN'),o.fetch||global.fetch);marked=true;
  const p={type:'block_actions',user:{id:user},team:{id:'T086X85G14N'},api_app_id:'A0C54G77M6E',channel:{id:meta.c},container:{type:'message',channel_id:meta.c,message_ts:meta.ts,is_ephemeral:false},message:{...m,blocks:updated},state:{values:{[INPUT_BLOCK]:{[INPUT_ACTION]:{type:'plain_text_input',value:text}}}},actions:[{type:'button',action_id:'submitnotes',value:'Submit',action_ts:(Date.now()/1000).toFixed(6)}]};
  dispatched=true;
  const r=await(o.fetch||global.fetch)(ROUTE,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload:JSON.stringify({key:env(o,'TPS_INTERNAL_KEY'),tps_assignment_verified:p})}),signal:AbortSignal.timeout(95000)});
  if(!r.ok)throw Error('Routing response '+r.status);
  return{queued:true,message:'Description submitted. The call is being sent to pricing. Its card and Job Board will update when routing finishes.'};
 }catch(e){
  if(!marked&&!dispatched)submissions.delete(id);
  return{uncertain:marked||dispatched,error:marked||dispatched?'The description is saved, but routing is not yet verified. Check the Job Board before retrying.':e.message};
 }
}
async function finishSubmission(payload,o={}){
 const r=await submitDescription(payload,o);
 let meta={};try{meta=JSON.parse(payload.view?.private_metadata||'{}');}catch{}
 await jf.slackApi('views.update',{view_id:payload.view.id,view:resultView(meta.j,r.message||r.error)},o.modalToken||env(o,'TPS_BOT_TOKEN'),o.fetch||global.fetch).catch(e=>console.warn('description result',e.message));
 return r;
}
module.exports={OPEN_ACTION,CALLBACK,cardRefs,plumberNotes,currentText,gatherFiles,descView,openDescModal,submissionError,resultView,readSource,submitDescription,finishSubmission,_submissions:submissions};
