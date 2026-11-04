const test=require('node:test'),assert=require('node:assert/strict');
const d=require('../src/desc-modal');
const jf=require('../src/job-files');
const FOLDER='1Hk8dnTybkB0TIgEvJoqIBMLkKeYxeBul',o={TPS_INTERNAL_KEY:'k',GOOGLE_API_KEY:'g',PUBLIC_URL:'https://board.example',TPS_BOT_TOKEN:'xoxb-test'};
// Shaped like a real #completed card (Read call message card prefix + Send to #completed blocks)
const card=()=>[
 {type:'card',title:{type:'mrkdwn',text:'132273'},subtitle:{type:'mrkdwn',text:'Lakeside Gardens Inc.'}},
 {type:'divider',block_id:'tpsref:Rec1:1793740000.123456'},
 {type:'actions',block_id:'tps_card_resource_links',elements:[
  {type:'button',action_id:'tps_resource_files',url:`https://drive.google.com/drive/folders/${FOLDER}`,value:'open'},
  {type:'button',action_id:'tps_resource_incoming',url:'https://tpsplumbing.slack.com/archives/C0INCOMING/p1793740000123456?thread_ts=1793740000.123456&cid=C0INCOMING',value:'open'}]},
 {type:'rich_text',block_id:'tpsbox|132273|x',elements:[{type:'rich_text_section',elements:[{type:'text',text:'Plumber Notes\n',style:{bold:true}},{type:'text',text:'1/2 copper, 2 couplings to fix leak'}]}]},
 {type:'input',block_id:'notes_input_block',optional:true,element:{type:'plain_text_input',action_id:'notes_input_action',multiline:true,initial_value:'AI draft'},label:{type:'plain_text',text:'Call Description'},hint:{type:'plain_text',text:'Draft from similar past calls. Check and edit it before Complete.'}},
 {type:'actions',block_id:'action_buttons_block',elements:[{type:'button',action_id:'tps_desc_open',value:'open'},{type:'button',action_id:'submitnotes',value:'Submit'}]}];

test('reads the job, Drive folder, Incoming Calls thread, notes and current text from the card',()=>{
 const b=card();
 assert.deepEqual(d.cardRefs(b),{folderId:FOLDER,incoming:{channel:'C0INCOMING',ts:'1793740000.123456'},jobNumber:'132273'});
 assert.equal(d.plumberNotes(b),'1/2 copper, 2 couplings to fix leak');
 assert.equal(d.currentText({message:{blocks:b}}),'AI draft');
 assert.equal(d.currentText({message:{blocks:b},state:{values:{notes_input_block:{notes_input_action:{value:'typed'}}}}}),'typed');
});

test('pop-up: notes, description box, then PDFs and photos; Slack photos by file id',()=>{
 const v=d.descView({jobNumber:'132273',notes:'leak <b>',text:'AI draft',hint:'Draft hint',folderId:FOLDER,meta:{c:'C1',ts:'1.2'},files:[
  {src:'slack',id:'F1',name:'IMG_1.jpg',mimeType:'image/jpeg',created:'2'},
  {src:'slack',id:'F2',name:'clip.mp4',mimeType:'video/mp4',permalink:'https://tpsplumbing.slack.com/files/U/F2/clip.mp4',created:'3'},
  {src:'drive',id:'pdf1aaaaaaaaaa',name:'261269-1.pdf',mimeType:'application/pdf',created:'1'}]},o);
 assert.equal(v.callback_id,d.CALLBACK);assert.equal(v.submit.text,'Save to card');
 assert.ok(v.blocks[0].text.text.includes('leak b')&&!v.blocks[0].text.text.includes('<b>'));
 const input=v.blocks[1];assert.equal(input.block_id,'notes_input_block');assert.equal(input.element.initial_value,'AI draft');assert.equal(input.hint.text,'Draft hint');
 const types=v.blocks.slice(2).map(b=>b.type);
 assert.deepEqual(types,['divider','context','section','image','image','section']);
 assert.ok(v.blocks[5].image_url.startsWith(`https://board.example/job-files/${FOLDER}/thumb/pdf1aaaaaaaaaa?`),'PDF first page');
 assert.deepEqual(v.blocks[6].slack_file,{id:'F1'});
 assert.equal(v.blocks[7].accessory.text.text,'Play');
 assert.deepEqual(JSON.parse(v.private_metadata),{c:'C1',ts:'1.2'});
 assert.ok(v.blocks.length<=100);
});

test('pop-up caps photos and stays under the 100-block limit',()=>{
 const files=Array.from({length:60},(_,i)=>({src:'slack',id:'F'+i,name:`p${i}.jpg`,mimeType:'image/jpeg',created:String(i)}));
 const v=d.descView({jobNumber:'1',notes:'',text:'',files,meta:{}},o);
 assert.equal(v.blocks.filter(b=>b.type==='image').length,30);
 assert.ok(v.blocks.at(-1).elements[0].text.startsWith('30 more not shown'));
 assert.equal(v.blocks[1].element.initial_value,undefined);
});

function fakeSlack(handlers){
 const calls=[];
 const fetch=async(url,init)=>{
  if(url.startsWith('https://slack.com/api/')){const m=url.split('/').pop(),b=JSON.parse(init.body);calls.push({m,b});const r=(handlers[m]||(()=>({ok:true})))(b);return{ok:true,json:async()=>r};}
  return{ok:true,json:async()=>({files:[{id:'pdf1aaaaaaaaaa',name:'WO.pdf',mimeType:'application/pdf'},{id:'img2aaaaaaaaaa',name:'IMG_1.jpg',mimeType:'image/jpeg'}]})};
 };
 return{calls,fetch};
}

test('openDescModal opens on the trigger, then fills from Drive and the Incoming Calls thread (no duplicates)',async()=>{
 jf._listCache.clear();
 const s=fakeSlack({'views.open':()=>({ok:true,view:{id:'V1',hash:'h'}}),'conversations.replies':()=>({ok:true,messages:[{ts:'1',files:[{id:'F1',name:'IMG_1.jpg',mimetype:'image/jpeg'},{id:'F3',name:'IMG_3.jpg',mimetype:'image/jpeg'}]}]})});
 const r=await d.openDescModal({trigger_id:'T1',channel:{id:'C0COMPLETED'},message:{ts:'1793741271.447669',blocks:card()},actions:[{action_id:'tps_desc_open'}]},{...o,fetch:s.fetch});
 assert.equal(r,'opened 132273 files=3');
 assert.deepEqual(s.calls.map(c=>c.m),['views.open','conversations.replies','views.update']);
 assert.equal(s.calls[1].b.channel,'C0INCOMING');
 const view=s.calls[2].b.view;
 assert.equal(view.blocks[1].element.initial_value,'AI draft');
 assert.equal(view.blocks.filter(b=>b.type==='image').length,3,'PDF page + 2 photos');
});

test('Save writes the text into the card box and keeps every other block',async()=>{
 const s=fakeSlack({'conversations.history':()=>({ok:true,messages:[{ts:'1793741271.447669',text:'132273',blocks:card()}]}),'chat.update':()=>({ok:true})});
 const out=await d.saveDescription({view:{private_metadata:JSON.stringify({c:'C0COMPLETED',ts:'1793741271.447669',j:'132273'}),state:{values:{notes_input_block:{notes_input_action:{value:'  The plumber fixed the leak.  '}}}}}},{...o,fetch:s.fetch});
 assert.equal(out,null);
 const up=s.calls.find(c=>c.m==='chat.update').b;
 assert.equal(up.channel,'C0COMPLETED');assert.equal(up.text,'132273');
 assert.equal(up.blocks.length,card().length);
 assert.equal(up.blocks.find(b=>b.block_id==='notes_input_block').element.initial_value,'The plumber fixed the leak.');
 assert.deepEqual(up.blocks[0],card()[0]);
});

test('Save refuses a completed card, an empty box, and reports a failed update in the pop-up',async()=>{
 const meta=JSON.stringify({c:'C0COMPLETED',ts:'1793741271.447669'});
 const val=v=>({notes_input_block:{notes_input_action:{value:v}}});
 let s=fakeSlack({'conversations.history':()=>({ok:true,messages:[{ts:'1793741271.447669',blocks:card().filter(b=>b.type!=='input')}]})});
 let out=await d.saveDescription({view:{private_metadata:meta,state:{values:val('x')}}},{...o,fetch:s.fetch});
 assert.match(out.errors.notes_input_block,/already completed/);assert.ok(!s.calls.some(c=>c.m==='chat.update'));
 out=await d.saveDescription({view:{private_metadata:meta,state:{values:val('  ')}}},{...o,fetch:s.fetch});
 assert.match(out.errors.notes_input_block,/Write the description/);
 s=fakeSlack({'conversations.history':()=>({ok:true,messages:[{ts:'1793741271.447669',blocks:card()}]}),'chat.update':()=>({ok:false,error:'cant_update_message'})});
 out=await d.saveDescription({view:{private_metadata:meta,state:{values:val('x')}}},{...o,fetch:s.fetch});
 assert.match(out.errors.notes_input_block,/Try Save again/);
});

test('Save falls back to the card as it was opened when the channel cannot be read',async()=>{
 d._openCards.set('C0COMPLETED|1793741271.447669',card());
 const s=fakeSlack({'conversations.history':()=>({ok:false,error:'missing_scope'}),'chat.update':()=>({ok:true})});
 const out=await d.saveDescription({view:{private_metadata:JSON.stringify({c:'C0COMPLETED',ts:'1793741271.447669'}),state:{values:{notes_input_block:{notes_input_action:{value:'ok'}}}}}},{...o,fetch:s.fetch});
 assert.equal(out,null);assert.ok(s.calls.some(c=>c.m==='chat.update'));
});
