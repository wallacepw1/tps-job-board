'use strict';
const{ADMINS}=require('./assignment-policy');
function summaryHome(view,user){if(!ADMINS.includes(user))return view;const blocks=view.blocks.map(b=>({...b}));const button={type:'button',action_id:'jb_summary_canvas',text:{type:'plain_text',text:'Morning summary'},value:'open'};const actions=blocks.find(b=>b.type==='actions'&&b.elements?.length<25);if(actions)actions.elements=[...actions.elements,button];else if(blocks.length<100)blocks.splice(0,0,{type:'actions',elements:[button]});return{...view,blocks};}
function summaryView(text,url){return{type:'modal',callback_id:'jb_summary_result',title:{type:'plain_text',text:'Morning summary'},close:{type:'plain_text',text:'Close'},blocks:[{type:'section',text:{type:'mrkdwn',text}},...(url?[{type:'actions',elements:[{type:'button',action_id:'jb_canvas_link',text:{type:'plain_text',text:'Open summary canvas'},url,value:'open'}]}]:[])]};}
function registerSummarySurface(app,{fetch:fetcher=global.fetch,key=process.env.TPS_INTERNAL_KEY,url=process.env.TPS_JOBS_URL||'https://webhook.latenode.com/27333/prod/tps-jobs'}={}){
 app.action('jb_canvas_link',async({ack})=>ack());
 app.action('jb_summary_canvas',async({ack,body,client})=>{
  await ack();const user=body.user.id;
  const opened=await client.views.open({trigger_id:body.trigger_id,view:summaryView(ADMINS.includes(user)?'Opening your summary…':'Morning summaries are limited to admins.')});
  if(!ADMINS.includes(user))return;
  let result;try{if(!key)throw Error('Summary connection is unavailable');const r=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,action:'jb_canvas',user}),signal:AbortSignal.timeout(30000)});result=JSON.parse(await r.text());}catch(e){result={error:e.message||'Summary could not be reached'}}
  const target=result?.ok&&/^https:\/\/app\.slack\.com\/docs\/T086X85G14N\/F[A-Z0-9]+$/.test(result.url||'')?result.url:null;
  await client.views.update({view_id:opened.view.id,view:summaryView(target?'Your morning summary is ready. The live Job Board keeps current status and assignment tools.':result?.error||'The summary canvas is not enabled yet.',target)});
 });
}
module.exports={summaryHome,summaryView,registerSummarySurface};