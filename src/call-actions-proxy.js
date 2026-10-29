'use strict';
const {createHmac,timingSafeEqual}=require('node:crypto');
const ROUTE='https://webhook.latenode.com/27333/prod/eb873fbf-b964-4cf3-a704-adeb16274831';
function verifySlackRequest(raw,headers,secret,now=Date.now()){
 const ts=headers['x-slack-request-timestamp'],signature=headers['x-slack-signature'];
 if(!secret||typeof raw!=='string'||!/^\d{10}$/.test(ts||'')||Math.abs(now/1000-Number(ts))>300||!/^v0=[a-f0-9]{64}$/.test(signature||''))return false;
 const expected='v0='+createHmac('sha256',secret).update('v0:'+ts+':'+raw).digest('hex');
 return timingSafeEqual(Buffer.from(signature),Buffer.from(expected));
}
async function relayCallAction(raw,headers,{secret=process.env.TPS_CALL_ROUTE_SIGNING_SECRET,key=process.env.TPS_INTERNAL_KEY,fetch:fetcher=global.fetch,now=Date.now()}={}){
 if(!verifySlackRequest(raw,headers,secret,now))return{status:401,body:'Request could not be verified.'};
 if(!key)return{status:503,body:'Call controls are not connected.'};
 let payload;try{payload=JSON.parse(new URLSearchParams(raw).get('payload'));if(!payload?.type)throw Error();}catch{return{status:400,body:'Invalid Slack request.'};}
 const response=await fetcher(ROUTE,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload:JSON.stringify({key,tps_assignment_verified:payload})}),signal:AbortSignal.timeout(95000)});
 return{status:response.status,body:await response.text()};
}
function registerCallActionsProxy(receiver,options={}){
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
module.exports={verifySlackRequest,relayCallAction,registerCallActionsProxy};
