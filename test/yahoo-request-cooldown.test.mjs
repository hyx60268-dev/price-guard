import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestCooldown,retryAfterDeadline } from '../scripts/lib/request-cooldown.mjs';
import { mapLimit } from '../scripts/lib/worker-pool.mjs';

const START=Date.parse('2026-10-16T00:00:00Z');
const MAX_TIMER_MS=2147483647;
const result={items:[],totalResultsAvailable:0};
const html='<script id="__NEXT_DATA__">'+JSON.stringify({props:{initialState:{searchState:{search:{result}}}}})+'</script>'+' '.repeat(10000);
const ok=()=>new Response(html);
const limited=value=>new Response('',{status:429,headers:value===null?{}:{'retry-after':value}});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}};

async function fixture(t,fetchImpl){
  const {fetchYahooResult,yahooRequestStats}=await import('../scripts/lib/yahoo.mjs?cooldown-test='+crypto.randomUUID());
  t.mock.timers.enable({apis:['Date','setTimeout'],now:START});
  t.mock.method(globalThis,'fetch',fetchImpl);
  t.mock.method(console,'warn',()=>{});
  return {stats:yahooRequestStats,read:(name='item',settings={})=>fetchYahooResult('https://fixture.test/'+name,settings),advance:async ms=>{t.mock.timers.tick(ms);await flush()}};
}

test('Retry-After parses numeric and HTTP-date deadlines without the former 120-second ceiling',()=>{
  for(const seconds of ['1','1.5','180','3600','2147484'])assert.equal(retryAfterDeadline(seconds,START),START+Number(seconds)*1000);
  const future=START+300000;
  for(const date of [new Date(future).toUTCString(),'Friday, 16-Oct-26 00:05:00 GMT','Fri Oct 16 00:05:00 2026'])assert.equal(retryAfterDeadline(date,START),future);
  for(const invalid of [null,undefined,'',' ','garbage','-1','0','Infinity','1e4','2026/10/17',new Date(START-1000).toUTCString(),new Date(START).toUTCString()])assert.equal(retryAfterDeadline(invalid,START),null,JSON.stringify(invalid));
  assert.equal(retryAfterDeadline('9'.repeat(400),START),Infinity,'overflowing numeric deadlines fail closed');
});

test('gate rechecks a concurrent extension and never shortens it with an older deadline',async()=>{
  let now=START;const sleeps=[],starts=[];
  const gate=createRequestCooldown({intervalMs:()=>5500,now:()=>now,wait:ms=>{const wake=deferred();sleeps.push({ms,wake});return wake.promise}});
  await gate.turn();starts.push(now);
  const queued=gate.turn().then(()=>starts.push(now));await flush();
  assert.equal(sleeps[0].ms,5500);
  now+=1000;gate.deferUntil(START+181000);gate.deferUntil(START+60000);
  now=START+5500;sleeps[0].wake.resolve();await flush();
  assert.deepEqual(starts,[START]);assert.equal(sleeps[1].ms,175500);
  now=START+181000;sleeps[1].wake.resolve();await queued;
  assert.deepEqual(starts,[START,START+181000]);
});

test('long and overflowing server holds use bounded timer chunks without allowing an early turn',async()=>{
  for(const deadline of [START+MAX_TIMER_MS+5000,Infinity]){
    let now=START;const sleeps=[],wakeups=[];let started=false;
    const gate=createRequestCooldown({now:()=>now,wait:ms=>{sleeps.push(ms);const wake=deferred();wakeups.push(wake);return wake.promise}});
    gate.deferUntil(deadline);const turn=gate.turn().then(()=>{started=true});await flush();
    assert.deepEqual(sleeps,[MAX_TIMER_MS]);
    now+=MAX_TIMER_MS;wakeups[0].resolve();await flush();assert.equal(started,false);
    assert.equal(sleeps[1],deadline===Infinity?MAX_TIMER_MS:5000);
    if(deadline!==Infinity){now+=5000;wakeups[1].resolve();await turn;assert.equal(started,true)}
  }
});

test('an early timer wake and a failed wait cannot release early or poison later gate turns',async()=>{
  let now=START,waits=0;const delays=[];
  const gate=createRequestCooldown({intervalMs:()=>5500,now:()=>now,wait:async ms=>{delays.push(ms);if(++waits===1)throw Error('fixture timer failure');now+=waits===2?ms-500:ms}});
  await gate.turn();
  await assert.rejects(gate.turn(),/fixture timer failure/);
  await gate.turn();assert.equal(now,START+5500);assert.deepEqual(delays,[5500,5500,500]);
});

test('a 429 from an in-flight Yahoo request extends already-sleeping and queued calls',async t=>{
  const first=deferred(),starts=[];
  const {read,advance,stats}=await fixture(t,async url=>{starts.push([url,Date.now()-START]);return starts.length===1?first.promise:ok()});
  const all=Promise.all([read('first'),read('second'),read('third')]);await flush();
  assert.deepEqual(starts.map(x=>x[1]),[0]);
  await advance(1000);first.resolve(limited('180'));await flush();
  await advance(4500);assert.equal(starts.length,1,'old 5.5-second wake must not erase the new 181-second deadline');
  await advance(175499);assert.equal(starts.length,1);
  await advance(1);assert.deepEqual(starts.map(x=>x[1]),[0,181000]);
  await advance(5500);await advance(5500);
  assert.deepEqual(await all,[result,result,result]);
  assert.deepEqual(starts.map(x=>x[1]),[0,181000,186500,192000]);
  assert.deepEqual(stats(),{turns:4,waitMs:192000,cooldownExtensions:1,nextRequestAt:START+197500});
});

for(const [label,header,delay] of [
  ['future HTTP-date',new Date(START+300000).toUTCString(),300000],
  ['numeric over 120 seconds','180',180000],
  ['numeric beyond timer range','2147484',2147484000],
  ['invalid header','nonsense',60000],
  ['past HTTP-date',new Date(START-60000).toUTCString(),60000],
  ['missing header',null,60000],
  ['zero header','0',60000]
])test(`Yahoo retry honors ${label} with the configured fallback and no early request`,async t=>{
  const starts=[];
  const {read,advance}=await fixture(t,async()=>{starts.push(Date.now()-START);return starts.length===1?limited(header):ok()});
  const pending=read();await flush();assert.deepEqual(starts,[0]);
  if(delay>MAX_TIMER_MS){await advance(MAX_TIMER_MS);assert.deepEqual(starts,[0]);await advance(delay-MAX_TIMER_MS-1)}
  else await advance(delay-1);
  assert.deepEqual(starts,[0]);await advance(1);
  assert.deepEqual(await pending,result);assert.deepEqual(starts,[0,delay]);
});

for(const [label,settings,interval] of [['default',{},5500],['minimum',{yahooRequestIntervalMs:1},4000],['slower setting',{yahooRequestIntervalMs:8000},8000]])test(`concurrent Yahoo calls retain the ${label} request spacing`,async t=>{
  const starts=[];
  const {read,advance}=await fixture(t,async()=>{starts.push(Date.now()-START);return ok()});
  const all=Promise.all(Array.from({length:5},(_,i)=>read(String(i),settings)));await flush();
  for(let i=1;i<5;i++){await advance(interval-1);assert.equal(starts.length,i);await advance(1)}
  await all;assert.deepEqual(starts,[0,interval,interval*2,interval*3,interval*4]);
});

test('failed Yahoo requests retain bounded retries and do not poison subsequent callers',async t=>{
  const starts=[];let failing=true;
  const {read,advance}=await fixture(t,async()=>{starts.push(Date.now()-START);if(failing)throw Error('fixture network failure');return ok()});
  const failed=assert.rejects(read(),/Yahoo 请求失败.*fixture network failure/);await flush();
  await advance(1000);assert.equal(starts.length,1);
  await advance(4500);await failed;assert.deepEqual(starts,[0,5500]);
  failing=false;const subsequent=read();await flush();await advance(5499);assert.equal(starts.length,2);
  await advance(1);assert.deepEqual(await subsequent,result);assert.deepEqual(starts,[0,5500,11000]);
});

test('the final 429 still holds later callers and retains the bounded fallback backoff',async t=>{
  const starts=[];
  const {read,advance}=await fixture(t,async()=>{starts.push(Date.now()-START);return starts.length<=2?limited(null):ok()});
  const failed=assert.rejects(read(),/HTTP 429/);await flush();await advance(60000);await failed;
  assert.deepEqual(starts,[0,60000]);
  const later=read();await flush();await advance(119999);assert.equal(starts.length,2);
  await advance(1);assert.deepEqual(await later,result);assert.deepEqual(starts,[0,60000,180000]);
});

test('bounded workers can overlap Yahoo requests without bypassing shared request spacing',async t=>{
  const starts=[];let active=0,peak=0;
  const {read,advance}=await fixture(t,async()=>{
    starts.push(Date.now()-START);active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,12000));active--;return ok();
  });
  const all=mapLimit(Array.from({length:8},(_,i)=>i),2,value=>read(String(value)));await flush();
  for(let elapsed=0;elapsed<60000;elapsed+=500)await advance(500);
  assert.deepEqual(await all,Array(8).fill(result));assert.equal(active,0);assert.equal(peak,2);assert.equal(starts.length,8);
  for(let i=1;i<starts.length;i++)assert.ok(starts[i]-starts[i-1]>=5500);
});


test('aggregate gate statistics are isolated snapshots and include the active observed wait',async()=>{
  let now=START;const wake=deferred();
  const gate=createRequestCooldown({intervalMs:()=>5500,now:()=>now,wait:()=>wake.promise});
  await gate.turn();const next=gate.turn();await flush();now+=1000;
  gate.deferUntil(START+6000);gate.deferUntil(START+5900);
  const snapshot=gate.stats();assert.deepEqual(snapshot,{turns:1,waitMs:1000,cooldownExtensions:1,nextRequestAt:START+6000});
  snapshot.turns=99;assert.equal(gate.stats().turns,1);
  now=START+6000;wake.resolve();await next;
  assert.deepEqual(gate.stats(),{turns:2,waitMs:6000,cooldownExtensions:1,nextRequestAt:START+11500});
});

test('a finite run rejects an inadmissible or indefinite hold without waiting or shortening it',async()=>{
 for(const hold of [START+3600000,Infinity]){
  const gate=createRequestCooldown({now:()=>START,wait:async()=>{throw Error('must not sleep')}});
  gate.deferUntil(hold);
  await assert.rejects(gate.turn({deadline:START+720000}),error=>error.code==='request_deferred'&&error.reason==='request_cooldown_deadline'&&error.retryAt===(hold===Infinity?'indefinite':hold));
  assert.equal(gate.stats().turns,0);assert.equal(gate.stats().nextRequestAt,hold);
 }
});

test('an admitted short hold still waits in full and an expired caller cannot request',async()=>{
 let clock=START;const sleeps=[];
 const gate=createRequestCooldown({now:()=>clock,wait:async ms=>{sleeps.push(ms);clock+=ms}});
 gate.deferUntil(START+60000);await gate.turn({deadline:START+120000});
 assert.deepEqual(sleeps,[60000]);assert.equal(gate.stats().turns,1);
 await assert.rejects(gate.turn({deadline:clock}),error=>error.reason==='request_deadline');
 assert.equal(gate.stats().turns,1);
});

test('a queued finite caller times out behind a longer-lived caller and never later takes a turn',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:START});
 const gate=createRequestCooldown();gate.deferUntil(START+10000);
 const long=gate.turn({deadline:START+120000});
 const short=assert.rejects(gate.turn({deadline:START+20000}),error=>error.code==='request_deferred');await flush();
 gate.deferUntil(START+60000);await flush();
 t.mock.timers.tick(20000);await flush();await short;
 assert.equal(gate.stats().turns,0);
 t.mock.timers.tick(40000);await flush();await long;
 assert.equal(gate.stats().turns,1);assert.equal(gate.stats().nextRequestAt,START+60000);
});

for(const [label,header,retryAt] of [['one hour','3600',START+3600000],['HTTP date',new Date(START+3600000).toUTCString(),START+3600000],['indefinite','9'.repeat(400),Infinity]])test(`Yahoo ${label} hold immediately defers finite-budget work and remains intact`,async t=>{
 let requests=0;const {read,stats}=await fixture(t,async()=>{requests++;return limited(header)});
 await assert.rejects(read('first',{yahooRequestDeadline:START+720000}),error=>error.code==='request_deferred'&&error.reason==='request_cooldown_deadline');
 await assert.rejects(read('second',{yahooRequestDeadline:START+720000}),error=>error.code==='request_deferred');
 assert.equal(requests,1);assert.equal(stats().nextRequestAt,retryAt);assert.equal(Date.now(),START);
});

test('concurrent Yahoo extension wakes admitted finite callers and drains the queue before the run deadline',async t=>{
 const first=deferred();let requests=0;
 const {read,advance,stats}=await fixture(t,async()=>{requests++;return first.promise});
 const settings={yahooRequestDeadline:START+720000};
 const all=Promise.allSettled([read('first',settings),read('second',settings),read('third',settings)]);await flush();
 await advance(1000);first.resolve(limited('3600'));await flush();
 const outcomes=await all;
 assert.equal(outcomes.length,3);assert.ok(outcomes.every(row=>row.status==='rejected'&&row.reason.code==='request_deferred'));
 assert.equal(requests,1);assert.equal(Date.now(),START+1000);assert.equal(stats().nextRequestAt,START+3601000);
});

test('Yahoo retries remain possible when the full hold fits inside the run budget',async t=>{
 let requests=0;const {read,advance}=await fixture(t,async()=>++requests===1?limited('60'):ok());
 const pending=read('within-budget',{yahooRequestDeadline:START+720000});await flush();
 await advance(59999);assert.equal(requests,1);await advance(1);
 assert.deepEqual(await pending,result);assert.equal(requests,2);
});

test('a response that runs out of budget never advances evidence and never retries',async t=>{
 let requests=0;
 const {read,advance}=await fixture(t,async(_url,{signal})=>{requests++;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))});
 const pending=assert.rejects(read('timeout',{yahooRequestDeadline:START+500}),error=>error.reason==='request_deadline');await flush();
 await advance(500);await pending;assert.equal(requests,1);
});

test('a request queued before checkpoint failure rechecks the failure latch before fetching',async t=>{
 const fs=(await import('node:fs/promises')).default,os=await import('node:os'),path=await import('node:path');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'yahoo-checkpoint-failure-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const yahoo=await import('../scripts/lib/yahoo.mjs?cooldown-test='+crypto.randomUUID());
 await yahoo.initializeYahooRequestAccess({root,password:'fixture-only-password'});
 t.mock.method(fs,'rename',async()=>{throw Error('fixture checkpoint failure')});
 t.mock.timers.enable({apis:['Date','setTimeout'],now:START});
 let requests=0;t.mock.method(globalThis,'fetch',async()=>{requests++;return limited('60')});
 const settings={yahooRequestDeadline:START+720000};
 const first=yahoo.fetchYahooResult('https://fixture.invalid/one',settings);
 const second=yahoo.fetchYahooResult('https://fixture.invalid/two',settings);
 const outcomes=Promise.allSettled([first,second]);
 // Complete real filesystem checkpoint work before advancing mocked time.
 await assert.rejects(first,error=>error.reason==='yahoo_cooldown_state_unavailable');
 t.mock.timers.tick(60000);await flush();
 const settled=await outcomes;assert.equal(requests,1);
 assert.ok(settled.every(row=>row.status==='rejected'&&row.reason.reason==='yahoo_cooldown_state_unavailable'));
});

test('a 429 extension between admission and fetch invalidates the ticket before network start',async t=>{
 const first=deferred();let requests=0;
 const {read,stats}=await fixture(t,async()=>{requests++;return requests===1?first.promise:ok()});
 const settings={yahooRequestDeadline:START+30000};
 const all=Promise.allSettled([read('first',settings),read('second',settings)]);await flush();
 // Wake admission but keep its Promise/finally microtasks pending. A response
 // becomes ready in that same turn, before the admitted caller starts fetch.
 t.mock.timers.tick(5500);first.resolve(limited('60'));await flush();
 const outcomes=await all;
 assert.equal(requests,1);assert.equal(stats().nextRequestAt,START+65500);
 assert.ok(outcomes.every(row=>row.status==='rejected'&&row.reason.reason==='request_cooldown_deadline'));
});

test('an expired deadline after admission but before fetch cannot issue a request',async t=>{
 let requests=0;const {read}=await fixture(t,async()=>{requests++;return ok()});
 const pending=assert.rejects(read('deadline',{yahooRequestDeadline:START+10}),error=>error.reason==='request_deadline');
 // Admission runs before this continuation, but its public promise is still
 // pending through the race/finally chain. Advance only the wall clock here.
 await Promise.resolve();t.mock.timers.setTime(START+10);await flush();
 await pending;assert.equal(requests,0);
});

test('a short post-admission server hold also invalidates a ticket inside its already-reserved spacing slot',async t=>{
 const first=deferred();let requests=0;
 const {read,advance}=await fixture(t,async()=>{requests++;return requests===1?first.promise:ok()});
 const settings={yahooRequestDeadline:START+30000};
 const all=Promise.all([read('first',settings),read('second',settings)]);await flush();
 t.mock.timers.tick(5500);first.resolve(limited('1'));await flush();assert.equal(requests,1);
 await advance(5500);assert.equal(requests,2);await advance(5500);await all;assert.equal(requests,3);
});

test('deferral aborts the transport for an unread 429 body instead of leaving it active',async t=>{
 let signal,active=false;
 const {read}=await fixture(t,async(_url,options)=>{signal=options.signal;active=true;signal.addEventListener('abort',()=>{active=false},{once:true});return limited('3600')});
 await assert.rejects(read('unread-body',{yahooRequestDeadline:START+720000}),error=>error.reason==='request_cooldown_deadline');
 assert.equal(signal.aborted,true);assert.equal(active,false);
});
