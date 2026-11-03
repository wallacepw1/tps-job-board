'use strict';
const {createHmac,timingSafeEqual}=require('node:crypto');
const ROUTE='https://webhook.latenode.com/27333/prod/eb873fbf-b964-4cf3-a704-adeb16274831';
function verifySlackRequest(raw,headers,secret,now=Date.now()){
 const ts=headers['x-slack-request-timestamp'],signature=headers['x-slack-signature'];
 if(!secret||typeof raw!=='string'||!/^\d{10}$/.test(ts||'')||Math.abs(now/1000-Number(ts))>300||!/^v0=[a-f0-9]{64}$/.test(signature||''))return false;
 const expected='v0='+createHmac('sha256',secret).update('v0:'+ts+':'+raw).digest('hex');
 return timingSafeEqual(Buffer.from(signature),Buffer.from(expected));
}
const PREVIEW_URL='https://webhook.latenode.com/27333/prod/tps-job-files-preview';
function inspectJobFilesEvent(raw,headers,{secret=process.env.TPS_CALL_ROUTE_SIGNING_SECRET,key=process.env.TPS_INTERNAL_KEY,now=Date.now()}={}){
 if(!verifySlackRequest(raw,headers,secret,now))return{status:401,body:'Request could not be verified.'};
 let p;try{p=JSON.parse(raw);}catch{return{status:400,body:'Invalid Slack event.'};}
 if(p.type==='url_verification')return typeof p.challenge==='string'&&p.challenge.length<=512?{status:200,body:p.challenge}:{status:400,body:'Invalid challenge.'};
 const e=p.event;
 if(p.type!=='event_callback'||p.team_id!=='T086X85G14N'||p.api_app_id!=='A0C54G77M6E'||e?.type!=='entity_details_requested'||e.external_ref?.id!=='tps-job-files-test-132263'||e.entity_url!==PREVIEW_URL||e.channel!=='C0C2ZVB32RG'||e.message_ts!=='1793719172.591069'||!/^U[A-Z0-9]+$/.test(e.user||'')||!e.trigger_id)return{status:200,body:''};
 if(!key)return{status:503,body:'Preview is not connected.'};
 return{status:200,body:'',forward:{payload:JSON.stringify({key,tps_assignment_verified:p})}};
}
function registerJobFilesEvents(receiver,options={}){
 receiver.router.get('/slack/job-files-events/health',(_req,res)=>res.json({ready:!!(options.secret||process.env.TPS_CALL_ROUTE_SIGNING_SECRET)&&!!(options.key||process.env.TPS_INTERNAL_KEY),testOnly:true}));
 receiver.router.post('/slack/job-files-events',async(req,res)=>{
  try{
   let raw=req.rawBody?.toString()||'';
   if(!raw)for await(const chunk of req){raw+=chunk.toString();if(Buffer.byteLength(raw)>1024*1024)return res.status(413).send('Request too large.');}
   if(Buffer.byteLength(raw)>1024*1024)return res.status(413).send('Request too large.');
   const out=inspectJobFilesEvent(raw,req.headers,options);
   res.status(out.status).type('text/plain').send(out.body);
   if(out.forward)await (options.fetch||global.fetch)(ROUTE,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(out.forward),signal:AbortSignal.timeout(8000)}).then(r=>{if(!r.ok)throw Error('Preview relay refused');});
  }catch{if(!res.headersSent)res.status(502).send('Preview could not be reached.');else console.error('Verified job files preview relay failed');}
 });
}
async function relayCallAction(raw,headers,{secret=process.env.TPS_CALL_ROUTE_SIGNING_SECRET,key=process.env.TPS_INTERNAL_KEY,fetch:fetcher=global.fetch,now=Date.now()}={}){
 if(!verifySlackRequest(raw,headers,secret,now))return{status:401,body:'Request could not be verified.'};
 if(!key)return{status:503,body:'Call controls are not connected.'};
 let payload;try{payload=JSON.parse(new URLSearchParams(raw).get('payload'));if(!payload?.type)throw Error();}catch{return{status:400,body:'Invalid Slack request.'};}
 const response=await fetcher(ROUTE,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload:JSON.stringify({key,tps_assignment_verified:payload})}),signal:AbortSignal.timeout(95000)});
 return{status:response.status,body:await response.text()};
}
function registerCallActionsProxy(receiver,options={}){
 registerJobFilesEvents(receiver,options);
 receiver.router.post('/slack/call-actions',async(req,res)=>{
  let raw='';
  try{
   if(req.rawBody)raw=req.rawBody.toString();
   else{for await(const chunk of req){raw+=chunk.toString();if(Buffer.byteLength(raw)>1024*1024){res.status(413).send('Request too large.');return;}}}
   const secret=options.secret||process.env.TPS_CALL_ROUTE_SIGNING_SECRET;
   if(!verifySlackRequest(raw,req.headers,secret)){res.status(401).send('Request could not be verified.');return;}
   if(!(options.key||process.env.TPS_INTERNAL_KEY)){res.status(503).send('Call controls are not connected.');return;}
   const payload=JSON.parse(new URLSearchParams(raw).get('payload'));
   const quick=payload.type==='block_actions'||payload.view?.callback_id==='job_assignment';
   if(quick){res.status(200).send('');relayCallAction(raw,req.headers,options).catch(()=>console.error('Verified call action relay failed'));return;}
   const out=await relayCallAction(raw,req.headers,options);res.status(out.status).type('application/json').send(out.body);
  }catch{if(!res.headersSent)res.status(502).send('Call controls could not be reached.');}
 });
}
module.exports={verifySlackRequest,relayCallAction,registerCallActionsProxy,inspectJobFilesEvent,registerJobFilesEvents};
