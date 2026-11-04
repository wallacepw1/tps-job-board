'use strict';
// Job files side panel (Slack Work Objects). A TPS Bot message carries a Work Object for a job's Drive folder.
// Clicking it sends entity_details_requested; we answer straight from here (no Latenode run) with an embed:
// a small gallery page listing the folder, served by this app and shown by Slack inside the side panel.
// Drive is read with a Google API key; the job folders are shared "anyone with the link can view".
const {createHmac,timingSafeEqual}=require('node:crypto');

const ENTITY_TYPE='slack#/entities/file';
const REF_TYPE='tps_job_files';
const TTL_SEC=10*60;
const FRAME_ANCESTORS="frame-ancestors https://*.slack.com https://*.slack-gov.com https://*.slack-mcps.com";

const env=(o,k)=>o[k]??process.env[k];
const baseUrl=o=>String(env(o,'PUBLIC_URL')||'https://tps-job-board.onrender.com').replace(/\/+$/,'');
const signingKey=o=>env(o,'JOB_FILES_SECRET')||env(o,'TPS_INTERNAL_KEY')||'';

function folderIdFrom(url){return String(url||'').match(/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([\w-]{10,})/)?.[1]||null;}
function folderUrl(id){return`https://drive.google.com/drive/folders/${id}`;}
const validFolder=id=>/^[\w-]{10,100}$/.test(id||'');
const validJob=n=>/^\d{5,7}$/.test(n||'');

// external_ref.id = "job-files:<invoice>:<folderId>". The first test card (Nov 3) used "tps-job-files-test-<invoice>".
function refId(jobNumber,folderId){return`job-files:${jobNumber}:${folderId}`;}
function parseRef(id){
 const s=String(id||'');
 let m=s.match(/^job-files:(\d{5,7}):([\w-]{10,100})$/);if(m)return{jobNumber:m[1],folderId:m[2]};
 m=s.match(/^tps-job-files-(?:test-)?(\d{5,7})$/);if(m)return{jobNumber:m[1],folderId:null};
 return null;
}

function sign(folderId,jobNumber,exp,o={}){return createHmac('sha256',signingKey(o)).update(`job-files|${folderId}|${jobNumber}|${exp}`).digest('hex').slice(0,40);}
function verify(folderId,jobNumber,exp,sig,o={},now=Date.now()){
 if(!signingKey(o)||!validFolder(folderId)||!validJob(jobNumber)||!/^\d{10}$/.test(String(exp))||!/^[a-f0-9]{40}$/.test(sig||''))return false;
 if(Number(exp)<now/1000)return false;
 return timingSafeEqual(Buffer.from(sig),Buffer.from(sign(folderId,jobNumber,exp,o)));
}
function signedQuery(folderId,jobNumber,o={},now=Date.now(),ttl=TTL_SEC){
 const exp=Math.floor(now/1000)+ttl;
 return`job=${jobNumber}&exp=${exp}&sig=${sign(folderId,jobNumber,exp,o)}`;
}
function galleryUrl(folderId,jobNumber,o={},now=Date.now(),ttl=TTL_SEC){
 return`${baseUrl(o)}/job-files/${folderId}?${signedQuery(folderId,jobNumber,o,now,ttl)}`;
}

// The Work Object as posted on a message (no preview_url there; Slack asks for it on click).
function entity(jobNumber,folderId,previewUrl){
 const preview={is_supported:true,mime_type:'application/vnd.slack-embed'};
 if(previewUrl)preview.preview_url=previewUrl;
 return{url:folderUrl(folderId),external_ref:{id:refId(jobNumber,folderId),type:REF_TYPE},entity_type:ENTITY_TYPE,
  entity_payload:{attributes:{title:{text:`Job files · ${jobNumber}`},product_name:'TPS Job Files',full_size_preview:preview},fields:{}}};
}
const FILES_ACTION='tps_job_files_open';
function filesButton(jobNumber,folderId){return{type:'button',action_id:FILES_ACTION,text:{type:'plain_text',text:'Files'},value:`${jobNumber}:${folderId}`};}
function cardMessage(channel,jobNumber,folderId){
 const text=`📁 Job files · ${jobNumber}: work order, photos and videos in Drive.`;
 return{channel,text,unfurl_links:false,unfurl_media:false,
  blocks:[{type:'section',text:{type:'mrkdwn',text}},{type:'actions',elements:[filesButton(jobNumber,folderId)]}],
  metadata:{entities:[entity(jobNumber,folderId)]}};
}
function parseFilesValue(v){const m=String(v||'').match(/^(\d{5,7}):([\w-]{10,100})$/);return m?{jobNumber:m[1],folderId:m[2]}:null;}

// The Files pop-up (works on phones, where the side panel embed does not). Slack fetches every image itself,
// so image links are signed for longer than the panel's 10 minutes.
const MODAL_IMG_TTL=7*24*3600,MODAL_LINK_TTL=24*3600,MODAL_MAX=40;
const plain=t=>({type:'plain_text',text:String(t).slice(0,150),emoji:true});
function loadingModal(jobNumber){return{type:'modal',callback_id:'tps_job_files',title:plain(`Job ${jobNumber} files`),close:plain('Close'),blocks:[{type:'section',text:{type:'mrkdwn',text:':hourglass_flowing_sand: Loading the job folder…'}}]};}
function filesModal({jobNumber,folderId,files},o={},now=Date.now()){
 const order={pdf:0,photo:1,video:2,file:3,folder:4};
 const sorted=[...files].sort((a,b)=>order[kindOf(a)]-order[kindOf(b)]||String(a.createdTime).localeCompare(String(b.createdTime)));
 const img=signedQuery(folderId,jobNumber,o,now,MODAL_IMG_TTL),link=signedQuery(folderId,jobNumber,o,now,MODAL_LINK_TTL),base=baseUrl(o);
 const thumb=(f,w)=>`${base}/job-files/${folderId}/thumb/${encodeURIComponent(f.id)}?${img}&w=${w}`;
 const viewer=f=>`${base}/job-files/${folderId}/view/${encodeURIComponent(f.id)}?${link}`;
 const counts=sorted.reduce((c,f)=>(c[kindOf(f)]=(c[kindOf(f)]||0)+1,c),{});
 const label=(n,w)=>n?`${n} ${w}${n===1?'':'s'}`:'';
 const summary=[label(counts.pdf,'PDF'),label(counts.photo,'photo'),label(counts.video,'video')].filter(Boolean).join(' · ')||'No files yet';
 const blocks=[{type:'section',text:{type:'mrkdwn',text:`*Job ${jobNumber}* · ${summary}`},accessory:{type:'button',action_id:'tps_job_files_drive',text:plain('Open in Drive'),url:folderUrl(folderId)}}];
 for(const f of sorted.slice(0,MODAL_MAX)){
  const k=kindOf(f);
  if(k==='photo')blocks.push({type:'image',image_url:thumb(f,1000),alt_text:f.name.slice(0,200),title:plain(f.name)});
  else if(k==='pdf'){blocks.push({type:'divider'},{type:'section',text:{type:'mrkdwn',text:`:page_facing_up: *${f.name.replace(/[*_~`<>&]/g,'')}*`},accessory:{type:'button',action_id:`tps_job_files_pdf_${f.id}`.slice(0,255),text:plain('View PDF'),url:viewer(f)}},{type:'image',image_url:thumb(f,1000),alt_text:`First page of ${f.name}`.slice(0,200)});}
  else blocks.push({type:'section',text:{type:'mrkdwn',text:`${k==='video'?':movie_camera:':':paperclip:'} ${f.name.replace(/[*_~`<>&]/g,'')}`},accessory:{type:'button',action_id:`tps_job_files_open_${f.id}`.slice(0,255),text:plain(k==='video'?'Play':'Open'),url:viewLink(f)}});
 }
 if(sorted.length>MODAL_MAX)blocks.push({type:'context',elements:[{type:'mrkdwn',text:`Showing ${MODAL_MAX} of ${sorted.length}. Open in Drive for the rest.`}]});
 if(!sorted.length)blocks.push({type:'section',text:{type:'mrkdwn',text:'Nothing in this job folder yet.'}});
 return{type:'modal',callback_id:'tps_job_files',title:plain(`Job ${jobNumber} files`),close:plain('Close'),blocks:blocks.slice(0,100)};
}
// A Files button click from a TPS Bot message. Opens right away (the trigger lasts 3 seconds), then fills in.
async function openFilesModal(payload,o={}){
 const ref=parseFilesValue(payload?.actions?.[0]?.value);if(!ref)return'bad value';
 const token=env(o,'TPS_BOT_TOKEN');if(!token)return'TPS_BOT_TOKEN is not set';
 const fetcher=o.fetch||global.fetch;
 const opened=await slackApi('views.open',{trigger_id:payload.trigger_id,view:loadingModal(ref.jobNumber)},token,fetcher);
 let view;
 try{view=filesModal({...ref,files:await listFolder(ref.folderId,o)},o);}
 catch(e){view={...loadingModal(ref.jobNumber),blocks:[{type:'section',text:{type:'mrkdwn',text:`Couldn't read the Drive folder right now. <${folderUrl(ref.folderId)}|Open it in Drive>`}}]};}
 await slackApi('views.update',{view_id:opened.view.id,view},token,fetcher);
 return'opened';
}

async function slackApi(method,body,token,fetcher){
 const r=await fetcher(`https://slack.com/api/${method}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json; charset=utf-8'},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
 const j=await r.json().catch(()=>({ok:false,error:`http_${r.status}`}));
 if(!j.ok)throw Object.assign(Error(`${method}: ${j.error}`),{data:j});
 if(j.warning||j.response_metadata?.warnings)console.warn(`${method} warning`,j.warning||'',JSON.stringify(j.response_metadata?.warnings||[]));
 return j;
}

// ---- Drive ----
const listCache=new Map(); // folderId -> {at, files}
async function listFolder(folderId,o={}){
 const hit=listCache.get(folderId);if(hit&&Date.now()-hit.at<60000)return hit.files;
 const key=env(o,'GOOGLE_API_KEY');if(!key)throw Error('GOOGLE_API_KEY is not set');
 const q=encodeURIComponent(`'${folderId}' in parents and trashed = false`);
 const fields=encodeURIComponent('nextPageToken,files(id,name,mimeType,size,createdTime,thumbnailLink,webViewLink)');
 const files=[];let page='';
 for(let i=0;i<5;i++){
  const r=await(o.fetch||global.fetch)(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=200&orderBy=createdTime&supportsAllDrives=true&includeItemsFromAllDrives=true&key=${encodeURIComponent(key)}${page?`&pageToken=${encodeURIComponent(page)}`:''}`,{signal:AbortSignal.timeout(8000)});
  if(!r.ok)throw Error(`Drive list ${r.status}`);
  const j=await r.json();files.push(...(j.files||[]));page=j.nextPageToken;if(!page)break;
 }
 if(listCache.size>300)listCache.clear();
 listCache.set(folderId,{at:Date.now(),files});
 return files;
}

const CSS=`:root{--bg:#fff;--fg:#1d1c1d;--muted:#616061;--line:#e8e8e8;--tile:#f6f6f6;--accent:#1264a3}
@media (prefers-color-scheme:dark){:root{--bg:#1a1d21;--fg:#d1d2d3;--muted:#9a9b9e;--line:#35373b;--tile:#222529;--accent:#1d9bd1}}
*{box-sizing:border-box}body{margin:0;padding:12px;background:var(--bg);color:var(--fg);font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
header{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:10px}h1{font-size:16px;margin:0}
.muted{color:var(--muted);font-size:13px}a{color:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px}
.tile{display:block;text-decoration:none;color:inherit;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--tile)}
.pic{position:relative;aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;overflow:hidden}
.pic img{width:100%;height:100%;object-fit:cover}.pdf .pic img{object-fit:contain;background:#fff}
.badge{position:absolute;left:6px;bottom:6px;background:rgba(0,0,0,.65);color:#fff;font-size:11px;padding:2px 6px;border-radius:4px}
.name{padding:6px 8px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.empty{padding:24px 0;color:var(--muted)}
`;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function kindOf(f){const m=f.mimeType||'';return m.startsWith('image/')?'photo':m.startsWith('video/')?'video':m==='application/pdf'?'pdf':m==='application/vnd.google-apps.folder'?'folder':'file';}
const viewLink=f=>f.webViewLink||(kindOf(f)==='folder'?folderUrl(f.id):`https://drive.google.com/file/d/${f.id}/view`);

function galleryHtml({jobNumber,folderId,files,query}){
 const order={pdf:0,photo:1,video:2,file:3,folder:4};
 const sorted=[...files].sort((a,b)=>order[kindOf(a)]-order[kindOf(b)]||String(a.createdTime).localeCompare(String(b.createdTime)));
 const counts=sorted.reduce((c,f)=>(c[kindOf(f)]=(c[kindOf(f)]||0)+1,c),{});
 const label=(n,w)=>n?`${n} ${w}${n===1?'':'s'}`:'';
 const summary=[label(counts.pdf,'PDF'),label(counts.photo,'photo'),label(counts.video,'video'),label((counts.file||0)+(counts.folder||0),'other file')].filter(Boolean).join(' · ')||'No files yet';
 const thumb=f=>`/job-files/${folderId}/thumb/${encodeURIComponent(f.id)}?${query}`;
 const tile=f=>{const k=kindOf(f),badge={video:'▶ Video',pdf:'PDF',file:'File',folder:'Folder'}[k]||'';
  const img=(f.thumbnailLink||k==='photo'||k==='video'||k==='pdf')?`<img loading="lazy" src="${esc(thumb(f))}" alt="" onerror="this.remove()">`:'';
  const inPanel=k==='photo'||k==='pdf';
  const href=inPanel?`/job-files/${folderId}/view/${encodeURIComponent(f.id)}?${query}`:viewLink(f);
  return`<a class="tile ${k}" href="${esc(href)}"${inPanel?'':' target="_blank" rel="noopener"'}><div class="pic">${img}${badge?`<span class="badge">${badge}</span>`:''}</div><div class="name">${esc(f.name)}</div></a>`;};
 return`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Job files ${esc(jobNumber)}</title>
<style>${CSS}
</style></head><body>
<header><div><h1>Job ${esc(jobNumber)}</h1><div class="muted">${esc(summary)}</div></div><a href="${esc(folderUrl(folderId))}" target="_blank" rel="noopener">Open in Drive</a></header>
${sorted.length?`<div class="grid">${sorted.map(tile).join('')}</div>`:'<div class="empty">Nothing in this job folder yet.</div>'}
</body></html>`;
}

const PDFJS='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174';
const MAX_RAW=40*1024*1024;
// One photo or PDF, shown inside the side panel. PDFs are drawn page by page with PDF.js (no browser plugin is
// available inside Slack's sandboxed frame), from this app's /raw proxy of the Drive file.
function viewerHtml({jobNumber,folderId,file,query}){
 const back=`/job-files/${folderId}?${query}`,raw=`/job-files/${folderId}/raw/${encodeURIComponent(file.id)}?${query}`,k=kindOf(file);
 const body=k==='pdf'
  ?`<div id="pages" class="muted">Loading PDF…</div>
<script src="${PDFJS}/pdf.min.js"></script>
<script>
(async()=>{const box=document.getElementById('pages');try{
 pdfjsLib.GlobalWorkerOptions.workerSrc='${PDFJS}/pdf.worker.min.js';
 const pdf=await pdfjsLib.getDocument({url:${JSON.stringify(raw)}}).promise;box.textContent='';box.className='';
 const width=Math.min(document.body.clientWidth-24,1400);
 for(let n=1;n<=pdf.numPages;n++){const page=await pdf.getPage(n),v=page.getViewport({scale:1}),scale=width/v.width*(window.devicePixelRatio||1),vp=page.getViewport({scale});
  const c=document.createElement('canvas');c.width=vp.width;c.height=vp.height;c.style.width=width+'px';box.appendChild(c);await page.render({canvasContext:c.getContext('2d'),viewport:vp}).promise;}
}catch(e){box.textContent="Couldn't show this PDF here. Use Open in Drive.";}})();
</script>`
  :`<img class="full" src="${esc(raw)}" alt="${esc(file.name)}">`;
 return`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(file.name)}</title>
<style>${CSS}
nav{display:flex;justify-content:space-between;gap:8px;margin-bottom:10px;font-size:13px}.fname{font-weight:600;margin-bottom:8px;word-break:break-all}
img.full{max-width:100%;height:auto;border-radius:6px}canvas{display:block;margin:0 auto 10px;background:#fff;box-shadow:0 0 0 1px var(--line);max-width:100%}
</style></head><body>
<nav><a href="${esc(back)}">← Job ${esc(jobNumber)} files</a><a href="${esc(viewLink(file))}" target="_blank" rel="noopener">Open in Drive</a></nav>
<div class="fname">${esc(file.name)}</div>
${body}
</body></html>`;
}

function errorHtml(msg){return`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:14px -apple-system,sans-serif;padding:16px">${esc(msg)}</body>`;}

// ---- HTTP routes ----
function registerJobFilesGallery(receiver,o={}){
 const frame=res=>res.set('Content-Security-Policy',FRAME_ANCESTORS).set('Cache-Control','private, max-age=60');
 receiver.router.get('/job-files/health',(_q,res)=>res.json({ready:!!env(o,'GOOGLE_API_KEY')&&!!signingKey(o),bot:!!env(o,'TPS_BOT_TOKEN'),events:!!env(o,'TPS_CALL_ROUTE_SIGNING_SECRET')}));
 receiver.router.get('/job-files/:folder',async(req,res)=>{
  frame(res);
  const {folder}=req.params,{job,exp,sig}=req.query;
  if(!verify(folder,job,exp,sig,o))return res.status(403).type('html').send(errorHtml('This link has expired. Close the panel and click the job files card again.'));
  try{const files=await listFolder(folder,o);res.type('html').send(galleryHtml({jobNumber:job,folderId:folder,files,query:new URLSearchParams({job,exp,sig}).toString()}));}
  catch(e){console.error('job files list failed',folder,e.message);res.status(502).type('html').send(errorHtml(`Couldn't read the Drive folder right now. Open it in Drive instead: ${folderUrl(folder)}`));}
 });
 const fileOf=async(req,res)=>{
  const {folder,file}=req.params,{job,exp,sig}=req.query;
  if(!verify(folder,job,exp,sig,o)||!/^[\w-]{10,100}$/.test(file)){res.status(403).end();return null;}
  const f=(await listFolder(folder,o)).find(x=>x.id===file);if(!f){res.status(404).end();return null;}
  return{f,folder,job,query:new URLSearchParams({job,exp,sig}).toString()};
 };
 receiver.router.get('/job-files/:folder/view/:file',async(req,res)=>{
  frame(res);
  try{const x=await fileOf(req,res);if(!x)return;
   if(!['photo','pdf'].includes(kindOf(x.f)))return res.redirect(viewLink(x.f));
   res.type('html').send(viewerHtml({jobNumber:x.job,folderId:x.folder,file:x.f,query:x.query}));
  }catch{if(!res.headersSent)res.status(502).type('html').send(errorHtml("Couldn't read the Drive folder right now."));}
 });
 // The file itself, for the viewer. The embed runs with a null origin, so this answers any origin;
 // the signed, 10-minute link and the folder check are what protect it.
 receiver.router.get('/job-files/:folder/raw/:file',async(req,res)=>{
  res.set('Access-Control-Allow-Origin','*');
  try{const x=await fileOf(req,res);if(!x)return;
   if(!['photo','pdf'].includes(kindOf(x.f))||Number(x.f.size||0)>MAX_RAW)return res.status(415).end();
   const r=await(o.fetch||global.fetch)(`https://www.googleapis.com/drive/v3/files/${x.f.id}?alt=media&supportsAllDrives=true&key=${encodeURIComponent(env(o,'GOOGLE_API_KEY'))}`,{signal:AbortSignal.timeout(30000)});
   if(!r.ok)return res.status(502).end();
   res.set('Content-Type',x.f.mimeType).set('Cache-Control','private, max-age=600');
   res.send(Buffer.from(await r.arrayBuffer()));
  }catch{if(!res.headersSent)res.status(502).end();}
 });
 receiver.router.get('/job-files/:folder/thumb/:file',async(req,res)=>{
  const {folder,file}=req.params,{job,exp,sig}=req.query;
  if(!verify(folder,job,exp,sig,o)||!/^[\w-]{10,100}$/.test(file))return res.status(403).end();
  try{
   const f=(await listFolder(folder,o)).find(x=>x.id===file);if(!f)return res.status(404).end();
   const fetcher=o.fetch||global.fetch,size=Math.min(1600,Math.max(200,Number(req.query.w)||600));
   const urls=[f.thumbnailLink&&f.thumbnailLink.replace(/=s\d+$/,`=s${size}`),`https://drive.google.com/thumbnail?id=${file}&sz=w${size}`].filter(Boolean);
   for(const u of urls){
    const r=await fetcher(u,{redirect:'follow',signal:AbortSignal.timeout(8000)}).catch(()=>null);
    const type=r?.headers?.get?.('content-type')||'';
    if(r?.ok&&type.startsWith('image/')){res.set('Content-Type',type).set('Cache-Control','private, max-age=600');return res.send(Buffer.from(await r.arrayBuffer()));}
   }
   res.status(404).end();
  }catch{res.status(502).end();}
 });
}

// Answer a click on a job files card with the embed. Returns a short reason for the logs.
async function presentJobFiles(event,{store,...o}={}){
 const ref=parseRef(event?.external_ref?.id);
 if(!ref)return'not a job files card';
 const token=env(o,'TPS_BOT_TOKEN');if(!token)return'TPS_BOT_TOKEN is not set';
 const fetcher=o.fetch||global.fetch;
 let folderId=ref.folderId;
 if(!folderId)folderId=folderIdFrom(store?.find?.(ref.jobNumber)?.filesUrl)||folderIdFrom(event.entity_url);
 if(!folderId){
  await slackApi('entity.presentDetails',{trigger_id:event.trigger_id,error:{status:'not_found',custom_message:`No Drive folder found for job ${ref.jobNumber}.`}},token,fetcher).catch(()=>{});
  return'no folder';
 }
 const meta=entity(ref.jobNumber,folderId,galleryUrl(folderId,ref.jobNumber,o));
 meta.external_ref.id=event.external_ref.id; // answer for the card that was clicked
 await slackApi('entity.presentDetails',{trigger_id:event.trigger_id,metadata:meta},token,fetcher);
 return'presented';
}

async function postJobFilesCard({channel,jobNumber,filesUrl},o={}){
 const folderId=folderIdFrom(filesUrl);if(!folderId)throw Error(`job ${jobNumber} has no Drive folder link`);
 const token=env(o,'TPS_BOT_TOKEN');if(!token)throw Error('TPS_BOT_TOKEN is not set on Render');
 return slackApi('chat.postMessage',cardMessage(channel,jobNumber,folderId),token,o.fetch||global.fetch);
}

module.exports={FILES_ACTION,filesButton,parseFilesValue,filesModal,openFilesModal,signedQuery,viewerHtml,folderIdFrom,refId,parseRef,sign,verify,galleryUrl,entity,cardMessage,listFolder,galleryHtml,registerJobFilesGallery,presentJobFiles,postJobFilesCard,FRAME_ANCESTORS,_listCache:listCache};
