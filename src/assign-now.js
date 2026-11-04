'use strict';
const {createHash}=require('node:crypto');
const {validateAssignment,ADMINS}=require('./assignment-policy');
const {handleAssignment,fingerprint}=require('./assignment-worker');
const FUTURE='C0C2XB4VD1N';
const phaseIdFor=id=>'now_'+createHash('sha256').update(id).digest('hex');
async function clearParent(r,ctx){const state=await ctx.state.get(r.recordId)||{};if(state.pendingAssignNow===r.requestId&&!state.activeRequest){delete state.pendingAssignNow;await ctx.state.set(r.recordId,state);}}
async function assignWithNow(r,ctx,options,run=handleAssignment){
 if(r?.operation!=='assign'||!ctx.authenticated||!ctx.serialized||ctx.actor!==r.actor||!/^[a-zA-Z0-9_-]{16,100}$/.test(r.requestId||'')||!/^Rec[A-Z0-9]+$/i.test(r.recordId||''))return run(r,ctx);
 const old=await ctx.requests.get(r.requestId);
 if(old&&old.fingerprint!==fingerprint(r))return run(r,ctx);
 if(old&&['done','refused'].includes(old.status)){const result=await run(r,ctx);if(['done','refused'].includes(result.status))await clearParent(r,ctx);return result;}
 const state=await ctx.state.get(r.recordId)||{};
 if(state.activeRequest&&state.activeRequest!==r.requestId&&!String(state.activeRequest).startsWith('now_'))return run(r,ctx);
 const c=await ctx.loadCall(r);c.helper=state.helper?.user||null;
 if(c.source?.channel!==FUTURE||c.stage!=='unassigned'||c.lead){try{const result=await run(r,ctx);if(['done','refused'].includes(result.status))await clearParent(r,ctx);return result;}catch{return{status:'uncertain',requestId:r.requestId,error:'The current assignment still needs verification. Use Check and resume.'};}}
 const validation=validateAssignment(r,{...c,appointmentDate:c.today});
 if(!validation.ok)return{status:'refused',requestId:r.requestId,error:validation.error};
 if(c.helper)return{status:'refused',requestId:r.requestId,error:'Resolve the existing helper before assigning this Future call.'};
 const phaseId=phaseIdFor(r.requestId);
 if(state.pendingAssignNow&&state.pendingAssignNow!==r.requestId)return{status:'refused',requestId:r.requestId,error:'An earlier assignment still needs verification. Use Check and resume.'};
 if(state.activeRequest&&![r.requestId,phaseId].includes(state.activeRequest))return{status:'refused',requestId:r.requestId,error:'Another call action is still being verified.'};
 const key='TPS_ASSIGN_NOW_'+r.requestId;
 let phase=await options.store.getGlobalVariable(key);if(typeof phase==='string')phase=JSON.parse(phase);
 if(!phase){
  const parts={};for(const p of new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ctx.now?ctx.now():Date.now())))parts[p.type]=p.value;
  phase={fingerprint:fingerprint(r),request:{...r,requestId:phaseId,parentAssignmentRequestId:r.requestId,operation:'reschedule',target:null,schedule:{date:parts.year+'-'+parts.month+'-'+parts.day,time:parts.hour+':'+parts.minute}}};
  await options.store.setGlobalVariable(key,JSON.stringify(phase));
 }
 if(phase.fingerprint!==fingerprint(r))return{status:'refused',requestId:r.requestId,error:'This schedule receipt belongs to another assignment.'};
 const save=async result=>{const value={...result,requestId:r.requestId,request:structuredClone(r),fingerprint:fingerprint(r),updatedAt:ctx.now?ctx.now():Date.now(),phase:'schedule_now'};await ctx.requests.set(r.requestId,value);return value;};
 await save({status:'working'});
 state.pendingAssignNow=r.requestId;await ctx.state.set(r.recordId,state);
 let scheduled;try{scheduled=await run(phase.request,ctx);}catch{return save({status:'uncertain',error:'The move to today is not yet verified. Check the Job Board before retrying.'});}
 if(scheduled.status!=='done'){const result=await save({status:scheduled.status==='refused'?'refused':'uncertain',error:scheduled.error||'The move to today is not yet verified. The plumber was not assigned. Check the Job Board before retrying.'});if(result.status==='refused')await clearParent(r,ctx);return result;}
 let result;try{result=await run(r,ctx);}catch{return save({status:'uncertain',error:'The schedule is saved, but assignment is not yet verified. Use Check and resume.'});}if(['done','refused'].includes(result.status))await clearParent(r,ctx);return result;
}
async function pendingAssignment(r,store){
 const no=error=>({status:'refused',error});
 if(!ADMINS.includes(r.actor)||!/^Rec[A-Z0-9]+$/i.test(r.recordId||''))return no('Invalid recovery request.');
 const read=async k=>{const v=await store.getGlobalVariable(k);return typeof v==='string'?JSON.parse(v):v;};
 const state=await read('TPS_ASSIGN_STATE_'+r.recordId)||{},id=state.pendingAssignNow||state.activeRequest;
 if(!id)return{status:'done',pendingRequest:null};
 let saved=await read('TPS_ASSIGN_REQUEST_'+id);
 if(saved?.request?.parentAssignmentRequestId)saved=await read('TPS_ASSIGN_REQUEST_'+saved.request.parentAssignmentRequestId);
 if(!saved?.request||saved.request.actor!==r.actor||saved.request.recordId!==r.recordId)return no('A pending action belongs to another admin. Ask that admin to verify it.');
 const original=saved.request;
 if(state.pendingAssignNow||id.startsWith('now_')){
  const phase=await read('TPS_ASSIGN_NOW_'+original.requestId);
  if(original.operation!=='assign'||saved.fingerprint!==fingerprint(original)||phase?.fingerprint!==saved.fingerprint||phase.request?.parentAssignmentRequestId!==original.requestId||phase.request?.requestId!==phaseIdFor(original.requestId)||phase.request?.actor!==r.actor||phase.request?.recordId!==r.recordId||phase.request?.incomingTs!==original.incomingTs)return no('The original assignment could not be verified. Nothing was resumed.');
 }
 return{status:'done',pendingRequest:original};
}
module.exports={assignWithNow,pendingAssignment};
