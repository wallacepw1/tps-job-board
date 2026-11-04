const test=require('node:test'),assert=require('node:assert/strict');
const jf=require('../src/job-files');
const FOLDER='1Hk8dnTybkB0TIgEvJoqIBMLkKeYxeBul',o={TPS_INTERNAL_KEY:'k',GOOGLE_API_KEY:'g',PUBLIC_URL:'https://board.example'};
test('folder ids and refs',()=>{
 assert.equal(jf.folderIdFrom(`WORK ORDER/MEDIA\nhttps://drive.google.com/drive/folders/${FOLDER}?usp=drive_link`),FOLDER);
 assert.equal(jf.folderIdFrom('https://example.com'),null);
 assert.deepEqual(jf.parseRef(jf.refId('132198',FOLDER)),{jobNumber:'132198',folderId:FOLDER});
 assert.deepEqual(jf.parseRef('tps-job-files-test-132263'),{jobNumber:'132263',folderId:null});
 assert.equal(jf.parseRef('job-files:12:abc'),null);
});
test('gallery links are signed, tied to the folder and job, and expire',()=>{
 const now=1793719200000,u=new URL(jf.galleryUrl(FOLDER,'132198',o,now)),q=u.searchParams;
 assert.ok(jf.verify(FOLDER,'132198',q.get('exp'),q.get('sig'),o,now));
 assert.ok(!jf.verify(FOLDER,'132199',q.get('exp'),q.get('sig'),o,now),'other job');
 assert.ok(!jf.verify('1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA','132198',q.get('exp'),q.get('sig'),o,now),'other folder');
 assert.ok(!jf.verify(FOLDER,'132198',q.get('exp'),q.get('sig'),o,now+11*60000),'expired');
 assert.ok(!jf.verify(FOLDER,'132198',q.get('exp'),q.get('sig'),{TPS_INTERNAL_KEY:''},now),'no key');
});
test('card message carries the Work Object under metadata.entities',()=>{
 const m=jf.cardMessage('C1','132198',FOLDER),e=m.metadata.entities[0];
 assert.equal(e.entity_type,'slack#/entities/file');assert.equal(e.external_ref.id,`job-files:132198:${FOLDER}`);
 assert.equal(e.url,`https://drive.google.com/drive/folders/${FOLDER}`);
 assert.equal(e.entity_payload.attributes.full_size_preview.preview_url,undefined);assert.ok(m.text.includes('132198'));
});
test('gallery lists PDFs first, escapes names, and links each file to Drive',()=>{
 const html=jf.galleryHtml({jobNumber:'132198',folderId:FOLDER,query:'job=132198&exp=1&sig=a',files:[
  {id:'img1aaaaaaaaaa',name:'WhatsApp_132198_<x>.jpg',mimeType:'image/jpeg',createdTime:'2026-10-26'},
  {id:'pdf1aaaaaaaaaa',name:'261269-1.pdf',mimeType:'application/pdf',createdTime:'2026-10-27'},
  {id:'vid1aaaaaaaaaa',name:'clip.mp4',mimeType:'video/mp4',createdTime:'2026-10-25'}]});
 assert.ok(html.indexOf('261269-1.pdf')<html.indexOf('WhatsApp_132198'));
 assert.ok(html.includes('&lt;x&gt;')&&!html.includes('<x>'));
 assert.ok(html.includes('https://drive.google.com/file/d/vid1aaaaaaaaaa/view'));
 assert.ok(html.includes('1 PDF · 1 photo · 1 video'));
});
test('gallery route sends frame-ancestors for Slack and refuses unsigned links',async()=>{
 const routes={};jf.registerJobFilesGallery({router:{get:(p,h)=>routes[p]=h}},{...o,fetch:async()=>({ok:true,json:async()=>({files:[{id:'img1aaaaaaaaaa',name:'a.jpg',mimeType:'image/jpeg'}]})})});
 const mk=()=>({h:{},set(k,v){this.h[k]=v;return this;},status(n){this.code=n;return this;},type(){return this;},send(b){this.body=b;return this;},end(){return this;}});
 let res=mk();await routes['/job-files/:folder']({params:{folder:FOLDER},query:{job:'132198',exp:'9999999999',sig:'0'.repeat(40)}},res);
 assert.equal(res.code,403);assert.equal(res.h['Content-Security-Policy'],jf.FRAME_ANCESTORS);
 const q=new URL(jf.galleryUrl(FOLDER,'132198',o)).searchParams;res=mk();
 await routes['/job-files/:folder']({params:{folder:FOLDER},query:Object.fromEntries(q)},res);
 assert.equal(res.code,undefined);assert.ok(res.body.includes('a.jpg'));
});
test('photos and PDFs open inside the panel; videos still open in Drive',()=>{
 const html=jf.galleryHtml({jobNumber:'132198',folderId:FOLDER,query:'job=132198&exp=1&sig=a',files:[
  {id:'pdf1aaaaaaaaaa',name:'wo.pdf',mimeType:'application/pdf'},{id:'img1aaaaaaaaaa',name:'a.jpg',mimeType:'image/jpeg'},{id:'vid1aaaaaaaaaa',name:'v.mp4',mimeType:'video/mp4'}]});
 assert.ok(html.includes(`/job-files/${FOLDER}/view/pdf1aaaaaaaaaa?job=132198&amp;exp=1&amp;sig=a`));
 assert.ok(html.includes(`/job-files/${FOLDER}/view/img1aaaaaaaaaa?`));
 assert.ok(!html.includes('/view/vid1'));
 const pdf=jf.viewerHtml({jobNumber:'132198',folderId:FOLDER,query:'job=132198&exp=1&sig=a',file:{id:'pdf1aaaaaaaaaa',name:'wo.pdf',mimeType:'application/pdf'}});
 assert.ok(pdf.includes('pdf.min.js')&&pdf.includes(`/job-files/${FOLDER}/raw/pdf1aaaaaaaaaa?job=132198&exp=1&sig=a`));
 assert.ok(pdf.includes('Open in Drive'));
});
test('raw proxy streams a signed PDF from Drive with CORS for the null-origin embed',async()=>{
 const routes={},seen=[];
 const fetch=async(url)=>{seen.push(url);if(url.includes('alt=media'))return{ok:true,arrayBuffer:async()=>new TextEncoder().encode('%PDF-1.4').buffer};return{ok:true,json:async()=>({files:[{id:'pdf2aaaaaaaaaa',name:'wo.pdf',mimeType:'application/pdf',size:'8'}]})};};
 jf._listCache.clear();jf.registerJobFilesGallery({router:{get:(p,h)=>routes[p]=h}},{...o,fetch});
 const q=Object.fromEntries(new URL(jf.galleryUrl(FOLDER,'132198',o)).searchParams);
 const res={h:{},set(k,v){this.h[k]=v;return this;},status(n){this.code=n;return this;},send(b){this.body=b;this.headersSent=true;return this;},end(){this.headersSent=true;return this;}};
 await routes['/job-files/:folder/raw/:file']({params:{folder:FOLDER,file:'pdf2aaaaaaaaaa'},query:q},res);
 assert.equal(res.code,undefined);assert.equal(res.h['Access-Control-Allow-Origin'],'*');assert.equal(res.h['Content-Type'],'application/pdf');
 assert.ok(seen.some(u=>u.includes('/files/pdf2aaaaaaaaaa?alt=media')));
 const bad={...res,h:{},code:undefined,set:res.set,status:res.status,send:res.send,end:res.end};
 await routes['/job-files/:folder/raw/:file']({params:{folder:FOLDER,file:'other1aaaaaaaa'},query:q},bad);assert.equal(bad.code,404);
});
test('Files pop-up: photos as images, PDFs with a viewer link and first page, long-lived signed image links',()=>{
 const now=1793719200000,v=jf.filesModal({jobNumber:'132198',folderId:FOLDER,files:[
  {id:'img1aaaaaaaaaa',name:'a.jpg',mimeType:'image/jpeg'},{id:'pdf1aaaaaaaaaa',name:'wo.pdf',mimeType:'application/pdf'},{id:'vid1aaaaaaaaaa',name:'v.mp4',mimeType:'video/mp4'}]},o,now);
 assert.equal(v.type,'modal');assert.ok(v.blocks.length<=100);
 const imgs=v.blocks.filter(b=>b.type==='image');assert.equal(imgs.length,2);
 const u=new URL(imgs[1].image_url);assert.equal(u.pathname,`/job-files/${FOLDER}/thumb/img1aaaaaaaaaa`);
 assert.ok(Number(u.searchParams.get('exp'))-now/1000>6*24*3600);assert.ok(jf.verify(FOLDER,'132198',u.searchParams.get('exp'),u.searchParams.get('sig'),o,now));
 const pdfBtn=v.blocks.find(b=>b.accessory?.text?.text==='View PDF');assert.match(pdfBtn.accessory.url,/\/view\/pdf1aaaaaaaaaa\?/);
 assert.ok(v.blocks.some(b=>b.accessory?.text?.text==='Play'));
});
test('card carries the Work Object and a Files button that names the job and folder',()=>{
 const m=jf.cardMessage('C1','132198',FOLDER),b=m.blocks[1].elements[0];
 assert.equal(b.action_id,jf.FILES_ACTION);assert.deepEqual(jf.parseFilesValue(b.value),{jobNumber:'132198',folderId:FOLDER});
 assert.equal(jf.parseFilesValue('x:y'),null);
});
test('openFilesModal opens a loading view on the trigger, then fills it from Drive',async()=>{
 const calls=[];jf._listCache.clear();
 const fetch=async(url,init)=>{if(url.startsWith('https://slack.com/api/')){calls.push({m:url.split('/').pop(),b:JSON.parse(init.body)});return{ok:true,json:async()=>({ok:true,view:{id:'V1'}})};}return{ok:true,json:async()=>({files:[{id:'img1aaaaaaaaaa',name:'a.jpg',mimeType:'image/jpeg'}]})};};
 const r=await jf.openFilesModal({trigger_id:'T1',actions:[{action_id:jf.FILES_ACTION,value:`132198:${FOLDER}`}]},{...o,TPS_BOT_TOKEN:'x',fetch});
 assert.equal(r,'opened');assert.deepEqual(calls.map(c=>c.m),['views.open','views.update']);
 assert.equal(calls[0].b.trigger_id,'T1');assert.equal(calls[1].b.view_id,'V1');assert.ok(calls[1].b.view.blocks.some(b=>b.type==='image'));
});
test('gallery opens photos and videos in a full-screen swipe viewer',()=>{
 const html=jf.galleryHtml({jobNumber:'132275',folderId:FOLDER,query:'job=132275&exp=1&sig=a',files:[
  {id:'img1aaaaaaaaaa',name:'a.jpg',mimeType:'image/jpeg'},{id:'vid1aaaaaaaaaa',name:'b.mp4',mimeType:'video/mp4'},{id:'pdf1aaaaaaaaaa',name:'c.pdf',mimeType:'application/pdf'}]});
 assert.ok(html.includes('data-lb="photo" data-id="img1aaaaaaaaaa"'));
 assert.ok(html.includes('data-lb="video" data-id="vid1aaaaaaaaaa"'));
 assert.ok(!html.includes('data-lb="pdf"'),'PDFs keep the PDF viewer');
 assert.ok(html.includes('&amp;w=1600'),'full-size photo');
 assert.ok(html.includes('id="lb"')&&html.includes('/preview'));
});
test('Files pop-up has a View full screen link to the signed gallery',()=>{
 const v=jf.filesModal({jobNumber:'132275',folderId:FOLDER,files:[]},o);
 const b=v.blocks[0].accessory;assert.equal(b.text.text,'📷 View full screen');
 const q=new URL(b.url).searchParams;assert.ok(jf.verify(FOLDER,'132275',q.get('exp'),q.get('sig'),o,Date.now()+23*3600e3),'valid for a day');
});
