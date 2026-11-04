'use strict';
const{ADMINS,TECHS}=require('./assignment-policy');
function boardRole(user){if(!user)return'preview';if(ADMINS.includes(user))return'admin';return TECHS.some(t=>t.id===user)?'plumber':'none';}
function canViewJob(job,user){const role=boardRole(user);return!!job&&(role==='admin'||role==='preview'||role==='plumber'&&(job.techId===user||job.helperId===user));}
function scopedJobs(jobs,user){return jobs.filter(j=>canViewJob(j,user));}
function canAddNotes(job,user,url){return canViewJob(job,user)&&job.status!=='done'&&!!job.assignedMessageUrl&&job.assignedMessageUrl===url;}
function scopedFilters(filters){const role=boardRole(filters.user);if(role==='plumber')return{...filters,tab:filters.tab==='recent'?'recent':'mine',tech:'all'};return filters;}
module.exports={boardRole,canViewJob,canAddNotes,scopedJobs,scopedFilters};