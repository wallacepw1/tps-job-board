const test=require('node:test'),assert=require('node:assert/strict');
const jf=require('../src/job-files');
const file={id:'video_file_12345',name:'Walkthrough.mp4',mimeType:'video/mp4'};
const data={jobNumber:'132275',folderId:'folder_123456789',files:[file]};
const options={TPS_INTERNAL_KEY:'test-key',inlineVideo:true};
test('test viewer embeds Drive video with thumbnail and fallback link',()=>{
 const view=jf.filesModal(data,options);const video=view.blocks.find(b=>b.type==='video');
 assert.ok(video);assert.equal(video.video_url,'https://drive.google.com/file/d/video_file_12345/preview');
 assert.match(video.thumbnail_url,/\/thumb\/video_file_12345\?/);
 assert.ok(view.blocks.some(b=>b.accessory?.text?.text==='Play'));
});
test('live viewer retains existing Play links without opting in',()=>{
 assert.ok(!jf.filesModal(data,{TPS_INTERNAL_KEY:'test-key'}).blocks.some(b=>b.type==='video'));
});
test('a rejected video block falls back to a usable file popup',async()=>{
 jf._listCache.clear();let updates=0;const views=[];
 const fetch=async(url,init)=>{
  if(url.includes('googleapis'))return{ok:true,json:async()=>({files:[file]})};
  const body=JSON.parse(init.body);
  if(url.endsWith('views.open'))return{json:async()=>({ok:true,view:{id:'V1'}})};
  views.push(body.view);updates++;return{json:async()=>updates===1?({ok:false,error:'invalid_blocks'}):({ok:true})};
 };
 await jf.openFilesModal({trigger_id:'test',actions:[{value:'132275:folder_123456789'}]},{...options,TPS_BOT_TOKEN:'fake',GOOGLE_API_KEY:'fake',fetch});
 assert.equal(updates,2);assert.ok(views[0].blocks.some(b=>b.type==='video'));
 assert.ok(!views[1].blocks.some(b=>b.type==='video'));assert.match(JSON.stringify(views[1]),/Play links/);
});
test('inline-video test action cannot run outside testing',async()=>{
 const {createHmac}=require('node:crypto'),{registerCallActionsProxy}=require('../src/call-actions-proxy');
 const routes={},secret='test-secret';let calls=0;
 registerCallActionsProxy({router:{get(){},post:(path,fn)=>routes[path]=fn}},{secret,key:'test',fetch:async()=>{calls++;throw Error('Unexpected call')}});
 const payload={type:'block_actions',channel:{id:'C0C19TG3KJ6'},trigger_id:'test',actions:[{action_id:jf.FILES_VIDEO_TEST_ACTION,value:'132275:folder_123456789'}]};
 const raw=new URLSearchParams({payload:JSON.stringify(payload)}).toString(),ts=String(Math.floor(Date.now()/1000));
 await routes['/slack/call-actions']({rawBody:Buffer.from(raw),headers:{'x-slack-request-timestamp':ts,'x-slack-signature':'v0='+createHmac('sha256',secret).update('v0:'+ts+':'+raw).digest('hex')}},{status(){return this},send(){this.headersSent=true}});
 assert.equal(calls,0);
});

