import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createFingerprintLoader} from '../scripts/lib/image-fingerprint-cache.mjs';

const URL='https://fixture.invalid/image',hash=value=>createHash('sha256').update(value).digest('hex');
const defer=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve};};
async function waitFor(predicate){for(let i=0;i<200&&!predicate();i++)await new Promise(resolve=>setTimeout(resolve,1));assert.ok(predicate(),'offline fixture stage reached');}
async function fixture(t,{fingerprint=async buffer=>({dHash:buffer.toString()}),maxEntries=5000}={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'fingerprint-peek-concurrency-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 let time=1000,reads=0,computes=0;const bodies=[];
 const options={directory,maxEntries,now:()=>time,fetchImage:()=>{reads++;const value=defer();bodies.push(value);return value.promise;},
  fingerprint:async(...args)=>{computes++;return fingerprint(...args);}};
 const loader=createFingerprintLoader(options);
 return {directory,loader,advance:value=>{time=value;},counts:()=>({reads,computes}),
  async start(options={},url=URL){const index=bodies.length,promise=loader.get(url,options);await waitFor(()=>bodies.length>index);return {promise,body:bodies[index]};},
  diskPeek:()=>createFingerprintLoader({...options,fetchImage:()=>{throw Error('peek initiated transport');},fingerprint:()=>{throw Error('peek computed a fingerprint');}}).peek(URL)};
}
const response=(body,cacheControl='public,max-age=100')=>({buffer:Buffer.from(body),cacheControl});

test('newer no-store, private, no-cache and unknown-freshness bodies cannot revive an older persisted image through peek',async t=>{
 for(const directive of ['no-store','private,max-age=100','public,no-cache,max-age=100',''])await t.test(directive||'unknown freshness',async t=>{
  const f=await fixture(t),a=await f.start(),b=await f.start();a.body.resolve(response('old'));const old=await a.promise;
  assert.equal(await f.loader.peek(URL),null,'another original load is still pending');
  f.advance(1100);b.body.resolve(response('new',directive));const newer=await b.promise;
  assert.notEqual(newer.contentSha256,old.contentSha256);const before=f.counts(),stats={...f.loader.stats};
  assert.equal(await f.loader.peek(URL),null);assert.equal(await f.diskPeek(),null);
  assert.deepEqual(f.counts(),before);assert.deepEqual(f.loader.stats,stats,'peek does not write, prune, compute or fetch');
 });
});

test('an observed newer body whose fingerprint fails invalidates the old image even when failure throws',async t=>{
 for(const throws of [false,true])await t.test(String(throws),async t=>{
  const f=await fixture(t,{fingerprint:async buffer=>{if(buffer.toString()==='bad'){if(throws)throw Error('decode failure');return null;}return {dHash:'complete'};}});
  const a=await f.start(),b=await f.start();a.body.resolve(response('old'));await a.promise;
  f.advance(1100);b.body.resolve(response('bad'));
  if(throws)await assert.rejects(b.promise,/decode failure/);else assert.equal(await b.promise,null);
  assert.equal(await f.loader.peek(URL),null);assert.equal(await f.diskPeek(),null);assert.equal(f.counts().reads,2);
 });
});

test('older fingerprint computation finishing late preserves the newest original hash and clock',async t=>{
 const gate=defer();let oldComputing=false;
 const f=await fixture(t,{fingerprint:async buffer=>{if(buffer.toString()==='old'){oldComputing=true;await gate.promise;}return {dHash:buffer.toString()};}});
 const a=await f.start(),b=await f.start();a.body.resolve(response('old'));await waitFor(()=>oldComputing);
 f.advance(1100);b.body.resolve(response('new'));const newer=await b.promise;
 assert.equal(await f.loader.peek(URL),null,'pending older task is not awaited or exposed');
 gate.resolve();const older=await a.promise;assert.equal(older.imageObservedAt,new Date(1000).toISOString());
 const hit=await f.loader.peek(URL);assert.equal(hit.contentSha256,newer.contentSha256);assert.equal(hit.imageObservedAt,new Date(1100).toISOString());
 assert.equal((await f.diskPeek()).contentSha256,newer.contentSha256);assert.equal(f.counts().reads,2);
});

test('older computation cannot republish after a newer uncacheable body finishes',async t=>{
 const gate=defer();let oldComputing=false;
 const f=await fixture(t,{fingerprint:async buffer=>{if(buffer.toString()==='old'){oldComputing=true;await gate.promise;}return {dHash:buffer.toString()};}});
 const a=await f.start(),b=await f.start();a.body.resolve(response('old'));await waitFor(()=>oldComputing);
 f.advance(1100);b.body.resolve(response('new','no-store'));await b.promise;gate.resolve();await a.promise;
 assert.equal(await f.loader.peek(URL),null);assert.equal(await f.diskPeek(),null);assert.equal(f.counts().reads,2);
});

test('equal-clock different bodies fail closed, identical bodies preserve the original clock, and a newer read can recover',async t=>{
 for(const same of [false,true])await t.test(String(same),async t=>{
  const f=await fixture(t),a=await f.start(),b=await f.start();a.body.resolve(response('old'));const old=await a.promise;
  b.body.resolve(response(same?'old':'different'));await b.promise;
  const peek=await f.loader.peek(URL),persisted=await f.diskPeek();
  if(same){assert.equal(peek.contentSha256,old.contentSha256);assert.equal(peek.imageObservedAt,old.imageObservedAt);assert.equal(persisted.contentSha256,old.contentSha256);}
  else{assert.equal(peek,null);assert.equal(persisted,null);f.advance(1200);const c=await f.start();c.body.resolve(response('newest'));const value=await c.promise;assert.equal((await f.loader.peek(URL)).contentSha256,value.contentSha256);}
 });
});

test('a URL row visible during pending atomic publication is not peekable and an old writer cannot overwrite newer state',async t=>{
 const f=await fixture(t),gate=defer(),published=defer(),rename=fs.rename;let held=false;
 t.mock.method(fs,'rename',async function(from,to){await rename.call(this,from,to);if(!held&&path.basename(to).startsWith('url-')){held=true;published.resolve();await gate.promise;}});
 const a=await f.start(),b=await f.start();a.body.resolve(response('old'));await published.promise;
 assert.equal(await f.loader.peek(URL),null);
 f.advance(1100);b.body.resolve(response('new'));const newer=await b.promise;assert.equal(await f.loader.peek(URL),null);
 gate.resolve();await a.promise;t.mock.restoreAll();
 assert.equal((await f.loader.peek(URL)).contentSha256,newer.contentSha256);
 const persisted=await f.diskPeek();assert.ok(!persisted||persisted.contentSha256===newer.contentSha256,'a conservative disk miss is allowed; stale restoration is not');
});

test('cancellation while an original is being computed cannot publish or revive its predecessor',async t=>{
 const gate=defer();let computing=false;
 const f=await fixture(t,{fingerprint:async buffer=>{if(buffer.toString()==='new'){computing=true;await gate.promise;}return {dHash:buffer.toString()};}});
 const controller=new AbortController(),a=await f.start(),b=await f.start({signal:controller.signal});a.body.resolve(response('old'));await a.promise;
 f.advance(1100);b.body.resolve(response('new'));await waitFor(()=>computing);controller.abort();assert.equal(await b.promise,null);
 assert.equal(await f.loader.peek(URL),null);gate.resolve();await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(await f.loader.peek(URL),null);assert.equal(await f.diskPeek(),null);assert.equal(f.counts().reads,2);
});

test('cancellation during URL publication removes the late record without cache-only cleanup writes',async t=>{
 const f=await fixture(t),gate=defer(),published=defer(),rename=fs.rename;
 t.mock.method(fs,'rename',async function(from,to){await rename.call(this,from,to);if(path.basename(to).startsWith('url-')){published.resolve();await gate.promise;}});
 const controller=new AbortController(),a=await f.start({signal:controller.signal});a.body.resolve(response('body'));await published.promise;
 controller.abort();assert.equal(await a.promise,null);assert.equal(await f.loader.peek(URL),null);gate.resolve();
 await waitFor(()=>!f.loader.stats.writes||f.loader.stats.writes>=2);await new Promise(resolve=>setTimeout(resolve,10));t.mock.restoreAll();
 assert.equal(await f.loader.peek(URL),null);assert.equal(await f.diskPeek(),null);assert.equal(f.counts().reads,1);
});

test('evicting bounded unavailable watermarks never restores a stale disk-only record',async t=>{
 const f=await fixture(t,{maxEntries:2}),a=await f.start(),b=await f.start();a.body.resolve(response('old'));const first=await a.promise;
 const file=path.join(f.directory,'url-'+hash(URL)+'.json'),bodyFile=path.join(f.directory,'body-'+first.contentSha256+'.json');
 const old=await fs.readFile(file),oldBody=await fs.readFile(bodyFile);
 f.advance(1100);b.body.resolve(response('new','no-store'));await b.promise;
 const urls=['https://fixture.invalid/other-one','https://fixture.invalid/other-two'];
 for(const url of urls){const c=await f.start({},url);c.body.resolve(response(url));await c.promise;}
 // Simulate old derived records reappearing after the small metadata cap evicts
 // their watermark. Read-only peeking must still never restore the older body.
 await fs.writeFile(file,old);await fs.writeFile(bodyFile,oldBody);const before=f.counts(),stats={...f.loader.stats};
 assert.equal(await f.loader.peek(URL),null);for(const url of urls)assert.ok(await f.loader.peek(url));
 assert.deepEqual(f.counts(),before);assert.deepEqual(f.loader.stats,stats);
});

test('oversized malformed derived files and URL keys are misses without computation or reads',async t=>{
 const f=await fixture(t),content={contentSha256:hash('body'),dHash:'x'.repeat(70*1024)};
 await fs.writeFile(path.join(f.directory,'body-'+content.contentSha256+'.json'),JSON.stringify({version:1,fingerprint:content,checksum:hash(JSON.stringify(content))}));
 await fs.writeFile(path.join(f.directory,'url-'+hash(URL)+'.json'),JSON.stringify({version:1,contentSha256:content.contentSha256,observedAt:1000,expiresAt:2000}));
 assert.equal(await f.loader.peek(URL),null);assert.equal(await f.loader.peek('https://fixture.invalid/'+ 'x'.repeat(8192)),null);
 assert.deepEqual(f.counts(),{reads:0,computes:0});assert.equal(f.loader.stats.writes,0);
});

test('synchronous known observations expose settled original metadata only and never perform I/O or renew clocks',async t=>{
 const f=await fixture(t);assert.deepEqual(f.loader.peekKnownObservation(URL),{status:'unknown'});
 const a=await f.start();assert.deepEqual(f.loader.peekKnownObservation(URL),{status:'unavailable',reason:'pending'});
 a.body.resolve(response('body'));const value=await a.promise;
 const expected={status:'available',contentSha256:value.contentSha256,imageObservedAt:value.imageObservedAt,imageCacheExpiresAt:value.imageCacheExpiresAt};
 f.advance(1500);const counts=f.counts(),stats={...f.loader.stats};
 for(const name of ['open','readFile','writeFile','rename','rm','readdir','stat','mkdir'])t.mock.method(fs,name,()=>{throw Error('known observation performed filesystem I/O');});
 for(let i=0;i<10;i++)assert.deepEqual(f.loader.peekKnownObservation(URL),expected);
 const mutation=f.loader.peekKnownObservation(URL);mutation.contentSha256='changed';assert.deepEqual(f.loader.peekKnownObservation(URL),expected);
 assert.deepEqual(Object.keys(expected).sort(),Object.keys(f.loader.peekKnownObservation(URL)).sort(),'no bytes or full fingerprint');
 f.advance(NaN);assert.deepEqual(f.loader.peekKnownObservation(URL),{status:'unavailable',reason:'invalid_clock'});
 f.advance(500);assert.deepEqual(f.loader.peekKnownObservation(URL),{status:'unavailable',reason:'invalid_clock'});
 f.advance(value.imageCacheExpiresAt);assert.deepEqual(f.loader.peekKnownObservation(URL),{status:'unavailable',reason:'expired'});
 assert.deepEqual(f.counts(),counts);assert.deepEqual(f.loader.stats,stats);t.mock.restoreAll();
});

test('synchronous known state changes immediately on newer uncacheable bodies, failed computation and equal-clock conflict',async t=>{
 for(const mode of ['no-store','private','no-cache','failed','conflict'])await t.test(mode,async t=>{
  const f=await fixture(t,{fingerprint:async buffer=>buffer.toString()==='bad'?null:{dHash:'complete'}}),a=await f.start(),b=await f.start();
  a.body.resolve(response('old'));await a.promise;
  if(mode!=='conflict')f.advance(1100);
  b.body.resolve(response(mode==='failed'?'bad':'new',mode==='conflict'||mode==='failed'?'public,max-age=100':mode));await b.promise;
  assert.deepEqual(f.loader.peekKnownObservation(URL),{status:'unavailable',reason:mode==='conflict'?'same_time_conflict':'original_unavailable'});
  assert.equal(await f.loader.peek(URL),null);
 });
});

test('a completed disk-only peek establishes the synchronous known original without writes or a fresh clock',async t=>{
 const f=await fixture(t),a=await f.start();a.body.resolve(response('body'));const value=await a.promise;
 const restored=createFingerprintLoader({directory:f.directory,now:()=>1500,fetchImage:()=>{throw Error('disk peek fetched');},fingerprint:()=>{throw Error('disk peek computed');}});
 assert.deepEqual(restored.peekKnownObservation(URL),{status:'unknown'});
 const stats={...restored.stats};const hit=await restored.peek(URL);
 assert.equal(hit.contentSha256,value.contentSha256);assert.deepEqual(restored.peekKnownObservation(URL),{
  status:'available',contentSha256:value.contentSha256,imageObservedAt:value.imageObservedAt,imageCacheExpiresAt:value.imageCacheExpiresAt});
 assert.deepEqual(restored.stats,stats);
});

test('an older observed clock cannot supersede the newer known hash even if its response finishes last',async t=>{
 const f=await fixture(t),a=await f.start(),b=await f.start();f.advance(1100);a.body.resolve(response('newer'));const newer=await a.promise;
 f.advance(1000);b.body.resolve(response('older'));const older=await b.promise;assert.equal(older.imageObservedAt,new Date(1000).toISOString());
 f.advance(1200);assert.deepEqual(f.loader.peekKnownObservation(URL),{status:'available',contentSha256:newer.contentSha256,imageObservedAt:newer.imageObservedAt,imageCacheExpiresAt:newer.imageCacheExpiresAt});
 assert.equal((await f.loader.peek(URL)).contentSha256,newer.contentSha256);
});

test('metadata eviction cannot add ordinary GETs or promote an unknown disk hit into strict evidence',async t=>{
 const f=await fixture(t,{maxEntries:2}),urls=[URL,'https://fixture.invalid/two','https://fixture.invalid/three'];
 const snapshots=[];
 for(const url of urls){const a=await f.start({},url);a.body.resolve(response(url));const value=await a.promise;
  snapshots.push({url,file:await fs.readFile(path.join(f.directory,'url-'+hash(url)+'.json')),body:await fs.readFile(path.join(f.directory,'body-'+value.contentSha256+'.json')),sha:value.contentSha256});}
 // Restore the first disk-only row if ordinary file-count pruning removed it.
 await fs.writeFile(path.join(f.directory,'url-'+hash(URL)+'.json'),snapshots[0].file);
 await fs.writeFile(path.join(f.directory,'body-'+snapshots[0].sha+'.json'),snapshots[0].body);
 const counts=f.counts();assert.equal(f.loader.peekKnownObservation(URL).status,'unknown');
 const unknownHit=await f.loader.get(URL);assert.equal(unknownHit.imageCacheSource,'http_fresh');
 assert.equal(f.loader.peekKnownObservation(URL).status,'unknown','ordinary reuse cannot authorize untrusted strict evidence');
 const knownHit=await f.loader.get(urls[2]);assert.equal(knownHit.imageCacheSource,'http_fresh');
 assert.equal(f.loader.peekKnownObservation(urls[2]).status,'available');assert.deepEqual(f.counts(),counts);
 assert.equal(await f.loader.peek(URL),null);
});

test('a disk peek suspended across newer invalidation and watermark eviction cannot restore its old body',async t=>{
 const f=await fixture(t,{maxEntries:2}),sha=hash('old'),content={contentSha256:sha,dHash:'old'};
 const urlFile=path.join(f.directory,'url-'+hash(URL)+'.json'),bodyFile=path.join(f.directory,'body-'+sha+'.json');
 await fs.writeFile(urlFile,JSON.stringify({version:1,contentSha256:sha,observedAt:1000,expiresAt:101000}));
 await fs.writeFile(bodyFile,JSON.stringify({version:1,fingerprint:content,checksum:hash(JSON.stringify(content))}));
 const opened=defer(),gate=defer(),open=fs.open;let held=false;
 t.mock.method(fs,'open',async function(file,...args){const handle=await open.call(this,file,...args);
  if(file===bodyFile&&!held){held=true;const read=handle.read.bind(handle);handle.read=async(...args)=>{const value=await read(...args);opened.resolve();await gate.promise;return value;};}
  return handle;});
 const peek=f.loader.peek(URL);await opened.promise;await fs.rm(urlFile);f.advance(1100);
 const newer=await f.start();newer.body.resolve(response('new','no-store'));await newer.promise;
 for(const url of ['https://fixture.invalid/two','https://fixture.invalid/three']){const next=await f.start({},url);next.body.resolve(response(url));await next.promise;}
 assert.equal(f.loader.peekKnownObservation(URL).status,'unknown');const counts=f.counts(),stats={...f.loader.stats};
 gate.resolve();assert.equal(await peek,null);t.mock.restoreAll();
 assert.equal(f.loader.peekKnownObservation(URL).status,'unknown');assert.deepEqual(f.counts(),counts);assert.deepEqual(f.loader.stats,stats);
});

test('equal-clock identical bytes with conflicting original freshness fail closed in either response order',async t=>{
 for(const firstDirective of ['no-store','private','no-cache','public,max-age=10'])for(const reverse of [false,true])await t.test(firstDirective+' reverse='+reverse,async t=>{
  const f=await fixture(t),a=await f.start(),b=await f.start();
  const directives=reverse?['public,max-age=100',firstDirective]:[firstDirective,'public,max-age=100'];
  a.body.resolve(response('same',directives[0]));await a.promise;b.body.resolve(response('same',directives[1]));await b.promise;
  assert.deepEqual(f.loader.peekKnownObservation(URL),{status:'unavailable',reason:'same_time_conflict'});
  assert.equal(await f.loader.peek(URL),null);assert.equal(await f.diskPeek(),null);
  f.advance(1100);const newer=await f.start();newer.body.resolve(response('same'));const value=await newer.promise;
  assert.equal(f.loader.peekKnownObservation(URL).imageObservedAt,value.imageObservedAt);assert.equal(f.loader.peekKnownObservation(URL).status,'available');
 });
});

test('a same-clock same-hash disk row cannot extend the known source expiry',async t=>{
 const f=await fixture(t),a=await f.start();a.body.resolve(response('body','public,max-age=10'));const original=await a.promise;
 await fs.writeFile(path.join(f.directory,'url-'+hash(URL)+'.json'),JSON.stringify({version:1,contentSha256:original.contentSha256,observedAt:1000,expiresAt:101000}));
 const counts=f.counts(),normal=await f.loader.get(URL);assert.equal(normal.imageCacheSource,'http_fresh');assert.deepEqual(f.counts(),counts);
 assert.equal(f.loader.peekKnownObservation(URL).imageCacheExpiresAt,11000,'ordinary disk reuse cannot renew previously known evidence');
});
