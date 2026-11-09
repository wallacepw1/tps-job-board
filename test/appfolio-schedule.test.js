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
 assert.equal(af.pickerView(call,[slots[1]],{},now).callback_id,af.CALLBACK+'_info');
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
 assert.equal(r.booked,true);assert.deepEqual(log.map(x=>x[0]),['picker','views.update','chat.postMessage']);
 assert.equal(log[0][1].mode,'reserve');assert.deepEqual(log[0][1].selection,sel);
 assert.equal(log[2][1].thread_ts,'1794241637.318289');
});
test('submit without a pick is rejected before AppFolio',()=>{assert.ok(af.submissionError({view:{private_metadata:JSON.stringify(call),state:{values:{}}}}));});
