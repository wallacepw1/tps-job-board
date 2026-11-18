'use strict';
const {verifySlackRequest}=require('./call-actions-proxy');
const {assistantMeldRequest}=require('./assistant-meld-relay');
const {handlePhone}=require('./phone-admin');
const {handlePriceSearch,publicStatus}=require('./price-search');
const appfolioSchedule=require('./appfolio-schedule');
const WORKING={response_action:'update',view:{type:'modal',callback_id:'tps_tool_result',title:{type:'plain_text',text:'TPS Assistant',emoji:true},close:{type:'plain_text',text:'Close',emoji:true},blocks:[{type:'section',text:{type:'mrkdwn',text:'Working… This window will update when the result is ready. Please do not submit again.'}}]}};
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
 // Late photos and edits can belong to a recall; keep threaded events from people and any post with files.
 // A bot's own text-only thread posts (TPS Bot price notes, pricing card records, status replies) are never
 // handled by the Assistant, and a pricing session sends hundreds of them, so they stop here (2026-11-18).
 if(message.thread_ts)return !((message.bot_id||message.bot_profile||message.subtype==='bot_message')&&!message.files?.length);
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
   // "Schedule this call" alert in the TPS Assistant messages: same AppFolio scheduling as the card button,
   // with this app's token for the pop-up and the alert. Never relayed to Latenode.
   if(appfolioSchedule.intercepts(body)){
    if(body.type==='view_submission'){
     const error=appfolioSchedule.submissionError(body);
     if(error)return res.status(200).json({response_action:'errors',errors:error});
     res.status(200).json({response_action:'update',view:appfolioSchedule.infoView('AppFolio scheduling',':hourglass_flowing_sand: Booking in AppFolio… This takes about a minute. Please do not submit again.')});
    }else res.status(200).send('');
    appfolioSchedule.route(body,{...options,viewToken:options.assistantToken||process.env.TPS_ASSISTANT_BOT_TOKEN}).catch(e=>console.error('appfolio schedule',e.message));
    return;
   }
   // Phone settings (/admin phone) are answered here, never relayed to Latenode.
   const phone=handlePhone(body,{fetch:options.fetch,load:options.loadPhone});
   if(phone){if(phone.json)res.status(phone.status).json(phone.json);else res.status(phone.status).send(phone.body);return;}
   // Price search is an Assistant modal. It never publishes the Job Board Home or replaces the Assistant Home.
   const price=handlePriceSearch(body,{fetch:options.fetch,enabled:options.priceSearchEnabled,token:options.assistantToken,schedule:options.schedule,env:options.env,now:options.now,photoLoader:options.photoLoader,client:options.priceClient});
   if(price){if(price.json)res.status(price.status).json(price.json);else res.status(price.status).send(price.body??'');return;}
   const meld=assistantMeldRequest(body,options.key||process.env.TPS_INTERNAL_KEY);
   if(meld){
    if(!meld.forward)return res.status(meld.status).send(meld.body);
    const response=await(options.fetch||global.fetch)(meld.forward.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(meld.forward.body),signal:AbortSignal.timeout(2200)});
    res.status(response.status).type('application/json').send(await response.text());
    return;
   }
   if(!shouldForwardAssistant(body))return res.status(200).send('');
   // Await delivery so Slack retries transport failures rather than losing a click.
   let response;
   try{response=await (options.fetch||global.fetch)(TARGET,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(2200)});}
   catch(e){
    // Latenode was slow to answer (it usually still runs the submission). A 502 here makes Slack show
    // "We had some trouble connecting" and invites a second submit, so close the form on a Working window instead.
    if(body.type==='view_submission'){console.error('assistant relay slow, acked submission',e.name);return res.status(200).json(WORKING);}
    throw e;
   }
   res.status(response.status).type('application/json').send(await response.text());
  }catch{if(!res.headersSent)res.status(502).send('Assistant could not be reached.');}
 });
 receiver.router.get('/slack/assistant-events/health',(_req,res)=>res.json({ready:!!(options.secret||process.env.TPS_ASSISTANT_SIGNING_SECRET),meldReady:!!(options.secret||process.env.TPS_ASSISTANT_SIGNING_SECRET)&&!!(options.key||process.env.TPS_INTERNAL_KEY),priceSearch:publicStatus(options.env,options.assistantToken||process.env.TPS_ASSISTANT_BOT_TOKEN)}));
}
module.exports={parseAssistantBody,shouldForwardAssistant,registerAssistantEventsProxy};

