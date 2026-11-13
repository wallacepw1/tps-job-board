const test=require('node:test'),assert=require('node:assert/strict');
const af=require('../src/appfolio-schedule');
const now=Date.UTC(2026,10,9,20);const future=now+86400000;
const slots=[{id:'timeslot-1',label:'Tue 11/10/26: 8:00 am - 12:00 pm PST',start:future,end:future+4*3600000},{id:'timeslot-2',label:'old',start:now-1000,end:now+1000},{id:'bad',label:'x',start:future,end:future+1}];
const call={invoice:'132315',workOrder:'33717-1'};
function fakeSlack(log,{picker}){return async(url,opts)=>{if(url.includes('tps-appfolio-schedule-picker')){const b=JSON.parse(opts.body);log.push(['picker',b]);return{ok:true,text:async()=>JSON.stringify(picker(b))};}const m=url.split('/').pop(),b=JSON.parse(opts.body);log.push([m,b]);return{json:async()=>({ok:true,view:{id:'V1'},ts:'1.2'})};};}
test('intercepts only its button and modal',()=>{
 assert.equal(af.intercepts({type:'block_actions',actions:[{action_id:af.ACTION}]}),true);
 assert.equal(af.intercepts({type:'view_submission',view:{callback_id:af.CALLBACK}}),true);
 assert.equal(af.intercepts({type:'block_actions',actions:[{action_id:'assign_call'}]}),false);
});
test('picker view keeps only valid future windows',()=>{
 const v=af.pickerView(call,slots,{incomingTs:'1794241637.318289'},now);
 const opts=v.blocks[1].element.options;assert.equal(opts.length,1);assert.deepEqual(JSON.parse(opts[0].value),{id:'timeslot-1',start:future,end:future+4*3600000});
 assert.equal(JSON.parse(v.private_metadata).workOrder,'33717-1');
 assert.equal(af.pickerView(call,[slots[1]],{},now).title.text,'Schedule call');
});
test('reads incoming ts from the card reference',()=>{assert.equal(af.incomingTs([{type:'divider',block_id:'tpsref:RecAB:1794241637.318289'}]),'1794241637.318289');});
test('button: admin opens loading view, reads AppFolio, shows windows; nothing booked',async()=>{
 const log=[];const fetch=fakeSlack(log,{picker:b=>({status:'options',slots})});
 await af.route({type:'block_actions',team:{id:'T086X85G14N'},user:{id:'U0876C3TEGL'},trigger_id:'t',actions:[{action_id:af.ACTION,value:JSON.stringify(call)}],channel:{id:'C0C2XUL7ZHN'},message:{ts:'9.9',blocks:[{block_id:'tpsref:RecA:1794241637.318289'}]}},{fetch,TPS_BOT_TOKEN:'x',key:'k'});
 assert.deepEqual(log.map(x=>x[0]),['views.open','picker','views.update']);
 assert.equal(log[1][1].mode,'read');assert.equal(log[1][1].selection,undefined);
 assert.equal(log[2][1].view.callback_id,af.CALLBACK);
});
test('non-admin gets a notice and AppFolio is never opened',async()=>{
 const log=[];const fetch=fakeSlack(log,{picker:()=>{throw Error('no')}});
 await af.route({type:'block_actions',team:{id:'T086X85G14N'},user:{id:'U0C2TELAYKE'},trigger_id:'t',actions:[{action_id:af.ACTION,value:JSON.stringify(call)}]},{fetch,TPS_BOT_TOKEN:'x'});
 assert.deepEqual(log.map(x=>x[0]),['views.open']);
});
test('submit books the picked window and logs it in the Incoming thread',async()=>{
 const log=[];const fetch=fakeSlack(log,{picker:b=>({status:'booked',appointment:'Scheduled For: 11/10/26 ...'})});
 const sel={id:'timeslot-1',start:Date.now()+86400000,end:Date.now()+90000000};
 const p={type:'view_submission',team:{id:'T086X85G14N'},user:{id:'U0C2PMHJK0A'},view:{id:'V1',callback_id:af.CALLBACK,private_metadata:JSON.stringify({...call,incomingTs:'1794241637.318289'}),state:{values:{window:{slot:{selected_option:{text:{text:'Tue 8-12'},value:JSON.stringify(sel)}}}}}}};
 assert.equal(af.submissionError(p),null);
 const r=await af.route(p,{fetch,TPS_BOT_TOKEN:'x',key:'k'});
 assert.equal(r.booked,true);assert.deepEqual(log.map(x=>x[0]),['picker','views.update','chat.postMessage']);assert.match(r.routed,/not in Please Assign/);
 assert.equal(log[0][1].mode,'reserve');assert.deepEqual(log[0][1].selection,sel);
 assert.equal(log[2][1].thread_ts,'1794241637.318289');
});
test('submit without a pick is rejected before AppFolio',()=>{assert.ok(af.submissionError({view:{private_metadata:JSON.stringify(call),state:{values:{}}}}));});
test('reads the Latenode reply shape (stringified slots, "null" fields)',async()=>{
 const log=[];const f=Date.now()+86400000;const reply={status:'options',step:'null',appointment:'null',slots:JSON.stringify([{id:'timeslot-9',label:'Tue',start:f,end:f+3600000}])};
 const fetch=async(url,opts)=>{if(url.includes('tps-appfolio-schedule-picker'))return{ok:true,text:async()=>JSON.stringify(reply)};const m=url.split('/').pop();log.push([m,JSON.parse(opts.body)]);return{json:async()=>({ok:true,view:{id:'V1'}})};};
 await af.route({type:'block_actions',team:{id:'T086X85G14N'},user:{id:'U0876C3TEGL'},trigger_id:'t',actions:[{action_id:af.ACTION,value:JSON.stringify(call)}],message:{ts:'9.9',blocks:[]}},{fetch,TPS_BOT_TOKEN:'x',key:'k'});
 assert.equal(log[1][1].view.callback_id,af.CALLBACK);
});

const ASSIGN='C0C2XUL7ZHN';
test('booked window on a later day moves the Please Assign card to Future Calls via a Reschedule request',async()=>{
 const sent=[];const submit=async(req,o={})=>{sent.push([req,o.mode||'submit']);return{status:sent.length<2?'queued':'done'};};
 const now=Date.UTC(2026,10,10,1);// Nov 9 5pm Pacific
 const msg=await af.routeCard({user:{id:'U0876C3TEGL'}},{channel:ASSIGN,invoice:'132315',recordId:'RecABC123',incomingTs:'1794241637.318289'},{date:'2026-11-10',time:'10:00'},{now,submitAssignment:submit,pollMs:0});
 assert.match(msg,/Moved to Future Calls for 2026-11-10 10:00/);
 const r=sent[0][0];assert.equal(r.operation,'reschedule');assert.deepEqual(r.schedule,{date:'2026-11-10',time:'10:00'});assert.equal(r.expectedLead,null);assert.equal(r.recordId,'RecABC123');assert.equal(sent[1][1],'status');
});
test('same-day time keeps the card in Please Assign and sends nothing',async()=>{
 let called=false;const now=Date.UTC(2026,10,10,17);
 const msg=await af.routeCard({user:{id:'U0876C3TEGL'}},{channel:ASSIGN,recordId:'RecA',incomingTs:'1794241637.318289'},{date:'2026-11-10',time:'14:00'},{now,submitAssignment:async()=>{called=true}});
 assert.match(msg,/stays in Please Assign/);assert.equal(called,false);
});
test('own date/time is accepted without a tenant window; empty submit is rejected',()=>{
 const meta=JSON.stringify({...call});const tomorrow=af.pacific(Date.now()+86400000).date;
 const p={view:{private_metadata:meta,state:{values:{own_date:{date:{selected_date:tomorrow}},own_time:{time:{selected_time:'09:30'}}}}}};
 const s=af.selectionOf(p);assert.deepEqual(s.own,{date:tomorrow,time:'09:30'});assert.equal(s.selection,null);
 assert.ok(af.submissionError({view:{private_metadata:meta,state:{values:{window:{}}}}}).window);
});
test('reads record id and Pacific time',()=>{assert.equal(af.recordId([{block_id:'tpsref:RecXY9:1794241637.318289'}]),'RecXY9');assert.deepEqual(af.pacific(1794333600000),{date:'2026-11-10',time:'10:00'});});
test('DM button finds the card in Please Assign, and scheduling updates the DM',async()=>{
 const log=[];const card={ts:'1794300000.000100',blocks:[{type:'divider',block_id:'tpsref:RecDM1:1794299999.000200'},{type:'actions',elements:[{action_id:'tps_appfolio_pick_time',value:JSON.stringify(call)}]}]};
 const fetch=async(url,opts={})=>{if(url.includes('conversations.history')){log.push(['history',url]);return{json:async()=>({ok:true,messages:[{ts:'1.1',blocks:[]},card]})};}if(url.includes('tps-appfolio-schedule-picker'))return{ok:true,text:async()=>JSON.stringify(JSON.parse(opts.body).selection?.custom?{status:'booked',appointment:'Scheduled For: 1/5/99'}:{status:'options',slots})};const m=url.split('/').pop();log.push([m,JSON.parse(opts.body)]);return{json:async()=>({ok:true,view:{id:'V1'}})};};
 await af.route({type:'block_actions',team:{id:'T086X85G14N'},user:{id:'U0876C3TEGL'},trigger_id:'t',channel:{id:'D0PAUL'},message:{ts:'1794300001.000300',blocks:[]},actions:[{action_id:'tps_appfolio_pick_time',value:JSON.stringify(call)}]},{fetch,TPS_BOT_TOKEN:'x',key:'k'});
 const meta=JSON.parse(log.find(x=>x[0]==='views.update')[1].view.private_metadata);
 assert.equal(meta.channel,'C0C2XUL7ZHN');assert.equal(meta.cardTs,card.ts);assert.equal(meta.recordId,'RecDM1');assert.equal(meta.incomingTs,'1794299999.000200');assert.deepEqual(meta.dm,{channel:'D0PAUL',ts:'1794300001.000300'});
 log.length=0;
 const p={type:'view_submission',team:{id:'T086X85G14N'},user:{id:'U0876C3TEGL'},view:{id:'V2',private_metadata:JSON.stringify(meta),state:{values:{own_date:{date:{selected_date:'2099-01-05'}},own_time:{time:{selected_time:'09:00'}}}}}};
 const out=await af.route(p,{fetch,TPS_BOT_TOKEN:'x',submitAssignment:async()=>({status:'done'}),pollMs:0});
 assert.match(out.routed,/Moved to Future Calls/);
 const upd=log.find(x=>x[0]==='chat.update'&&x[1].channel==='D0PAUL');assert.ok(upd);assert.ok(log.find(x=>x[0]==='chat.update'&&x[1].channel==='C0C2XUL7ZHN'&&x[1].blocks.length===1));assert.equal(upd[1].channel,'D0PAUL');assert.match(upd[1].text,/2099-01-05 9 AM – 1 PM/);
 // With the Assistant token the confirmation goes to the TPS Assistant messages and the TPS Bot prompt is removed.
 log.length=0;await af.route(p,{fetch,TPS_BOT_TOKEN:'x',assistantToken:'xoxb-assistant',submitAssignment:async()=>({status:'done'}),pollMs:0});
 const conf=log.find(x=>x[0]==='chat.postMessage'&&x[1].channel==='U0876C3TEGL');assert.match(conf[1].text,/scheduled by <@U0876C3TEGL>: 2099-01-05 9 AM – 1 PM/);
 assert.deepEqual(log.find(x=>x[0]==='chat.delete')[1],{channel:'D0PAUL',ts:'1794300001.000300'});assert.equal(log.some(x=>x[0]==='chat.update'&&x[1].channel==='D0PAUL'),false);
 // Alert pressed in the TPS Assistant messages: it turns into the confirmation in place, nothing is posted or deleted.
 log.length=0;await af.route(p,{fetch,TPS_BOT_TOKEN:'x',viewToken:'xoxb-assistant',assistantToken:'xoxb-assistant',submitAssignment:async()=>({status:'done'}),pollMs:0});
 assert.match(log.find(x=>x[0]==='chat.update'&&x[1].channel==='D0PAUL')[1].text,/scheduled by <@U0876C3TEGL>/);assert.equal(log.some(x=>x[0]==='chat.delete'||x[0]==='chat.postMessage'&&x[1].channel==='U0876C3TEGL'),false);
});
test('DM button with no matching card leaves routing alone',async()=>{
 const fetch=async url=>({json:async()=>({ok:true,messages:[]})});
 assert.equal(await af.findAssignCard(call,{fetch,TPS_BOT_TOKEN:'x'}),null);
});
test('scheduling takes the button off the card and keeps the other blocks',async()=>{
 const log=[];const blocks=[{type:'rich_text',block_id:'wo_main'},{type:'actions',block_id:'tps_appfolio_pick',elements:[{action_id:'tps_appfolio_pick_time',value:JSON.stringify(call)}]},{type:'divider',block_id:'tpsref:RecZ1:1794299999.000200'},{type:'actions',block_id:'tps_card_resource_links',elements:[{action_id:'tps_resource_files'}]}];
 const fetch=async(url,opts={})=>{if(url.includes('conversations.history'))return{json:async()=>({ok:true,messages:[{ts:'1794300000.000100',text:'132315',blocks}]})};const m=url.split('/').pop();log.push([m,JSON.parse(opts.body)]);return{json:async()=>({ok:true})};};
 assert.equal(await af.removeButton({channel:'C0C2XUL7ZHN',cardTs:'1794300000.000100'},{fetch,TPS_BOT_TOKEN:'x'}),true);
 const u=log.find(x=>x[0]==='chat.update')[1];assert.deepEqual(u.blocks.map(b=>b.block_id),['wo_main','tpsref:RecZ1:1794299999.000200','tps_card_resource_links']);assert.equal(u.text,'132315');
 assert.equal(await af.removeButton({channel:'',cardTs:''},{fetch}),false);
});

function ownSubmit(status,log){
 const meta={channel:'C0C2XUL7ZHN',cardTs:'',incomingTs:'1794299999.000200',recordId:'RecOWN1',invoice:'132317',workOrder:'387266-1'};
 const fetch=async(url,opts={})=>{if(url.includes('tps-appfolio-schedule-picker')){const b=JSON.parse(opts.body);log.push(['picker',b]);return{ok:true,text:async()=>JSON.stringify({status,step:'null',appointment:'null',slots:'null'})};}const m=url.split('/').pop();log.push([m,JSON.parse(opts.body)]);return{json:async()=>({ok:true})};};
 const p={type:'view_submission',team:{id:'T086X85G14N'},user:{id:'U0876C3TEGL'},view:{id:'V2',private_metadata:JSON.stringify(meta),state:{values:{own_date:{date:{selected_date:'2099-01-05'}},own_time:{time:{selected_option:{value:'10:00'}}}}}}};
 return af.route(p,{fetch,TPS_BOT_TOKEN:'x',submitAssignment:async()=>({status:'done'}),pollMs:0});
}
test('own date + 4-hour window is entered in AppFolio, then the card moves',async()=>{
 const log=[];const out=await ownSubmit('booked',log);
 assert.deepEqual(log.find(x=>x[0]==='picker')[1].selection,{custom:true,date:'2099-01-05',time:'10:00'});
 assert.equal(out.booked,true);assert.match(out.routed,/Moved to Future Calls for 2099-01-05 10:00/);
 assert.match(log.find(x=>x[0]==='views.update')[1].view.blocks[0].text.text,/10 AM – 2 PM/);
 assert.ok(log.find(x=>x[0]==='chat.postMessage'&&x[1].thread_ts==='1794299999.000200'));
});
test('own window: AppFolio failure leaves the card where it is; tenant-times-only work order schedules the card only',async()=>{
 let log=[];let out=await ownSubmit('unverified',log);assert.equal(out.routed,'');assert.match(log.find(x=>x[0]==='views.update')[1].view.blocks[0].text.text,/card was not moved/);
 log=[];out=await ownSubmit('no_custom_form',log);assert.equal(out.booked,false);assert.match(out.routed,/Moved to Future Calls/);
});
test('own-time view offers 4-hour windows by start hour',()=>{
 const v=af.ownTimeView(call,{});const opts=v.blocks.find(b=>b.block_id==='own_time').element.options;
 assert.equal(opts[0].value,'07:00');assert.ok(opts.some(o=>o.text.text==='9 AM – 1 PM'&&o.value==='09:00'));assert.ok(opts.some(o=>o.text.text==='3 PM – 7 PM'&&o.value==='15:00'));
});
test('scheduled time replaces the tenant availability list on the card',()=>{
 const body='132366\n387458-1\n\nJason\n\n📅 Tenant availability:\nThursday 11/12/2026: 1:00pm-5:00pm PST\nFriday 11/13/2026: 10:00am-2:00pm PST,\n1:00pm-5:00pm PST\n\nVendor / access instructions:\nkey';
 const out=af.withScheduled(body,'📅 Scheduled: Fri 11/13/26: 1:00 pm - 5:00 pm PST (booked in AppFolio)');
 assert.equal(out,'132366\n387458-1\n\nJason\n\n📅 Scheduled: Fri 11/13/26: 1:00 pm - 5:00 pm PST (booked in AppFolio)\n\nVendor / access instructions:\nkey');
 assert.equal(af.withScheduled(out,'📅 Scheduled: X'),'132366\n387458-1\n\nJason\n\n📅 Scheduled: X\n\nVendor / access instructions:\nkey');
 assert.equal(af.withScheduled('a\n\nVendor / access instructions:\nk','📅 Scheduled: X'),'a\n\n📅 Scheduled: X\n\nVendor / access instructions:\nk');
 assert.equal(af.withScheduled('a','📅 Scheduled: X'),'a\n\n📅 Scheduled: X');
});
test('card button: time is written on the card and the Assistant alert for that call is closed',async()=>{
 const log=[],c={invoice:'132366',workOrder:'387458-1'},btn=v=>({type:'actions',block_id:'tps_appfolio_pick',elements:[{type:'button',action_id:'tps_appfolio_pick_time',value:JSON.stringify(v)}]});
 const card={ts:'1794570742.000100',text:'132366',blocks:[{type:'rich_text',block_id:'wo_main',elements:[{type:'rich_text_section',elements:[{type:'text',text:'132366\n387458-1\n\n📅 Tenant availability:\nFriday 11/13/2026: 1:00pm-5:00pm PST\n\nVendor / access instructions:'}]}]},btn(c)]};
 const alerts=[{ts:'1794570742.217879',blocks:[btn(c)]},{ts:'1794570795.393719',blocks:[btn({invoice:'132367',workOrder:'387534-1'})]}];
 const fetch=async(url,o={})=>{
  if(url.includes('tps-appfolio-schedule-picker'))return{ok:true,text:async()=>JSON.stringify({status:'booked',appointment:'Scheduled For: 11/13/26'})};
  if(url.includes('conversations.history')){const ch=new URL(url).searchParams.get('channel');log.push(['history',ch,o.headers.Authorization]);return{json:async()=>({ok:true,messages:ch==='DASSIST'?alerts:[card]})};}
  const m=url.split('/').pop(),b=JSON.parse(o.body);log.push([m,b,o.headers.Authorization]);return{json:async()=>({ok:true,channel:{id:'DASSIST'},view:{id:'V1'}})};
 };
 const start=Date.now()+3600000,meta={...c,channel:'C0C2XUL7ZHN',cardTs:card.ts,incomingTs:'',recordId:''};
 const p={type:'view_submission',team:{id:'T086X85G14N'},user:{id:'U0876C3TEGL'},view:{id:'V2',private_metadata:JSON.stringify(meta),state:{values:{window:{slot:{selected_option:{text:{text:'Fri 11/13/26: 1:00 pm - 5:00 pm PST'},value:JSON.stringify({id:'timeslot-1',start,end:start+4*3600000})}}}}}}};
 const out=await af.route(p,{fetch,TPS_BOT_TOKEN:'xoxb-bot',assistantToken:'xoxb-assistant',key:'k',now:start-3600000});
 assert.equal(out.booked,true);
 const cardUpd=log.find(x=>x[0]==='chat.update'&&x[1].channel==='C0C2XUL7ZHN');
 assert.equal(cardUpd[1].blocks.length,1);assert.match(cardUpd[1].blocks[0].elements[0].elements[0].text,/📅 Scheduled: .*\(booked in AppFolio\)\n\nVendor/);assert.doesNotMatch(cardUpd[1].blocks[0].elements[0].elements[0].text,/Tenant availability/);
 const closed=log.filter(x=>x[0]==='chat.update'&&x[1].channel==='DASSIST');
 assert.equal(closed.length,1);assert.equal(closed[0][1].ts,'1794570742.217879');assert.equal(closed[0][2],'Bearer xoxb-assistant');assert.match(closed[0][1].text,/132366 · WO 387458-1 scheduled by <@U0876C3TEGL>/);
});
test('card stored by Slack with the calendar as its own emoji element still gets the set time',()=>{
 const blocks=[{type:'rich_text',block_id:'wo_main',elements:[{type:'rich_text_section',elements:[{type:'text',text:'132366\n387458-1\n\nJason\n\n'},{type:'emoji',name:'date',unicode:'1f4c5'},{type:'text',text:' Tenant availability:\nThursday 11/12/2026: 1:00pm-5:00pm PST\nFriday 11/13/2026: 10:00am-2:00pm PST, 1:00pm-5:00pm PST\n\nVendor / access instructions:'}]}]}];
 assert.equal(af.scheduleOnBlocks(blocks,'📅 Scheduled: Fri 1 PM'),true);
 assert.deepEqual(blocks[0].elements[0].elements,[{type:'text',text:'132366\n387458-1\n\nJason\n\n📅 Scheduled: Fri 1 PM\n\nVendor / access instructions:'}]);
 assert.equal(af.withScheduled('a\n\n:date: Tenant availability:\nx\n\nVendor / access instructions:','📅 Scheduled: Y'),'a\n\n📅 Scheduled: Y\n\nVendor / access instructions:');
 const linked=[{type:'rich_text',block_id:'wo_main',elements:[{type:'rich_text_section',elements:[{type:'text',text:'a'},{type:'link',url:'https://x.y'}]}]}];assert.equal(af.scheduleOnBlocks(linked,'z'),false);assert.equal(linked[0].elements[0].elements.length,2);
});

test('tenant times that have passed come off the card list',()=>{
 const now=Date.parse('2026-11-13T20:00:00Z'); // Fri 11/13 12:00 PM Pacific
 const body='132366\n387458-1\n\n📅 Tenant availability:\nThursday 11/12/2026: 1:00pm-5:00pm PST\nFriday 11/13/2026: 8:00am-12:00pm PST,\n1:00pm-5:00pm PST\nMonday 11/16/2026: 10:00am-2:00pm PST\n\nVendor / access instructions:\nkey';
 assert.equal(af.dropPast(body,now),'132366\n387458-1\n\n📅 Tenant availability:\nFriday 11/13/2026: 1:00pm-5:00pm PST\nMonday 11/16/2026: 10:00am-2:00pm PST\n\nVendor / access instructions:\nkey');
 assert.equal(af.dropPast('a\n\n:date: Tenant availability:\nThursday 11/12/2026: 1:00pm-5:00pm PST\n\nVendor / access instructions:',now),'a\n\n:date: Tenant availability: the times the tenant offered have passed.\n\nVendor / access instructions:');
 const future='a\n\n📅 Tenant availability:\nMonday 11/16/2026: 10:00am-2:00pm PST,\n1:00pm-5:00pm PST';assert.equal(af.dropPast(future,now),future);
 const odd='a\n\n📅 Tenant availability:\nThursday 11/12/2026: call first\n\nVendor / access instructions:';assert.equal(af.dropPast(odd,now),odd);
 assert.equal(af.dropPast('a\n\n📅 Scheduled: X',now),'a\n\n📅 Scheduled: X');
 assert.equal(af.withScheduled(af.dropPast('a\n\n📅 Tenant availability:\nThursday 11/12/2026: 1:00pm-5:00pm PST\n\nVendor / access instructions:',now),'📅 Scheduled: Y'),'a\n\n📅 Scheduled: Y\n\nVendor / access instructions:');
});

// Paul 2026-11-13: one scheduler per card. Reschedule on an AppFolio card goes through AppFolio.
const rsCard={ts:'1794570797.362939',text:'132367',blocks:[{type:'rich_text',block_id:'wo_main',elements:[{type:'rich_text_section',elements:[{type:'text',text:'132367\n387534-1\nTorrey Pines\n\n'},{type:'emoji',name:'date',unicode:'1f4c5'},{type:'text',text:' Scheduled: 2026-11-13 10 AM – 2 PM (booked in AppFolio)'}]}]},{type:'divider',block_id:'tpsref:RecAB12:1794570796.200049'},{type:'actions',block_id:'action_buttons_block',elements:[{type:'button',action_id:'future_calls'}]}]};
const rsPress=(user='U0876C3TEGL',channel='C0C2XB4VD1N',message=rsCard)=>({type:'block_actions',team:{id:'T086X85G14N'},user:{id:user},trigger_id:'t',actions:[{action_id:'future_calls'}],channel:{id:channel},message});
test('Reschedule is taken over only for admins on AppFolio cards in Please Assign or Future Calls',()=>{
 assert.deepEqual(af.cardCall(rsCard),{invoice:'132367',workOrder:'387534-1'});
 assert.equal(af.intercepts(rsPress()),true);
 assert.equal(af.intercepts(rsPress('U0876C3TEGL','C0C2XUL7ZHN')),true);
 assert.equal(af.intercepts(rsPress('U0C2TELAYKE')),false);
 assert.equal(af.intercepts(rsPress('U0876C3TEGL','C0EDGAR0001')),false);
 const meld={...rsCard,blocks:[{type:'rich_text',block_id:'wo_main',elements:[{type:'rich_text_section',elements:[{type:'text',text:'132344\nTBG7EL3\nTyco'}]}]}]};
 assert.equal(af.intercepts(rsPress('U0876C3TEGL','C0C2XB4VD1N',meld)),false);
});
test('Reschedule on a card booked in AppFolio offers AppFolio reschedule plus No date/time',async()=>{
 const log=[];const fetch=fakeSlack(log,{picker:b=>({status:'already_scheduled',appointment:'Schedule Reschedule Scheduled For: 11/13/26 Arrival Window 4 hours Time 10:00 AM Timezone PST'})});
 await af.route(rsPress(),{fetch,TPS_BOT_TOKEN:'x',key:'k'});
 const v=log.find(x=>x[0]==='views.update')[1].view;
 assert.equal(v.title.text,'Reschedule in AppFolio');assert.match(v.blocks[0].text.text,/11\/13\/26 10:00 AM/);
 const meta=JSON.parse(v.private_metadata);assert.equal(meta.reschedule,true);assert.equal(meta.via,'reschedule');assert.equal(meta.recordId,'RecAB12');
 assert.ok(v.blocks.some(b=>b.block_id==='no_date'));
 assert.equal(log.filter(x=>x[0]==='chat.update').length,0);
});
test('Reschedule with tenant times ahead shows only scheduling choices; none left adds No date/time; unreadable AppFolio is card only',async()=>{
 let log=[];await af.route(rsPress(),{fetch:fakeSlack(log,{picker:()=>({status:'options',slots:[{id:'timeslot-1',label:'Mon',start:Date.now()+86400000,end:Date.now()+90000000}]})}),TPS_BOT_TOKEN:'x'});
 let v=log.find(x=>x[0]==='views.update')[1].view;assert.equal(v.title.text,'Schedule in AppFolio');assert.ok(!v.blocks.some(b=>b.block_id==='no_date'));
 log=[];await af.route(rsPress(),{fetch:fakeSlack(log,{picker:()=>({status:'options',slots:[]})}),TPS_BOT_TOKEN:'x'});
 v=log.find(x=>x[0]==='views.update')[1].view;assert.ok(v.blocks.some(b=>b.block_id==='no_date'));assert.equal(v.blocks.find(b=>b.block_id==='own_date').optional,true);
 log=[];await af.route(rsPress(),{fetch:fakeSlack(log,{picker:()=>({status:'unverified',step:'login'})}),TPS_BOT_TOKEN:'x'});
 v=log.find(x=>x[0]==='views.update')[1].view;assert.equal(JSON.parse(v.private_metadata).cardOnly,true);assert.match(v.blocks[0].text.text,/not\* changed/);
});
const rsSubmit=(meta,values)=>({type:'view_submission',team:{id:'T086X85G14N'},user:{id:'U0876C3TEGL'},view:{id:'V9',callback_id:af.CALLBACK,private_metadata:JSON.stringify({invoice:'132367',workOrder:'387534-1',channel:'C0C2XB4VD1N',cardTs:rsCard.ts,incomingTs:'1794570796.200049',recordId:'RecAB12',via:'reschedule',...meta}),state:{values}}});
const noDate={no_date:{none:{selected_options:[{value:'none'}]}}};
const ownLater=d=>({own_date:{date:{selected_date:d}},own_time:{time:{selected_option:{value:'09:00'}}}});
test('No date/time moves only the card; AppFolio is never called',async()=>{
 const log=[],sent=[];const fetch=fakeSlack(log,{picker:()=>{throw Error('AppFolio must not be called');}});
 const p=rsSubmit({},noDate);assert.equal(af.submissionError(p),null);assert.match(af.pendingText(p),/not changed/);
 const r=await af.route(p,{fetch,TPS_BOT_TOKEN:'x',submitAssignment:async q=>{sent.push(q);return{status:'done'};}});
 assert.equal(sent.length,1);assert.deepEqual(sent[0].schedule,{noDate:true});assert.equal(sent[0].operation,'reschedule');
 assert.ok(!log.some(x=>x[0]==='picker'));assert.match(r.routed,/no date\/time/);
 assert.ok(af.submissionError(rsSubmit({},{...noDate,...ownLater('2099-01-05')})));
 assert.ok(af.submissionError({...rsSubmit({via:''},noDate)}));
});
test('Reschedule submit moves the AppFolio appointment, then the card',async()=>{
 const log=[],sent=[];const fetch=fakeSlack(log,{picker:b=>b.mode==='reserve'?{status:'booked',appointment:'Scheduled For: 1/5/99 Arrival Window 4 hours Time 9:00 AM'}:{status:'already_scheduled'}});
 const p=rsSubmit({reschedule:true},ownLater('2099-01-05'));assert.match(af.pendingText(p),/Rescheduling in AppFolio/);
 const r=await af.route(p,{fetch,TPS_BOT_TOKEN:'x',key:'k',submitAssignment:async q=>{sent.push(q);return{status:'done'};}});
 const pk=log.find(x=>x[0]==='picker')[1];assert.deepEqual(pk.selection,{custom:true,reschedule:true,date:'2099-01-05',time:'09:00'});
 assert.equal(r.booked,true);assert.deepEqual(sent[0].schedule,{date:'2099-01-05',time:'09:00'});
 assert.match(log.find(x=>x[0]==='chat.postMessage'&&x[1].channel==='C0C19TG3KJ6')[1].text,/rescheduled by/);
});
test('Reschedule that AppFolio does not confirm leaves the card where it is',async()=>{
 const log=[],sent=[];const fetch=fakeSlack(log,{picker:()=>({status:'unverified',step:'rescheduled: x'})});
 const r=await af.route(rsSubmit({reschedule:true},ownLater('2099-01-05')),{fetch,TPS_BOT_TOKEN:'x',key:'k',submitAssignment:async q=>{sent.push(q);return{status:'done'};}});
 assert.equal(r.booked,false);assert.equal(sent.length,0);
});
test('Card-only (AppFolio unreadable) moves the card without calling AppFolio',async()=>{
 const log=[],sent=[];const fetch=fakeSlack(log,{picker:()=>{throw Error('AppFolio must not be called');}});
 await af.route(rsSubmit({cardOnly:true},ownLater('2099-01-05')),{fetch,TPS_BOT_TOKEN:'x',submitAssignment:async q=>{sent.push(q);return{status:'done'};}});
 assert.ok(!log.some(x=>x[0]==='picker'));assert.deepEqual(sent[0].schedule,{date:'2099-01-05',time:'09:00'});
});
