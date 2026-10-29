const test=require('node:test'),assert=require('node:assert/strict');
const {JobStore,finalize,dayKey}=require('../src/jobs');
const {applyWorkflow}=require('../src/workflow');
const {parseReplies}=require('../src/parse');
const now=()=>String(Date.now()/1000);
test('a confirmed return starts a new visit instead of inheriting the completed visit date',()=>{
 const ts=d=>String(new Date(d).getTime()/1000);
 const history=parseReplies([{ts:ts('2026-10-20T16:00:00Z'),text:'Call assigned to Eduardo on Tue Oct 20'}, {ts:ts('2026-10-20T20:00:00Z'),text:'Call completed'}, {ts:ts('2026-10-29T16:00:00Z'),text:'Return on the same unbilled invoice assigned to Cindy: Handle still leaks. Prior pricing remains historical; no invoice was changed or sent.'}]);
 assert.equal(history.completed,false);assert.equal(history.visitDate,'2026-10-29');assert.equal(history.scheduledFor,null);assert.equal(history.tech,'Cindy');
});
const parent={ts:'1790000000.000001',text:'132999\nTest customer\n123 Main St\nSan Diego, CA 92101',reply_count:0};
const source=()=>({jobNumber:'132999',role:'plumber',channel:'C0C19G9GT34',incomingTs:parent.ts,tech:{name:'Cindy',id:'U0C2JV565K7'},message:{ts:now(),text:'132999',reply_count:2,latest_reply:'1793290000.000002',blocks:[{type:'context',block_id:'tpsref:RecTEST123:'+parent.ts}]}});
function store(card,thread=[]){const s=new JobStore({conversations:{replies:async p=>({messages:p.channel==='C0C19TG3KJ6'?[parent,...thread]:[card.message]})}});s.fetchCalendar=async()=>[];s.fetchPosts=async()=>[];s.fetchFutureCalls=async()=>new Map();s.fetchCalls=async()=>new Map();s.fetchWorkflow=async()=>new Map([['132999',card]]);return s;}
test('a newly assigned visit ignores an older inherited booking and calendar',()=>{const card=source();card.message.ts=String(new Date('2026-10-29T16:00:00Z').getTime()/1000);const j=finalize(applyWorkflow({jobNumber:'132999',scheduledFor:{date:'2026-10-20',time:'10:00'},event:{summary:'132999',start:{dateTime:'2026-10-20T10:00:00-07:00'}}},card));assert.equal(dayKey(j.when),'2026-10-29');});
test('reassigning an undated visit keeps its original visit day',()=>{const history=parseReplies([{ts:String(new Date('2026-10-28T16:00:00Z').getTime()/1000),text:'Call assigned to Eduardo on Wed Oct 28, 2026 9:00 AM'},{ts:String(new Date('2026-10-29T16:00:00Z').getTime()/1000),text:'Call reassigned from Eduardo to Cindy on Thu Oct 29, 2026 9:00 AM'}]);const j=finalize(applyWorkflow({jobNumber:'132999',...history},source()));assert.equal(dayKey(j.when),'2026-10-28');});
test('recovering an older Incoming parent also preserves its cancellation',async()=>{const card={...source(),role:'assign'};const s=store(card,[{ts:now(),text:'Call cancelled by Paul'}]);await s.refresh();assert.equal(s.jobs.length,0);});
test('recovering an older Incoming parent preserves helper history',async()=>{const s=store(source(),[{ts:now(),text:'TPS helper assigned: <@UHELPER>'}]);await s.refresh();assert.equal(s.jobs[0].helperId,'UHELPER');});
test('an edited lead comment invalidates Pending completion without changing reply count',async()=>{const card=source(),s=store(card);let note='Replaced faucet';s.slack.conversations.replies=async p=>({messages:p.channel==='C0C19TG3KJ6'?[parent]:[card.message,{ts:'2',text:note},{ts:'3',files:[{id:'F',mimetype:'image/jpeg'}]}]});await s.refresh();assert.equal(s.jobs[0].status,'pending');note='';s.invalidateThread(card.channel,card.message.ts);await s.refresh();assert.equal(s.jobs[0].status,'assigned');});
test('source read failures retain the previous verified board',async()=>{const s=store(source());const previous=[{jobNumber:'132123'}];s.jobs=previous;s.fetchWorkflow=async()=>{throw Error('channel access failed')};await assert.rejects(s.refresh(),/channel access/);assert.equal(s.jobs,previous);});
test('the current card selects its real Incoming thread over another intake for the same invoice',async()=>{
 const card={...source(),role:'future'};card.message.text='132999\nNEEDS TO BE SCHEDULED';
 const s=store(card,[{ts:now(),text:'Tenant access still needed'}]);
 s.fetchPosts=async()=>[{...parent,ts:'1780000000.000001',text:'132999\nOld duplicate intake',reply_count:0}];
 await s.refresh();assert.equal(s.jobs[0].threadTs,parent.ts);assert.equal(s.jobs[0].needsDate,true);
});
test('a cancellation in the canonical Incoming removes a stale duplicate intake too',async()=>{
 const s=store({...source(),role:'future'},[{ts:now(),text:'Call cancelled by Paul'}]);
 s.fetchPosts=async()=>[{...parent,ts:'1780000000.000001',text:'132999\nOld duplicate intake',reply_count:0}];
 await s.refresh();assert.equal(s.find('132999'),undefined);assert.equal(s.jobs.length,0);
});
test('a file-only Incoming is verified against its matching work order and Calls record',async()=>{
 const card={...source(),role:'completed',recordId:'RecTEST123'};card.message.text='132999\n250089-2\nTest customer';
 const s=store(card);s.fetchCalls=async()=>new Map([['132999',{recordId:'RecTEST123',description:card.message.text}]]);
 s.slack.conversations.replies=async()=>({messages:[{ts:parent.ts,text:'',files:[{name:'250089-2.pdf'}]}]});
 await s.refresh();assert.equal(s.find('132999').status,'done');assert.equal(s.find('132999').workOrder,'250089-2');
 s.slack.conversations.replies=async()=>({messages:[{ts:parent.ts,text:'',files:[{name:'unrelated.pdf'}]}]});
 await assert.rejects(s.refresh(),/Incoming identity/);
});
