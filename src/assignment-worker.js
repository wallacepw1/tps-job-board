'use strict';
const {validateAssignment}=require('./assignment-policy');
const fingerprint=r=>JSON.stringify([r.actor,r.operation,r.recordId,r.incomingTs,r.expectedLead,r.expectedHelper,r.target]);
async function handleAssignment(r,ctx){
 const refused=error=>({requestId:r?.requestId,status:'refused',error});
 if(!ctx.authenticated||!ctx.serialized||ctx.actor!==r?.actor)return refused('The assignment request was not verified.');
 if(!/^[a-zA-Z0-9_-]{16,100}$/.test(r.requestId||'')||!/^Rec[A-Z0-9]+$/i.test(r.recordId||''))return refused('Invalid request identity.');
 const fp=fingerprint(r),old=await ctx.requests.get(r.requestId);
 if(old&&old.fingerprint!==fp)return refused('This request ID belongs to a different action.');
 if(old&&['done','refused'].includes(old.status))return old;
 const state=await ctx.state.get(r.recordId)||{};
 if(state.activeRequest&&state.activeRequest!==r.requestId)return refused('Another action is still being verified for this call. Refresh shortly.');
 const now=()=>ctx.now?ctx.now():Date.now();
 const save=async result=>{const value={...result,request:structuredClone(r),requestId:r.requestId,fingerprint:fp,updatedAt:now()};await ctx.requests.set(r.requestId,value);return value;};
 const release=async()=>{delete state.activeRequest;delete state.effect;delete state.dispatchStarted;delete state.helperRetiredRequest;await ctx.state.set(r.recordId,state);};
 let c;
 try{c=await ctx.loadCall(r);c.helper=state.helper?.user||null;}catch{return refused('The current call could not be read. Nothing was changed.');}
 if(state.effect?.requestId===r.requestId){
  try{await ctx.audit(r,c,state);const result=state.effect.result;await release();return save(result);}catch{return save({status:'uncertain',error:'The action succeeded but its history confirmation is still pending.'});}
 }
 // A dispatch may have succeeded before its response was lost. Never repeat it blindly.
 if(old&&['working','uncertain'].includes(old.status)){
  if(['assign','reassign','lead_complete'].includes(r.operation)&&state.dispatchStarted===r.requestId){
   let verified=false;try{verified=await ctx.verifyDispatch(r,c,state);}catch{}
   if(!verified)return save({...old,status:'uncertain',error:'The previous dispatch needs verification before it can be repeated.'});
   if(state.helper&&r.operation==='reassign')await ctx.helper.updateLead(c,{...state.helper},r.target);
   if(state.helper&&r.operation==='lead_complete'){await ctx.helper.retire(c,state.helper);state.helper=null;}
   state.effect={requestId:r.requestId,result:{status:'done',lead:r.operation==='lead_complete'?c.lead:r.target,helper:state.helper?.user||null}};await ctx.state.set(r.recordId,state);await ctx.audit(r,c,state);const result=state.effect.result;await release();return save(result);
  }
  // Helper adapters resume by stored card/source IDs and verified archive receipts.
 }
 const ownPendingHelper=r.operation==='helper_add'&&old&&state.helper?.requestId===r.requestId;
 const ownRetirement=state.helperRetiredRequest===r.requestId&&r.operation==='lead_complete'&&old;
 const validation=validateAssignment(r,ownPendingHelper||ownRetirement?{...c,helper:r.expectedHelper}:c);
 if(!validation.ok)return refused(validation.error);
 state.activeRequest=r.requestId;await ctx.state.set(r.recordId,state);
 await save({status:'working',startedAt:old?.startedAt||now()});
 try{
  if(r.operation==='helper_add'){
   state.helper=state.helper||{user:r.target,requestId:r.requestId};
   await ctx.state.set(r.recordId,state);
   const card=await ctx.helper.ensure(c,state.helper);
   state.helper={...state.helper,...card,closing:false};await ctx.state.set(r.recordId,state);
  }else if(['helper_remove','helper_done','lead_complete'].includes(r.operation)&&state.helper){
   state.helper.closing=true;await ctx.state.set(r.recordId,state);
   const copied=await ctx.helper.archive(c,state.helper);
   if(!copied?.verified){state.helper.closing=false;await release();return save({status:'failed',error:copied?.error||'Helper records are not yet verified. Nothing was deleted.'});}
   await ctx.helper.retire(c,state.helper);state.helper=null;
   if(r.operation==='lead_complete')state.helperRetiredRequest=r.requestId;
   await ctx.state.set(r.recordId,state);
  }
  if(['assign','reassign','lead_complete'].includes(r.operation)){
   state.dispatchStarted=r.requestId;await ctx.state.set(r.recordId,state);
   let dispatchError;
   try{await ctx.dispatch(r,c,state);}catch(e){dispatchError=e;}
   let verified=false;try{verified=await ctx.verifyDispatch(r,c,state);}catch{}
   if(!verified)return save({status:'uncertain',error:'The call change is not yet verified. Do not repeat it; refresh shortly.'});
   if(r.operation==='reassign'&&state.helper)await ctx.helper.updateLead(c,state.helper,r.target);
   if(r.operation==='lead_complete'&&state.helper){await ctx.helper.retire(c,state.helper);state.helper=null;}
  }
  state.effect={requestId:r.requestId,result:{status:'done',lead:r.operation==='assign'||r.operation==='reassign'?r.target:c.lead,helper:state.helper?.user||null}};await ctx.state.set(r.recordId,state);
  await ctx.audit(r,c,state);
  await release();return save({status:'done',lead:r.operation==='assign'||r.operation==='reassign'?r.target:c.lead,helper:state.helper?.user||null});
 }catch(e){
  // Keep the lock and receipts when a side effect could have occurred.
  return save({status:'uncertain',error:'This action needs verification before retrying. Its records were retained.'});
 }
}
module.exports={handleAssignment,fingerprint};
