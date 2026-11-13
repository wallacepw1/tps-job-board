'use strict';
// Reschedule on a Meld call card (Please Assign, Future Calls or a plumber channel; admins only) goes through Meld (Paul 2026-11-13: Meld wants all
// scheduling done in Meld). The TPS Meld Scheduler scenario in Latenode does the Meld side and keeps Meld Intake's
// records in step; this file shows the choices and moves the card.
//  - Booked in Meld: pick a new date + 4-hour window; Meld moves the appointment and tells the resident.
//  - Not booked, resident gave times still ahead: pick one of them (final, booked in Meld).
//  - Not booked, no resident times: offer 2 or 3 four-hour windows; the resident's pick comes back through Meld Intake.
//  - Always (except when the resident has times): send the card to Future Calls with no date; Meld is not changed.
const {slackApi}=require('./job-files');
const af=require('./appfolio-schedule');
const SCHEDULER='https://webhook.latenode.com/27333/prod/tps-meld-schedule';
const CALLBACK='tps_meld_schedule_modal';
const INCOMING='C0C19TG3KJ6',ASSIGN='C0C2XUL7ZHN',FUTURE='C0C2XB4VD1N';
const ADMINS=['U0876C3TEGL','U0C2PMHJK0A','U0C2X3HU490'];
const pt=text=>({type:'plain_text',text:String(text).slice(0,3000)});
const md=text=>({type:'section',text:{type:'mrkdwn',text:String(text).slice(0,3000)}});
const isAdmin=p=>(p.team?.id||p.team_id)==='T086X85G14N'&&ADMINS.includes(p.user?.id);
const validCall=c=>!!c&&/^\d{5,8}$/.test(c.invoice||'')&&/^T[A-Z0-9]{5,8}$/.test(c.code||'');
// A Meld call card: invoice on the first line, the Meld code (T…) on the second.
function meldCall(m){
 const main=(m?.blocks||[]).find(b=>b.block_id==='wo_main')?.elements?.[0]?.elements;
 const text=Array.isArray(main)?main.map(e=>e.type==='text'?e.text:'').join(''):String(m?.text||'');
 const [invoice,code]=text.split('\n').map(x=>x.trim()).filter(Boolean);
 const call={invoice,code};return validCall(call)?call:null;
}
function reschedulePress(p){
 if(p?.type!=='block_actions'||p.actions?.[0]?.action_id!==af.RESCHEDULE||!isAdmin(p))return false;
 return af.CARD_CHANNELS.includes(p.channel?.id||p.container?.channel_id)&&!!meldCall(p.message);
}
function intercepts(p){return reschedulePress(p)||(p?.type==='view_submission'&&p.view?.callback_id===CALLBACK);}

const hourLabel=h=>(h%12||12)+' '+(h<12?'AM':'PM');
const WINDOWS=Array.from({length:13},(_,i)=>i+7).map(h=>({text:pt(hourLabel(h)+' – '+hourLabel((h+4)%24)),value:String(h).padStart(2,'0')+':00'}));
const windowLabel=time=>WINDOWS.find(w=>w.value===time)?.text.text||time;
const winBlocks=(n,optional,title)=>[{type:'input',block_id:'date_'+n,optional,label:pt(title?title+' date':'Date'),element:{type:'datepicker',action_id:'date'}},
 {type:'input',block_id:'time_'+n,optional,label:pt((title?title+' window':'Arrival window')+' (4 hours, Pacific)'),element:{type:'static_select',action_id:'time',placeholder:pt('Choose a window'),options:WINDOWS}}];
const noDateBlock={type:'input',block_id:'no_date',optional:true,label:pt('No date or time yet'),element:{type:'checkboxes',action_id:'none',options:[{text:pt('Send to Future Calls with no date/time (Meld is not changed)'),value:'none'}]}};
const head=(call,meldUrl)=>`Invoice *${call.invoice}* · Meld *${call.code}*${meldUrl?` · <${meldUrl}|Open in Meld>`:''}`;
function infoView(title,text){return{type:'modal',callback_id:CALLBACK+'_info',title:pt(title),close:pt('Close'),blocks:[md(text)]};}
const modal=(title,submit,meta,blocks)=>({type:'modal',callback_id:CALLBACK,title:pt(title),submit:pt(submit),close:pt('Cancel'),private_metadata:JSON.stringify(meta),blocks});

// The pop-up for what Meld shows now.
function viewFor(call,meta,out){
 const m={...meta,invoice:call.invoice,code:call.code,meldUrl:out.meldUrl||''},h=head(call,out.meldUrl);
 if(out.status==='ok'&&out.booked)return modal('Reschedule in Meld','Reschedule',{...m,mode:'move',was:out.booked.label},
  [md(`${h}\nBooked in Meld for *${out.booked.label}*. Pick a new date and 4-hour window: Meld moves the appointment and tells the resident.`),...winBlocks(1,true),noDateBlock]);
 if(out.status==='ok'&&out.times?.length){
  const options=out.times.slice(0,10).map(t=>({text:pt(String(t.label).slice(0,75)),value:JSON.stringify({id:t.id,label:t.label,start:t.start})}));
  return modal('Schedule in Meld','Book in Meld',{...m,mode:'book'},
   [md(`${h}\nThe resident offered these times in Meld. Pick one: it is booked in Meld right away (no confirmation needed). A later day moves the card to Future Calls at that time.`),
    {type:'input',block_id:'slot',label:pt("Resident's times"),element:{type:'radio_buttons',action_id:'slot',options}}]);
 }
 if(out.status==='ok'&&out.presence){
  const waiting=out.offer?.windows?.length?`\n:hourglass_flowing_sand: Already offered ${out.offer.windows.join(' or ')}; the resident has not picked yet. Sending new windows replaces them.`:'';
  return modal('Offer times in Meld','Send to resident',{...m,mode:'offer'},
   [md(`${h}\nNot scheduled in Meld and the resident gave no times. Offer 2 or 3 four-hour windows; Meld sends them to the resident, and when they pick one the card is scheduled for it. Until then the card waits in Future Calls at the first window.${waiting}`),
    ...winBlocks(1,true,'1st'),...winBlocks(2,true,'2nd'),...winBlocks(3,true,'3rd'),noDateBlock]);
 }
 const why=out.status==='ok'?'This Meld has no registered resident to pick a time, so schedule it in Meld itself.'
  :out.status==='closed'?`Meld shows this Meld as ${String(out.meldStatus||'closed').toLowerCase().replace(/_/g,' ')}.`
  :out.status==='not_accepted'?'This Meld is not accepted for TPS in Meld yet.'
  :out.status==='unknown'?'This Meld is not in the Meld intake records, so it cannot be scheduled from here.'
  :`Meld could not be read${out.why?` (${String(out.why).slice(0,200)})`:''}.`;
 return modal('Reschedule call','Move card',{...m,mode:'none'},[md(`${h}\n:warning: ${why} Use Open in Meld for the time. You can still send the card to Future Calls with no date; Meld is not changed.`),noDateBlock]);
}

function windowsOf(p,n){
 const v=p.view?.state?.values||{},out=[];
 for(let i=1;i<=n;i++){
  const date=v['date_'+i]?.date?.selected_date,time=v['time_'+i]?.time?.selected_option?.value;
  if(!date&&!time)continue;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date||'')||!/^([01]\d|2[0-3]):00$/.test(time||''))return null;
  out.push({date,time});
 }
 return out;
}
function selectionOf(p,now=Date.now()){
 try{
  const meta=JSON.parse(p.view.private_metadata||'{}');if(!validCall(meta))return null;
  const v=p.view.state?.values||{},noDate=(v.no_date?.none?.selected_options||[]).some(o=>o.value==='none');
  const today=af.pacific(now).date;
  if(meta.mode==='book'){const s=JSON.parse(v.slot?.slot?.selected_option?.value||'null');return s&&s.id!=null?{meta,book:s,label:s.label}:null;}
  const n=meta.mode==='offer'?3:meta.mode==='move'?1:0,wins=n?windowsOf(p,n):[];
  if(!wins)return null;
  if(noDate)return wins.length?null:{meta,noDate:true,label:'no date/time'};
  if(!wins.length||wins.some(w=>w.date<today))return null;
  if(meta.mode==='move')return{meta,move:wins[0],label:wins[0].date+' '+windowLabel(wins[0].time)};
  if(meta.mode==='offer'){
   const sorted=wins.slice().sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));
   for(let i=1;i<sorted.length;i++)if(sorted[i].date===sorted[i-1].date&&Number(sorted[i].time.slice(0,2))-Number(sorted[i-1].time.slice(0,2))<4)return null;
   return sorted.length>=2?{meta,offer:sorted,label:sorted.map(w=>w.date+' '+windowLabel(w.time)).join(' or ')}:null;
  }
  return null;
 }catch{return null;}
}
function submissionError(p){
 if(selectionOf(p))return null;
 let meta={};try{meta=JSON.parse(p.view?.private_metadata||'{}');}catch{}
 if(meta.mode==='book')return{slot:"Pick one of the resident's times."};
 if(meta.mode==='offer')return{date_1:'Set 2 or 3 windows (today or later, not overlapping), each with a date and a window. Or tick No date/time with no windows set.'};
 if(meta.mode==='move')return{date_1:'Set a date (today or later) and a 4-hour window, or tick No date/time (not both).'};
 return{no_date:'Tick the box to send the card to Future Calls with no date, or press Cancel.'};
}
function pendingText(p){const s=selectionOf(p);return s?.noDate?':hourglass_flowing_sand: Moving the card to Future Calls… Meld is not changed.':':hourglass_flowing_sand: '+(s?.offer?'Sending the windows to the resident in Meld':s?.move?'Rescheduling in Meld':'Booking in Meld')+'… Please do not submit again.';}

async function callScheduler(body,{key=process.env.TPS_INTERNAL_KEY,fetch:fetcher=global.fetch,meldScheduler=SCHEDULER}={}){
 const r=await fetcher(meldScheduler,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,...body}),signal:AbortSignal.timeout(60000)});
 const text=await r.text();let out;try{out=JSON.parse(text);if(typeof out==='string')out=JSON.parse(out);}catch{out=null;}
 if(!r.ok||!out||typeof out.status!=='string')throw Error('Meld could not be reached right now.');
 return out;
}

async function route(p,options={}){
 const token=options.TPS_BOT_TOKEN||process.env.TPS_BOT_TOKEN,fetcher=options.fetch||global.fetch;
 const slack=(m,b)=>slackApi(m,b,token,fetcher);
 if(p.type==='block_actions'){
  const call=meldCall(p.message);
  if(!isAdmin(p)||!call)return slack('views.open',{trigger_id:p.trigger_id,view:infoView('Meld scheduling','Only admins can reschedule Meld calls.')});
  const opened=await slack('views.open',{trigger_id:p.trigger_id,view:infoView('Meld scheduling',`:hourglass_flowing_sand: Checking Meld *${call.code}* (invoice ${call.invoice})… Keep this window open.`)});
  const meta={channel:p.channel?.id||p.container?.channel_id||'',cardTs:p.message?.ts||p.container?.message_ts||'',incomingTs:af.incomingTs(p.message?.blocks),recordId:af.recordId(p.message?.blocks)};
  let out;try{out=await callScheduler({mode:'read',code:call.code,invoice:call.invoice,user:p.user.id},options);}catch(e){out={status:'error',why:e.message.replace(/\.$/,'')};}
  return slack('views.update',{view_id:opened.view.id,view:viewFor(call,meta,out)});
 }
 const s=selectionOf(p);if(!s||!isAdmin(p))return null;
 const {meta}=s,done=view=>slack('views.update',{view_id:p.view.id,view}).catch(()=>{});
 if(s.noDate){
  const routed=await af.routeCard(p,meta,{noDate:true},options);
  await done(infoView('Meld scheduling',routed+'\nMeld was not changed.'));
  return{routed};
 }
 const body={code:meta.code,invoice:meta.invoice,user:p.user.id};
 let out;
 try{out=await callScheduler(s.book?{...body,mode:'book',id:s.book.id}:s.move?{...body,mode:'move',windows:[s.move]}:{...body,mode:'offer',windows:s.offer},options);}
 catch(e){await done(infoView('Meld scheduling',e.message+' Nothing was changed. Check the Meld before trying again.'));return{error:e.message};}
 const ok={booked:'booked in Meld',moved:'rescheduled in Meld',offered:'offered in Meld'}[out.status];
 if(!ok){
  const why={time_gone:"That time is no longer offered in Meld. Nothing was booked. Press Reschedule again to see the current times.",
   already_booked:`Meld is already scheduled${out.booked?' for '+out.booked.label:''}. Press Reschedule again.`,
   booked_instead:`Meld booked ${out.booked?.label||'a time'} instead of offering the windows. Check it in Meld; the card was not moved.`,
   unconfirmed:'Meld did not confirm the change. The card was not moved. Check the Meld before trying again.',
   not_booked:'Meld is no longer scheduled. Press Reschedule again.',no_resident:'This Meld has no registered resident to pick a time. Use Open in Meld.',
   bad_time:'Meld needs times at least 15 minutes from now (offers: 2 or 3 that do not overlap).'}[out.status]||`Meld could not be changed (${out.why||out.status}). The card was not moved.`;
  await done(infoView('Meld scheduling',why+(out.meldUrl?`\n<${out.meldUrl}|Open in Meld>`:'')));
  return{status:out.status};
 }
 const shown=out.status==='offered'?'Waiting for the resident: '+(out.windows||[]).join(' or '):out.booked?.label||s.label;
 const when=out.status==='offered'?out.first:{date:af.pacific(Date.parse(out.booked.start)).date,time:af.pacific(Date.parse(out.booked.start)).time};
 await af.removeButton(meta,options,shown+' ('+ok+')',true).catch(e=>console.error('meld card note',e.message));
 const routed=when&&/^\d{4}-\d{2}-\d{2}$/.test(when.date||'')?await af.routeCard(p,meta,when,options):'';
 const text=out.status==='offered'?`:white_check_mark: Sent to the resident in Meld: ${(out.windows||[]).join(' or ')}. When they pick one, the card is scheduled for it.`
  :out.status==='moved'?`:white_check_mark: Rescheduled in Meld to *${out.booked.label}*${out.was?` (was ${out.was})`:''}. Meld tells the resident.`
  :`:white_check_mark: Booked in Meld: *${out.booked.label}*.`;
 await done(infoView('Meld scheduling',text+(routed?'\n\n'+routed:'')));
 if(/^\d{10}\.\d{6}$/.test(meta.incomingTs||''))await slack('chat.postMessage',{channel:INCOMING,thread_ts:meta.incomingTs,unfurl_links:false,
  text:`:calendar: Meld ${meta.code} ${ok} by <@${p.user.id}>: ${shown}`}).catch(e=>console.error('meld schedule log',e.message));
 return{status:out.status,routed};
}

module.exports={CALLBACK,meldCall,intercepts,viewFor,selectionOf,submissionError,pendingText,infoView,route,callScheduler};
