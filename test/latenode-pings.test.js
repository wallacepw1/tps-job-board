const test=require('node:test'),assert=require('node:assert/strict');
const {targetsFor,createPinger}=require('../src/latenode-pings');
const card=(channel,extra={})=>({type:'message',channel,ts:'1794957658.489879',bot_id:'B0C4ZGXJGLV',subtype:'bot_message',...extra});
test('new cards map to the scenarios that used to poll for them',()=>{
 assert.deepEqual(targetsFor(card('C0C19TG3KJ6')),['meldFollow','jobsScan']);
 assert.deepEqual(targetsFor(card('C0C2XUL7ZHN')),['meldFollow']);
 assert.deepEqual(targetsFor(card('C0C2XB4VD1N')),['meldFollow']);
 assert.deepEqual(targetsFor(card('C0C2YDBHFFY')),['jobsScan','meldComplete']);
 assert.deepEqual(targetsFor(card('C0C5VVDCQ92')),[]);
});
test('thread replies, edits and deletions never ping',()=>{
 assert.deepEqual(targetsFor(card('C0C19TG3KJ6',{thread_ts:'1793827003.181319'})),[]);
 assert.deepEqual(targetsFor(card('C0C19TG3KJ6',{subtype:'message_changed'})),[]);
 assert.deepEqual(targetsFor(card('C0C2YDBHFFY',{subtype:'message_deleted'})),[]);
 assert.deepEqual(targetsFor(card('C0C19TG3KJ6',{thread_ts:'1794957658.489879'})),['meldFollow','jobsScan']);
});
test('a burst of cards sends one ping per scenario with the internal key',async()=>{
 const sent=[],timers=[];
 const ping=createPinger({key:'k',fetch:async(url,o)=>{sent.push({url,body:JSON.parse(o.body)});return{ok:true};},setTimer:fn=>{timers.push(fn);return{};}});
 ping(card('C0C19TG3KJ6'));ping(card('C0C19TG3KJ6',{ts:'1794957659.000001'}));ping(card('C0C2YDBHFFY'));
 assert.equal(timers.length,3);
 for(const fn of timers)await fn();
 await new Promise(r=>setImmediate(r));
 assert.deepEqual(sent.map(s=>s.url.split('/').pop()).sort(),['meld-actions','tps-jobs-scan','tps-meld-complete']);
 assert.ok(sent.every(s=>s.body.key==='k'&&s.body.source==='jobboard'));
 assert.equal(sent.find(s=>s.url.endsWith('meld-actions')).body.action,'follow');
});
test('no key, no ping',async()=>{
 let calls=0,fn;
 const ping=createPinger({key:'',fetch:async()=>{calls++;return{ok:true};},setTimer:f=>{fn=f;return{};}});
 ping(card('C0C2YDBHFFY'));await fn();assert.equal(calls,0);
});
