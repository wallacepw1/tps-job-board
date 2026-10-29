'use strict';
const {createHmac,timingSafeEqual,randomUUID}=require('node:crypto');
const {ADMINS,TECHS}=require('./assignment-policy');
const LABELS={assign:'Assign',reassign:'Reassign',helper_add:'Assign helper',helper_remove:'Remove helper'};
function assignmentActions(job,actor){
 if(!ADMINS.includes(actor)||!job.recordId||!job.threadTs||job.status==='done'||job.canceled||job.billingStage)return[];
 const ops=job.techId&&job.assignedMessageUrl?['reassign',job.helperId?'helper_remove':'helper_add']:!job.techId?['assign']:[];
 return ops.map(operation=>({type:'button',action_id:'assignment_open',text:{type:'plain_text',text:LABELS[operation]},value:JSON.stringify({jobNumber:job.jobNumber,operation})}));
}
function encodeDraft(draft,key,now=Date.now()){
 if(!key)throw Error('The form signing key is unavailable.');
 const body=Buffer.from(JSON.stringify({...draft,expires:now+15*60e3})).toString('base64url');
 return body+'.'+createHmac('sha256',key).update(body).digest('hex');
}
function decodeDraft(value,key,actor,now=Date.now()){
 if(!key||typeof value!=='string')throw Error('This form could not be verified.');
 const parts=value.split('.');if(parts.length!==2||!/^[a-f0-9]{64}$/.test(parts[1]))throw Error('Invalid form.');
 const signature=createHmac('sha256',key).update(parts[0]).digest();
 if(!timingSafeEqual(signature,Buffer.from(parts[1],'hex')))throw Error('This form was changed.');
 const draft=JSON.parse(Buffer.from(parts[0],'base64url').toString());
 if(draft.actor!==actor||!ADMINS.includes(actor)||!Number.isFinite(draft.expires)||draft.expires<now)throw Error('This form expired or belongs to another user. Reopen the call.');
 return draft;
}
function assignmentModal(job,operation,actor,key,now=Date.now()){
 if(!assignmentActions(job,actor).some(a=>JSON.parse(a.value).operation===operation))throw Error('This assignment action is not available. Refresh the board.');
 const draft={requestId:randomUUID(),actor,operation,jobNumber:job.jobNumber,recordId:job.recordId,incomingTs:job.threadTs,expectedLead:job.techId||null,expectedHelper:job.helperId||null,target:null};
 const options=TECHS.filter(t=>t.id!==job.techId&&t.id!==job.helperId).map(t=>({text:{type:'plain_text',text:t.name},value:t.id}));
 return{type:'modal',callback_id:'job_assignment',private_metadata:encodeDraft(draft,key,now),
 title:{type:'plain_text',text:LABELS[operation]},submit:{type:'plain_text',text:operation==='assign'?'Confirm assignment':'Confirm'},close:{type:'plain_text',text:'Cancel'},
 blocks:[{type:'section',text:{type:'mrkdwn',text:['*'+job.jobNumber+'*',job.location||'',job.issue||'',job.tech?'Lead: '+job.tech:'No lead assigned.',operation==='helper_add'?'The lead remains responsible. This is the same call and invoice.':'The existing call history and appointment are retained.'].filter(Boolean).join('\n').slice(0,2900)}},
 ...(operation==='helper_remove'?[{type:'section',text:{type:'mrkdwn',text:'Remove the helper after their photos and comments are safely recorded.'}}]:[{type:'input',block_id:'assignment_target',label:{type:'plain_text',text:operation==='helper_add'?'Helper':'Plumber'},element:{type:'static_select',action_id:'target',options,placeholder:{type:'plain_text',text:'Choose a plumber'}}}])]};
}
function assignmentResumeModal(request,actor,key,now=Date.now()){
 if(!ADMINS.includes(actor)||request.actor!==actor)throw Error('This pending action belongs to another admin.');
 return{type:'modal',callback_id:'job_assignment',private_metadata:encodeDraft({...request,resume:true},key,now),title:{type:'plain_text',text:'Pending assignment'},submit:{type:'plain_text',text:'Check and resume'},close:{type:'plain_text',text:'Cancel'},blocks:[{type:'section',text:{type:'mrkdwn',text:'An earlier '+(LABELS[request.operation]||'call action')+' still needs verification. Check its existing result and resume only unfinished steps. The original request and plumber selection will be retained.'}}]};
}
async function submitAssignment(request,{fetch:fetcher=global.fetch,endpoint=process.env.TPS_CALL_ACTIONS_URL,key=process.env.TPS_INTERNAL_KEY,mode='submit'}={}){
 if(!key||!endpoint)throw Error('Assignment tools are not connected yet. Nothing was changed.');
 const u=new URL(endpoint);if(u.protocol!=='https:'||u.hostname!=='webhook.latenode.com'||u.username||u.password)throw Error('Assignment endpoint is invalid.');
 const res=await fetcher(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,mode,request}),signal:AbortSignal.timeout(15000)});
 if(!res.ok)throw Error('The assignment queue did not respond. Refresh before trying again.');
 const body=await res.json();if(!['queued','working','done','refused','failed','uncertain'].includes(body.status))throw Error('The assignment result could not be verified. Refresh before trying again.');
 return body;
}
function registerAssignmentHandlers(app,{store,refresh,publishHome,messageModal,submit=submitAssignment,signingKey=()=>process.env.SLACK_SIGNING_SECRET}){
 app.action('assignment_open',async({ack,body,action,client})=>{
  await ack();let view;
  try{if(!ADMINS.includes(body.user.id))throw Error('Assignment tools are limited to TPS admins.');const choice=JSON.parse(action.value);const job=store.find(choice.jobNumber);if(!job)throw Error('This call is no longer on the board. Refresh first.');view=assignmentModal(job,choice.operation,body.user.id,signingKey());}
  catch(e){view=messageModal('Assignment',e.message);}
  const opened=body.view?.type==='modal'?await client.views.push({trigger_id:body.trigger_id,view}):await client.views.open({trigger_id:body.trigger_id,view});
  if(view.callback_id==='job_assignment'&&opened.view?.id){
   try{const original=decodeDraft(view.private_metadata,signingKey(),body.user.id);const result=await submit({actor:body.user.id,recordId:original.recordId},{mode:'pending'});
    if(result.status==='refused')await client.views.update({view_id:opened.view.id,view:messageModal('Assignment',result.error)});
    else if(result.pendingRequest)await client.views.update({view_id:opened.view.id,view:assignmentResumeModal(result.pendingRequest,body.user.id,signingKey())});
   }catch{await client.views.update({view_id:opened.view.id,view:messageModal('Assignment','The queue could not be checked. Refresh and reopen before assigning.')}).catch(()=>{});}
  }
 });
 app.view('job_assignment',async({ack,body,view,client})=>{
  let request;
  try{request=decodeDraft(view.private_metadata,signingKey(),body.user.id);if(!request.resume&&request.operation!=='helper_remove'){request.target=view.state.values.assignment_target?.target?.selected_option?.value;if(!TECHS.some(t=>t.id===request.target))throw Error('Choose a current TPS plumber.');}}
  catch(e){await ack({response_action:'update',view:messageModal('Assignment',e.message)});return;}
  await ack({response_action:'update',view:messageModal('Assignment','⏳ Assignment queued. You may close this window; the call history will record the result.')});
  let result;
  try{
   result=await submit(request);
   for(let i=0;i<6&&['queued','working'].includes(result.status);i++){await new Promise(r=>setTimeout(r,4000));result=await submit(request,{mode:'status'});}
  }catch{result={status:'uncertain',error:'The queue response was interrupted. Refresh before trying again; do not repeat the action.'};}
  const text=result.status==='done'?'✅ Saved. The call history and Job Board reflect the assignment.':result.error||'⏳ Still queued. Refresh the Job Board shortly; do not repeat the action.';
  await client.views.update({view_id:body.view.id,view:messageModal('Assignment',text)}).catch(()=>{});
  if(result.status==='done'){await refresh();await publishHome(client,body.user.id).catch(()=>{});}
 });
}
module.exports={assignmentActions,assignmentModal,assignmentResumeModal,encodeDraft,decodeDraft,submitAssignment,registerAssignmentHandlers};
