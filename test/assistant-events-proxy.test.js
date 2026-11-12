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
test('signed admin Meld click is acknowledged and relayed directly with the internal key',async()=>{
 const routes={},secret='fixture-signing',sent=[];let ack=false;
 registerAssistantEventsProxy({router:{post:(p,h)=>routes[p]=h,get:()=>{}}},{secret,key:'fixture-internal',fetch:async(url,p)=>{assert.equal(ack,false);sent.push({url,p});return{ok:true,status:200,text:async()=>''};}});
 const payload={type:'block_actions',team:{id:'T086X85G14N'},user:{id:'U0876C3TEGL'},actions:[{action_id:'meld_accept'}]},raw=new URLSearchParams({payload:JSON.stringify(payload)}).toString(),ts=String(Math.floor(Date.now()/1000));
 const headers={'x-slack-request-timestamp':ts,'x-slack-signature':'v0='+createHmac('sha256',secret).update('v0:'+ts+':'+raw).digest('hex')};
 const res={status(n){this.code=n;return this;},send(){ack=true;return this;},type(){return this;}};
 await routes['/slack/assistant-events']({rawBody:Buffer.from(raw),headers},res);assert.equal(res.code,200);assert.equal(sent[0].url,'https://webhook.latenode.com/27333/prod/eb873fbf-b964-4cf3-a704-adeb16274831');assert.equal(JSON.parse(JSON.parse(sent[0].p.body).payload).key,'fixture-internal');
});

test('Schedule this call pressed in the Assistant messages opens the pop-up with the Assistant token and is not relayed',async()=>{
 const routes={},secret='fixture-signing',sent=[];
 const fetch=async(url,o)=>{sent.push({url,auth:o.headers?.Authorization,body:o.body});if(url.includes('tps-appfolio-schedule-picker'))return{ok:true,text:async()=>JSON.stringify({status:'options',slots:'[]'})};return{json:async()=>({ok:true,view:{id:'V1'},messages:[]})};};
 registerAssistantEventsProxy({router:{post:(p,h)=>routes[p]=h,get:()=>{}}},{secret,key:'k',assistantToken:'xoxb-assistant',TPS_BOT_TOKEN:'xoxb-bot',fetch});
 const payload={type:'block_actions',team:{id:'T086X85G14N'},user:{id:'U0876C3TEGL'},trigger_id:'t',channel:{id:'D0ASSIST'},message:{ts:'1794300001.000300',blocks:[]},actions:[{action_id:'tps_appfolio_pick_time',value:JSON.stringify({invoice:'132364',workOrder:'387489-1'})}]};
 const raw=new URLSearchParams({payload:JSON.stringify(payload)}).toString(),ts=String(Math.floor(Date.now()/1000));
 const headers={'x-slack-request-timestamp':ts,'x-slack-signature':'v0='+createHmac('sha256',secret).update('v0:'+ts+':'+raw).digest('hex')};
 const res={status(n){this.code=n;return this;},send(){return this;},json(){return this;},type(){return this;}};
 await routes['/slack/assistant-events']({rawBody:Buffer.from(raw),headers},res);assert.equal(res.code,200);
 for(let i=0;i<50&&!sent.some(x=>x.url.endsWith('views.update'));i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(sent.find(x=>x.url.endsWith('views.open')).auth,'Bearer xoxb-assistant');assert.equal(sent.find(x=>x.url.endsWith('views.update')).auth,'Bearer xoxb-assistant');
 assert.equal(sent.find(x=>x.url.includes('conversations.history')).auth,'Bearer xoxb-bot');assert.equal(sent.some(x=>x.url.includes('media-bot-slack-events')),false);
});
