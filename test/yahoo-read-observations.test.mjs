import test from 'node:test';
import assert from 'node:assert/strict';
import {createYahooReadObservations} from '../scripts/lib/yahoo-read-observations.mjs';
import {RequestDeferredError} from '../scripts/lib/request-cooldown.mjs';

test('transport counts classify actual starts and never retain identifying URL contents',()=>{
 let now=100;const observations=createYahooReadObservations({now:()=>now});
 const profile=observations.begin('https://paypayfleamarket.yahoo.co.jp/user/private-seller?page=2','candidate');
 profile.response(200);now=120;profile.finish({complete:true,bytes:500});profile.finish();
 const own=observations.begin('https://paypayfleamarket.yahoo.co.jp/item/private-item','own');
 own.response(429);now=130;own.finish();
 const snapshot=observations.snapshot();
 assert.equal(snapshot.transportRequests,2);assert.equal(snapshot.unfinished,0);
 assert.deepEqual(snapshot.byPurpose.profile,{requests:1,responses:1,completed:1,failed:0,decodedBodyBytes:500,durationMs:20});
 assert.equal(snapshot.byPurpose.own.failed,1);assert.deepEqual(snapshot.httpStatuses,{'200':1,'429':1});
 assert.equal(JSON.stringify(snapshot).includes('private-'),false);
 snapshot.byPurpose.own.requests=99;assert.equal(observations.snapshot().byPurpose.own.requests,1);
});

test('audit reservation failure before transport is fail-closed and never retried or counted as a source fetch',async()=>{
 const yahoo=await import('../scripts/lib/yahoo.mjs?audit-admission='+crypto.randomUUID());let fetched=0,reserved=0;
 await assert.rejects(yahoo.fetchYahooPage('https://paypayfleamarket.yahoo.co.jp/item/target',{
  beforeYahooTransport(){reserved++;throw Error('receipt storage unavailable')}
 },{fetchImpl:async()=>{fetched++;throw Error('must not fetch')}}),error=>error.code==='request_deferred'&&error.reason==='comparison_audit_not_admitted');
 assert.equal(fetched,0);assert.equal(reserved,1);assert.equal(yahoo.yahooTransportStats().transportRequests,0);
});

test('transport observation counts a denied response and preserves original source hold metadata',async()=>{
 const yahoo=await import('../scripts/lib/yahoo.mjs?audit-denial='+crypto.randomUUID());let fetched=0;const completions=[];
 await assert.rejects(yahoo.fetchYahooPage('https://paypayfleamarket.yahoo.co.jp/item/target',{attempts:1,yahooRequestPurpose:'known',
  beforeYahooTransport:()=>({id:'reservation'}),afterYahooTransport:value=>completions.push(value)},
  {fetchImpl:async()=>{fetched++;return new Response('blocked',{status:403,headers:{'retry-after':'120'}})}}),error=>error.httpStatus===403&&error.retryAfter==='120');
 const stats=yahoo.yahooTransportStats();assert.equal(fetched,1);assert.equal(stats.byPurpose.known.requests,1);
 assert.equal(stats.byPurpose.known.failed,1);assert.deepEqual(stats.httpStatuses,{'403':1});
 assert.deepEqual(completions,[{reservation:{id:'reservation'},httpStatus:403,retryAfter:'120',completed:false,transportStarted:true,decodedBodyBytes:0,observedAt:null}]);
});

test('preexisting RequestDeferred error is not replaced or counted as transport',async()=>{
 const yahoo=await import('../scripts/lib/yahoo.mjs?audit-deferred='+crypto.randomUUID());
 const error=new RequestDeferredError('audit_expired',Infinity);let fetched=0;
 await assert.rejects(yahoo.fetchYahooPage('https://paypayfleamarket.yahoo.co.jp/item/target',{beforeYahooTransport(){throw error}},
  {fetchImpl:async()=>{fetched++}}),value=>value===error);
 assert.equal(fetched,0);assert.equal(yahoo.yahooTransportStats().transportRequests,0);
});

test('already scheduled item response supplies original receipt without an additional request',async t=>{
 const yahoo=await import('../scripts/lib/yahoo.mjs?audit-receipt='+crypto.randomUUID());
 const url='https://paypayfleamarket.yahoo.co.jp/item/target';let fetched=0;
 const candidate={itemId:'candidate',title:'fixture candidate',price:28000,seller:{id:'external'},image:{url:'https://example.invalid/image'}};
 const state={itemsState:{items:{item:{id:'target',title:'fixture'}}},
  recommendsState:{recommends:{recommends:{similar:{recommendItems:{items:[candidate]}}}}}};
 const next={props:{initialState:state}};
 const html='<script id="__NEXT_DATA__">'+JSON.stringify(next)+'</script>'+' '.repeat(10000);
 t.mock.method(globalThis,'fetch',async()=>{fetched++;const response=new Response(html);Object.defineProperty(response,'url',{value:url});return response});
 const bundle=await yahoo.fetchYahooItemBundle('target',{yahooComparisonAudit:true,yahooRequestPurpose:'own'});
 assert.equal(fetched,1);assert.equal(bundle.recommendationReceipt.cards.length,1);
 assert.equal(bundle.recommendationReceipt.observedAt,new Date(bundle.observedAt).toISOString());
 assert.equal(bundle.recommendationReceipt.cards[0].itemStatus,null);
 assert.equal(yahoo.yahooTransportStats().byPurpose.own.completed,1);
});


test('reservation crossing deadline never starts a transport and reports the unused reservation',async t=>{
 const yahoo=await import('../scripts/lib/yahoo.mjs?audit-slow='+crypto.randomUUID());let now=Date.now(),fetched=0;const completions=[];
 t.mock.method(Date,'now',()=>now);
 await assert.rejects(yahoo.fetchYahooPage('https://paypayfleamarket.yahoo.co.jp/item/target',{deadlineAt:now+10,
  beforeYahooTransport(){now+=20;return {id:'reserved'}},afterYahooTransport:row=>completions.push(row)},
  {fetchImpl:async()=>{fetched++;return new Response('x'.repeat(10000))}}),error=>error.reason==='request_deadline');
 assert.equal(fetched,0);assert.equal(yahoo.yahooTransportStats().transportRequests,0);
 assert.equal(completions.length,1);assert.equal(completions[0].transportStarted,false);
 assert.equal(completions[0].completed,false);
});

test('rejected asynchronous audit callbacks fail closed without unhandled rejections',async t=>{
 const unhandled=[];const handler=error=>unhandled.push(error);process.on('unhandledRejection',handler);t.after(()=>process.off('unhandledRejection',handler));
 for(const stage of ['before','after']){
  const yahoo=await import('../scripts/lib/yahoo.mjs?audit-async='+crypto.randomUUID());let fetched=0;
  const options=stage==='before'?{beforeYahooTransport:async()=>{throw Error('async reservation rejected')}}:{afterYahooTransport:async()=>{throw Error('async completion rejected')}};
  await assert.rejects(yahoo.fetchYahooPage('https://paypayfleamarket.yahoo.co.jp/item/target',options,
   {fetchImpl:async()=>{fetched++;return new Response('x'.repeat(10000))}}),error=>error.reason===`comparison_audit_${stage==='before'?'not_admitted':'record_failed'}`);
  assert.equal(fetched,stage==='before'?0:1);
 }
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(unhandled,[]);
});


test('late response headers remain observable without renewing completed evidence',()=>{
 let now=0;const observations=createYahooReadObservations({now:()=>now});
 const read=observations.begin('https://paypayfleamarket.yahoo.co.jp/item/z1','candidate');now=20;read.finish();
 now=40;read.response(429);read.response(200);read.finish({complete:true,bytes:999});
 const snapshot=observations.snapshot();assert.equal(snapshot.lateResponses,1);
 assert.deepEqual(snapshot.httpStatuses,{'429':1});assert.equal(snapshot.byPurpose.candidate.responses,1);
 assert.equal(snapshot.byPurpose.candidate.failed,1);assert.equal(snapshot.byPurpose.candidate.completed,0);
 assert.equal(snapshot.byPurpose.candidate.durationMs,20);assert.equal(snapshot.byPurpose.candidate.decodedBodyBytes,0);
});


test('real Yahoo result wrapper preserves body observation through delayed consumer and profile-name parsing',async t=>{
 const {createOwnSourceLoader}=await import('../scripts/lib/own-source.mjs');
 for(const suffix of ['search/test','user/seller?page=1']){
  const yahoo=await import('../scripts/lib/yahoo.mjs?search-time='+crypto.randomUUID());let now=Date.now();const original=now;
  t.mock.method(Date,'now',()=>now);
  const html='<title>Fixture</title><script id="__NEXT_DATA__">'+JSON.stringify({props:{initialState:{searchState:{search:{result:{items:[]}}}}}})+'</script>'+' '.repeat(10000);
  const url='https://paypayfleamarket.yahoo.co.jp/'+suffix;
  t.mock.method(globalThis,'fetch',async()=>{const response=new Response(html);Object.defineProperty(response,'url',{value:url});return response});
  const loader=createOwnSourceLoader({now:()=>now,fetchYahooResult:value=>yahoo.fetchYahooResult(value,{afterYahooTransport(){now+=300000}})});
  const result=await loader.yahooResult(url);assert.equal(result.observedAt,new Date(original).toISOString());
  assert.equal(result.fromCache,false);assert.equal(result.url,url);
  if(suffix.startsWith('user/'))assert.ok(Object.hasOwn(result,'profileName'));
  t.mock.restoreAll();
 }
});
