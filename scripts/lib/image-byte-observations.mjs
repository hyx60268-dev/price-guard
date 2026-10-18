import { createHash,randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

const limits=Object.freeze({maxImages:32,maxBytes:64*1024*1024,maxImageBytes:12_000_000});
const bounded=(value,maximum)=>Number.isSafeInteger(value)&&value>=0?Math.min(value,maximum):maximum;
const observationKey=value=>{
 if(typeof value?.url!=='string'||!value.url||value.url.length>8192||
    !/^[a-f0-9]{64}$/.test(value.contentSha256||'')||typeof value.imageObservedAt!=='string')return null;
 const time=Date.parse(value.imageObservedAt);
 if(!Number.isFinite(time)||time<0||new Date(time).toISOString()!==value.imageObservedAt)return null;
 return JSON.stringify([value.url,value.contentSha256,value.imageObservedAt]);
};

// A comparison-local, bounded store of successfully decoded original bodies.
// This is not an HTTP cache: a miss cannot fetch, and lookup cannot substitute
// another URL/query, content hash or observation time. Nothing is written to disk.
export function createImageByteObservationPool(options={}){
 const maxImages=bounded(options.maxImages,limits.maxImages),maxBytes=bounded(options.maxBytes,limits.maxBytes),
  maxImageBytes=bounded(options.maxImageBytes,limits.maxImageBytes),entries=new Map(),unavailable=new Map();
 let bytes=0,accepted=0,rejected=0,evicted=0;
 const transfers={fetches:0,settledFetches:0,completedDecodedBytes:0,durationMs:0,unknownBodyTransfers:0};
 const remove=key=>{const value=entries.get(key);if(value){bytes-=value.buffer.length;entries.delete(key)}};
 function observe(value){
  const key=observationKey(value),buffer=value?.buffer;
  if(!key||!Buffer.isBuffer(buffer)||buffer.length===0||buffer.length>maxImageBytes||
     buffer.length>maxBytes||maxImages===0||createHash('sha256').update(buffer).digest('hex')!==value.contentSha256){rejected++;return false}
  if(entries.has(key))return true;
  while(entries.size>=maxImages||bytes+buffer.length>maxBytes){remove(entries.keys().next().value);evicted++}
  // Own the retained bytes. Neither a downloader nor a geometry consumer can
  // mutate the body associated with another fingerprint or concurrent lookup.
  const owned=Buffer.from(buffer);
  entries.set(key,{buffer:owned,url:value.url,contentSha256:value.contentSha256,imageObservedAt:value.imageObservedAt});
  bytes+=owned.length;accepted++;unavailable.delete(key);return true;
 }
 function get(fingerprint){
  const key=observationKey(fingerprint),value=key&&entries.get(key);
  return value?Object.freeze({...value,buffer:Buffer.from(value.buffer)}):null;
 }
 function observeTransfer(value){
  if(!value||!Number.isSafeInteger(value.fetches)||value.fetches<0||!Number.isSafeInteger(value.settledFetches)||value.settledFetches<0||!Number.isSafeInteger(value.completedDecodedBytes)||value.completedDecodedBytes<0||!Number.isFinite(value.durationMs)||value.durationMs<0||!Number.isSafeInteger(value.unknownBodyTransfers)||value.unknownBodyTransfers<0)return;
  for(const key of Object.keys(transfers))transfers[key]+=value[key];
 }
 function observeUnavailable(value,reason){
  const key=observationKey(value);
  if(!key||entries.has(key)||!['bytes_missing','bytes_corrupt','bytes_expired'].includes(reason))return;
  if(unavailable.size>=limits.maxImages)unavailable.delete(unavailable.keys().next().value);
  unavailable.set(key,reason);
 }
 function unavailableReason(value){return unavailable.get(observationKey(value))||null}
 function clear(){entries.clear();unavailable.clear();bytes=0}
 return Object.freeze({observe,get,has:value=>entries.has(observationKey(value)),clear,observeTransfer,observeUnavailable,unavailableReason,get transferStats(){return Object.freeze({...transfers})},get stats(){return Object.freeze({images:entries.size,bytes,accepted,rejected,evicted})}});
}

// Reusable bodies are a separate, conservative HTTP cache. Limits count actual
// encoded disk bytes (including the header) and cannot be increased by callers.
// A body is never a reason to fetch, renew freshness or alias URL variants.
export const originalImageByteLimits=Object.freeze({maxMemoryBytes:16*1024*1024,maxMemoryImages:256,maxDiskBytes:64*1024*1024,maxDiskImages:512,maxImageBytes:12_000_000,maxPendingImages:20,maxPendingBytes:16*1024*1024,maxWriteWaitMs:2000});
export function createOriginalImageByteCache({directory,now=Date.now,...options}={}){
 const cap=Object.fromEntries(Object.entries(originalImageByteLimits).map(([key,max])=>[key,bounded(options[key],max)]));
 const root=directory?path.join(directory,'original-bytes'):null,memory=new Map(),diskIndex=new Map();
 // Reserve room for the bounded writer/recovery metadata even mid-write.
 const diskBudget=Math.max(0,cap.maxDiskBytes-256);
 const counters={memoryReuses:0,diskReuses:0,misses:0,corrupt:0,expired:0,writes:0,pruned:0,memoryBytes:0,memoryImages:0,diskBytes:0,diskImages:0,diskBlocked:0,pendingWrites:0,pendingWriteBytes:0,queueSkips:0,queueTimeouts:0};
 const filename=url=>'bytes-'+createHash('sha256').update(url).digest('hex')+'.bin';
 const valid=value=>observationKey(value)&&Number.isFinite(value.imageCacheExpiresAt)&&
  value.imageCacheExpiresAt>Date.parse(value.imageObservedAt)&&value.imageCacheExpiresAt-Date.parse(value.imageObservedAt)<=24*3600_000;
 const fresh=value=>valid(value)&&Date.parse(value.imageObservedAt)<=now()&&value.imageCacheExpiresAt>now();
 const remove=key=>{const value=memory.get(key);if(value){counters.memoryBytes-=value.buffer.length;memory.delete(key);counters.memoryImages=memory.size}};
 function remember(value){
  for(const [key,item] of memory)if(!fresh(item))remove(key);
  if(!cap.maxMemoryImages||value.buffer.length>cap.maxMemoryBytes)return;
  const key=observationKey(value);if(memory.get(key)?.imageCacheExpiresAt===value.imageCacheExpiresAt)return;remove(key);
  while(memory.size>=cap.maxMemoryImages||counters.memoryBytes+value.buffer.length>cap.maxMemoryBytes)remove(memory.keys().next().value);
  memory.set(key,{...value,buffer:Buffer.from(value.buffer)});counters.memoryBytes+=value.buffer.length;counters.memoryImages=memory.size;
 }
 const outcome=(reason,value)=>({reason,...(value?{value:Object.freeze({...value,buffer:Buffer.from(value.buffer)})}:{})});
 // Open once and bound metadata/allocation before reading any body. Atomic
 // replacement cannot splice a new record's bytes into an old record's clock.
 async function readRecord(file,body=true){
  let handle;
  try{
   if(!(await fs.lstat(file)).isFile())return {reason:'bytes_corrupt'};
   handle=await fs.open(file,fsSync.constants.O_RDONLY|fsSync.constants.O_NOFOLLOW|fsSync.constants.O_NONBLOCK);const stat=await handle.stat();
   if(!stat.isFile()||stat.size<5||stat.size>cap.maxImageBytes+16388||stat.size>cap.maxDiskBytes)return {reason:'bytes_corrupt',size:stat.size};
   const prefix=Buffer.alloc(4);if((await handle.read(prefix,0,4,0)).bytesRead!==4)return {reason:'bytes_corrupt',size:stat.size};
   const length=prefix.readUInt32BE();if(length<2||length>16384||length+4>=stat.size)return {reason:'bytes_corrupt',size:stat.size};
   const header=Buffer.alloc(length);if((await handle.read(header,0,length,4)).bytesRead!==length)return {reason:'bytes_corrupt',size:stat.size};
   const value=JSON.parse(header.toString('utf8'));
   if(value.version!==1||!valid(value)||!Number.isSafeInteger(value.bodyBytes)||value.bodyBytes<1||value.bodyBytes>cap.maxImageBytes||stat.size!==4+length+value.bodyBytes||path.basename(file)!==filename(value.url))return {reason:'bytes_corrupt',size:stat.size};
   if(!fresh(value))return {reason:'bytes_expired',size:stat.size};
   if(body){
    const buffer=Buffer.alloc(value.bodyBytes);let offset=0;
    while(offset<buffer.length){const read=await handle.read(buffer,offset,buffer.length-offset,4+length+offset);if(!read.bytesRead)return {reason:'bytes_corrupt',size:stat.size};offset+=read.bytesRead}
    if(createHash('sha256').update(buffer).digest('hex')!==value.contentSha256)return {reason:'bytes_corrupt',size:stat.size};
    value.buffer=buffer;
   }
   return {reason:'hit',value,size:stat.size};
  }catch(error){return {reason:error?.code==='ENOENT'?'bytes_missing':'bytes_corrupt'}}
  finally{await handle?.close().catch(()=>{})}
 }
 async function safeRoot(){
  if(!root)return false;
  try{return (await fs.lstat(root)).isDirectory()&&await fs.realpath(root)===path.join(await fs.realpath(directory),'original-bytes')}catch{return false}
 }
 // Each writer creates an owner-named file inside the exclusive directory.
 // Reaping removes only a dead owner's unique file, then rmdir succeeds only
 // if the directory is still empty. A concurrent new claim either has its own
 // owner file (rmdir fails), or its owner creation fails and it cannot write.
 function claim(lock){
  const owner=process.pid+'-'+randomUUID()+'.owner';
  for(let attempt=0;attempt<2;attempt++){
   try{
    fsSync.mkdirSync(lock);const created=fsSync.lstatSync(lock);
    fsSync.writeFileSync(path.join(lock,owner),'',{flag:'wx'});
    const current=fsSync.lstatSync(lock),owners=fsSync.readdirSync(lock);
    if(created.dev!==current.dev||created.ino!==current.ino||owners.length!==1||owners[0]!==owner){
     // An empty abandoned claim may have been replaced before owner creation.
     // Never enter the critical section unless this is still our sole claim.
     fsSync.unlinkSync(path.join(lock,owner));return null;
    }
    return owner;
   }catch{
    try{
     if(!fsSync.lstatSync(lock).isDirectory())return null;
     const names=fsSync.readdirSync(lock);
     if(names.length>1)return null;
     if(names.length){
      const match=/^(\d+)-[a-f0-9-]+\.owner$/.exec(names[0]);if(!match)return null;
      const pid=Number(match[1]);if(!Number.isSafeInteger(pid)||pid<1)return null;
      try{process.kill(pid,0);return null}catch(error){if(error.code!=='ESRCH')return null}
      fsSync.unlinkSync(path.join(lock,names[0]));
     }
     fsSync.rmdirSync(lock);
    }catch{return null}
   }
  }
  return null;
 }
 async function withWriter(fn,beforeRelease){
  if(!root)return false;
  const lock=path.join(root,'.writer');let owner;
  try{
   await fs.mkdir(root,{recursive:true});
   if(!await safeRoot()){counters.diskBlocked++;return false}
   owner=claim(lock);if(!owner)return false;
   return await fn();
  }catch{return false}
  finally{
   if(owner){
    try{await beforeRelease?.()}catch{/* Best-effort rollback cannot fail fingerprints. */}finally{
     // Release has no asynchronous gap in which another writer can lose its
     // newly created claim to this writer's delayed cleanup.
     try{fsSync.unlinkSync(path.join(lock,owner));fsSync.rmdirSync(lock)}catch{/* Cache-only failure. */}
    }
   }
  }
 }
 const identity=stat=>[stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
 async function trim(reserveBytes=0,reserveImages=0){
  if(!await safeRoot()){counters.diskBlocked++;return false}
  const names=await fs.readdir(root),entries=[],present=new Set();let foreignBytes=0,foreignImages=0,blocked=false;
  // Bound concurrent metadata reads. Existing unchanged files need only lstat,
  // rather than reopening every header after each of hundreds of downloads.
  for(let start=0;start<names.length;start+=32){const batch=await Promise.allSettled(names.slice(start,start+32).map(async name=>{
   const file=path.join(root,name);
   if(/^bytes-[a-f0-9]{64}\.bin\.[a-f0-9-]+\.tmp$/.test(name)){await fs.rm(file,{force:true});counters.pruned++;return}
   if(!/^bytes-[a-f0-9]{64}\.bin$/.test(name)){
    if(name==='.writer')return;
    const stat=await fs.lstat(file);foreignBytes+=stat.size;foreignImages++;if(!stat.isFile())blocked=true;return;
   }
   present.add(name);const stat=await fs.lstat(file),prior=diskIndex.get(name);
   const record=stat.isFile()&&prior?.identity===identity(stat)?{reason:fresh(prior.value)?'hit':'bytes_expired',value:prior.value,size:stat.size}:await readRecord(file,false);
   if(record.reason!=='hit'){await fs.rm(file,{force:true});diskIndex.delete(name);counters.pruned++;return}
   diskIndex.set(name,{identity:identity(stat),value:record.value,size:stat.size});
   entries.push({name,file,size:stat.size,time:Date.parse(record.value.imageObservedAt)});
  }));if(batch.some(result=>result.status==='rejected')){counters.diskBlocked++;return false}}
  for(const name of diskIndex.keys())if(!present.has(name))diskIndex.delete(name);
  entries.sort((a,b)=>a.time-b.time||a.file.localeCompare(b.file));
  let bytes=foreignBytes+entries.reduce((sum,item)=>sum+item.size,0);
  while(entries.length&&(bytes+reserveBytes>diskBudget||entries.length+foreignImages+reserveImages>cap.maxDiskImages)){
   const entry=entries.shift();await fs.rm(entry.file,{force:true});diskIndex.delete(entry.name);bytes-=entry.size;counters.pruned++;
  }
  counters.diskBytes=bytes;counters.diskImages=entries.length+foreignImages;
  const fits=!blocked&&bytes+reserveBytes<=diskBudget&&entries.length+foreignImages+reserveImages<=cap.maxDiskImages;
  if(!fits)counters.diskBlocked++;return fits;
 }
 async function prune(){
  for(const [key,value] of memory)if(!fresh(value))remove(key);
  if(!root)return;
  // Avoid creating a disk directory just by reading or failing a download.
  try{await fs.access(root)}catch{return}
  await withWriter(()=>trim());
 }
 const pending=[];let writing=false;
 function enqueueWrite(run,bytes,{stopped,signal}){
  if(counters.pendingWrites>=cap.maxPendingImages||counters.pendingWriteBytes+bytes>cap.maxPendingBytes||!cap.maxWriteWaitMs){counters.queueSkips++;return Promise.resolve(false)}
  counters.pendingWrites++;counters.pendingWriteBytes+=bytes;
  return new Promise(resolve=>{
   const task={run,bytes,stopped,resolve,started:false,finished:false,queuedAt:performance.now(),timer:null,signal,abort:null};
   const finish=result=>{
    if(task.finished)return;task.finished=true;clearTimeout(task.timer);signal?.removeEventListener('abort',task.abort);
    counters.pendingWrites--;counters.pendingWriteBytes-=bytes;resolve(result);
   };
   task.finish=finish;
   const cancel=()=>{if(task.started||task.finished)return;const index=pending.indexOf(task);if(index>=0)pending.splice(index,1);finish(false)};
   task.abort=cancel;signal?.addEventListener('abort',cancel,{once:true});
   const watch=()=>{
    if(task.started||task.finished)return;
    if(stopped()||signal?.aborted){cancel();return}
    const remaining=cap.maxWriteWaitMs-(performance.now()-task.queuedAt);
    if(remaining<=0){counters.queueTimeouts++;cancel();return}
    task.timer=setTimeout(watch,Math.min(25,remaining));
   };
   pending.push(task);watch();drainWrites();
  });
 }
 function drainWrites(){
  if(writing)return;
  const task=pending.shift();if(!task)return;
  if(task.finished){drainWrites();return}
  if(task.stopped()||task.signal?.aborted){task.finish(false);drainWrites();return}
  if(performance.now()-task.queuedAt>=cap.maxWriteWaitMs){counters.queueTimeouts++;task.finish(false);drainWrites();return}
  task.started=true;clearTimeout(task.timer);writing=true;
  Promise.resolve().then(task.run).then(()=>task.finish(true),()=>task.finish(false)).finally(()=>{writing=false;drainWrites()});
 }
 async function put(value,{stopped:callerStopped=()=>false,signal}={}){
  const stopped=()=>signal?.aborted||callerStopped();
  if(stopped()||!fresh(value)||!Buffer.isBuffer(value.buffer)||!value.buffer.length||value.buffer.length>cap.maxImageBytes||createHash('sha256').update(value.buffer).digest('hex')!==value.contentSha256)return false;
  const stored={url:value.url,contentSha256:value.contentSha256,imageObservedAt:value.imageObservedAt,imageCacheExpiresAt:value.imageCacheExpiresAt,buffer:value.buffer};
  // Admission precedes ownership/copying. A rejected request falls straight
  // through to bounded RAM without retaining a body behind an awaited promise.
  if(!root||!cap.maxDiskImages){if(!stopped())remember(stored);return !stopped()}
  if(stopped())return false;
  const header=Buffer.from(JSON.stringify({version:1,url:stored.url,contentSha256:stored.contentSha256,imageObservedAt:stored.imageObservedAt,imageCacheExpiresAt:stored.imageCacheExpiresAt,bodyBytes:stored.buffer.length}));
  const total=4+header.length+stored.buffer.length;if(header.length>16384||total>diskBudget){remember(stored);return true}
  if(counters.pendingWrites>=cap.maxPendingImages||counters.pendingWriteBytes+stored.buffer.length>cap.maxPendingBytes||!cap.maxWriteWaitMs){counters.queueSkips++;remember(stored);return true}
  // No await between this admission check, ownership and queue reservation.
  stored.buffer=Buffer.from(stored.buffer);
  let writtenIdentity=null;
  await enqueueWrite(()=>withWriter(async()=>{
   let temporary;
   try{
    if(stopped()||!await trim(total,1)||stopped())return;
    const name=filename(stored.url),file=path.join(root,name),previous=diskIndex.get(name);temporary=file+'.'+randomUUID()+'.tmp';
    const prefix=Buffer.alloc(4);prefix.writeUInt32BE(header.length);
    await fs.writeFile(temporary,(async function*(){yield prefix;yield header;yield stored.buffer})());
    if(stopped()||!await safeRoot()||stopped())return;
    await fs.rename(temporary,file);temporary=null;
    const stat=fsSync.lstatSync(file);writtenIdentity=identity(stat);
    diskIndex.set(name,{identity:writtenIdentity,value:{...stored,buffer:undefined},size:stat.size});
    counters.diskBytes+=stat.size-(previous?.size||0);counters.diskImages+=previous?0:1;counters.writes++;
   }finally{if(temporary)await fs.rm(temporary,{force:true}).catch(()=>{})}
  },async()=>{
   // Roll back while still owning the writer claim, so a canceled publication
   // cannot survive merely because another process won a cleanup race.
   if((stopped()||!fresh(stored))&&writtenIdentity){
    const file=path.join(root,filename(stored.url)),stat=await fs.lstat(file).catch(()=>null);
    if(stat&&identity(stat)===writtenIdentity)await fs.rm(file,{force:true});
    await trim();
   }
  }),stored.buffer.length,{stopped,signal});
  if(stopped()||!fresh(stored)){remove(observationKey(stored));return false}
  remember(stored);return true;
 }
 async function get(value,{stopped=()=>false}={}){
  if(stopped())return outcome('stopped');
  for(const [key,item] of memory)if(!fresh(item))remove(key);
  if(!fresh(value)){counters.expired++;return outcome('bytes_expired')}
  const key=observationKey(value),resident=memory.get(key);
  if(resident&&resident.imageCacheExpiresAt===value.imageCacheExpiresAt){counters.memoryReuses++;return outcome('memory_hit',resident)}
  if(root&&await safeRoot()){
   const record=await readRecord(path.join(root,filename(value.url)));
   if(stopped())return outcome('stopped');
   if(!fresh(value)){counters.expired++;return outcome('bytes_expired')}
   if(record.reason==='hit'&&observationKey(record.value)===key&&record.value.imageCacheExpiresAt===value.imageCacheExpiresAt){
    remember(record.value);counters.diskReuses++;return outcome('disk_hit',record.value);
   }
   if(record.reason==='bytes_corrupt'){counters.corrupt++;return outcome(record.reason)}
   if(record.reason==='bytes_expired'){counters.expired++;return outcome(record.reason)}
  }
  counters.misses++;return outcome('bytes_missing');
 }
 return Object.freeze({get,put,prune,get stats(){return Object.freeze({...counters})}});
}
