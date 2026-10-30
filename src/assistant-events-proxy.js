'use strict';
const {verifySlackRequest}=require('./call-actions-proxy');
const TARGET='https://webhook.latenode.com/27333/prod/media-bot-slack-events';
function parseAssistantBody(raw){
 try{return JSON.parse(raw);}catch{
  const form=Object.fromEntries(new URLSearchParams(raw));
  return form.payload?JSON.parse(form.payload):form;
 }
}
function shouldForwardAssistant(body){
 if(body.type!=='event_callback')return true;
 const event=body.event||{};
 if(event.type==='app_home_opened')return event.tab==='home';
 if(event.type!=='message')return false;
 if(event.subtype==='message_deleted')return false;
 const message=event.subtype==='message_changed'?event.message:event;
 if(!message)return false;
 // Late photos and edits can belong to a recall; keep every threaded event.
 if(message.thread_ts)return true;
 if(event.subtype==='message_changed'||message.bot_id||message.bot_profile)return false;
 return event.channel_type==='im'||String(event.channel||'').startsWith('D');
}
function registerAssistantEventsProxy(receiver,options={}){
 receiver.router.post('/slack/assistant-events',async(req,res)=>{
  try{
   let raw=req.rawBody?.toString()||'';
   if(!raw)for await(const chunk of req){raw+=chunk.toString();if(Buffer.byteLength(raw)>1024*1024)return res.status(413).send('Request too large.');}
   if(!verifySlackRequest(raw,req.headers,options.secret||process.env.TPS_ASSISTANT_SIGNING_SECRET))return res.status(401).send('Request could not be verified.');
   const body=parseAssistantBody(raw);
   if(body.type==='url_verification')return res.status(200).send(body.challenge);
   if(!shouldForwardAssistant(body))return res.status(200).send('');
   // Await delivery so Slack retries transport failures rather than losing a click.
   const response=await (options.fetch||global.fetch)(TARGET,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(2200)});
   res.status(response.status).type('application/json').send(await response.text());
  }catch{if(!res.headersSent)res.status(502).send('Assistant could not be reached.');}
 });
 receiver.router.get('/slack/assistant-events/health',(_req,res)=>res.json({ready:!!(options.secret||process.env.TPS_ASSISTANT_SIGNING_SECRET)}));
}
module.exports={parseAssistantBody,shouldForwardAssistant,registerAssistantEventsProxy};

