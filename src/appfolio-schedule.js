'use strict';
// "Pick AppFolio time" on a TPS Bot call card (#please-assign-these).
// Opens a pop-up, asks the Latenode "TPS AppFolio Scheduling Picker" scenario to read the tenant's
// offered windows from the AppFolio work order, and books the window an admin picks.
// Nothing is booked without an explicit pick + submit. Admins only.
const {slackApi}=require('./job-files');
const PICKER='https://webhook.latenode.com/27333/prod/tps-appfolio-schedule-picker';
const ACTION='tps_appfolio_pick_time';
const CALLBACK='tps_appfolio_pick_time_modal';
const INCOMING='C0C19TG3KJ6';
const ADMINS=['U0876C3TEGL','U0C2PMHJK0A','U0C2X3HU490'];
const pt=text=>({type:'plain_text',text:String(text).slice(0,3000)});
const md=text=>({type:'section',text:{type:'mrkdwn',text:String(text).slice(0,3000)}});

function validCall(c){return !!c&&typeof c.invoice==='string'&&/^\d{5,8}$/.test(c.invoice)&&typeof c.workOrder==='string'&&/^\d{5,9}-\d{1,3}$/.test(c.workOrder);}
function intercepts(p){return (p?.type==='block_actions'&&p.actions?.[0]?.action_id===ACTION)||(p?.type==='view_submission'&&p.view?.callback_id===CALLBACK);}
function isAdmin(p){return (p.team?.id||p.team_id)==='T086X85G14N'&&ADMINS.includes(p.user?.id);}
function incomingTs(blocks){const m=JSON.stringify(blocks||[]).match(/tpsref:[^:"]*:(\d{10}\.\d{6})/);return m?m[1]:'';}

function infoView(title,text){return{type:'modal',callback_id:CALLBACK+'_info',title:pt(title),close:pt('Close'),blocks:[md(text)]};}
function loadingView(call){return infoView('AppFolio scheduling',`:hourglass_flowing_sand: Opening AppFolio work order *${call.workOrder}* (invoice ${call.invoice}) to read the tenant's times. This takes about a minute. Keep this window open.`);}
function pickerView(call,slots,meta,now=Date.now()){
 const options=(slots||[]).filter(s=>/^timeslot-\d+$/.test(s?.id||'')&&Number.isSafeInteger(s.start)&&Number.isSafeInteger(s.end)&&s.start>now&&s.end>s.start).slice(0,100)
  .map(s=>({text:pt(String(s.label||'').replace(/\s+/g,' ').slice(0,75)),value:JSON.stringify({id:s.id,start:s.start,end:s.end})}));
 if(!options.length)return infoView('AppFolio scheduling',`AppFolio has no future tenant time windows for work order *${call.workOrder}*. Schedule it with the tenant directly, then use Reschedule on the card.`);
 return{type:'modal',callback_id:CALLBACK,title:pt('Schedule in AppFolio'),submit:pt('Book in AppFolio'),close:pt('Cancel'),
  private_metadata:JSON.stringify({...meta,invoice:call.invoice,workOrder:call.workOrder}),
  blocks:[md(`Invoice *${call.invoice}* · AppFolio WO *${call.workOrder}*\nThese are the times the tenant offered in AppFolio. Pick one and press *Book in AppFolio*.`),
   {type:'input',block_id:'window',label:pt('Tenant arrival window'),element:options.length<=10
    ?{type:'radio_buttons',action_id:'slot',options}
    :{type:'static_select',action_id:'slot',placeholder:pt('Choose a date and time'),options}}]};
}
function selectionOf(p,now=Date.now()){
 try{
  const meta=JSON.parse(p.view.private_metadata||'{}');
  const opt=p.view.state?.values?.window?.slot?.selected_option;
  const sel=JSON.parse(opt?.value||'null');
  if(!validCall(meta)||!sel||!/^timeslot-\d+$/.test(sel.id)||!Number.isSafeInteger(sel.start)||!Number.isSafeInteger(sel.end)||sel.start<=now||sel.end<=sel.start)return null;
  return{meta,selection:{id:sel.id,start:sel.start,end:sel.end},label:opt.text?.text||''};
 }catch{return null;}
}
function submissionError(p){return selectionOf(p)?null:'Pick one of the tenant windows (it may have expired; close and press the button again).';}

async function callPicker(body,{key=process.env.TPS_INTERNAL_KEY,fetch:fetcher=global.fetch}={}){
 const r=await fetcher(PICKER,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,...body}),signal:AbortSignal.timeout(110000)});
 const text=await r.text();let out;try{out=JSON.parse(text);if(typeof out==='string')out=JSON.parse(out);}catch{out=null;}
 if(!r.ok||!out||typeof out.status!=='string')throw Error('AppFolio could not be checked right now.');
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
  const meta={channel:p.channel?.id||p.container?.channel_id||'',cardTs:p.message?.ts||p.container?.message_ts||'',incomingTs:incomingTs(p.message?.blocks)};
  let view;
  try{
   const out=await callPicker({mode:'read',invoice:call.invoice,workOrder:call.workOrder},options);
   view=out.status==='options'?pickerView(call,out.slots,meta)
    :out.status==='already_scheduled'?infoView('AppFolio scheduling',`Work order *${call.workOrder}* is already scheduled in AppFolio:\n${out.appointment||''}`)
    :infoView('AppFolio scheduling',`AppFolio could not be read for work order *${call.workOrder}* (${out.step||out.status}). Try again in a minute, or check the work order in AppFolio.`);
  }catch(e){view=infoView('AppFolio scheduling',e.message+' Nothing was booked.');}
  return slack('views.update',{view_id:opened.view.id,view});
 }
 // view_submission: Slack was already answered with a "Booking…" view.
 const s=selectionOf(p);if(!s||!isAdmin(p))return null;
 const {meta,selection,label}=s;let text,booked=false,out=null;
 try{
  out=await callPicker({mode:'reserve',invoice:meta.invoice,workOrder:meta.workOrder,selection},options);
  booked=out.status==='booked';
  text=booked?`:white_check_mark: Booked in AppFolio for WO *${meta.workOrder}*.\n${out.appointment||label}`
   :out.status==='already_scheduled'?`Work order *${meta.workOrder}* was already scheduled in AppFolio:\n${out.appointment||''}`
   :out.status==='window_unavailable'?'That window is no longer offered in AppFolio. Nothing was booked. Press the button again to see current times.'
   :'AppFolio did not confirm the booking. Check the work order in AppFolio before trying again.';
 }catch{text='AppFolio could not be reached. Check the work order in AppFolio before trying again.';}
 await slack('views.update',{view_id:p.view.id,view:infoView('AppFolio scheduling',text)}).catch(()=>{});
 if(booked&&/^\d{10}\.\d{6}$/.test(meta.incomingTs||'')){
  await slack('chat.postMessage',{channel:INCOMING,thread_ts:meta.incomingTs,text:`:calendar: AppFolio appointment booked by <@${p.user.id}> for WO ${meta.workOrder}: ${label||out.appointment||''}`,unfurl_links:false}).catch(e=>console.error('appfolio schedule log',e.message));
 }
 return{booked};
}

module.exports={ACTION,CALLBACK,intercepts,submissionError,route,pickerView,selectionOf,incomingTs,infoView};
