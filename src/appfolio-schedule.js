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

// Own time: any date plus a 4-hour arrival window by start time (9-1, 10-2, ...).
const hourLabel=h=>(h%12||12)+' '+(h<12?'AM':'PM');
const WINDOWS=Array.from({length:13},(_,i)=>i+7).map(h=>({text:pt(hourLabel(h)+' – '+hourLabel((h+4)%24)),value:String(h).padStart(2,'0')+':00'}));
const windowLabel=time=>WINDOWS.find(w=>w.value===time)?.text.text||time;
const ownBlocks=optional=>[{type:'input',block_id:'own_date',optional,label:pt('Date'),element:{type:'datepicker',action_id:'date'}},
 {type:'input',block_id:'own_time',optional,label:pt('Arrival window (4 hours, Pacific)'),element:{type:'static_select',action_id:'time',placeholder:pt('Choose a window'),options:WINDOWS}}];
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
   {type:'section',text:{type:'mrkdwn',text:'*Or set your own date and 4-hour window.* It is entered in AppFolio when the work order allows it; otherwise only the card is scheduled.'}},
   ...ownBlocks(true)]};
}
function ownTimeView(call,meta){return{type:'modal',callback_id:CALLBACK,title:pt('Schedule call'),submit:pt('Schedule'),close:pt('Cancel'),
 private_metadata:JSON.stringify({...meta,invoice:call.invoice,workOrder:call.workOrder}),
 blocks:[md(`Invoice *${call.invoice}* · AppFolio WO *${call.workOrder}*\nThe tenant gave no times, so pick any date and a 4-hour arrival window. It is entered in AppFolio (the property manager and tenant are notified). A later day moves the card to Future Calls; today keeps it in Please Assign.`),
  ...ownBlocks(false)]};}
function ownTimeOf(p){const v=p.view?.state?.values||{};const date=v.own_date?.date?.selected_date,time=v.own_time?.time?.selected_option?.value||v.own_time?.time?.selected_time;return /^\d{4}-\d{2}-\d{2}$/.test(date||'')&&/^([01]\d|2[0-3]):[0-5]\d$/.test(time||'')?{date,time}:null;}
function selectionOf(p,now=Date.now()){
 try{
  const meta=JSON.parse(p.view.private_metadata||'{}');
  const opt=p.view.state?.values?.window?.slot?.selected_option;
  const sel=JSON.parse(opt?.value||'null');
  if(validCall(meta)&&!sel){const own=ownTimeOf(p);return own&&own.date>=pacific(now).date?{meta,selection:null,own,label:own.date+' '+windowLabel(own.time)}:null;}
  if(!validCall(meta)||!sel||!/^timeslot-\d+$/.test(sel.id)||!Number.isSafeInteger(sel.start)||!Number.isSafeInteger(sel.end)||sel.start<=now||sel.end<=sel.start)return null;
  return{meta,selection:{id:sel.id,start:sel.start,end:sel.end},label:opt.text?.text||''};
 }catch{return null;}
}
function submissionError(p){if(selectionOf(p))return null;const v=p.view?.state?.values||{};const block=v.window?'window':'own_date';return{[block]:'Pick one of the tenant times, or set a date (today or later) and a 4-hour window.'};}

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
 // Pressed in the TPS Assistant messages: that app owns the pop-up and the alert, TPS Bot still owns the cards.
 const ui=(m,b)=>slackApi(m,b,options.viewToken||token,fetcher);
 if(p.type==='block_actions'){
  let call=null;try{call=JSON.parse(p.actions[0].value||'null');}catch{}
  if(!isAdmin(p))return ui('views.open',{trigger_id:p.trigger_id,view:infoView('AppFolio scheduling','Only admins can book AppFolio times.')});
  if(!validCall(call))return ui('views.open',{trigger_id:p.trigger_id,view:infoView('AppFolio scheduling','This card has no AppFolio work order number.')});
  const opened=await ui('views.open',{trigger_id:p.trigger_id,view:loadingView(call)});
  let meta={channel:p.channel?.id||p.container?.channel_id||'',cardTs:p.message?.ts||p.container?.message_ts||'',incomingTs:incomingTs(p.message?.blocks),recordId:recordId(p.message?.blocks)};
  // Pressed in the "please schedule" DM: work on the call's card in Please Assign instead.
  if(meta.channel!==ASSIGN&&/^D/.test(meta.channel)){const dm={channel:meta.channel,ts:meta.cardTs};meta={...(await findAssignCard(call,options).catch(e=>{console.error('appfolio card lookup',e.message);return null;})||{channel:'',cardTs:'',incomingTs:'',recordId:''}),dm};}
  let view;
  try{
   const out=await callPicker({mode:'read',invoice:call.invoice,workOrder:call.workOrder},options);
   if(out.status==='already_scheduled'){
    await removeButton(meta,options).catch(e=>console.error('appfolio button removal',e.message));
    await closeAlerts(call,`:white_check_mark: Invoice ${call.invoice} · WO ${call.workOrder} is already scheduled in AppFolio.`,options).catch(e=>console.error('appfolio alert cleanup',e.message));
   }
   // Opening the scheduler also tidies the card: tenant times that have passed come off it.
   else await removeButton(meta,options,'',true).catch(e=>console.error('appfolio past times',e.message));
   view=out.status==='options'?pickerView(call,out.slots,meta)
    :out.status==='already_scheduled'?infoView('AppFolio scheduling',`Work order *${call.workOrder}* is already scheduled in AppFolio:\n${out.appointment||''}`)
    :infoView('AppFolio scheduling',`AppFolio could not be read for work order *${call.workOrder}* (${out.step||out.status}). Try again in a minute, or check the work order in AppFolio.`);
  }catch(e){view=infoView('AppFolio scheduling',e.message+' Nothing was booked.');}
  return ui('views.update',{view_id:opened.view.id,view});
 }
 // view_submission: Slack was already answered with a "Booking…" view.
 const s=selectionOf(p);if(!s||!isAdmin(p))return null;
 const {meta,selection,label,own}=s;let text,booked=false,out=null;
 let ownOk=false;
 if(own){
  // Own date + 4-hour window: enter it in AppFolio's own schedule form first; the card only moves when that is settled.
  try{
   out=await callPicker({mode:'reserve',invoice:meta.invoice,workOrder:meta.workOrder,selection:{custom:true,date:own.date,time:own.time}},options);
   booked=out.status==='booked';ownOk=booked||out.status==='no_custom_form';
   text=booked?`:white_check_mark: Entered in AppFolio for WO *${meta.workOrder}*: ${label} (4-hour window).\n${out.appointment||''}`
    :out.status==='no_custom_form'?`Card scheduled for ${label}. AppFolio only offers the tenant's times on this work order, so AppFolio was not changed.`
    :out.status==='already_scheduled'?`Work order *${meta.workOrder}* was already scheduled in AppFolio:\n${out.appointment||''}`
    :`AppFolio did not confirm the schedule${out.step?' ('+out.step+')':''}. The card was not moved. Check the work order in AppFolio before trying again.`;
  }catch{text='AppFolio could not be reached. The card was not moved. Check the work order in AppFolio before trying again.';}
 }
 else try{
  out=await callPicker({mode:'reserve',invoice:meta.invoice,workOrder:meta.workOrder,selection},options);
  booked=out.status==='booked';
  text=booked?`:white_check_mark: Booked in AppFolio for WO *${meta.workOrder}*.\n${out.appointment||label}`
   :out.status==='already_scheduled'?`Work order *${meta.workOrder}* was already scheduled in AppFolio:\n${out.appointment||''}`
   :out.status==='window_unavailable'?'That window is no longer offered in AppFolio. Nothing was booked. Press the button again to see current times.'
   :'AppFolio did not confirm the booking. Check the work order in AppFolio before trying again.';
 }catch{text='AppFolio could not be reached. Check the work order in AppFolio before trying again.';}
 const when=own?(ownOk?own:null):booked?pacific(selection.start):null;let routed='';
 // Scheduled (or AppFolio says it already was): take the button off the card before it moves.
 if(when||out?.status==='already_scheduled')await removeButton(meta,options,when?label+(booked?' (booked in AppFolio)':''):'').catch(e=>console.error('appfolio button removal',e.message));
 if(when)routed=await routeCard(p,meta,when,options);
 await ui('views.update',{view_id:p.view.id,view:infoView('AppFolio scheduling',text+(routed?'\n\n'+routed:''))}).catch(()=>{});
 if(when&&/^D/.test(meta.dm?.channel||'')&&/^\d{10}\.\d{6}$/.test(meta.dm?.ts||'')){
  const done=`:white_check_mark: Invoice ${meta.invoice} · WO ${meta.workOrder} scheduled by <@${p.user.id}>: ${label||out?.appointment||''}${routed?'\n'+routed:''}`;
  // Paul 2026-11-12: the alert and its confirmation belong in the TPS Assistant messages, not the TPS Bot DM.
  // Alert pressed in the Assistant messages: it becomes the confirmation in place. Older alerts in the TPS Bot DM:
  // the confirmation is posted in the Assistant messages and the alert removed (kept and updated if that fails).
  const assistant=options.assistantToken??process.env.TPS_ASSISTANT_BOT_TOKEN;
  const said={channel:meta.dm.channel,ts:meta.dm.ts,text:done,blocks:[md(done)]};
  if(options.viewToken)await ui('chat.update',said).catch(e=>console.error('appfolio dm update',e.message));
  else{
   const moved=assistant?await slackApi('chat.postMessage',{channel:p.user.id,text:done,blocks:[md(done)],unfurl_links:false},assistant,fetcher).then(()=>true).catch(e=>{console.error('appfolio assistant confirmation',e.message);return false;}):false;
   await slack(moved?'chat.delete':'chat.update',moved?{channel:meta.dm.channel,ts:meta.dm.ts}:said).catch(e=>console.error('appfolio dm update',e.message));
  }
 }
 if(when||out?.status==='already_scheduled')await closeAlerts(meta,when?`:white_check_mark: Invoice ${meta.invoice} · WO ${meta.workOrder} scheduled by <@${p.user.id}>: ${label||out?.appointment||''}${routed?'\n'+routed:''}`:`:white_check_mark: Invoice ${meta.invoice} · WO ${meta.workOrder} is already scheduled in AppFolio.`,options,options.viewToken?meta.dm?.ts:'').catch(e=>console.error('appfolio alert cleanup',e.message));
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
// Paul 2026-11-13: once scheduled, the card shows the time that was set instead of every time the tenant offered.
const MARK='(?:📅|:date:|:calendar:)';
function withScheduled(text,line){
 const t=String(text||''),has=new RegExp(MARK+' (?:Tenant availability|Scheduled):','u');
 if(has.test(t))return t.replace(new RegExp(MARK+' (?:Tenant availability|Scheduled):[\\s\\S]*?(?=\\n\\nVendor \\/ access instructions:|\\n\\nProperty notes:|\\n\\nWORK ORDER|$)','u'),line);
 return /\n\nVendor \/ access instructions:/.test(t)?t.replace(/\n\nVendor \/ access instructions:/,'\n\n'+line+'\n\nVendor / access instructions:'):t+'\n\n'+line;
}
// Slack stores the card's 📅 as its own emoji element between two text elements, so the card body is put back
// together, changed, and written as one text element. Cards holding anything else (links, mentions) are left alone.
function cardText(blocks,change){
 const section=blocks.find(b=>b.block_id==='wo_main')?.elements?.[0];
 if(!section||!Array.isArray(section.elements)||!section.elements.length)return false;
 if(!section.elements.every(e=>e.type==='text'&&typeof e.text==='string'&&!e.style||e.type==='emoji'&&(e.unicode||e.name)))return false;
 const whole=section.elements.map(e=>e.type==='text'?e.text:e.unicode?String.fromCodePoint(...e.unicode.split('-').map(x=>parseInt(x,16))):':'+e.name+':').join('');
 const next=change(whole);if(next===whole)return false;
 section.elements=[{type:'text',text:next}];
 return true;
}
function scheduleOnBlocks(blocks,line){return cardText(blocks,t=>withScheduled(t,line));}
// Paul 2026-11-13: tenant times that have already passed are no use on a card. Days before today and today's
// windows that have ended are taken off the "Tenant availability" list. A list that cannot be read is left alone.
function dropPast(text,now=Date.now()){
 const {date:today,time:clock}=pacific(now),h24=(h,m,ap)=>String((+h%12)+(/p/i.test(ap)?12:0)).padStart(2,'0')+':'+m;
 return String(text||'').replace(new RegExp('('+MARK+' Tenant availability:)\\n([\\s\\S]*?)(?=\\n\\nVendor \\/ access instructions:|\\n\\nProperty notes:|\\n\\nWORK ORDER|$)','u'),(all,head,body)=>{
  const days=[];
  for(const raw of body.split('\n')){
   const line=raw.trim();if(!line)continue;
   const d=line.match(/^([A-Za-z]+) (\d{1,2})\/(\d{1,2})\/(\d{4}):\s*(.*)$/);
   if(d)days.push({name:d[1]+' '+d[2]+'/'+d[3]+'/'+d[4],date:d[4]+'-'+d[2].padStart(2,'0')+'-'+d[3].padStart(2,'0'),windows:d[5]});
   else if(days.length)days[days.length-1].windows+=' '+line;else return all;
  }
  const kept=[];let dropped=false;
  for(const d of days){
   const windows=d.windows.split(',').map(w=>w.trim()).filter(Boolean),stay=[];
   for(const w of windows){
    const m=w.match(/^\d{1,2}:\d{2}\s*[ap]m\s*-\s*(\d{1,2}):(\d{2})\s*([ap]m)\b/i);if(!m)return all;
    if(d.date>today||d.date===today&&h24(m[1],m[2],m[3])>clock)stay.push(w);else dropped=true;
   }
   if(stay.length)kept.push(d.name+': '+stay.join(', '));
  }
  if(!dropped)return all;
  return kept.length?head+'\n'+kept.join('\n'):head+' the times the tenant offered have passed.';
 });
}
// Removes the Pick AppFolio time button from a TPS Bot card and, when a time was set, writes it on the card.
// Everything else on the card stays as it is.
async function removeButton(meta,options={},scheduled='',keepButton=false){
 if(!/^C/.test(meta.channel||'')||!/^\d{10}\.\d{6}$/.test(meta.cardTs||''))return false;
 const token=options.TPS_BOT_TOKEN||process.env.TPS_BOT_TOKEN,fetcher=options.fetch||global.fetch;
 const url=new URL('https://slack.com/api/conversations.history');for(const[k,v]of Object.entries({channel:meta.channel,oldest:meta.cardTs,latest:meta.cardTs,inclusive:'true',limit:'1'}))url.searchParams.set(k,v);
 const r=await fetcher(url.href,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)}),j=await r.json();
 if(!j.ok)throw Error('conversations.history: '+j.error);
 const m=(j.messages||[]).find(x=>x.ts===meta.cardTs);if(!m||!Array.isArray(m.blocks))return false;
 const blocks=JSON.parse(JSON.stringify(m.blocks.filter(b=>keepButton||!(b.type==='actions'&&(b.elements||[]).some(e=>e.action_id===ACTION)))));
 let text=m.text||'';
 if(scheduled){
  const line='📅 Scheduled: '+scheduled;
  scheduleOnBlocks(blocks,line);
  if(new RegExp(MARK+' (?:Tenant availability|Scheduled):','u').test(text))text=withScheduled(text,line);
 }else if(keepButton){cardText(blocks,t=>dropPast(t,options.now));text=dropPast(text,options.now);}
 if(JSON.stringify(blocks)===JSON.stringify(m.blocks)&&text===(m.text||''))return false;
 await slackApi('chat.update',{channel:meta.channel,ts:meta.cardTs,text,blocks},token,fetcher);
 return true;
}
// The "Schedule this call" alerts for this call in the TPS Assistant messages turn into one line once the call is
// scheduled, wherever it was scheduled from (the card button or the alert itself).
const ALERT_USER='U0876C3TEGL';
async function closeAlerts(call,done,options={},skipTs=''){
 const token=options.assistantToken??process.env.TPS_ASSISTANT_BOT_TOKEN,fetcher=options.fetch||global.fetch;
 if(!token||!validCall(call))return 0;
 const im=await slackApi('conversations.open',{users:ALERT_USER},token,fetcher);
 const url=new URL('https://slack.com/api/conversations.history');url.searchParams.set('channel',im.channel.id);url.searchParams.set('limit','100');
 const r=await fetcher(url.href,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)}),j=await r.json();
 if(!j.ok)throw Error('conversations.history: '+j.error);
 const mine=(j.messages||[]).filter(x=>x.ts!==skipTs&&(x.blocks||[]).some(b=>b.type==='actions'&&(b.elements||[]).some(e=>{if(e.action_id!==ACTION)return false;try{const v=JSON.parse(e.value);return v.invoice===call.invoice&&v.workOrder===call.workOrder;}catch{return false;}})));
 for(const m of mine)await slackApi('chat.update',{channel:im.channel.id,ts:m.ts,text:done,blocks:[md(done)]},token,fetcher);
 return mine.length;
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

module.exports={dropPast,findAssignCard,removeButton,closeAlerts,withScheduled,scheduleOnBlocks,ACTION,CALLBACK,intercepts,submissionError,route,routeCard,pickerView,ownTimeView,selectionOf,incomingTs,recordId,infoView,pacific};
