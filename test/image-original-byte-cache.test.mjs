import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile,spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createOriginalImageByteCache,createImageByteObservationPool,originalImageByteLimits } from '../scripts/lib/image-byte-observations.mjs';
import { createFingerprintLoader } from '../scripts/lib/image-fingerprint-cache.mjs';
import { configureImageFingerprintCache,imageFingerprints,withImageByteObservations,imageByteCacheStats } from '../scripts/lib/image.mjs';
const execute=promisify(execFile),url='https://fixture.invalid/image?size=original',hash=body=>createHash('sha256').update(body).digest('hex');
const svg='<svg xmlns="http://www.w3.org/2000/svg" width="12" height="10"><rect width="10" height="10" fill="red"/></svg>';
const value=(body='original',overrides={})=>{const buffer=Buffer.from(body);return {buffer,url,contentSha256:hash(buffer),imageObservedAt:new Date(1000).toISOString(),imageCacheExpiresAt:100_000,...overrides}};
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve}};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(run){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'original-image-byte-cache-'));try{await run(directory)}finally{await fs.rm(directory,{recursive:true,force:true})}}
async function withFetch(fetcher,run,options={}){const saved=globalThis.fetch;globalThis.fetch=fetcher;configureImageFingerprintCache(options);try{await run()}finally{globalThis.fetch=saved;configureImageFingerprintCache()}}
const bodyFile=(directory,source=url)=>path.join(directory,'original-bytes','bytes-'+hash(source)+'.bin');

test('same-run warm real wrapper restores own bytes to a new comparison without fetching or renewing',async()=>{
 let time=1000,fetches=0;
 await withFetch(async()=>{fetches++;return new Response(svg,{headers:{'cache-control':'public,max-age=60'}})},async()=>{
  const first=await imageFingerprints(url);time=2000;
  const pool=createImageByteObservationPool();
  await withImageByteObservations(pool,async()=>{
   const second=await imageFingerprints(url);assert.equal(pool.get(second).buffer.toString(),svg);assert.equal(second.imageCacheSource,'http_fresh');assert.equal(first.imageCacheSource,'current_body');assert.notEqual(first,second);
   assert.equal(second.imageObservedAt,first.imageObservedAt);assert.equal(second.imageCacheExpiresAt,first.imageCacheExpiresAt);
   assert.equal(pool.unavailableReason(second),null);
  });
  assert.equal(fetches,1);assert.ok(imageByteCacheStats().memoryReuses>=1);assert.equal(pool.stats.images,0);
 },{now:()=>time});
});

test('shared fresh in-flight wrapper work supplies both comparison scopes, with one download',async()=>{
 const entered=deferred(),late=deferred();let fetches=0;
 await withFetch(async()=>{fetches++;entered.resolve();return late.promise},async()=>{
  const a=createImageByteObservationPool(),b=createImageByteObservationPool();
  const run=pool=>withImageByteObservations(pool,async()=>{const result=await imageFingerprints(url);assert.equal(pool.get(result).buffer.toString(),svg);return result});
  const one=run(a);await entered.promise;const two=run(b);
  late.resolve(new Response(svg,{headers:{'cache-control':'public,max-age=60'}}));
  const [first,second]=await Promise.all([one,two]);assert.equal(fetches,1);assert.equal(first.imageObservedAt,second.imageObservedAt);
 },{now:()=>1000});
});

test('fresh disk bodies survive a real process restart and remain cache-only',()=>fixture(async directory=>{
 let fetches=0;
 await withFetch(async()=>{fetches++;return new Response(svg,{headers:{'cache-control':'public,max-age=60'}})},async()=>{
  const first=await imageFingerprints(url);
  const script=`import {configureImageFingerprintCache,imageFingerprints,withImageByteObservations,imageByteCacheStats} from ${JSON.stringify(new URL('../scripts/lib/image.mjs',import.meta.url).href)};
   import {createImageByteObservationPool} from ${JSON.stringify(new URL('../scripts/lib/image-byte-observations.mjs',import.meta.url).href)};
   globalThis.fetch=()=>{throw Error('No fetch allowed')};configureImageFingerprintCache({directory:${JSON.stringify(directory)},now:()=>2000});
   const pool=createImageByteObservationPool();await withImageByteObservations(pool,async()=>{const value=await imageFingerprints(${JSON.stringify(url)});console.log(JSON.stringify({value,body:pool.get(value)?.buffer.toString(),stats:imageByteCacheStats()}))});`;
  const {stdout}=await execute(process.execPath,['--input-type=module','-e',script]);const restored=JSON.parse(stdout);
  assert.equal(restored.body,svg);assert.equal(restored.value.imageObservedAt,first.imageObservedAt);assert.equal(restored.value.imageCacheExpiresAt,first.imageCacheExpiresAt);
  assert.equal(restored.stats.diskReuses,1);assert.equal(fetches,1);
 },{directory,now:()=>1000});
}));

test('legacy fingerprint-only entries report bytes_missing with no transport or fake freshness',()=>fixture(async directory=>{
 let fetches=0;const options={directory,now:()=>1000,fetchImage:async()=>{fetches++;return {buffer:Buffer.from('body'),cacheControl:'public,max-age=60'}},fingerprint:async()=>({dHash:'real'})};
 const first=await createFingerprintLoader(options).get(url);await fs.rm(path.join(directory,'original-bytes'),{recursive:true});
 const pool=createImageByteObservationPool(),warm=createFingerprintLoader({...options,now:()=>2000,fetchImage:async()=>assert.fail('legacy byte miss must not fetch'),observeImageBytes:pool.observe,observeImageByteMiss:pool.observeUnavailable});
 const second=await warm.get(url);assert.equal(second.imageObservedAt,first.imageObservedAt);assert.equal(second.imageCacheExpiresAt,first.imageCacheExpiresAt);
 assert.equal(pool.get(second),null);assert.equal(pool.unavailableReason(second),'bytes_missing');assert.equal(warm.byteStats.misses,1);assert.equal(fetches,1);
}));

test('raw bodies require explicit public HTTP freshness; private/no-store/no-cache remain comparison-local',()=>fixture(async directory=>{
 for(const [index,cacheControl] of ['private,max-age=60','public,private,max-age=60','public,no-store,max-age=60','public,no-cache,max-age=60','max-age=60','public,max-age=0','public,max-age=60,max-age=120'].entries()){
  const pool=createImageByteObservationPool(),loader=createFingerprintLoader({directory,now:()=>1000,fetchImage:async()=>({buffer:Buffer.from('secret'),cacheControl}),fingerprint:async()=>({dHash:'real'}),observeImageBytes:pool.observe});
  const result=await loader.get(url+'&n='+index);assert.equal(pool.get(result).buffer.toString(),'secret');assert.equal(loader.byteStats.memoryBytes,0);assert.equal(loader.byteStats.diskBytes,0);
 }
 await assert.rejects(fs.access(path.join(directory,'original-bytes')),{code:'ENOENT'});
}));

test('byte cache retains exact query/hash/original timestamp/expiry bindings and isolates mutation',()=>fixture(async directory=>{
 const cache=createOriginalImageByteCache({directory,now:()=>2000}),input=value(),expected=Buffer.from(input.buffer);
 await cache.put(input);input.buffer.fill(0);const first=await cache.get(input);assert.equal(first.reason,'memory_hit');assert.deepEqual(first.value.buffer,expected);
 first.value.buffer.fill(1);assert.deepEqual((await cache.get(input)).value.buffer,expected);
 const restored=createOriginalImageByteCache({directory,now:()=>2000});
 for(const changed of [{url:url+'&different=1'},{contentSha256:'a'.repeat(64)},{imageObservedAt:new Date(1001).toISOString()},{imageCacheExpiresAt:99_999}])assert.equal((await restored.get({...input,...changed})).reason,'bytes_missing');
 const disk=await restored.get(input);assert.equal(disk.reason,'disk_hit');assert.deepEqual(disk.value.buffer,expected);
 disk.value.buffer.fill(2);assert.deepEqual((await restored.get(input)).value.buffer,expected);
}));

test('expiry/Age never renews and cache-only expired lookup never fetches',()=>fixture(async directory=>{
 let time=1000;const cache=createOriginalImageByteCache({directory,now:()=>time}),input=value('body',{imageCacheExpiresAt:2000});
 await cache.put(input);time=2000;assert.equal((await cache.get(input)).reason,'bytes_expired');assert.equal(cache.stats.memoryBytes,0);
 await cache.prune();assert.equal(cache.stats.diskBytes,0);await assert.rejects(fs.access(bodyFile(directory)),{code:'ENOENT'});
 let reads=0;const loader=createFingerprintLoader({directory,now:()=>1000,fetchImage:async()=>{reads++;return {buffer:Buffer.from('age'),cacheControl:'public,max-age=60',cacheAge:'59'}},fingerprint:async()=>({dHash:'real'})});
 const observed=await loader.get(url);assert.equal(observed.imageCacheExpiresAt,2000);assert.equal(reads,1);
}));

test('corrupt, truncated and oversized persisted bodies fail closed without a network retry',()=>fixture(async directory=>{
 const input=value('verified-body'),file=bodyFile(directory);
 for(const mutation of ['hash','truncated','oversized','header']){
  await createOriginalImageByteCache({directory,now:()=>2000}).put(input);
  if(mutation==='hash'){const data=await fs.readFile(file);data[data.length-1]^=1;await fs.writeFile(file,data)}
  if(mutation==='truncated')await fs.truncate(file,8);
  if(mutation==='oversized')await fs.truncate(file,12_016_389);
  if(mutation==='header'){const fd=await fs.open(file,'r+');await fd.write(Buffer.from([255,255,255,255]),0,4,0);await fd.close()}
  const cache=createOriginalImageByteCache({directory,now:()=>2000}),result=await cache.get(input);
  assert.equal(result.reason,'bytes_corrupt',mutation);assert.equal(cache.stats.corrupt,1);assert.equal(cache.stats.memoryBytes,0);
 }
}));

test('memory entry/byte bounds and actual encoded disk bytes remain hard caps',()=>fixture(async directory=>{
 const cache=createOriginalImageByteCache({directory,now:()=>2000,maxMemoryBytes:7,maxMemoryImages:2,maxDiskBytes:1500,maxDiskImages:2});
 for(let index=0;index<12;index++)await cache.put(value('body'+index,{url:url+'&n='+index}));
 assert.ok(cache.stats.memoryBytes<=7);assert.ok(cache.stats.memoryImages<=2);assert.ok(cache.stats.diskImages<=2);
 const names=await fs.readdir(path.join(directory,'original-bytes')),sizes=await Promise.all(names.map(async name=>(await fs.stat(path.join(directory,'original-bytes',name))).size));
 assert.equal(sizes.reduce((a,b)=>a+b,0),cache.stats.diskBytes);assert.ok(cache.stats.diskBytes<=1500);
 assert.ok(cache.stats.pruned>0);assert.ok(names.every(name=>/^bytes-[a-f0-9]{64}\.bin$/.test(name)));
 assert.equal(originalImageByteLimits.maxMemoryBytes,16*1024*1024);assert.equal(originalImageByteLimits.maxDiskBytes,64*1024*1024);
 const strict=createOriginalImageByteCache({maxMemoryBytes:Number.MAX_SAFE_INTEGER,maxMemoryImages:Number.MAX_SAFE_INTEGER,now:()=>2000});
 const big=value(Buffer.alloc(9*1024*1024));await strict.put(big);await strict.put({...big,url:url+'&2'});
 assert.equal(strict.stats.memoryImages,1);assert.equal(strict.stats.memoryBytes,9*1024*1024);
 assert.equal(await strict.put(value(Buffer.alloc(12_000_001))),false);
}));

test('atomic cache writes leave no temps; prune removes orphan temporary and expired files',()=>fixture(async directory=>{
 const cache=createOriginalImageByteCache({directory,now:()=>2000});await cache.put(value());
 const root=path.join(directory,'original-bytes'),temporary=bodyFile(directory)+'.abcd-1234.tmp';await fs.writeFile(temporary,'interrupted bytes');
 await cache.prune();await assert.rejects(fs.access(temporary),{code:'ENOENT'});
 assert.ok((await fs.readdir(root)).every(name=>name.endsWith('.bin')));
 await fs.mkdir(path.join(root,'.writer'));await fs.writeFile(path.join(root,'.writer','2147483647-dead.owner'),'');
 await cache.put(value('recovered',{url:url+'&recovered'}));
 assert.equal(cache.stats.writes,2);assert.ok((await fs.readdir(root)).every(name=>name.endsWith('.bin')));
}));

test('cancellation/late computation/partial downloads cannot populate reusable byte storage',()=>fixture(async directory=>{
 const entered=deferred(),late=deferred(),controller=new AbortController();
 const loader=createFingerprintLoader({directory,fetchImage:async()=>{entered.resolve();return late.promise},fingerprint:async()=>assert.fail('canceled body must not decode')});
 const pending=loader.get(url,{signal:controller.signal});await entered.promise;controller.abort();assert.equal(await pending,null);
 late.resolve({buffer:Buffer.from('late'),cacheControl:'public,max-age=60'});await flush();await flush();assert.equal(loader.byteStats.memoryBytes,0);assert.deepEqual(await fs.readdir(directory),[]);
 await withFetch(async()=>({ok:true,status:200,headers:new Headers({'cache-control':'public,max-age=60','content-length':'9999'}),arrayBuffer:async()=>Buffer.from(svg)}),async()=>{
  assert.equal(await imageFingerprints(url),null);assert.equal(imageByteCacheStats().memoryBytes,0);assert.deepEqual(await fs.readdir(directory),[]);
 },{directory});
}));

test('cancel during atomic writes never exposes a retained late body or orphan temp',()=>fixture(async directory=>{
 let stop=false;const cache=createOriginalImageByteCache({directory,now:()=>2000}),saved=fs.writeFile;
 fs.writeFile=async function(file,...args){const result=await saved.call(this,file,...args);if(String(file).endsWith('.tmp'))stop=true;return result};
 try{assert.equal(await cache.put(value(),{stopped:()=>stop}),false)}finally{fs.writeFile=saved}
 assert.equal(cache.stats.memoryBytes,0);assert.equal((await cache.get(value())).reason,'bytes_missing');
 assert.deepEqual(await fs.readdir(path.join(directory,'original-bytes')),[]);
}));

test('diagnostics contain fixed numeric fields, never source URLs, bytes or errors',()=>fixture(async directory=>{
 const cache=createOriginalImageByteCache({directory,now:()=>2000});await cache.get(value());await cache.put(value());await cache.get(value());
 assert.ok(Object.values(cache.stats).every(Number.isFinite));assert.doesNotMatch(JSON.stringify(cache.stats),/fixture|original|Buffer|Error/);
 const pool=createImageByteObservationPool();pool.observeUnavailable(value(),'arbitrary private error');assert.equal(pool.unavailableReason(value()),null);
 pool.observeUnavailable(value(),'bytes_missing');assert.equal(pool.unavailableReason(value()),'bytes_missing');pool.clear();assert.equal(pool.unavailableReason(value()),null);
}));

test('cache roots, body records and lock ownership never follow symlinks',()=>fixture(async directory=>{
 const outside=await fs.mkdtemp(path.join(os.tmpdir(),'byte-cache-outside-'));
 try{
  const root=path.join(directory,'original-bytes');await fs.symlink(outside,root);
  const cache=createOriginalImageByteCache({directory,now:()=>2000});await cache.put(value());
  assert.deepEqual(await fs.readdir(outside),[]);assert.ok(cache.stats.diskBlocked>0);
  await fs.unlink(root);await fs.mkdir(root);await fs.writeFile(path.join(outside,'body'),'private');await fs.symlink(path.join(outside,'body'),bodyFile(directory));
  const isolated=createOriginalImageByteCache({directory,now:()=>2000});assert.equal((await isolated.get(value())).reason,'bytes_corrupt');
  await fs.symlink(path.join(outside,'body'),path.join(root,'.writer'));await isolated.put(value());
  assert.equal(await fs.readFile(path.join(outside,'body'),'utf8'),'private');assert.equal(isolated.stats.writes,0);
 }finally{await fs.rm(outside,{recursive:true,force:true})}
}));

test('unknown orphan sizes are counted; an overfull foreign cache cannot add a body',()=>fixture(async directory=>{
 const root=path.join(directory,'original-bytes');await fs.mkdir(root);await fs.writeFile(path.join(root,'orphan.bin'),Buffer.alloc(2000));
 const cache=createOriginalImageByteCache({directory,now:()=>2000,maxDiskBytes:1500});await cache.put(value());
 assert.deepEqual(await fs.readdir(root),['orphan.bin']);assert.equal(cache.stats.writes,0);assert.equal(cache.stats.diskBytes,2000);assert.ok(cache.stats.diskBlocked>0);
}));

test('cancellation just after atomic rename rolls back the newly written record',()=>fixture(async directory=>{
 let stopped=false;const cache=createOriginalImageByteCache({directory,now:()=>2000}),saved=fs.rename;
 fs.rename=async function(...args){const result=await saved.apply(this,args);stopped=true;return result};
 try{assert.equal(await cache.put(value(),{stopped:()=>stopped}),false)}finally{fs.rename=saved}
 assert.equal(cache.stats.memoryBytes,0);assert.equal((await createOriginalImageByteCache({directory,now:()=>2000}).get(value())).reason,'bytes_missing');
 assert.deepEqual(await fs.readdir(path.join(directory,'original-bytes')),[]);
}));

test('empty abandoned writer claims recover without a second persistent recovery lock',()=>fixture(async directory=>{
 const root=path.join(directory,'original-bytes');await fs.mkdir(root);await fs.mkdir(path.join(root,'.writer'));
 const cache=createOriginalImageByteCache({directory,now:()=>2000});await cache.put(value());assert.equal(cache.stats.writes,1);
 assert.ok((await fs.readdir(root)).every(name=>name.endsWith('.bin')));
}));

test('non-regular body files cannot block cache lookup or pruning',{skip:process.platform==='win32'},()=>fixture(async directory=>{
 const root=path.join(directory,'original-bytes');await fs.mkdir(root);await execute('mkfifo',[bodyFile(directory)]);
 const cache=createOriginalImageByteCache({directory,now:()=>2000});
 const result=await Promise.race([cache.get(value()),new Promise((_,reject)=>setTimeout(()=>reject(Error('FIFO lookup blocked')),500).unref())]);
 assert.equal(result.reason,'bytes_corrupt');await cache.prune();assert.deepEqual(await fs.readdir(root),[]);
}));

test('process crash midway through a temp write releases via dead-owner recovery and orphan cleanup',()=>fixture(async directory=>{
 const script=`import fs from 'node:fs/promises';
import fsSync from 'node:fs';import {createOriginalImageByteCache} from ${JSON.stringify(new URL('../scripts/lib/image-byte-observations.mjs',import.meta.url).href)};
  const original=fs.writeFile;fs.writeFile=async function(file,...args){const result=await original.call(this,file,...args);if(String(file).endsWith('.tmp'))process.kill(process.pid,'SIGKILL');return result};
  const cache=createOriginalImageByteCache({directory:${JSON.stringify(directory)},now:()=>2000});
  await cache.put({...${JSON.stringify({...value(),buffer:undefined})},buffer:Buffer.from('original')});`;
 await assert.rejects(execute(process.execPath,['--input-type=module','-e',script]),error=>error.signal==='SIGKILL');
 const cache=createOriginalImageByteCache({directory,now:()=>2000});await cache.put(value('recovered'));
 assert.equal(cache.stats.writes,1);assert.ok(cache.stats.pruned>=1);
 assert.ok((await fs.readdir(path.join(directory,'original-bytes'))).every(name=>/^bytes-[a-f0-9]{64}\.bin$/.test(name)));
 assert.equal((await createOriginalImageByteCache({directory,now:()=>2000}).get(value('recovered'))).reason,'disk_hit');
}));

test('multiple processes share the encoded disk cap without unbounded writer queues',()=>fixture(async directory=>{
 const script=`import {createOriginalImageByteCache} from ${JSON.stringify(new URL('../scripts/lib/image-byte-observations.mjs',import.meta.url).href)};
  const cache=createOriginalImageByteCache({directory:${JSON.stringify(directory)},now:()=>2000,maxDiskBytes:5000,maxDiskImages:5});
  for(let i=0;i<25;i++)await cache.put({...${JSON.stringify({...value(),buffer:undefined})},url:${JSON.stringify(url)}+'&worker='+process.pid+'&i='+i,buffer:Buffer.from('original')});`;
 await Promise.all(Array.from({length:4},()=>execute(process.execPath,['--input-type=module','-e',script])));
 const cache=createOriginalImageByteCache({directory,now:()=>2000,maxDiskBytes:5000,maxDiskImages:5});await cache.prune();
 const names=await fs.readdir(path.join(directory,'original-bytes')),sizes=await Promise.all(names.map(async name=>(await fs.stat(path.join(directory,'original-bytes',name))).size));
 assert.ok(names.length<=5);assert.ok(sizes.reduce((a,b)=>a+b,0)<=5000);assert.ok(names.every(name=>name.endsWith('.bin')));
}));

test('normal twenty-image parallel wrapper downloads all survive a cache-only restart',()=>fixture(async directory=>{
 let fetches=0;const urls=Array.from({length:20},(_,index)=>url+'&n='+index);
 await withFetch(async()=>{fetches++;return new Response(svg,{headers:{'cache-control':'public,max-age=60'}})},async()=>{
  const first=await Promise.all(urls.map(imageFingerprints));assert.equal(fetches,20);assert.equal(imageByteCacheStats().writes,20);
  assert.equal(imageByteCacheStats().pendingWrites,0);assert.equal(imageByteCacheStats().pendingWriteBytes,0);
  configureImageFingerprintCache({directory,now:()=>2000});globalThis.fetch=()=>assert.fail('byte restore must not fetch');
  const pool=createImageByteObservationPool();await withImageByteObservations(pool,async()=>{
   for(let index=0;index<urls.length;index++){const result=await imageFingerprints(urls[index]);assert.ok(pool.has(result));assert.equal(result.imageObservedAt,first[index].imageObservedAt);assert.equal(result.imageCacheSource,'http_fresh')}
  });assert.equal(imageByteCacheStats().diskReuses,20);
  const script=`import {configureImageFingerprintCache,imageFingerprints,withImageByteObservations,imageByteCacheStats} from ${JSON.stringify(new URL('../scripts/lib/image.mjs',import.meta.url).href)};
   import {createImageByteObservationPool} from ${JSON.stringify(new URL('../scripts/lib/image-byte-observations.mjs',import.meta.url).href)};
   globalThis.fetch=()=>{throw Error('Source access forbidden')};configureImageFingerprintCache({directory:${JSON.stringify(directory)},now:()=>2000});
   const pool=createImageByteObservationPool();let restored=0;await withImageByteObservations(pool,async()=>{for(const url of ${JSON.stringify(urls)}){const result=await imageFingerprints(url);if(pool.has(result))restored++}});console.log(JSON.stringify({restored,stats:imageByteCacheStats()}));`;
  const restarted=JSON.parse((await execute(process.execPath,['--input-type=module','-e',script])).stdout);
  assert.equal(restarted.restored,20);assert.equal(restarted.stats.diskReuses,20);
 },{directory,now:()=>1000});
}));

test('pending write image/byte caps include active work and overflow becomes RAM-only',()=>fixture(async directory=>{
 const entered=deferred(),release=deferred(),saved=fs.writeFile;let once=false;
 fs.writeFile=async function(file,...args){if(String(file).endsWith('.tmp')&&!once){once=true;entered.resolve();await release.promise}return saved.call(this,file,...args)};
 const cache=createOriginalImageByteCache({directory,now:()=>2000,maxPendingImages:2,maxPendingBytes:6});
 try{
  const one=cache.put(value('one'));await entered.promise;
  const two=cache.put(value('two',{url:url+'&2'}));await flush();
  const three=await cache.put(value('x',{url:url+'&3'}));assert.equal(three,true);assert.equal(cache.stats.pendingWrites,2);assert.equal(cache.stats.pendingWriteBytes,6);assert.equal(cache.stats.queueSkips,1);
  release.resolve();await Promise.all([one,two]);assert.equal(cache.stats.writes,2);assert.equal(cache.stats.pendingWrites,0);assert.equal(cache.stats.pendingWriteBytes,0);
  assert.equal((await cache.get(value('x',{url:url+'&3'}))).reason,'memory_hit');
  assert.equal((await createOriginalImageByteCache({directory,now:()=>2000}).get(value('x',{url:url+'&3'}))).reason,'bytes_missing');
 }finally{release.resolve();fs.writeFile=saved}
}));

test('a canceled middle queue entry resolves promptly and later work preserves FIFO order',()=>fixture(async directory=>{
 const entered=deferred(),release=deferred(),saved=fs.writeFile,order=[];let once=false;
 fs.writeFile=async function(file,...args){if(String(file).endsWith('.tmp')){order.push(path.basename(file).split('.bin')[0]);if(!once){once=true;entered.resolve();await release.promise}}return saved.call(this,file,...args)};
 const cache=createOriginalImageByteCache({directory,now:()=>2000}),controller=new AbortController();
 try{
  const one=cache.put(value('one'));await entered.promise;
  const two=cache.put(value('two',{url:url+'&2'}),{signal:controller.signal,stopped:()=>controller.signal.aborted});
  const three=cache.put(value('three',{url:url+'&3'}));controller.abort();assert.equal(await two,false);assert.equal(cache.stats.pendingWrites,2);
  release.resolve();await Promise.all([one,three]);assert.deepEqual(order,['bytes-'+hash(url),'bytes-'+hash(url+'&3')]);assert.equal(cache.stats.pendingWrites,0);assert.equal(cache.stats.pendingWriteBytes,0);
 }finally{release.resolve();fs.writeFile=saved}
}));

test('queue timeout and failed head do not retain pending bytes or deadlock subsequent writes',()=>fixture(async directory=>{
 const entered=deferred(),release=deferred(),saved=fs.writeFile;let once=false;
 fs.writeFile=async function(file,...args){if(String(file).endsWith('.tmp')&&!once){once=true;entered.resolve();await release.promise;throw Error('controlled disk failure')}return saved.call(this,file,...args)};
 const cache=createOriginalImageByteCache({directory,now:()=>2000,maxWriteWaitMs:30});
 try{
  const one=cache.put(value('one'));await entered.promise;
  assert.equal(await cache.put(value('timeout',{url:url+'&timeout'})),true);assert.equal(cache.stats.queueTimeouts,1);assert.equal(cache.stats.pendingWrites,1);
  release.resolve();await one;await cache.put(value('later',{url:url+'&later'}));assert.equal(cache.stats.writes,1);assert.equal(cache.stats.pendingWrites,0);assert.equal(cache.stats.pendingWriteBytes,0);
 }finally{release.resolve();fs.writeFile=saved}
}));

test('a paused empty claim cannot join a replacement writer after an ABA race',()=>fixture(async directory=>{
 const root=path.join(directory,'original-bytes'),lock=path.join(root,'.writer'),ready=path.join(directory,'ready');await fs.mkdir(root);
 const module=new URL('../scripts/lib/image-byte-observations.mjs',import.meta.url).href,saved=fsSync.mkdirSync;let once=false,child,done;
 const script=`import fs from 'node:fs/promises';import sync from 'node:fs';import {createOriginalImageByteCache} from ${JSON.stringify(module)};
  const saved=fs.readdir;let once=false;fs.readdir=async(...args)=>{const names=await saved(...args);if(args[0]===${JSON.stringify(root)}&&!once){once=true;sync.writeFileSync(${JSON.stringify(ready)},'ready');await new Promise(resolve=>setTimeout(resolve,400))}return names};
  const cache=createOriginalImageByteCache({directory:${JSON.stringify(directory)},now:()=>2000,maxDiskImages:1});await cache.put({...${JSON.stringify({...value('B',{url:url+'&B'}),buffer:undefined})},buffer:Buffer.from('B')});console.log(JSON.stringify(cache.stats));`;
 fsSync.mkdirSync=function(file,...args){
  const result=saved.call(this,file,...args);
  if(file===lock&&!once){
   once=true;child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
   done=new Promise((resolve,reject)=>{let output='',error='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>error+=bytes);child.on('exit',code=>code===0?resolve(JSON.parse(output)):reject(Error(error)))});
   const until=Date.now()+5000;while(!fsSync.existsSync(ready)&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
   if(!fsSync.existsSync(ready))throw Error('Replacement writer did not start');
  }
  return result;
 };
 try{
  const cache=createOriginalImageByteCache({directory,now:()=>2000,maxDiskImages:1});await cache.put(value('A',{url:url+'&A'}));
  fsSync.mkdirSync=saved;const other=await done;assert.equal(cache.stats.writes,0);assert.equal(other.writes,1);assert.equal((await fs.readdir(root)).length,1);
 }finally{fsSync.mkdirSync=saved;child?.kill()}
}));

test('signal-only cancellation is honored before admission and during an active write',()=>fixture(async directory=>{
 const early=new AbortController();early.abort();const cache=createOriginalImageByteCache({directory,now:()=>2000});
 assert.equal(await cache.put(value(),{signal:early.signal}),false);assert.equal(cache.stats.memoryBytes,0);assert.deepEqual(await fs.readdir(directory),[]);
 const entered=deferred(),release=deferred(),saved=fs.writeFile,active=new AbortController();
 fs.writeFile=async function(file,...args){if(String(file).endsWith('.tmp')){entered.resolve();await release.promise}return saved.call(this,file,...args)};
 try{const pending=cache.put(value(),{signal:active.signal});await entered.promise;active.abort();release.resolve();assert.equal(await pending,false);assert.equal(cache.stats.memoryBytes,0);assert.equal(cache.stats.pendingWriteBytes,0)}finally{release.resolve();fs.writeFile=saved}
 assert.deepEqual(await fs.readdir(path.join(directory,'original-bytes')),[]);
}));

test('queue overflow is decided before owning a body or yielding, with no duplicate retained copy',()=>fixture(async directory=>{
 const cache=createOriginalImageByteCache({directory,now:()=>2000,maxPendingImages:0}),input=value(Buffer.alloc(1024*1024)),saved=Buffer.from;let sourceCopies=0;
 Buffer.from=function(input,...args){if(input===valueBuffer)sourceCopies++;return saved.call(this,input,...args)};
 const valueBuffer=input.buffer;
 try{const pending=Array.from({length:40},()=>cache.put(input));assert.equal(cache.stats.queueSkips,40);assert.equal(cache.stats.pendingWrites,0);assert.equal(cache.stats.memoryBytes,1024*1024);assert.equal(sourceCopies,1);await Promise.all(pending)}finally{Buffer.from=saved}
 assert.deepEqual(await fs.readdir(directory),[]);
}));
