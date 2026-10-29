'use strict';
const {TECHS}=require('./assignment-policy');
const {revision}=require('./assignment-helper');
// Only archived helper messages are eligible. Files remain in Slack and Incoming.
async function cleanupHelperThread(h,snapshot,c,a){
 if(!TECHS.some(t=>t.channel===h.channel)||!c?.recordId||!h.requestId||!Array.isArray(snapshot))throw Error('Invalid helper cleanup identity.');
 const archived=new Set(snapshot);
 async function checked(){
  const rows=await a.readThread(h),parent=rows.find(m=>m.ts===h.ts);
  if(!parent||parent.user!=='U0C52NTH4LW'||!(parent.blocks||[]).some(b=>b.block_id==='tps_helper:'+c.recordId+':'+h.requestId))throw Error('Helper card identity could not be verified.');
  const children=rows.filter(m=>m.ts!==h.ts);
  if(children.some(m=>!archived.has(a.digest(revision(m)))))throw Error('A helper contribution changed. Archive again before cleanup.');
  return children;
 }
 for(let pass=0;pass<=snapshot.length;pass++){
  const children=await checked();
  if(!children.length){
   if(a.beforeParentDelete)await a.beforeParentDelete();
   if((await checked()).length)throw Error('A helper reply arrived before card removal. Archive again.');
   await a.deleteMessage(h.channel,h.ts,true);return;
  }
  await a.deleteMessage(h.channel,children[0].ts,false);
 }
 throw Error('Helper cleanup did not converge. Retain the card for verification.');
}
module.exports={cleanupHelperThread};
