'use strict';
const READS=new Set(['auth.test','conversations.replies','conversations.history','files.info','files.getUploadURLExternal']);
function slackTransport(token,fetcher=global.fetch){return async(method,params={})=>{
 if(!token)throw Error('Slack connection unavailable');
 const url=new URL('https://slack.com/api/'+method);
 const opts={method:READS.has(method)?'GET':'POST',headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)};
 if(opts.method==='GET'){for(const [k,v] of Object.entries(params))if(v!==undefined&&v!==null)url.searchParams.set(k,String(v));}
 else{opts.headers['Content-Type']='application/json; charset=utf-8';opts.body=JSON.stringify(params);}
 const r=await fetcher(url.href,opts);
 if(!r.ok)return{ok:false,error:'HTTP '+r.status};
 return r.json();
};}
module.exports={slackTransport};
