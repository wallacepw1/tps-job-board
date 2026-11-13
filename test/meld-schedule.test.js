const test=require('node:test'),assert=require('node:assert/strict');
const ms=require('../src/meld-schedule');
const af=require('../src/appfolio-schedule');
const ADMIN={team:{id:'T086X85G14N'},user:{id:'U0876C3TEGL'}};
const card=(code='TBG7EL3')=>({ts:'1794241000.000100',text:'x',blocks:[{block_id:'wo_main',type:'rich_text',elements:[{type:'rich_text_section',elements:[{type:'text',text:`132344\n${code}\n\n1155 Connecticut Street`}]}]},{type:'context',block_id:'tpsref:RecAB12:1794241637.318289',elements:[]}]});
const press=(extra={})=>({type:'block_actions',...ADMIN,trigger_id:'t',actions:[{action_id:'future_calls'}],channel:{id:'C0C2XB4VD1N'},message:card(),...extra});
function fake(log,scheduler){return async(url,opts={})=>{
 if(url.includes('tps-meld-schedule')){const b=JSON.parse(opts.body);log.push(['meld',b]);return{ok:true,text:async()=>JSON.stringify(JSON.stringify(scheduler(b)))};}
 const m=url.split('?')[0].split('/').pop();
 if(m==='conversations.history'){log.push([m]);return{json:async()=>({ok:true,messages:[{ts:'1794241000.000100',...card()}]})};}
 log.push([m,JSON.parse(opts.body)]);return{json:async()=>({ok:true,view:{id:'V1'},ts:'1.2'})};};}
const submit=(meta,values)=>({type:'view_submission',...ADMIN,view:{id:'V9',callback_id:ms.CALLBACK,private_metadata:JSON.stringify({invoice:'132344',code:'TBG7EL3',channel:'C0C2XUL7ZHN',cardTs:'1794241000.000100',incomingTs:'1794241637.318289',recordId:'RecAB12',...meta}),state:{values}}});
const win=(n,date,time)=>({['date_'+n]:{date:{selected_date:date}},['time_'+n]:{time:{selected_option:{value:time}}}});
const noDate={no_date:{none:{selected_options:[{value:'none'}]}}};
const opts=(log,scheduler,sent=[])=>({fetch:fake(log,scheduler),TPS_BOT_TOKEN:'x',key:'k',submitAssignment:async q=>{sent.push(q);return{status:'done'};}});

test('Reschedule is taken over only for admins on Meld cards in Please Assign or Future Calls; AppFolio leaves them alone',()=>{
 assert.equal(ms.intercepts(press()),true);
 assert.equal(ms.intercepts(press({user:{id:'U0C2TELAYKE'}})),false);
 assert.equal(ms.intercepts(press({channel:{id:'C0C19TG3KJ6'}})),false);
 assert.equal(ms.intercepts(press({message:{blocks:[{block_id:'wo_main',elements:[{elements:[{type:'text',text:'132344\n33717-1'}]}]}]}})),false);
 assert.equal(af.intercepts(press()),false);
 assert.deepEqual(ms.meldCall(card('TZ7QPAAB')),{invoice:'132344',code:'TZ7QPAAB'});
});
test('press reads Meld, then booked Meld shows Reschedule plus No date',async()=>{
 const log=[];await ms.route(press(),opts(log,b=>({status:'ok',booked:{label:'Mon, Nov 16 · 9 AM – 1 PM PT',start:'2026-11-16T17:00:00Z'},meldUrl:'https://m'})));
 assert.deepEqual(log.map(x=>x[0]),['views.open','meld','views.update']);
 assert.equal(log[1][1].mode,'read');assert.equal(log[1][1].code,'TBG7EL3');assert.equal(log[1][1].key,'k');
 const v=log[2][1].view;assert.equal(JSON.parse(v.private_metadata).mode,'move');assert.equal(JSON.parse(v.private_metadata).recordId,'RecAB12');
 assert.ok(v.blocks.some(b=>b.block_id==='no_date'));
});
test('resident times ahead: only those times, no plain No date',()=>{
 const v=ms.viewFor({invoice:'132344',code:'TBG7EL3'},{},{status:'ok',booked:null,times:[{id:78,label:'Sat 8-12',start:'x'}],presence:true});
 assert.equal(JSON.parse(v.private_metadata).mode,'book');assert.ok(!v.blocks.some(b=>b.block_id==='no_date'));
 assert.equal(v.blocks[1].element.options.length,1);
});
test('no resident times: offer up to 3 windows plus No date; no resident or unreadable Meld: card-only No date',()=>{
 const o=ms.viewFor({invoice:'132344',code:'TBG7EL3'},{},{status:'ok',times:[],presence:true,offer:{windows:['A','B']}});
 assert.equal(JSON.parse(o.private_metadata).mode,'offer');assert.ok(o.blocks.some(b=>b.block_id==='date_3'));assert.match(o.blocks[0].text.text,/Already offered A or B/);
 for(const out of [{status:'ok',times:[],presence:false},{status:'error',why:'x'},{status:'closed',meldStatus:'COMPLETED'},{status:'unknown'}]){
  const v=ms.viewFor({invoice:'132344',code:'TBG7EL3'},{},out);assert.equal(JSON.parse(v.private_metadata).mode,'none');assert.deepEqual(v.blocks.map(b=>b.block_id).filter(Boolean),['no_date']);
 }
});
test('No date moves only the card; Meld is never called',async()=>{
 const log=[],sent=[];const p=submit({mode:'move'},noDate);
 assert.equal(ms.submissionError(p),null);assert.match(ms.pendingText(p),/Meld is not changed/);
 const r=await ms.route(p,opts(log,()=>{throw Error('Meld must not be called');},sent));
 assert.deepEqual(sent[0].schedule,{noDate:true});assert.ok(!log.some(x=>x[0]==='meld'));assert.match(r.routed,/no date/);
 assert.ok(ms.submissionError(submit({mode:'move'},{...noDate,...win(1,'2099-01-05','09:00')})));
 assert.ok(ms.submissionError(submit({mode:'none'},{})));
});
test('booked Meld: new time is moved in Meld first, then the card note, card and Incoming log',async()=>{
 const log=[],sent=[];const p=submit({mode:'move'},win(1,'2099-01-05','09:00'));
 assert.equal(ms.submissionError(p),null);
 const r=await ms.route(p,opts(log,b=>({status:'moved',was:'old',booked:{label:'Mon, Jan 5 · 9 AM – 1 PM PT',start:'2099-01-05T17:00:00Z'}}),sent));
 const call=log.find(x=>x[0]==='meld')[1];assert.equal(call.mode,'move');assert.deepEqual(call.windows,[{date:'2099-01-05',time:'09:00'}]);
 assert.deepEqual(sent[0].schedule,{date:'2099-01-05',time:'09:00'});assert.equal(r.status,'moved');
 const upd=log.find(x=>x[0]==='chat.update')[1];assert.match(JSON.stringify(upd.blocks),/Scheduled: Mon, Jan 5 · 9 AM – 1 PM PT \(rescheduled in Meld\)/);
 assert.match(log.find(x=>x[0]==='chat.postMessage')[1].text,/rescheduled in Meld by/);
});
test('resident time is booked in Meld; Meld that does not confirm leaves the card where it is',async()=>{
 let log=[],sent=[];const p=submit({mode:'book'},{slot:{slot:{selected_option:{value:JSON.stringify({id:78,label:'Sat 8-12'})}}}});
 await ms.route(p,opts(log,b=>({status:'booked',booked:{label:'Sat',start:'2099-01-03T16:00:00Z'}}),sent));
 assert.equal(log.find(x=>x[0]==='meld')[1].id,78);assert.deepEqual(sent[0].schedule,{date:'2099-01-03',time:'08:00'});
 log=[];sent=[];const r=await ms.route(p,opts(log,()=>({status:'unconfirmed'}),sent));
 assert.equal(sent.length,0);assert.ok(!log.some(x=>x[0]==='chat.update'));assert.equal(r.status,'unconfirmed');
 assert.ok(ms.submissionError(submit({mode:'book'},{})));
});
test('offer needs 2-3 windows that do not overlap; card waits at the first window',async()=>{
 assert.ok(ms.submissionError(submit({mode:'offer'},win(1,'2099-01-05','09:00'))));
 assert.ok(ms.submissionError(submit({mode:'offer'},{...win(1,'2099-01-05','09:00'),...win(2,'2099-01-05','11:00')})));
 const log=[],sent=[];const p=submit({mode:'offer'},{...win(1,'2099-01-06','13:00'),...win(2,'2099-01-05','08:00')});
 assert.equal(ms.submissionError(p),null);
 await ms.route(p,opts(log,b=>({status:'offered',windows:['Jan 5 8-12','Jan 6 1-5'],first:{date:'2099-01-05',time:'08:00'}}),sent));
 assert.deepEqual(log.find(x=>x[0]==='meld')[1].windows,[{date:'2099-01-05',time:'08:00'},{date:'2099-01-06',time:'13:00'}]);
 assert.deepEqual(sent[0].schedule,{date:'2099-01-05',time:'08:00'});
 assert.match(JSON.stringify(log.find(x=>x[0]==='chat.update')[1].blocks),/Waiting for the resident: Jan 5 8-12 or Jan 6 1-5 \(offered in Meld\)/);
});
