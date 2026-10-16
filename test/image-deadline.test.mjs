import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFingerprintLoader } from '../scripts/lib/image-fingerprint-cache.mjs';
import { configureImageFingerprintCache,imageFingerprints } from '../scripts/lib/image.mjs';

const url='https://fixture.test/deadline-image';
const svg='<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';
const response=()=>new Response(svg,{headers:{'cache-control':'public, max-age=60'}});
const downloaded=()=>({buffer:Buffer.from(svg),cacheControl:'public, max-age=60'});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(run){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'image-deadline-test-'));
 try{await run(directory)}finally{await fs.rm(directory,{recursive:true,force:true})}
}
async function withFetch(fetcher,run,options={}){
 const original=globalThis.fetch;globalThis.fetch=fetcher;configureImageFingerprintCache(options);
 try{await run()}finally{globalThis.fetch=original;configureImageFingerprintCache()}
}

test('loader rejects pre-aborted and expired requests before fetching or computing',()=>fixture(async directory=>{
 let reads=0,computes=0;
 const loader=createFingerprintLoader({directory,now:()=>10,fetchImage:async()=>{reads++;return downloaded()},fingerprint:async()=>{computes++;return {dHash:'verified'}}});
 const controller=new AbortController();controller.abort();
 assert.equal(await loader.get(url,{signal:controller.signal}),null);
 assert.equal(await loader.get(url,{deadlineAt:10}),null);
 assert.equal(reads,0);assert.equal(computes,0);assert.deepEqual(await fs.readdir(directory),[]);
}));

test('loader propagates cancellation and ignores a late non-cooperative download',()=>fixture(async directory=>{
 const started=deferred(),late=deferred(),controller=new AbortController();let context,computes=0;
 const loader=createFingerprintLoader({directory,fetchImage:async(_url,options)=>{context=options;started.resolve();return late.promise},fingerprint:async()=>{computes++;return {dHash:'verified'}}});
 const now=()=>1000,pending=loader.get(url,{signal:controller.signal,deadlineAt:2000,now});
 await started.promise;assert.equal(context.deadlineAt,2000);assert.equal(context.now,now);
 controller.abort();assert.equal(await pending,null);assert.equal(context.signal.aborted,true);
 late.resolve(downloaded());await flush();
 assert.equal(computes,0);assert.equal(loader.stats.downloadBytes,0);assert.deepEqual(await fs.readdir(directory),[]);
}));

test('loader deadline aborts an in-flight request even without a caller signal',()=>fixture(async directory=>{
 let time=0,signal;const late=deferred();
 const loader=createFingerprintLoader({directory,fetchImage:async(_url,context)=>{signal=context.signal;time=25;return late.promise},fingerprint:async()=>assert.fail('expired download must not compute')});
 assert.equal(await loader.get(url,{deadlineAt:25,now:()=>time}),null);
 assert.equal(signal.aborted,true);late.resolve(downloaded());await flush();
 assert.deepEqual(await fs.readdir(directory),[]);
}));

test('a deadline reached after download prevents computation and cache population',()=>fixture(async directory=>{
 let time=0,computes=0;
 const loader=createFingerprintLoader({directory,now:()=>time,fetchImage:async()=>{time=10;return downloaded()},fingerprint:async()=>{computes++;return {dHash:'verified'}}});
 assert.equal(await loader.get(url,{deadlineAt:10}),null);
 assert.equal(computes,0);assert.deepEqual(await fs.readdir(directory),[]);
}));

test('cancellation during fingerprinting never stores its late result',()=>fixture(async directory=>{
 const started=deferred(),late=deferred(),controller=new AbortController();
 const loader=createFingerprintLoader({directory,fetchImage:async()=>downloaded(),fingerprint:async()=>{started.resolve();return late.promise}});
 const pending=loader.get(url,{signal:controller.signal});await started.promise;
 controller.abort();assert.equal(await pending,null);
 late.resolve({dHash:'verified'});await flush();assert.equal(loader.stats.computed,0);
 assert.deepEqual(await fs.readdir(directory),[]);
}));

test('bounded requests reuse verified persisted freshness without renewing observation',()=>fixture(async directory=>{
 let reads=0,time=1000;
 const options={directory,now:()=>time,fetchImage:async()=>{reads++;return downloaded()},fingerprint:async()=>({dHash:'verified'})};
 const first=await createFingerprintLoader(options).get(url);time=2000;
 const loader=createFingerprintLoader(options),second=await loader.get(url,{deadlineAt:3000});
 assert.equal(reads,1);assert.equal(second.imageObservedAt,first.imageObservedAt);
 assert.equal(second.imageCacheExpiresAt,first.imageCacheExpiresAt);assert.equal(second.imageCacheSource,'http_fresh');
 assert.equal(await loader.get(url,{deadlineAt:2000}),null);assert.equal(reads,1);
}));

test('wrapper abort reaches the actual fetch and cannot trigger retry or cache writes',()=>fixture(async directory=>{
 let reads=0,fetchSignal;const started=deferred(),controller=new AbortController();
 await withFetch(async(_url,{signal})=>{
  reads++;fetchSignal=signal;started.resolve();
  return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
 },async()=>{
  const pending=imageFingerprints(url,{signal:controller.signal});await started.promise;
  controller.abort();assert.equal(await pending,null);await flush();
  assert.equal(fetchSignal.aborted,true);assert.equal(reads,1);assert.deepEqual(await fs.readdir(directory),[]);
 },{directory});
}));

test('wrapper abort reaches an in-flight response body without caching partial bytes',()=>fixture(async directory=>{
 let reads=0,bodyAborted=false;const started=deferred(),controller=new AbortController();
 await withFetch(async(_url,{signal})=>{
  reads++;return {ok:true,status:200,headers:new Headers({'cache-control':'public, max-age=60'}),arrayBuffer:()=>{
   started.resolve();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{
    bodyAborted=true;reject(new DOMException('Aborted','AbortError'));
   },{once:true}));
  }};
 },async()=>{
  const pending=imageFingerprints(url,{signal:controller.signal});await started.promise;
  controller.abort();assert.equal(await pending,null);await flush();
  assert.equal(bodyAborted,true);assert.equal(reads,1);assert.deepEqual(await fs.readdir(directory),[]);
 },{directory});
}));

test('wrapper deadline aborts a body read when no external signal is supplied',()=>fixture(async directory=>{
 let time=0,reads=0,bodyAborted=false;
 await withFetch(async(_url,{signal})=>{
  reads++;return {ok:true,status:200,headers:new Headers(),arrayBuffer:()=>{
   time=25;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{
    bodyAborted=true;reject(new DOMException('Aborted','AbortError'));
   },{once:true}));
  }};
 },async()=>{
  assert.equal(await imageFingerprints(url,{deadlineAt:25,now:()=>time}),null);await flush();
  assert.equal(bodyAborted,true);assert.equal(reads,1);assert.deepEqual(await fs.readdir(directory),[]);
 },{directory});
}));

test('deadline or cancellation after a failed attempt forbids retries; legacy retries remain',async()=>{
 for(const failure of ['http','network']){
  let time=0,reads=0;
  await withFetch(async()=>{reads++;time=10;if(failure==='network')throw new Error('network');return new Response('',{status:503})},async()=>{
   assert.equal(await imageFingerprints(url,{deadlineAt:10,now:()=>time}),null);assert.equal(reads,1);
  });
  const controller=new AbortController();reads=0;
  await withFetch(async()=>{reads++;controller.abort();if(failure==='network')throw new Error('network');return new Response('',{status:503})},async()=>{
   assert.equal(await imageFingerprints(url,{signal:controller.signal}),null);assert.equal(reads,1);
  });
 }
 for(const options of [undefined,{deadlineAt:1000,now:()=>0}]){
  let reads=0;
  await withFetch(async()=>{reads++;return reads===1?new Response('',{status:503}):response()},async()=>{
   assert.ok((await imageFingerprints(url,options))?.contentSha256);assert.equal(reads,2);
  });
 }
});

test('different callers never share pending cancellation but can reuse a resolved fresh observation',async()=>{
 const calls=[],entered=[deferred(),deferred(),deferred()];let time=1000;
 await withFetch(async(_url,{signal})=>{
  const pending=deferred(),index=calls.length;calls.push({signal,...pending});entered[index].resolve();return pending.promise;
 },async()=>{
  const legacy=imageFingerprints(url);await entered[0].promise;
  const a=new AbortController(),b=new AbortController();
  const first=imageFingerprints(url,{signal:a.signal,deadlineAt:2000,now:()=>time});await entered[1].promise;
  const second=imageFingerprints(url,{signal:b.signal,deadlineAt:3000,now:()=>time});await entered[2].promise;
  a.abort();assert.equal(await first,null);assert.equal(calls[1].signal.aborted,true);
  assert.equal(calls[0].signal.aborted,false);assert.equal(calls[2].signal.aborted,false);
  calls.forEach(call=>call.resolve(response()));
  const [original,independent]=await Promise.all([legacy,second]);assert.equal(original.contentSha256,independent.contentSha256);
  time=1500;const reused=await imageFingerprints(url,{signal:b.signal,deadlineAt:3000,now:()=>time});
  assert.equal(calls.length,3);assert.equal(reused.imageObservedAt,original.imageObservedAt);
  assert.equal(reused.imageCacheExpiresAt,original.imageCacheExpiresAt);
  assert.equal(await imageFingerprints(url,{signal:a.signal}),null);
  assert.equal(await imageFingerprints(url,{deadlineAt:time,now:()=>time}),null);assert.equal(calls.length,3);
 },{now:()=>time});
});
