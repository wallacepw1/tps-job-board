'use strict';
const {timingSafeEqual,createHash}=require('node:crypto');
const {ADMINS,TECHS}=require('./assignment-policy');
function equal(a,b){return typeof a==='string'&&typeof b==='string'&&a.length>0&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
async function unwrapAssignment(p,store,now=Date.now()){
 if(!p?.tps_assignment_dispatch&&!p?.tps_assignment_verified)return{payload:p,approved:false,worker:false};
 if(!equal(p.key,await store.getGlobalVariable('TPS_INTERNAL_KEY')))throw Error('Unverified call-action bridge.');
 if(p.tps_assignment_verified){if(!p.tps_assignment_verified.type)throw Error('Invalid verified Slack payload.');return{payload:p.tps_assignment_verified,approved:true,worker:false};}
 const id=p.tps_assignment_dispatch;if(!/^[a-zA-Z0-9_-]{16,100}$/.test(id))throw Error('Invalid dispatch reference.');
 const k='TPS_ASSIGN_DISPATCH_'+id;const value=await store.getGlobalVariable(k);const cap=typeof value==='string'?JSON.parse(value):value;
 if(!cap||cap.used||cap.expires<now||!cap.payload)throw Error('Dispatch already used or expired.');
 cap.used=true;await store.setGlobalVariable(k,JSON.stringify(cap));
 return{payload:cap.payload,approved:true,worker:true};
}
function idsOf(p){const body=JSON.stringify(p.message?.blocks||[]);let meta;try{meta=JSON.parse(p.actions?.[0]?.value||'{}');}catch{}
 return{recordId:body.match(/\btpsref:(Rec[A-Z0-9]+):/i)?.[1]||body.match(/\bRec[A-Z0-9]+\b/i)?.[0]||meta?.recordId,incomingTs:body.match(/\btpsref:Rec[A-Z0-9]+:(\d{10}\.\d{6})/i)?.[1]||body.match(/\b\d{10}\.\d{6}\b/)?.[0]||meta?.incomingTs};}
async function routeChannelAssignment(p,ctx){
 if(ctx.worker)return null;
 const a=p.actions?.[0];const action=a?.action_id||p.view?.callback_id||'';
 const assignment=['assign_call','reassign_open','reassign_keep','tps_helper_open','tps_helper_done','job_assignment'].includes(action)||/^assign_(esteban|eduardo|edgar|cindy)$/.test(action)||/^reassign_to_/.test(action);
 const completion=action==='complete_call';
 if(!assignment&&!completion)return null;
 const enabled=String(await ctx.store.getGlobalVariable('TPS_ASSIGNMENT_ENABLED'))==='true';
 if(!enabled)return action.startsWith('tps_helper_')?{handled:true,error:'Helper tools are not released yet.'}:null;
 const channel=p.channel?.id||p.container?.channel_id;
 // Completed/closing return visits retain the existing recall dispatcher.
 if(channel&&![...TECHS.map(t=>t.channel),'C0C2XUL7ZHN','C0C2XB4VD1N'].includes(channel)&&!action.startsWith('tps_helper_'))return null;
 const user=p.user?.id;
 const say=async text=>{if(channel&&user)await ctx.slack('chat.postEphemeral',{channel,user,text}).catch(()=>{});};
 const ids=idsOf(p);
 if(completion){
  if(!ids.recordId)return null;
  const saved=await ctx.store.getGlobalVariable('TPS_ASSIGN_STATE_'+ids.recordId);let state;try{state=typeof saved==='string'?JSON.parse(saved):saved;}catch{return{handled:true,error:'Helper state could not be read.'};}
  if(!state?.helper&&!state?.activeRequest)return null;
 }
 if(!ctx.approved){await say('Assignment controls could not verify this Slack request. Open TPS Job Board to manage the call.');return{handled:true,error:'unverified Slack request'};}
 if(!['tps_helper_done','complete_call'].includes(action)&&!ADMINS.includes(user)){await say('🔒 Assignment tools are limited to TPS admins.');return{handled:true,error:'not admin'};}
 const hook=await ctx.store.getGlobalVariable('TPS_ASSIGNMENT_HOOK');
 if(!/^https:\/\/webhook\.latenode\.com\//.test(hook||'')){await say('Assignment tools are not connected yet. Nothing was changed.');return{handled:true,error:'queue unavailable'};}
 const open=['assign_call','reassign_open','tps_helper_open'].includes(action);
 let shellViewId;
 if(open){
  const shell={type:'modal',title:{type:'plain_text',text:'Assignment'},close:{type:'plain_text',text:'Cancel'},blocks:[{type:'section',text:{type:'plain_text',text:'Checking the current call…'}}]};
  const out=await ctx.slack(p.view?.type==='modal'?'views.push':'views.open',{trigger_id:p.trigger_id,view:shell});
  if(!out.ok||!out.view?.id)throw Error('Assignment form could not open.');
  shellViewId=out.view.id;
 }
 const requestId=createHash('sha256').update(JSON.stringify([user,action,p.action_ts||a?.action_ts||p.trigger_id||p.view?.hash||'',channel,p.container?.message_ts||p.message?.ts])).digest('hex');
 const body={key:await ctx.store.getGlobalVariable('TPS_INTERNAL_KEY'),mode:open?'open':action==='job_assignment'?'modal_submit':'event_submit',event:p,...ids,shellViewId,requestId};
 const r=await ctx.fetch(hook,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 if(!r.ok)throw Error('The assignment queue did not respond.');
 if(!open)await say('⏳ Queued. The call history will record the result; please do not press again.');
 return{handled:true,queued:true};
}
module.exports={unwrapAssignment,routeChannelAssignment,idsOf};
