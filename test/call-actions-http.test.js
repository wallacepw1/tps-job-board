const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),{createHmac}=require('node:crypto');
const {ExpressReceiver}=require('@slack/bolt');
const {registerCallActionsProxy}=require('../src/call-actions-proxy');
test('actual Bolt ExpressReceiver preserves signed raw bytes on the TPS Bot bridge',async()=>{
 const receiver=new ExpressReceiver({signingSecret:'board-fixture-secret'}),secret='route-fixture-secret';let forwarded;let signal;
 const received=new Promise(r=>signal=r);
 registerCallActionsProxy(receiver,{secret,key:'fixture-internal-key',fetch:async(url,opts)=>{forwarded=JSON.parse(opts.body);signal();return{status:200,text:async()=>''}}});
 const server=http.createServer(receiver.app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const raw=new URLSearchParams({payload:JSON.stringify({type:'block_actions',user:{id:'U0876C3TEGL'},actions:[{action_id:'reassign_open'}]})}).toString();
  const ts=String(Math.floor(Date.now()/1000)),signature='v0='+createHmac('sha256',secret).update('v0:'+ts+':'+raw).digest('hex');
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/slack/call-actions',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','x-slack-request-timestamp':ts,'x-slack-signature':signature},body:raw,signal:AbortSignal.timeout(3000)});
  assert.equal(response.status,200);await Promise.race([received,new Promise((_,rej)=>setTimeout(()=>rej(Error('No verified relay')),1000))]);
  const wrapper=JSON.parse(forwarded.payload);assert.equal(wrapper.key,'fixture-internal-key');assert.equal(wrapper.tps_assignment_verified.user.id,'U0876C3TEGL');
 }finally{await new Promise(r=>server.close(r));}
});
