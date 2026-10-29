'use strict';
const INCOMING='C0C19TG3KJ6';
const url=(channel,ts)=>'https://tpsplumbing.slack.com/archives/'+channel+'/p'+ts.replace('.','');
function revision(m){return JSON.stringify([m.ts,m.user||'',m.text||'',m.blocks||[],(m.files||[]).map(f=>f.id).sort()],(key,value)=>key==='block_id'?undefined:value);}
function helperBlocks(c,h){return[
 {type:'section',block_id:'tps_helper:'+c.recordId+':'+h.requestId,text:{type:'mrkdwn',text:'*Helper — call '+c.jobNumber+'*\nHelper: <@'+h.user+'> · Lead: <@'+c.lead+'>\n'+(c.address||'')+'\nThis is the same call and invoice. Post photos and comments in this thread.'}},
 {type:'actions',elements:[...(h.ts?[{type:'button',action_id:'tps_helper_notes',text:{type:'plain_text',text:'Add photos/notes'},url:url(h.channel,h.ts)+'?thread_ts='+h.ts+'&cid='+h.channel}]:[]),{type:'button',action_id:'tps_helper_done',text:{type:'plain_text',text:'Helper work finished'},value:JSON.stringify({recordId:c.recordId,incomingTs:c.incomingTs})},{type:'button',action_id:'tps_helper_lead',text:{type:'plain_text',text:'Open lead call'},url:url(c.source.channel,c.source.ts)},{type:'button',action_id:'tps_helper_incoming',text:{type:'plain_text',text:'Incoming history'},url:url(INCOMING,c.incomingTs)}]}
];}
function createHelperService(a){
 const rev=m=>a.digest?a.digest(revision(m)):revision(m);
 const key=h=>'tps_helper_archive_'+h.channel+'_'+h.ts.replace('.','');
 async function copy(c,h,m,onlyIncoming=false){
  if(!m?.ts||m.ts===h.ts)return;
  const record=await a.get(key(h))||{receipts:[]};
  const version=rev(m);
  const destinations=[{channel:INCOMING,ts:c.incomingTs},...(!onlyIncoming&&c.source?[c.source]:[])];
  for(const d of destinations){
   const id=JSON.stringify([version,d.channel,d.ts]);
   if(record.receipts.includes(id))continue;
   const result=await a.copy(m,d,{sourceChannel:h.channel,sourceTs:m.ts,revision:version,helper:h.user,recordId:c.recordId});
   if(!result?.verified)throw Error('A helper contribution is not verified in its destination.');
   record.receipts.push(id);await a.set(key(h),record);
  }
 }
 async function archive(c,h){
  try{
   const prior=await a.get(key(h));
   if(prior?.verified&&prior.parentDeletePending){
    try{if((await a.readThread(h)).length===0)return{verified:true};}
    catch(e){if(e.slackError==='thread_not_found')return{verified:true};throw e;}
   }
   let previous;
   for(let pass=0;pass<3;pass++){
    const replies=await a.readThread(h);
    for(const m of replies)await copy(c,h,m);
    const snapshot=replies.slice(1).map(rev);
    if(previous&&JSON.stringify(previous)===JSON.stringify(snapshot)){
     if(!await a.verifyCopies(c,h))throw Error('Could not verify copied helper records.');
     const record=await a.get(key(h))||{receipts:[]};record.snapshot=snapshot;record.verified=true;await a.set(key(h),record);
     return{verified:true};
    }
    previous=snapshot;
   }
   return{verified:false,error:'Helper replies are still arriving. Wait a moment, then retry.'};
  }catch(e){return{verified:false,error:'Helper records could not all be verified. Source messages were retained.',detail:e.slackError||e.message||'Unknown archive error'};}
 }
 return{
  async ensure(c,h){const existing=await a.findCard(c,h);const card=existing||await a.postCard(c,h,helperBlocks(c,h));await a.updateCard({...h,...card},helperBlocks(c,{...h,...card}));return card;},
  archive,
  async retire(c,h){
   const record=await a.get(key(h));
   if(!record?.verified)throw Error('Helper history is not verified.');
   let rows;
   try{rows=await a.readThread(h);}catch(e){if(!record.parentDeletePending||e.slackError!=='thread_not_found')throw e;rows=[];}
   if(record.parentDeletePending&&rows.length===0){record.retired=true;await a.set(key(h),record);return;}
   const current=rows.slice(1).map(rev);
   if(current.some(v=>!record.snapshot.includes(v)))throw Error('A new helper contribution arrived. Archive again before removing the card.');
   // Keep the thread mapping after retirement so delayed Slack events can still be archived.
   await a.deleteCard(h,record.snapshot,c,async()=>{record.parentDeletePending=true;await a.set(key(h),record);});record.retired=true;await a.set(key(h),record);
  },
  async updateLead(c,h,lead){const fresh=await a.currentLeadSource(c,lead);await a.updateCard(h,helperBlocks({...c,lead,source:fresh},h));},
  async reconcile(c,h,message){await copy(c,h,message,true);}
 };
}
module.exports={createHelperService,helperBlocks,revision};
