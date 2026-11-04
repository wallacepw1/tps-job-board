const test=require('node:test'),assert=require('node:assert/strict');
const jf=require('../src/job-files');
const folder='folder_123456789',video={id:'video_123456789',name:'Walkthrough.mp4',mimeType:'video/mp4'};
const data={jobNumber:'132275',folderId:folder,files:[video],query:'job=132275&video=1'};
test('test gallery video opens local player while live gallery keeps Drive link',()=>{
 assert.match(jf.galleryHtml(data),/href="\/job-files\/folder_123456789\/view\/video_123456789/);
 assert.match(jf.galleryHtml({...data,query:'job=132275'}),/href="https:\/\/drive.google.com\/file\/d\/video_123456789\/view/);
});
test('video viewer embeds Drive preview without downloading video through Render',()=>{
 const html=jf.viewerHtml({...data,file:video});
 assert.match(html,/<iframe[^>]+src="https:\/\/drive.google.com\/file\/d\/video_123456789\/preview"/);
 assert.match(html,/allowfullscreen/);assert.doesNotMatch(html,/<video[^>]+src="\/job-files/);
});
test('special work object reference enables the test gallery only',async()=>{
 assert.deepEqual(jf.parseRef('job-files-video-test:132275:'+folder),{jobNumber:'132275',folderId:folder,inlineVideo:true});
 let metadata;await jf.presentJobFiles({trigger_id:'test',external_ref:{id:'job-files-video-test:132275:'+folder}},{TPS_BOT_TOKEN:'fake',TPS_INTERNAL_KEY:'fake',fetch:async(url,init)=>{metadata=JSON.parse(init.body).metadata;return{json:async()=>({ok:true})}}});
 assert.match(metadata.entity_payload.attributes.full_size_preview.preview_url,/video=1/);
});

