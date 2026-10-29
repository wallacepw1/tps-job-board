'use strict';
const {messageText}=require('./parse');
const INCOMING='C0C19TG3KJ6';
async function copyHelperContribution(m,d,ref,a){
 const identity=a.hash(JSON.stringify([ref.sourceChannel,ref.sourceTs,ref.revision,d.channel,d.ts]));
 const marker='tps_helper_copy:'+identity;
 const text='Helper contribution from <@'+(m.user||ref.helper)+'>:\n'+messageText(m);
 const parts=text.match(/[\s\S]{1,2800}/g)||['Helper photo'];
 const photoLinks=(m.files||[]).map(f=>'<https://tpsplumbing.slack.com/archives/'+INCOMING+'/p'+d.ts.replace('.','')+'|Photo '+f.id+' in Incoming>').join('\n');
 const rows=await a.pages('conversations.replies',{channel:d.channel,ts:d.ts},'messages');
 for(let i=0;i<parts.length;i++){
  const tag=marker+':'+i;const value=parts[i]+(i===parts.length-1&&d.channel!==INCOMING&&photoLinks?'\n'+photoLinks:'');
  const existing=rows.find(x=>(x.blocks||[]).some(b=>b.block_id===tag));
  if(existing){if(existing.text!==value)return{verified:false};continue;}
  if(a.verifyOnly)return{verified:false};
  const blocks=[{type:'section',block_id:tag,text:{type:'mrkdwn',text:parts[i]}}];
  if(i===parts.length-1&&d.channel!==INCOMING&&photoLinks)blocks.push({type:'section',text:{type:'mrkdwn',text:photoLinks.slice(0,2900)}});
  await a.api('chat.postMessage',{channel:d.channel,thread_ts:d.ts,text:value,blocks,unfurl_links:false});
  const confirmed=await a.pages('conversations.replies',{channel:d.channel,ts:d.ts},'messages');
  if(!confirmed.some(x=>x.text===value&&(x.blocks||[]).some(b=>b.block_id===tag)))throw Error('Copied helper text was not visible in destination.');
 }
 if(d.channel!==INCOMING)return{verified:true};
 for(const original of m.files||[]){
  const key='TPS_HELPER_FILE_'+a.hash(JSON.stringify([original.id,d.channel,d.ts]));
  let receipt=await a.get(key);
  if(receipt?.fileId&&receipt.complete){
   const check=await a.api('files.info',{file:receipt.fileId});
   const shares=Object.values(check.file?.shares?.public||{}).concat(Object.values(check.file?.shares?.private||{})).flat();
   const sameChannel=Object.keys(check.file?.shares?.public||{}).concat(Object.keys(check.file?.shares?.private||{})).includes(d.channel);
   if(sameChannel&&shares.some(s=>s.thread_ts===d.ts))continue;
   return{verified:false};
  }
  if(a.verifyOnly)return{verified:false};
  if(receipt?.uploadStarted&&!receipt.uploaded)throw Error('A previous photo upload is uncertain. Preserve the source and verify it manually.');
  if(!receipt){
   const info=await a.api('files.info',{file:original.id});
   if(!info.file||info.file.is_tombstoned)throw Error('Original helper file is unavailable.');
   const bytes=await a.files.read(info.file);
   const reserve=await a.api('files.getUploadURLExternal',{filename:info.file.name||original.id,length:bytes.length});
   const u=new URL(reserve.upload_url);
   if(u.protocol!=='https:'||u.hostname!=='files.slack.com'||!reserve.file_id)throw Error('Unexpected Slack upload destination.');
   receipt={fileId:reserve.file_id,uploadUrl:u.href,name:info.file.name||original.id,uploadStarted:true};await a.set(key,receipt);
   const upload=await a.fetch(u.href,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:bytes,signal:AbortSignal.timeout(30000)});
   if(!upload.ok)throw Error('Helper photo upload failed.');
   receipt.uploaded=true;await a.set(key,receipt);
  }
  if(!receipt.uploaded)throw Error('Photo bytes are not verified uploaded.');
  await a.api('files.completeUploadExternal',{files:[{id:receipt.fileId,title:receipt.name}],channel_id:d.channel,thread_ts:d.ts,initial_comment:'Helper photo '+original.id+' from <@'+(m.user||ref.helper)+'>'});
  let shared=false;
  for(let attempt=0;attempt<5&&!shared;attempt++){
   const info=await a.api('files.info',{file:receipt.fileId});
   const share=[...(info.file?.shares?.public?.[d.channel]||[]),...(info.file?.shares?.private?.[d.channel]||[])];
   shared=share.some(s=>s.thread_ts===d.ts);
   if(!shared&&attempt<4)await new Promise(r=>setTimeout(r,1500));
  }
  if(!shared)throw Error('Uploaded helper photo is not yet shared in Incoming.');
  receipt.complete=true;delete receipt.uploadUrl;await a.set(key,receipt);
 }
 return{verified:true};
}
module.exports={copyHelperContribution};