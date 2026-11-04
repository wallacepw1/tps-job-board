const test=require('node:test'),assert=require('node:assert/strict'),{createHmac}=require('node:crypto');
const {inspectJobFilesEvent,registerJobFilesEvents}=require('../src/call-actions-proxy');
const secret='test-secret',now=Date.now();
const FOLDER='1Hk8dnTybkB0TIgEvJoqIBMLkKeYxeBul';
const event=(id=`job-files:132198:${FOLDER}`)=>({type:'event_callback',team_id:'T086X85G14N',api_app_id:'A0C54G77M6E',event:{type:'entity_details_requested',user:'U0876C3TEGL',external_ref:{id,type:'tps_job_files'},entity_url:`https://drive.google.com/drive/folders/${FOLDER}`,channel:'C0C2ZVB32RG',message_ts:'1793719172.591069',trigger_id:'test-trigger'}});
function request(p,ts=String(Math.floor(now/1000))){const raw=JSON.stringify(p);return{raw,headers:{'x-slack-request-timestamp':ts,'x-slack-signature':'v0='+createHmac('sha256',secret).update('v0:'+ts+':'+raw).digest('hex')}};}
const inspect=p=>{const r=request(p);return inspectJobFilesEvent(r.raw,r.headers,{secret,now});};
test('panel callback requires a valid Slack signature and echoes only verified challenges',()=>{const p={type:'url_verification',challenge:'test-challenge'},r=request(p);assert.equal(inspect(p).body,p.challenge);assert.equal(inspectJobFilesEvent(r.raw,{},{secret,now}).status,401);assert.equal(inspectJobFilesEvent(r.raw,r.headers,{secret,now:now+301000}).status,401);});
test('only TPS Bot job files clicks are presented',()=>{
 assert.equal(inspect(event()).present.trigger_id,'test-trigger');
 assert.ok(inspect(event('tps-job-files-test-132263')).present,'first test card still answered');
 const ordinary=event();ordinary.event.type='message';assert.equal(inspect(ordinary).present,undefined);
 assert.equal(inspect(event('another-job')).present,undefined);
 const other=event();other.api_app_id='other-app';assert.equal(inspect(other).present,undefined);
 const team=event();team.team_id='T0';assert.equal(inspect(team).present,undefined);
});
test('click is acknowledged first, then answered with entity.presentDetails and an embed; Latenode is never called',async()=>{
 const routes={},receiver={router:{get:(p,h)=>routes[p]=h,post:(p,h)=>routes[p]=h}};let acknowledged=false;const calls=[];
 const fetch=async(url,init)=>{assert.equal(acknowledged,true);calls.push({url,body:JSON.parse(init.body),auth:init.headers.Authorization});return{ok:true,json:async()=>({ok:true})};};
 registerJobFilesEvents(receiver,{secret,now,fetch,TPS_BOT_TOKEN:'xoxb-test',TPS_INTERNAL_KEY:'k',PUBLIC_URL:'https://board.example'});
 const r=request(event());const res={headersSent:false,status(n){this.code=n;return this;},type(){return this;},send(){this.headersSent=acknowledged=true;return this;}};
 await routes['/slack/job-files-events']({rawBody:Buffer.from(r.raw),headers:r.headers},res);
 assert.equal(res.code,200);assert.equal(calls.length,1);
 assert.equal(calls[0].url,'https://slack.com/api/entity.presentDetails');assert.equal(calls[0].auth,'Bearer xoxb-test');
 const {trigger_id,metadata}=calls[0].body;assert.equal(trigger_id,'test-trigger');
 const fp=metadata.entity_payload.attributes.full_size_preview;
 assert.equal(fp.is_supported,true);assert.equal(fp.mime_type,'application/vnd.slack-embed');
 assert.match(fp.preview_url,new RegExp(`^https://board\\.example/job-files/${FOLDER}\\?job=132198&exp=\\d{10}&sig=[a-f0-9]{40}$`));
 assert.ok(!calls.some(c=>c.url.includes('latenode')));
});
test('old test card finds its folder from the board',async()=>{
 const routes={},receiver={router:{get:(p,h)=>routes[p]=h,post:(p,h)=>routes[p]=h}};const calls=[];
 const store={find:n=>n==='132263'?{jobNumber:'132263',filesUrl:`https://drive.google.com/drive/folders/${FOLDER}?usp=sharing`}:null};
 registerJobFilesEvents(receiver,{secret,now,store,TPS_BOT_TOKEN:'x',TPS_INTERNAL_KEY:'k',fetch:async(url,init)=>{calls.push(JSON.parse(init.body));return{ok:true,json:async()=>({ok:true})};}});
 const p=event('tps-job-files-test-132263');p.event.entity_url='https://webhook.latenode.com/27333/prod/tps-job-files-preview';const r=request(p);
 await routes['/slack/job-files-events']({rawBody:Buffer.from(r.raw),headers:r.headers},{status(){return this;},type(){return this;},send(){this.headersSent=true;return this;}});
 assert.equal(calls[0].metadata.external_ref.id,'tps-job-files-test-132263');assert.match(calls[0].metadata.entity_payload.attributes.full_size_preview.preview_url,/job=132263/);
});
