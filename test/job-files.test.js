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
