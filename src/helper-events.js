'use strict';
const {TECHS}=require('./assignment-policy');
function registerHelperEvents(app,{endpoint=process.env.TPS_CALL_ACTIONS_URL,key=process.env.TPS_INTERNAL_KEY,fetch:fetcher=global.fetch}={}){
 app.event('message',async({event})=>{
  const m=event.subtype==='message_changed'?{...event.message,channel:event.channel}:event;
  if(!m.thread_ts||!TECHS.some(t=>t.channel===m.channel)||m.subtype==='message_deleted')return;
  if(!key||!endpoint)return;
  const u=new URL(endpoint);if(u.protocol!=='https:'||u.hostname!=='webhook.latenode.com')return;
  try{const r=await fetcher(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,mode:'helper_event',event:m}),signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Queue unavailable');}
  catch{console.error('Helper message relay needs retry; original thread is retained until verified archival');}
 });
}
module.exports={registerHelperEvents};