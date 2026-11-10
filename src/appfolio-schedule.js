'use strict';
// "Pick AppFolio time" on a TPS Bot call card (#please-assign-these).
// Opens a pop-up, asks the Latenode "TPS AppFolio Scheduling Picker" scenario to read the tenant's
// offered windows from the AppFolio work order, and books the window an admin picks.
// Nothing is booked without an explicit pick + submit. Admins only.
const {slackApi}=require('./job-files');
const {randomUUID}=require('node:crypto');
const {submitAssignment}=require('./assignment');
const PICKER='https://webhook.latenode.com/27333/prod/tps-appfolio-schedule-picker';
const ACTION='tps_appfolio_pick_time';
const CALLBACK='tps_appfolio_pick_time_modal';
const INCOMING='C0C19TG3KJ6',ASSIGN='C0C2XUL7ZHN';
const ADMINS=['U0876C3TEGL','U0C2PMHJK0A','U0C2X3HU490'];
const pt=text=>({type:'plain_text',text:String(text).slice(0,3000)});
const md=text=>({type:'section',text:{type:'mrkdwn',text:String(text).slice(0,3000)}});

function validCall(c){return !!c&&typeof c.invoice==='string'&&/^\d{5,8}$/.test(c.invoice)&&typeof c.workOrder==='string'&&/^\d{5,9}-\d{1,3}$/.test(c.workOrder);}
function intercepts(p){return (p?.type==='block_actions'&&p.actions?.[0]?.action_id===ACTION)||(p?.type==='view_submission'&&p.view?.callback_id===CALLBACK);}
function isAdmin(p){return (p.team?.id||p.team_id)==='T086X85G14N'&&ADMINS.includes(p.user?.id);}
function incomingTs(blocks){const m=JSON.stringify(blocks||[]).match(/tpsref:[^:"]*:(\d{10}\.\d{6})/);return m?m[1]:'';}
function recordId(blocks){const m=JSON.stringify(blocks||[]).match(/tpsref:(Rec[A-Za-z0-9]+):/);return m?m[1]:'';}
const pacific=ms=>{const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ms)).map(x=>[x.type,x.value]));return{date:p.year+'-'+p.month+'-'+p.day,time:p.hour+':'+p.minute};};

function infoView(title,text){return{type:'modal',callback_id:CALLBACK+'_info',title:pt(title),close:pt('Close'),blocks:[md(text)]};}
function loadingView(call){return infoView('AppFolio scheduling',`:hourglass_flowing_sand: Opening AppFolio work order *${call.workOrder}* (invoice ${call.invoice}) to read the tenant's times. This takes about a minute. Keep this window open.`);}
function pickerView(call,slots,meta,now=Date.now()){
 const options=(slots||[]).filter(s=>/^timeslot-\d+$/.test(s?.id||'')&&Number.isSafeInteger(s.start)&&Number.isSafeInteger(s.end)&&s.start>now&&s.end>s.start).slice(0,100)
  .map(s=>({text:pt(String(s.label||'').replace(/\s+/g,' ').slice(0,75)),value:JSON.stringify({id:s.id,start:s.start,end:s.end})}));
 if(!options.length)return ownTimeView(call,meta);
 return{type:'modal',callback_id:CALLBACK,title:pt('Schedule in AppFolio'),submit:pt('Book in AppFolio'),close:pt('Cancel'),
  private_metadata:JSON.stringify({...meta,invoice:call.invoice,workOrder:call.workOrder}),
  blocks:[md(`Invoice *${call.invoice}* · AppFolio WO *${call.workOrder}*\nPick one of the tenant's times to book it in AppFolio. A later day moves the card to Future Calls at that time; today keeps it in Please Assign.`),
   {type:'input',block_id:'window',optional:true,label:pt('Tenant arrival window'),element:options.length<=10
    ?{type:'radio_buttons',action_id:'slot',options}
    :{type:'static_select',action_id:'slot',placeholder:pt('Choose a date and time'),options}},
   {type:'section',text:{type:'mrkdwn',text:'*Or set your own date and time* (AppFolio is not changed, just the card):'}},
   {type:'input',block_id:'own_date',optional:true,label:pt('Date'),element:{type:'datepicker',action_id:'date'}},
   {type:'input',block_id:'own_time',optional:true,label:pt('Time (Pacific)'),element:{type:'timepicker',action_id:'time'}}]};
}
function ownTimeView(call,meta){return{type:'modal',callback_id:CALLBACK,title:pt('Schedule call'),submit:pt('Schedule'),close:pt('Cancel'),
 private_metadata:JSON.stringify({...meta,invoice:call.invoice,workOrder:call.workOrder}),
 blocks:[md(`AppFolio has no future tenant times for WO *${call.workOrder}*. Set the date and time you arranged with the tenant. A later day moves the card to Future Calls; today keeps it in Please Assign.`),
  {type:'input',block_id:'own_date',label:pt('Date'),element:{type:'datepicker',action_id:'date'}},
  {type:'input',block_id:'own_time',label:pt('Time (Pacific)'),element:{type:'timepicker',action_id:'time'}}]};}
function ownTimeOf(p){const v=p.view?.state?.values||{};const date=v.own_date?.date?.selected_date,time=v.own_time?.time?.selected_time;return /^\d{4}-\d{2}-\d{2}$/.test(date||'')&&/^([01]\d|2[0-3]):[0-5]\d$/.test(time||'')?{date,time}:null;}
function selectionOf(p,now=Date.now()){
 try{
  const meta=JSON.parse(p.view.private_metadata||'{}');
  const opt=p.view.state?.values?.window?.slot?.selected_option;
  const sel=JSON.parse(opt?.value||'null');
  if(validCall(meta)&&!sel){const own=ownTimeOf(p);return own&&own.date>=pacific(now).date?{meta,selection:null,own,label:own.date+' '+own.time}:null;}
  if(!validCall(meta)||!sel||!/^timeslot-\d+$/.test(sel.id)||!Number.isSafeInteger(sel.start)||!Number.isSafeInteger(sel.end)||sel.start<=now||sel.end<=sel.start)return null;
  return{meta,selection:{id:sel.id,start:sel.start,end:sel.end},label:opt.text?.text||''};
 }catch{return null;}
}
function submissionError(p){if(selectionOf(p))return null;const v=p.view?.state?.values||{};const block=v.window?'window':'own_date';return{[block]:'Pick one of the tenant times, or set a date (today or later) and a time.'};}

async function callPicker(body,{key=process.env.TPS_INTERNAL_KEY,fetch:fetcher=global.fetch}={}){
 const r=await fetcher(PICKER,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,...body}),signal:AbortSignal.timeout(110000)});
 const text=await r.text();let out;try{out=JSON.parse(text);if(typeof out==='string')out=JSON.parse(out);}catch{out=null;}
 if(!r.ok||!out||typeof out.status!=='string')throw Error('AppFolio could not be checked right now.');
 // Latenode's webhook reply stringifies each field: slots arrives as a JSON string and missing fields as "null".
 for(const k of ['step','appointment'])if(out[k]==='null'||out[k]==null)out[k]='';
 if(typeof out.slots==='string'){try{out.slots=JSON.parse(out.slots);}catch{out.slots=[];}}
 if(!Array.isArray(out.slots))out.slots=[];
 return out;
}

async function route(p,options={}){
 const token=options.TPS_BOT_TOKEN||process.env.TPS_BOT_TOKEN,fetcher=options.fetch||global.fetch;
 const slack=(m,b)=>slackApi(m,b,token,fetcher);
 if(p.type==='block_actions'){
  let call=null;try{call=JSON.parse(p.actions[0].value||'null');}catch{}
  if(!isAdmin(p))return slack('views.open',{trigger_id:p.trigger_id,view:infoView('AppFolio scheduling','Only admins can book AppFolio times.')});
  if(!validCall(call))return slack('views.open',{trigger_id:p.trigger_id,view:infoView('AppFolio scheduling','This card has no AppFolio work order number.')});
  const opened=await slack('views.open',{trigger_id:p.trigger_id,view:loadingView(call)});
  let meta={channel:p.channel?.id||p.container?.channel_id||'',cardTs:p.message?.ts||p.container?.message_ts||'',incomingTs:incomingTs(p.message?.blocks),recordId:recordId(p.message?.blocks)};
  // Pressed in the "please schedule" DM: work on the call's card in Please Assign instead.
  if(meta.channel!==ASSIGN&&/^D/.test(meta.channel)){const dm={channel:meta.channel,ts:meta.cardTs};meta={...(await findAssignCard(call,options).catch(e=>{console.error('appfolio card lookup',e.message);return null;})||{channel:'',cardTs:'',incomingTs:'',recordId:''}),dm};}
  let view;
  try{
   const out=await callPicker({mode:'read',invoice:call.invoice,workOrder:call.workOrder},options);
   if(out.status==='already_scheduled')await removeButton(meta,options).catch(e=>console.error('appfolio button removal',e.message));
   view=out.status==='options'?pickerView(call,out.slots,meta)
    :out.status==='already_scheduled'?infoView('AppFolio scheduling',`Work order *${call.workOrder}* is already scheduled in AppFolio:\n${out.appointment||''}`)
    :infoView('AppFolio scheduling',`AppFolio could not be read for work order *${call.workOrder}* (${out.step||out.status}). Try again in a minute, or check the work order in AppFolio.`);
  }catch(e){view=infoView('AppFolio scheduling',e.message+' Nothing was booked.');}
  return slack('views.update',{view_id:opened.view.id,view});
 }
 // view_submission: Slack was already answered with a "Booking…" view.
 const s=selectionOf(p);if(!s||!isAdmin(p))return null;
 const {meta,selection,label,own}=s;let text,booked=false,out=null;
 if(own){text=`Card scheduled for ${own.date} ${own.time}. AppFolio was not changed.`;}
 else try{
  out=await callPicker({mode:'reserve',invoice:meta.invoice,workOrder:meta.workOrder,selection},options);
  booked=out.status==='booked';
  text=booked?`:white_check_mark: Booked in AppFolio for WO *${meta.workOrder}*.\n${out.appointment||label}`
   :out.status==='already_scheduled'?`Work order *${meta.workOrder}* was already scheduled in AppFolio:\n${out.appointment||''}`
   :out.status==='window_unavailable'?'That window is no longer offered in AppFolio. Nothing was booked. Press the button again to see current times.'
   :'AppFolio did not confirm the booking. Check the work order in AppFolio before trying again.';
 }catch{text='AppFolio could not be reached. Check the work order in AppFolio before trying again.';}
 const when=booked?pacific(selection.start):own;let routed='';
 // Scheduled (or AppFolio says it already was): take the button off the card before it moves.
 if(when||out?.status==='already_scheduled')await removeButton(meta,options).catch(e=>console.error('appfolio button removal',e.message));
 if(when)routed=await routeCard(p,meta,when,options);
 await slack('views.update',{view_id:p.view.id,view:infoView('AppFolio scheduling',text+(routed?'\n\n'+routed:''))}).catch(()=>{});
 if((booked||own)&&/^D/.test(meta.dm?.channel||'')&&/^\d{10}\.\d{6}$/.test(meta.dm?.ts||'')){
  const done=`:white_check_mark: Invoice ${meta.invoice} · WO ${meta.workOrder} scheduled by <@${p.user.id}>: ${booked?(label||out.appointment||''):own.date+' '+own.time}${routed?'\n'+routed:''}`;
  await slack('chat.update',{channel:meta.dm.channel,ts:meta.dm.ts,text:done,blocks:[md(done)]}).catch(e=>console.error('appfolio dm update',e.message));
 }
 if(booked&&/^\d{10}\.\d{6}$/.test(meta.incomingTs||'')){
  await slack('chat.postMessage',{channel:INCOMING,thread_ts:meta.incomingTs,text:`:calendar: AppFolio appointment booked by <@${p.user.id}> for WO ${meta.workOrder}: ${label||out.appointment||''}`,unfurl_links:false}).catch(e=>console.error('appfolio schedule log',e.message));
 }
 return{booked,routed};
}
// Finds the call's card in Please Assign by its Pick AppFolio time button (invoice + work order).
async function findAssignCard(call,options={}){
 const token=options.TPS_BOT_TOKEN||process.env.TPS_BOT_TOKEN,fetcher=options.fetch||global.fetch;
 const url=new URL('https://slack.com/api/conversations.history');url.searchParams.set('channel',ASSIGN);url.searchParams.set('limit','200');
 const r=await fetcher(url.href,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)}),j=await r.json();
 if(!j.ok)throw Error('conversations.history: '+j.error);
 const m=(j.messages||[]).find(x=>(x.blocks||[]).some(b=>b.type==='actions'&&(b.elements||[]).some(e=>{if(e.action_id!==ACTION)return false;try{const v=JSON.parse(e.value);return v.invoice===call.invoice&&v.workOrder===call.workOrder;}catch{return false;}})));
 return m?{channel:ASSIGN,cardTs:m.ts,incomingTs:incomingTs(m.blocks),recordId:recordId(m.blocks)}:null;
}
// Removes the Pick AppFolio time button from a TPS Bot card, leaving everything else as it is.
async function removeButton(meta,options={}){
 if(!/^C/.test(meta.channel||'')||!/^\d{10}\.\d{6}$/.test(meta.cardTs||''))return false;
 const token=options.TPS_BOT_TOKEN||process.env.TPS_BOT_TOKEN,fetcher=options.fetch||global.fetch;
 const url=new URL('https://slack.com/api/conversations.history');for(const[k,v]of Object.entries({channel:meta.channel,oldest:meta.cardTs,latest:meta.cardTs,inclusive:'true',limit:'1'}))url.searchParams.set(k,v);
 const r=await fetcher(url.href,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)}),j=await r.json();
 if(!j.ok)throw Error('conversations.history: '+j.error);
 const m=(j.messages||[]).find(x=>x.ts===meta.cardTs);if(!m||!Array.isArray(m.blocks))return false;
 const blocks=m.blocks.filter(b=>!(b.type==='actions'&&(b.elements||[]).some(e=>e.action_id===ACTION)));
 if(blocks.length===m.blocks.length)return false;
 await slackApi('chat.update',{channel:meta.channel,ts:meta.cardTs,text:m.text||'',blocks},token,fetcher);
 return true;
}
// After a time is set: a later day moves the Please Assign card to Future Calls at that time
// (the same Reschedule request the Job Board sends); today leaves it in Please Assign.
async function routeCard(p,meta,when,options={}){
 const today=pacific(options.now||Date.now()).date;
 if(when.date<=today)return meta.channel===ASSIGN?'It is for today, so the card stays in Please Assign.':'';
 if(meta.channel!==ASSIGN)return 'The card is not in Please Assign, so it was left where it is. Use Reschedule on it if needed.';
 if(!/^Rec[A-Za-z0-9]+$/.test(meta.recordId||'')||!/^\d{10}\.\d{6}$/.test(meta.incomingTs||''))return 'The card could not be matched to its call, so it was left in Please Assign. Use Reschedule on it.';
 const request={requestId:randomUUID(),actor:p.user.id,operation:'reschedule',jobNumber:meta.invoice,recordId:meta.recordId,incomingTs:meta.incomingTs,expectedLead:null,expectedHelper:null,target:null,schedule:{date:when.date,time:when.time}};
 const submit=options.submitAssignment||submitAssignment;
 try{
  let r=await submit(request,options.assignment||{});
  for(let i=0;i<6&&['queued','working'].includes(r.status);i++){await new Promise(x=>setTimeout(x,options.pollMs??4000));r=await submit(request,{...(options.assignment||{}),mode:'status'});}
  return r.status==='done'?`Moved to Future Calls for ${when.date} ${when.time}.`:'Moving the card to Future Calls '+(r.error?'failed: '+r.error:'is still in progress. Check Future Calls shortly; do not repeat it.');
 }catch(e){return 'The card could not be moved to Future Calls ('+e.message+'). Use Reschedule on it.';}
}

module.exports={findAssignCard,removeButton,ACTION,CALLBACK,intercepts,submissionError,route,routeCard,pickerView,ownTimeView,selectionOf,incomingTs,recordId,infoView,pacific};
