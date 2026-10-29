const test=require('node:test'),assert=require('node:assert/strict');
const {slackTransport}=require('../src/assignment-transport');
test('Slack read and upload-reservation methods use GET query parameters with bounded requests',async()=>{
 const seen=[];const api=slackTransport('test-token',async(url,opts)=>{seen.push({url,opts});return{ok:true,json:async()=>({ok:true})}});
 for(const method of ['conversations.replies','conversations.history','files.info','files.getUploadURLExternal'])await api(method,{channel:'CTEST',limit:200});
 for(const r of seen){assert.equal(r.opts.method,'GET');assert.equal(new URL(r.url).searchParams.get('channel'),'CTEST');assert.ok(r.opts.signal);assert.equal(r.opts.body,undefined);}
});
test('Slack writes retain JSON bodies and missing tokens fail before network access',async()=>{
 let seen;const api=slackTransport('test-token',async(url,opts)=>{seen=opts;return{ok:true,json:async()=>({ok:true})}});
 await api('chat.postMessage',{text:'Test'});assert.equal(seen.method,'POST');assert.equal(JSON.parse(seen.body).text,'Test');
 await assert.rejects(()=>slackTransport('',()=>{throw Error('Network must not run')})('auth.test',{}),/connection unavailable/);
});
