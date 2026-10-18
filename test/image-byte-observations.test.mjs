import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createImageByteObservationPool } from '../scripts/lib/image-byte-observations.mjs';
import { createFingerprintLoader } from '../scripts/lib/image-fingerprint-cache.mjs';
import { configureImageFingerprintCache,imageFingerprints,withImageByteObservations } from '../scripts/lib/image.mjs';

const url='https://fixture.test/image?size=1200';
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
const observation=(body='original',overrides={})=>{
 const buffer=Buffer.from(body);
 return {buffer,url,contentSha256:hash(buffer),imageObservedAt:new Date(1000).toISOString(),...overrides};
};
const svg='<svg xmlns="http://www.w3.org/2000/svg" width="12" height="10"><rect width="10" height="10" fill="red"/></svg>';
const response=(headers={})=>new Response(svg,{headers});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(run){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'image-byte-observations-'));
 try{await run(directory)}finally{await fs.rm(directory,{recursive:true,force:true})}
}
async function withFetch(fetcher,run,settings={}){
 const original=globalThis.fetch;globalThis.fetch=fetcher;configureImageFingerprintCache(settings);
 try{await run()}finally{globalThis.fetch=original;configureImageFingerprintCache()}
}

test('byte observations bind exact URL/query, actual hash and original observation time',()=>{
 const pool=createImageByteObservationPool(),first=observation();
 assert.equal(pool.observe(first),true);
 assert.deepEqual(pool.get(first),first);
 for(const changed of [{url:url+'&extra=1'},{url:url.replace('1200','298')},
  {contentSha256:'a'.repeat(64)},{imageObservedAt:new Date(1001).toISOString()},
  {imageObservedAt:1000},{imageObservedAt:'1970-01-01T00:00:01Z'},
  {imageObservedAt:undefined},{contentSha256:undefined},{url:undefined}])assert.equal(pool.get({...first,...changed}),null);
 const changed=observation('changed',{imageObservedAt:new Date(2000).toISOString()});
 assert.equal(pool.observe(changed),true);assert.deepEqual(pool.get(changed),changed);
 assert.deepEqual(pool.get(first),first);
 assert.equal(pool.get({...first,contentSha256:changed.contentSha256}),null);
 assert.equal(pool.get({...changed,contentSha256:first.contentSha256}),null);
});

test('the pool owns retained bytes and each read is a defensive copy',()=>{
 const pool=createImageByteObservationPool(),value=observation(),expected=Buffer.from(value.buffer);
 pool.observe(value);value.buffer.fill(0);
 const one=pool.get(value);assert.deepEqual(one.buffer,expected);assert.ok(Object.isFrozen(one));
 one.buffer.fill(1);assert.deepEqual(pool.get(value).buffer,expected);
 assert.doesNotMatch(JSON.stringify(pool),/original|Buffer|fixture/);
 pool.clear();assert.equal(pool.get(value),null);assert.equal(pool.stats.images,0);assert.equal(pool.stats.bytes,0);
});

test('invalid or mismatched observations cannot be retained',()=>{
 const pool=createImageByteObservationPool();
 for(const value of [null,{},observation('',{}),observation('body',{buffer:'body'}),
  observation('body',{contentSha256:'a'.repeat(64)}),observation('body',{contentSha256:'invalid'}),
  observation('body',{imageObservedAt:'invalid'}),observation('body',{imageObservedAt:new Date(-1).toISOString()}),
  observation('body',{url:'x'.repeat(8193)})])assert.equal(pool.observe(value),false);
 assert.equal(pool.stats.images,0);assert.equal(pool.stats.bytes,0);
});

test('entry, aggregate byte and per-image bounds cannot be raised by options',()=>{
 const entries=createImageByteObservationPool({maxImages:1000}),first=observation('0');
 for(let index=0;index<33;index++)entries.observe(observation(String(index),{url:url+'&n='+index}));
 assert.equal(entries.stats.images,32);assert.equal(entries.stats.evicted,1);
 assert.equal(entries.get({...first,url:url+'&n=0'}),null);
 const small=createImageByteObservationPool({maxImages:2,maxBytes:7,maxImageBytes:5});
 const a=observation('one'),b=observation('two'),c=observation('three');
 assert.equal(small.observe(a),true);assert.equal(small.observe(a),true);assert.equal(small.stats.accepted,1);
 assert.equal(small.observe(b),true);assert.equal(small.stats.bytes,6);
 assert.equal(small.observe(c),true);assert.equal(small.stats.images,1);assert.equal(small.stats.bytes,5);
 assert.equal(small.get(a),null);assert.equal(small.get(b),null);assert.deepEqual(small.get(c),c);
 assert.equal(small.observe(observation('sixsix')),false);assert.equal(small.stats.images,1);
 const oversized=observation(Buffer.alloc(12_000_001)),defaultLimits=createImageByteObservationPool({maxImageBytes:100_000_000});
 assert.equal(defaultLimits.observe(oversized),false);assert.equal(defaultLimits.stats.images,0);
 for(const options of [{maxImages:0},{maxBytes:0},{maxImageBytes:0}])assert.equal(createImageByteObservationPool(options).observe(a),false);
});

test('the default 64 MiB aggregate limit remains a hard bound even when enlarged in options',()=>{
 const pool=createImageByteObservationPool({maxBytes:Number.MAX_SAFE_INTEGER}),buffer=Buffer.alloc(8*1024*1024),
  value={buffer,url,contentSha256:hash(buffer),imageObservedAt:new Date(1000).toISOString()};
 for(let index=0;index<9;index++)assert.equal(pool.observe({...value,url:url+'&n='+index}),true);
 assert.equal(pool.stats.bytes,64*1024*1024);assert.equal(pool.stats.images,8);assert.equal(pool.stats.evicted,1);
 assert.equal(pool.get({...value,url:url+'&n=0'}),null);pool.clear();assert.equal(pool.stats.bytes,0);
});

test('successful loader observes original bytes after both computation and content-hash reuse',()=>fixture(async directory=>{
 let time=1000,fetches=0,computations=0;const pool=createImageByteObservationPool(),events=[];
 const loader=createFingerprintLoader({directory,now:()=>time,
  fetchImage:async()=>{fetches++;return {buffer:Buffer.from('original bytes'),cacheControl:'public, max-age=0'}},
  fingerprint:async()=>{computations++;return {dHash:'fingerprint',contentSha256:'wrong-callback-sha'}},
  observeImageBytes:event=>{events.push(event);pool.observe(event)}});
 const first=await loader.get(url);time=2000;
 const second=await loader.get(url+'&query=other');
 assert.equal(fetches,2);assert.equal(computations,1);assert.equal(loader.stats.contentReuses,1);assert.equal(events.length,2);
 assert.equal(first.contentSha256,hash(Buffer.from('original bytes')));assert.equal(second.contentSha256,first.contentSha256);
 for(const [index,value] of [first,second].entries()){
  assert.ok(Object.isFrozen(events[index]));assert.deepEqual(Object.keys(events[index]).sort(),['buffer','contentSha256','imageObservedAt','url']);
  assert.equal(pool.get(value).buffer.toString(),'original bytes');assert.equal(pool.get(value).imageObservedAt,value.imageObservedAt);
  assert.equal(value.imageCacheSource,'current_body');assert.doesNotMatch(JSON.stringify(value),/original bytes|Buffer|"buffer"/);
 }
 assert.notEqual(first.imageObservedAt,second.imageObservedAt);
 assert.equal(pool.get({...first,imageObservedAt:second.imageObservedAt}),null);
 for(const file of await fs.readdir(directory))assert.doesNotMatch(await fs.readFile(path.join(directory,file),'utf8'),/original bytes|Buffer|"buffer"/);
}));

test('HTTP-fresh fingerprint reuse has no bytes, performs no extra fetch and never renews time',()=>fixture(async directory=>{
 let time=1000,fetches=0;const pool=createImageByteObservationPool();
 const options={directory,now:()=>time,fetchImage:async()=>{fetches++;return {buffer:Buffer.from('original bytes'),cacheControl:'public, max-age=3600'}},fingerprint:async()=>({dHash:'real'})};
 const first=await createFingerprintLoader(options).get(url);time=2000;
 const loader=createFingerprintLoader({...options,observeImageBytes:pool.observe}),second=await loader.get(url);
 assert.equal(fetches,1);assert.equal(loader.stats.httpFreshReuses,1);assert.equal(second.imageObservedAt,first.imageObservedAt);
 assert.equal(second.imageCacheSource,'http_fresh');assert.equal(pool.get(second),null);assert.equal(pool.stats.images,0);
}));

test('no-store bytes are available only in the local pool and never persisted',()=>fixture(async directory=>{
 const pool=createImageByteObservationPool();let fetches=0,computations=0;
 const loader=createFingerprintLoader({directory,fetchImage:async()=>{fetches++;return {buffer:Buffer.from('private original'),cacheControl:'public, no-store, max-age=600'}},
  fingerprint:async()=>{computations++;return {dHash:'real'}},observeImageBytes:pool.observe});
 const value=await loader.get(url);assert.equal(pool.get(value).buffer.toString(),'private original');
 assert.deepEqual(await fs.readdir(directory),[]);await loader.get(url);assert.equal(fetches,2);assert.equal(computations,2);
 pool.clear();assert.equal(pool.get(value),null);
}));

test('byte observer throws and rejecting thenables cannot fail a fingerprint or initiate a retry',async()=>{
 for(const observeImageBytes of [()=>{throw Error('observer failed')},async()=>{throw Error('async observer failed')},
  ()=>({then:(_resolve,reject)=>reject(Error('thenable failed'))}),()=>({get then(){throw Error('getter failed')}})]){
  let fetches=0;const loader=createFingerprintLoader({fetchImage:async()=>{fetches++;return {buffer:Buffer.from('body')}},fingerprint:async()=>({dHash:'real'}),observeImageBytes});
  const value=await loader.get(url);assert.equal(value.dHash,'real');assert.equal(value.contentSha256,hash(Buffer.from('body')));assert.equal(fetches,1);
 }
 await flush();
});

test('failed/partial/deadline bodies never produce a byte observation',async()=>{
 const events=[];
 for(const [fetchImage,fingerprint,options] of [
  [async()=>null,async()=>({dHash:'unused'}),undefined],
  [async()=>({buffer:Buffer.from('partial')}),async()=>null,undefined],
  [async()=>({buffer:Buffer.from('body')}),async()=>({dHash:'unused'}),{deadlineAt:1000}],
 ]){
  const loader=createFingerprintLoader({now:()=>1000,fetchImage,fingerprint,observeImageBytes:event=>events.push(event)});
  assert.equal(await loader.get(url,options),null);
 }
 const entered=deferred(),late=deferred(),controller=new AbortController();
 const loader=createFingerprintLoader({fetchImage:async()=>({buffer:Buffer.from('body')}),fingerprint:async()=>{entered.resolve();return late.promise},observeImageBytes:event=>events.push(event)});
 const pending=loader.get(url,{signal:controller.signal});await entered.promise;controller.abort();assert.equal(await pending,null);
 late.resolve({dHash:'late'});await flush();assert.deepEqual(events,[]);
});

test('canceled and late non-cooperative downloads cannot emit retained bytes',async()=>{
 const entered=deferred(),late=deferred(),controller=new AbortController(),pool=createImageByteObservationPool();let computations=0;
 const loader=createFingerprintLoader({fetchImage:async()=>{entered.resolve();return late.promise},
  fingerprint:async()=>{computations++;return {dHash:'real'}},observeImageBytes:pool.observe});
 const pending=loader.get(url,{signal:controller.signal});await entered.promise;controller.abort();assert.equal(await pending,null);
 late.resolve({buffer:Buffer.from('late body')});await flush();assert.equal(pool.stats.images,0);assert.equal(computations,0);
});

test('scope captures normal map calls, deduplicates existing downloads and clears on success',async()=>{
 let fetches=0;const pool=createImageByteObservationPool();
 await withFetch(async()=>{fetches++;return response({'cache-control':'public, max-age=60'})},async()=>{
  await withImageByteObservations(pool,async()=>{
   const values=await Promise.all([url,url].map(imageFingerprints));
   assert.equal(fetches,1);assert.equal(pool.stats.images,1);
   for(const value of values)assert.equal(pool.get(value).buffer.toString(),svg);
   assert.equal(pool.get(values[0]).imageObservedAt,new Date(1000).toISOString());
  });
  assert.equal(pool.stats.images,0);assert.equal(pool.stats.bytes,0);
  const other=createImageByteObservationPool();
  await withImageByteObservations(other,async()=>{const value=await imageFingerprints(url);assert.ok(value);assert.equal(other.get(value),null)});
  assert.equal(fetches,1);
 },{now:()=>1000});
});

test('concurrent Promise capture scopes isolate different downloads',async()=>{
 const pools=[createImageByteObservationPool(),createImageByteObservationPool()],entered=[deferred(),deferred()],late=[deferred(),deferred()];
 let fetches=0;
 await withFetch(async input=>{const index=input.endsWith('other')?1:0;fetches++;entered[index].resolve();return late[index].promise},async()=>{
  const results=[];
  const pending=pools.map((pool,index)=>withImageByteObservations(pool,async()=>{
   const value=await imageFingerprints(index?url+'&other':url);results[index]=value;
   assert.equal(pool.stats.images,1);assert.equal(pool.get(value).buffer.toString(),svg);
   assert.equal(pool.get({...value,url:index?url:url+'&other'}),null);
  }));
  await Promise.all(entered.map(value=>value.promise));late[1].resolve(response());late[0].resolve(response());
  await Promise.all(pending);assert.equal(fetches,2);assert.ok(results.every(Boolean));
  assert.ok(pools.every(pool=>pool.stats.images===0));
 });
});

test('shared pending wrapper work stays with its original scope without refetching for another pool',async()=>{
 const a=createImageByteObservationPool(),b=createImageByteObservationPool(),entered=deferred(),late=deferred();let fetches=0;
 await withFetch(async()=>{fetches++;entered.resolve();return late.promise},async()=>{
  const first=withImageByteObservations(a,async()=>{const value=await imageFingerprints(url);assert.equal(a.get(value).buffer.toString(),svg);return value});
  await entered.promise;
  const second=withImageByteObservations(b,async()=>{const value=await imageFingerprints(url);assert.equal(b.get(value),null);return value});
  late.resolve(response());const values=await Promise.all([first,second]);assert.deepEqual(values[0],values[1]);assert.equal(fetches,1);
  assert.equal(a.stats.images,0);assert.equal(b.stats.images,0);
 });
});

test('nested scopes restore their parent and failed scopes release retained bytes',async()=>{
 const outer=createImageByteObservationPool(),inner=createImageByteObservationPool();
 await withFetch(async()=>response(),async()=>{
  await assert.rejects(withImageByteObservations(outer,async()=>{
   const first=await imageFingerprints(url);assert.ok(outer.get(first));
   await withImageByteObservations(inner,async()=>{
    const second=await imageFingerprints(url+'&inner');assert.ok(inner.get(second));assert.equal(outer.get(second),null);
   });
   const third=await imageFingerprints(url+'&outer');assert.ok(outer.get(third));assert.equal(inner.get(third),null);
   throw Error('comparison failed');
  }),/comparison failed/);
  assert.equal(outer.stats.images,0);assert.equal(inner.stats.images,0);
 });
});

test('late unawaited work cannot populate a finished capture scope',async()=>{
 const pool=createImageByteObservationPool(),entered=deferred(),late=deferred();let pending;
 await withFetch(async()=>{entered.resolve();return late.promise},async()=>{
  await withImageByteObservations(pool,async()=>{pending=imageFingerprints(url);await entered.promise});
  late.resolve(response());assert.ok(await pending);assert.equal(pool.stats.images,0);
 });
});

test('scope observer failure cannot break normal collection or trigger download retry',async()=>{
 for(const observe of [()=>{throw Error('capture failed')},async()=>{throw Error('async capture failed')}]){
  let fetches=0;
  await withFetch(async()=>{fetches++;return response()},async()=>{
   const value=await withImageByteObservations({observe,clear:()=>{}},()=>imageFingerprints(url));
   assert.ok(value?.contentSha256);assert.equal(fetches,1);
  });
 }
 await flush();
});

test('invalid or incomplete downloaded images never enter a capture pool',async()=>{
 for(const fetcher of [async()=>new Response('invalid image bytes'),async()=>response({'content-length':'99999'}),
  async()=>({ok:true,status:200,headers:new Headers(),arrayBuffer:async()=>{throw Error('partial')}})]){
  const pool=createImageByteObservationPool();
  await withFetch(fetcher,async()=>{
   await withImageByteObservations(pool,async()=>{assert.equal(await imageFingerprints(url),null);assert.equal(pool.stats.images,0)});
  });
 }
});

test('network counters distinguish completed decoded bytes from partial unknown bodies and cache calls',async()=>{
 const {imageTransferStats}=await import('../scripts/lib/image.mjs');
 const pool=createImageByteObservationPool();
 await withFetch(async()=>response({'cache-control':'public,max-age=3600'}),async()=>{
  await withImageByteObservations(pool,async()=>{await imageFingerprints(url);await imageFingerprints(url)});
  assert.equal(pool.transferStats.fetches,1);assert.equal(pool.transferStats.completedDecodedBytes,Buffer.byteLength(svg));assert.equal(pool.transferStats.unknownBodyTransfers,0);
  assert.equal(imageTransferStats().fetches,1);assert.ok(imageTransferStats().durationMs>=0);
 });
 const failed=createImageByteObservationPool();
 await withFetch(async()=>({status:200,ok:true,headers:new Headers(),arrayBuffer:async()=>{throw Error('partial private body')}}),async()=>{
  await withImageByteObservations(failed,()=>imageFingerprints(url));
  assert.equal(failed.transferStats.fetches,2,'existing normal retry count, not a geometric refill');
  assert.equal(failed.transferStats.completedDecodedBytes,0);assert.equal(failed.transferStats.unknownBodyTransfers,2);assert.equal(failed.stats.images,0);
  assert.doesNotMatch(JSON.stringify(failed.transferStats),/private|body/);
 });
});

test('cancelled comparison retains initiated fetch count while late settlement stays outside closed scope',async()=>{
 const {imageTransferStats}=await import('../scripts/lib/image.mjs');
 const pool=createImageByteObservationPool(),entered=deferred(),late=deferred(),controller=new AbortController();
 await withFetch(async()=>{entered.resolve();return late.promise},async()=>{
  const pending=withImageByteObservations(pool,()=>imageFingerprints(url,{signal:controller.signal}));
  await entered.promise;assert.equal(imageTransferStats().fetches,1);assert.equal(pool.transferStats.fetches,1);
  controller.abort();assert.equal(await pending,null);
  assert.equal(pool.transferStats.settledFetches,0);assert.equal(imageTransferStats().settledFetches,0);
  late.resolve(response());await flush();await flush();
  assert.equal(imageTransferStats().fetches,1);assert.equal(imageTransferStats().settledFetches,1);
  assert.equal(pool.transferStats.fetches,1);assert.equal(pool.transferStats.settledFetches,0);
  assert.equal(pool.stats.images,0);
 });
});
