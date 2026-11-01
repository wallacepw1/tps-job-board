'use strict';
// "🔄 Refresh call list" button in the Job Board's Messages tab (posted by Latenode TPS Daily Jobs with the
// Job Board bot token). Render acks the click and asks Latenode tps-jobs to delete the Job Board's own earlier
// messages in that DM and repost the rundown. Latenode checks TPS_INTERNAL_KEY and that the user is an admin.
const TPS_JOBS_URL='https://webhook.latenode.com/27333/prod/tps-jobs';
const ACTION_ID='jb_refresh_calls';
async function requestRefresh(user,{url=process.env.TPS_JOBS_URL||TPS_JOBS_URL,key=process.env.TPS_INTERNAL_KEY,fetch:fetcher=global.fetch}={}){
 if(!key)return{ok:false,error:'TPS_INTERNAL_KEY is not set'};
 const r=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,action:'jb_refresh',user}),signal:AbortSignal.timeout(90000)});
 let out;try{out=JSON.parse(await r.text());}catch{out={ok:r.ok};}
 return out&&typeof out==='object'?out:{ok:false};
}
function registerRundownRefresh(app,options={}){
 app.action(ACTION_ID,async({ack,body,client})=>{
  await ack();
  const user=body.user&&body.user.id,channel=body.channel&&body.channel.id;
  let out;
  try{out=await requestRefresh(user,options);}catch(e){out={ok:false,error:'Latenode could not be reached'};}
  if(!out.ok&&channel&&user){
   await client.chat.postEphemeral({channel,user,text:`Couldn't refresh the call list (${out.error||'unknown error'}). Try again in a minute.`}).catch(()=>{});
  }
 });
}
module.exports={ACTION_ID,requestRefresh,registerRundownRefresh};
