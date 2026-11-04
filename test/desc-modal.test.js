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
 assert.equal(v.callback_id,d.CALLBACK);assert.equal(v.submit.text,'Submit description');
 assert.ok(v.blocks[0].text.text.includes('leak b')&&!v.blocks[0].text.text.includes('<b>'));
 const input=v.blocks[1];assert.equal(input.block_id,'notes_input_block');assert.equal(input.element.initial_value,'AI draft');assert.match(input.hint.text,/pricing/);
 const types=v.blocks.slice(2).map(b=>b.type);
 assert.deepEqual(types,['divider','section','section','image','image','section']);
 assert.equal(v.blocks[3].accessory.text.text,'📷 View full screen');assert.ok(v.blocks[3].accessory.url.startsWith(`https://board.example/job-files/${FOLDER}?`));
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
 const r=await d.openDescModal({trigger_id:'T1',user:{id:'U0876C3TEGL'},channel:{id:'C0COMPLETED'},message:{ts:'1793741271.447669',blocks:card()},actions:[{action_id:'tps_desc_open'}]},{...o,fetch:s.fetch});
 assert.equal(r,'opened 132273 files=3');
 assert.deepEqual(s.calls.map(c=>c.m),['views.open','conversations.replies','views.update']);
 assert.equal(s.calls[1].b.channel,'C0INCOMING');
 const view=s.calls[2].b.view;
 assert.equal(view.blocks[1].element.initial_value,'AI draft');
 assert.equal(view.blocks.filter(b=>b.type==='image').length,3,'PDF page + 2 photos');
});

test('a video in both Drive and Slack shows once, with its Drive file link',async()=>{
 jf._listCache.clear();
 const fetch=async(url,init)=>{
  if(url.startsWith('https://slack.com/api/'))return{ok:true,json:async()=>({ok:true,messages:[{ts:'1',files:[{id:'F9',name:'WhatsApp_132273_1.mp4',mimetype:'video/quicktime',size:3549804,permalink:'https://tpsplumbing.slack.com/files/U/F9/x.mp4'},{id:'F8',name:'other.mp4',mimetype:'video/mp4',size:42}]}]})};
  return{ok:true,json:async()=>({files:[{id:'vid1aaaaaaaaaa',name:'IMG_0569.MOV',mimeType:'video/mp4',size:'3549804',webViewLink:'https://drive.google.com/file/d/vid1aaaaaaaaaa/view?usp=drivesdk'}]})};
 };
 const {files}=await d.gatherFiles({folderId:FOLDER,incoming:{channel:'C0INCOMING',ts:'1793740000.123456'},jobNumber:'132273'},{...o,fetch});
 assert.deepEqual(files.map(f=>f.id),['vid1aaaaaaaaaa','F8']);
 const v=d.descView({jobNumber:'132273',notes:'',text:'',files,meta:{}},o);
 const plays=v.blocks.filter(b=>b.accessory?.text?.text==='Play').map(b=>b.accessory.url);
 assert.equal(plays[0],'https://drive.google.com/file/d/vid1aaaaaaaaaa/view?usp=drivesdk');
});
