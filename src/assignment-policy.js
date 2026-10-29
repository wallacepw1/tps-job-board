'use strict';
const ADMINS=['U0876C3TEGL','U0C2PMHJK0A','U0C2X3HU490'];
const TECHS=[
 {id:'U0C2TELAYKE',name:'Esteban',channel:'C0C2WRQLPL0'},
 {id:'U0C2MSLLS1L',name:'Eduardo',channel:'C0C1M4CRKSB'},
 {id:'U0C2PMHJK0A',name:'Edgar',channel:'C0C2WV6EHR6'},
 {id:'U0C2JV565K7',name:'Cindy',channel:'C0C19G9GT34'}
];
const OPERATIONS=['assign','reassign','helper_add','helper_remove','helper_done','lead_complete'];
function validateAssignment(r,c){
 const no=error=>({ok:false,error});
 if(!r||!c||!c.readVerified)return no('The current call could not be verified. Refresh and try again.');
 if(!/^[a-zA-Z0-9_-]{16,100}$/.test(r.requestId||''))return no('Invalid request.');
 if(!OPERATIONS.includes(r.operation))return no('Unknown assignment action.');
 const admin=ADMINS.includes(r.actor);
 if(r.operation==='helper_done'){if(!admin||!r.actor){if(!c.helper||r.actor!==c.helper)return no('Only the helper or an admin can finish helper work.');}}
 else if(r.operation==='lead_complete'){if(!admin&&r.actor!==c.lead)return no('Only the lead plumber or an admin can complete this call.');}
 else if(!admin)return no('Assignment tools are limited to TPS admins.');
 if(r.recordId!==c.recordId||r.incomingTs!==c.incomingTs)return no('This card no longer matches the current call.');
 if(!Object.hasOwn(r,'expectedLead')||r.expectedLead!==c.lead)return no('The lead plumber changed. Refresh before continuing.');
 if(!Object.hasOwn(r,'expectedHelper')||r.expectedHelper!==c.helper)return no('The helper changed. Refresh before continuing.');
 if(!['unassigned','plumber'].includes(c.stage))return no('This call is no longer awaiting assignment or in a plumber channel.');
 if(['assign','reassign','helper_add'].includes(r.operation)){
  if(!TECHS.some(t=>t.id===r.target))return no('Choose a current TPS plumber.');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(c.today||''))return no('The current Pacific date is unavailable.');
  if(c.appointmentDate&&c.appointmentDate>c.today)return no('This appointment is on a future day. Its schedule was left unchanged.');
 }
 if(r.operation==='assign'&&(c.lead||c.stage!=='unassigned'))return no('This call already has a lead. Use Reassign.');
 if(['reassign','helper_add','helper_remove','helper_done','lead_complete'].includes(r.operation)&&(!c.lead||c.stage!=='plumber'))return no('This call is not in a plumber channel.');
 if(r.operation==='reassign'&&r.target===c.lead)return no('That plumber already leads this call.');
 if(r.operation==='reassign'&&r.target===c.helper)return no('Remove this helper before making them the lead.');
 if(r.operation==='helper_add'&&(c.helper||r.target===c.lead))return no(c.helper?'Remove the current helper before choosing another.':'The lead cannot also be the helper.');
 if(['helper_remove','helper_done'].includes(r.operation)&&!c.helper)return no('There is no active helper on this call.');
 return{ok:true};
}
module.exports={ADMINS,TECHS,OPERATIONS,validateAssignment};