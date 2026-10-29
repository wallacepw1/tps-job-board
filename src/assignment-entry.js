'use strict';
const {timingSafeEqual}=require('node:crypto');
const {createRuntime}=require('./assignment-runtime');
const {handleAssignment,fingerprint}=require('./assignment-worker');
const {assignmentModal,decodeDraft}=require('./assignment');
const {ADMINS,TECHS}=require('./assignment-policy');
const {idsOf,callFeedback}=require('./assignment-route');
function validKey(a,b){return typeof a==='string'&&typeof b==='string'&&a.length>0&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
const messageView=text=>({type:'modal',title:{type:'plain_text',text:'Assignment'},close:{type:'plain_text',text:'Close'},blocks:[{type:'section',text:{type:'mrkdwn',text:String(text).slice(0,2900)}}]});
async function handleEnvelope(e,options){
 if(!validKey(e?.key,options.key))return{status:'refused',error:'Unverified action source.'};
 if(!options.serialized)return{status:'refused',error:'Assignment processing has not been enabled in Sequential mode.'};
 if(e.mode==='status'){
  const r=e.request||{};if(!/^[a-zA-Z0-9_-]{16,100}$/.test(r.requestId||''))return{status:'refused',error:'Invalid request identity.'};
  const value=await options.store.getGlobalVariable('TPS_ASSIGN_REQUEST_'+r.requestId);const saved=typeof value==='string'?JSON.parse(value):value;
  if(!saved)return{status:'queued'};
  if(saved.fingerprint!==fingerprint(r))return{status:'refused',error:'This result belongs to another request.'};
  const {fingerprint:privateFingerprint,request:privateRequest,...result}=saved;return result;
 }
 if(e.mode==='pending'){
  const r=e.request||{};
  if(!ADMINS.includes(r.actor)||!/^Rec[A-Z0-9]+$/i.test(r.recordId||''))return{status:'refused',error:'Invalid recovery request.'};
  const read=async k=>{const v=await options.store.getGlobalVariable(k);return typeof v==='string'?JSON.parse(v):v;};
  const state=await read('TPS_ASSIGN_STATE_'+r.recordId);
  if(!state?.activeRequest)return{status:'done',pendingRequest:null};
  const saved=await read('TPS_ASSIGN_REQUEST_'+state.activeRequest);
  if(!saved?.request||saved.request.actor!==r.actor||saved.request.recordId!==r.recordId)return{status:'refused',error:'A pending action belongs to another admin. Ask that admin to verify it.'};
  return{status:'done',pendingRequest:saved.request};
 }
 if(options.enabled!==true)return{status:'refused',error:'Assignment processing is not enabled yet.'};
 if(e.mode==='helper_event'){
  const ctx=createRuntime({...options,actor:e.event?.user||''});
  return ctx.reconcileEvent(e.event||{});
 }
 const actor=e.event?.user?.id||e.request?.actor;
 const ctx=createRuntime({...options,actor});
 let request=e.request;
 let shell=e.shellViewId;
 try{
  if(e.mode==='open'){
   if(!ADMINS.includes(actor))throw Error('Assignment tools are limited to TPS admins.');
   const c=await ctx.loadCall({recordId:e.recordId,incomingTs:e.incomingTs});
   const state=await ctx.state.get(c.recordId)||{};
   if(!['plumber','unassigned'].includes(c.stage))throw Error('This call has left the assignment stage. Use its return-visit tools if it needs another visit.');
   const action=e.event?.actions?.[0]?.action_id;
   const operation=action==='assign_call'?'assign':action==='reassign_open'?'reassign':state.helper?'helper_remove':'helper_add';
   const job={jobNumber:c.jobNumber,recordId:c.recordId,threadTs:c.incomingTs,status:c.lead?'assigned':'new',techId:c.lead,tech:TECHS.find(t=>t.id===c.lead)?.name,helperId:state.helper?.user||null,location:c.address,assignedMessageUrl:c.source?'https://tpsplumbing.slack.com/archives/'+c.source.channel+'/p'+c.source.ts.replace('.',''):null};
   const view=assignmentModal(job,operation,actor,options.key);
   const result=await options.slack('views.update',{view_id:shell,view});if(!result.ok)throw Error('The assignment form could not be displayed.');
   return{status:'done',formOpened:true};
  }
  if(e.mode==='modal_submit'){
   request=decodeDraft(e.event.view.private_metadata,options.key,actor);
   if(request.operation!=='helper_remove')request.target=e.event.view.state.values.assignment_target?.target?.selected_option?.value;
  }else if(e.mode==='event_submit'){
   const p=e.event;const ids=idsOf(p);const c=await ctx.loadCall(ids);const state=await ctx.state.get(c.recordId)||{};
   const action=p.actions?.[0]?.action_id;
   const channel=p.channel?.id||p.container?.channel_id,ts=p.container?.message_ts||p.message?.ts;
   let operation,target;
   if(action==='tps_helper_done'){
    if(!state.helper||state.helper.channel!==channel||state.helper.ts!==ts)throw Error('This helper card is no longer current.');
    operation='helper_done';target=null;
   }else{
    if(c.source?.channel!==channel||c.source?.ts!==ts)throw Error('This call card is no longer current.');
    operation=action==='complete_call'?'lead_complete':action.startsWith('reassign_to_')?'reassign':action.startsWith('assign_')?'assign':null;
    target=operation==='lead_complete'?null:TECHS.find(t=>action.endsWith('_'+t.name.toLowerCase()))?.id;
   }
   request={requestId:e.requestId,actor,operation,recordId:c.recordId,incomingTs:c.incomingTs,expectedLead:c.lead,expectedHelper:state.helper?.user||null,target};
  }
  if(!request)throw Error('Invalid assignment request.');
  const result=await handleAssignment(request,ctx);
  if(e.event?.view?.id)shell=e.event.view.id;
  if(shell)await options.slack('views.update',{view_id:shell,view:messageView(result.status==='done'?'✅ Saved. The call history has been updated.':result.error||'⏳ Still queued. Refresh the Job Board shortly.')});
  if(result.status!=='done'){
   let feedback=e.event;
   if(request?.recordId){let saved=await options.store.getGlobalVariable('TPS_ASSIGN_FEEDBACK_'+request.recordId);try{saved=typeof saved==='string'?JSON.parse(saved):saved;}catch{saved=null;}if(saved)feedback={channel:{id:saved.channel},container:{message_ts:saved.ts},message:saved.message};}
   if(feedback)await callFeedback(feedback,options,'⚠️ '+(result.error||'The action is not yet verified.')+' Check this call in the Job Board before retrying.').catch(()=>{});
  }
  const {fingerprint:privateFingerprint,request:privateRequest,...out}=result;return out;
 }catch(err){
  if(shell)await options.slack('views.update',{view_id:shell,view:messageView(err.message)}).catch(()=>{});
  else if(e.mode==='event_submit'&&ADMINS.includes(actor))await callFeedback(e.event,options,'⚠️ '+err.message+' Check the Job Board before retrying.').catch(()=>{});
  return{status:'refused',error:err.message};
 }
}
module.exports={handleEnvelope,messageView,validKey};
