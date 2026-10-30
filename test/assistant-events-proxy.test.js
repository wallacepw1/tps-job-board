const test=require('node:test'),assert=require('node:assert/strict');
const {parseAssistantBody,shouldForwardAssistant,registerAssistantEventsProxy}=require('../src/assistant-events-proxy');
const {createHmac}=require('node:crypto');
const event=e=>({type:'event_callback',event:e});
test('filters channel posts and deletions while retaining recall replies and edits',()=>{
 assert.equal(shouldForwardAssistant(event({type:'message',channel:'C1',bot_id:'B1'})),false);
 assert.equal(shouldForwardAssistant(event({type:'message',channel:'C1',text:'unrelated'})),false);
 assert.equal(shouldForwardAssistant(event({type:'message',subtype:'message_deleted',channel:'C1'})),false);
 for(const message of [{thread_ts:'123.456',bot_id:'B1',files:[{}]},{thread_ts:'123.456',text:'changed'}]){
  assert.equal(shouldForwardAssistant(event({type:'message',channel:'C1',...message})),true);
  assert.equal(shouldForwardAssistant(event({type:'message',subtype:'message_changed',channel:'C1',message})),true);
 }
 assert.equal(shouldForwardAssistant(event({type:'message',channel:'D1',user:'U1'})),true);
 assert.equal(shouldForwardAssistant(event({type:'app_home_opened',tab:'messages'})),false);
 assert.equal(shouldForwardAssistant(event({type:'app_home_opened',tab:'home'})),true);
});
test('preserves interactive and slash payloads',()=>{
 for(const body of [{type:'block_actions',actions:[{value:'qb:menu'}]},{type:'view_submission',view:{callback_id:'tps_invoice'}},{command:'/tps',text:'payroll'}]){
  const raw=new URLSearchParams(body.command?body:{payload:JSON.stringify(body)}).toString();
  assert.deepEqual(parseAssistantBody(raw),body);assert.equal(shouldForwardAssistant(body),true);
 }
});
test('signature is required and filtered events never invoke Latenode',async()=>{
 const routes={},secret='test-secret';let calls=0;
 registerAssistantEventsProxy({router:{post:(p,h)=>routes[p]=h,get:()=>{}}},{secret,fetch:async()=>{calls++;return{status:200,text:async()=>''}}});
 const raw=JSON.stringify(event({type:'message',channel:'C1',bot_id:'B1'})),ts=String(Math.floor(Date.now()/1000));
 const headers={'x-slack-request-timestamp':ts,'x-slack-signature':'v0='+createHmac('sha256',secret).update('v0:'+ts+':'+raw).digest('hex')};
 const res={status(n){this.code=n;return this},send(){return this},type(){return this}};
 await routes['/slack/assistant-events']({rawBody:Buffer.from(raw),headers:{}},res);assert.equal(res.code,401);
 await routes['/slack/assistant-events']({rawBody:Buffer.from(raw),headers},res);assert.equal(res.code,200);assert.equal(calls,0);
});

