'use strict';
// Event pings that replace Latenode timers (2026-11-18, Latenode credit cut).
// The Job Board app already receives every message posted in the call channels. When a new card lands, it tells
// the Latenode scenario that used to check on a timer, so those scenarios run only when there is something to do:
//  - Meld Intake follow-up (was every 2 min): new card in #incoming-calls, #please-assign-these or #future-calls.
//  - TPS Daily Jobs scan (was every 15 min): new card in #incoming-calls (repeat address) or #completed (photo check).
//  - Meld Complete (was every 10 min): new card in #completed.
// Pings are grouped: a burst of posts within DEBOUNCE_MS sends one ping per scenario.
const BASE='https://webhook.latenode.com/27333/prod/';
const INCOMING='C0C19TG3KJ6',PLEASE_ASSIGN='C0C2XUL7ZHN',FUTURE='C0C2XB4VD1N',COMPLETED='C0C2YDBHFFY';
const TARGETS={
 meldFollow:{path:'meld-actions',body:{action:'follow'},channels:[INCOMING,PLEASE_ASSIGN,FUTURE]},
 jobsScan:{path:'tps-jobs-scan',body:{action:'scan'},channels:[INCOMING,COMPLETED]},
 meldComplete:{path:'tps-meld-complete',body:{action:'complete'},channels:[COMPLETED]}
};
const DEBOUNCE_MS=15000;
// A new top-level card: not a thread reply, edit, deletion or join notice.
function isNewCard(event){
 if(!event||event.type!=='message'||event.thread_ts&&event.thread_ts!==event.ts)return false;
 return !event.subtype||event.subtype==='bot_message'||event.subtype==='file_share';
}
function targetsFor(event){
 if(!isNewCard(event))return[];
 return Object.keys(TARGETS).filter(name=>TARGETS[name].channels.includes(event.channel));
}
function createPinger({key=process.env.TPS_INTERNAL_KEY,fetch:fetcher=global.fetch,debounceMs=DEBOUNCE_MS,setTimer=setTimeout}={}){
 const pending=new Map();
 const send=async name=>{
  pending.delete(name);
  if(!key)return;
  const t=TARGETS[name];
  try{const r=await fetcher(BASE+t.path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,...t.body,source:'jobboard'}),signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('status '+r.status);}
  catch(e){console.error('latenode ping',name,e.message);}
 };
 return function onMessage(event){
  const names=targetsFor(event);
  for(const name of names){
   if(pending.has(name))continue;
   const timer=setTimer(()=>{send(name);},debounceMs);timer?.unref?.();
   pending.set(name,timer);
  }
  return names;
 };
}
function registerLatenodePings(app,options={}){
 const onMessage=createPinger(options);
 app.event('message',async({event})=>{onMessage(event);});
 return onMessage;
}
module.exports={TARGETS,isNewCard,targetsFor,createPinger,registerLatenodePings};
