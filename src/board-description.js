'use strict';
const d=require('./desc-modal');
const {ADMINS}=require('./assignment-policy');
const COMPLETED='C0C2YDBHFFY';
function registerDescriptionHandlers(app,{store},o={}){
 app.action(/^write_description_/,async({ack,body,action,client})=>{
  await ack();
  const job=store.find(action.value),admin=ADMINS.includes(body.user.id);
  const opened=await client.views[body.view?.type==='modal'?'push':'open']({trigger_id:body.trigger_id,view:d.resultView(action.value,'Loading the description and job files…')});
  const options={...o,modalToken:o.modalToken||process.env.SLACK_BOT_TOKEN,openedView:opened.view};
  try{
   if(!admin||job?.workflowStage!=='done'||job.workflowChannel!==COMPLETED)throw Error('This call is no longer in Completed, or this control is unavailable to you. Refresh the board.');
   const message=await d.readSource({c:COMPLETED,ts:job.workflowTs,j:job.jobNumber},options);
   await d.openDescModal({...body,channel:{id:COMPLETED},container:{channel_id:COMPLETED,message_ts:job.workflowTs},message},options);
  }catch(e){await client.views.update({view_id:opened.view.id,view:d.resultView(action.value,e.message)});}
 });
 app.view(d.CALLBACK,async({ack,body})=>{
  const error=d.submissionError(body);
  if(error){await ack({response_action:'errors',errors:{notes_input_block:error}});return;}
  await ack({response_action:'update',view:d.resultView('', 'Submitting the description… Please do not submit again.')});
  await d.finishSubmission(body,{...o,modalToken:o.modalToken||process.env.SLACK_BOT_TOKEN});
 });
 app.action(/^tps_desc_/,async({ack})=>ack());
}
module.exports={registerDescriptionHandlers};
