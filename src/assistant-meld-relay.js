'use strict';
const ROUTE='https://webhook.latenode.com/27333/prod/eb873fbf-b964-4cf3-a704-adeb16274831';
// Called only after the Assistant endpoint verifies Slack's signature.
function assistantMeldRequest(p,key){
 const action=p.actions?.[0]?.action_id||'';if(p.type!=='block_actions'||!/^meld_/.test(action))return null;
 if((p.team?.id||p.team_id)!=='T086X85G14N'||!['U0876C3TEGL','U0C2PMHJK0A','U0C2X3HU490'].includes(p.user?.id))return{status:403,body:'Meld intake is limited to TPS admins.'};
 if(action==='meld_open')return{status:200,body:''};
 if(!key)return{status:503,body:'Meld controls are not connected.'};
 return{status:200,body:'',forward:{url:ROUTE,body:{payload:JSON.stringify({key,tps_assignment_verified:p})}}};
}
module.exports={assistantMeldRequest};

