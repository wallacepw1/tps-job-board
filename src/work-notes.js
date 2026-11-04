'use strict';
const NOTE_BOTS=new Set(['U0CBJ272VJ9','U0C52NTH4LW']);
const NOTE_PEOPLE=new Set(['U0876C3TEGL','U0C2X3HU490','U0C2PMHJK0A','U0C2TELAYKE','U0C2MSLLS1L','U0C2JV565K7']);
function workNoteText(m){
 const text=String(m.text||'').trim();if(!text)return'';
 const bot=!!m.bot_id||m.subtype==='bot_message'||NOTE_BOTS.has(m.user);
 if(!bot)return text;
 if(!NOTE_BOTS.has(m.user))return'';
 let body=text;
 const copy=body.match(/^<@(U[A-Z0-9]+)(?:\|[^>]+)?>:\s*([\s\S]*)$/);
 if(copy){
  if(copy[1]==='U0CBJ272VJ9')body=copy[2];
  else if(NOTE_PEOPLE.has(copy[1]))return copy[2].trim();
  else return'';
 }
 const notes=body.match(/^(?::memo:|📝)?\s*Notes from <@U[A-Z0-9]+(?:\|[^>]+)?>:\s*([\s\S]+)$/i);
 return notes?notes[1].trim():'';
}
function collectWorkNotes(messages=[]){
 const parent=messages[0]?.ts,seen=new Set(),out=[];
 let cutoff=0;
 for(const m of messages)if((m.bot_id||NOTE_BOTS.has(m.user))&&/^(?:Call (?:assigned to|reassigned from)|TPS lead assigned:|Return on the same unbilled invoice assigned to |:arrows_counterclockwise: Sent to <#|:calendar: \*Rescheduled:|:hourglass_flowing_sand: \*Needs to be scheduled)/.test(String(m.text||'').trim()))cutoff=Math.max(cutoff,Number(m.ts)||0);
 for(const m of messages){
  if(m.ts===parent||(Number(m.ts)||0)<=cutoff)continue;
  const text=workNoteText(m),key=text.replace(/\s+/g,' ').trim();
  if(!key||seen.has(key))continue;seen.add(key);out.push(text);
 }
 return out.join('\n\n');
}
module.exports={workNoteText,collectWorkNotes};
