import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { createOriginalImageByteCache } from './image-byte-observations.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const version=1;
const freshLifetime=(response,observedAt)=>{
 const directives=String(response.cacheControl||'').split(',').map(value=>value.trim());
 if(!directives.some(value=>/^public$/i.test(value))||directives.some(value=>/^(?:private|no-store|no-cache)(?:\s*=|$)/i.test(value)))return 0;
 const ages=directives.filter(value=>/^max-age(?:\s*=|$)/i.test(value));
 if(ages.length!==1||!/^max-age\s*=\s*(?:\d+|"\d+")$/i.test(ages[0]))return 0;
 const seconds=Number(ages[0].split('=')[1].trim().replaceAll('"',''));
 if(response.cacheAge!=null&&!/^\d+$/.test(String(response.cacheAge)))return 0;
 const date=Date.parse(response.responseDate||''),age=Math.max(Number(response.cacheAge)||0,Number.isFinite(date)?Math.max(0,observedAt-date)/1000:0);
 return Number.isFinite(seconds)?Math.min(24*3600,Math.max(0,seconds-age))*1000:0;
};

// Persist derived fingerprints and bounded original bytes, never login state or source HTML.
// A fresh URL entry follows the source's explicit public cache lifetime (capped
// at24h). Otherwise the image body is read again; identical actual bytes can
// reuse computation by SHA256. Neither path renews product identity timestamps.
export function createFingerprintLoader({directory,fetchImage,fingerprint,now=Date.now,maxEntries=5000,observeImageBytes,observeImageByteMiss,byteCacheOptions}={}){
 const originalBytes=createOriginalImageByteCache({...byteCacheOptions,directory,now});
 const completed=new Map(),latest=new Map(),pending=new Map(),urlWriters=new Set();
 let pendingOverflow=0,diskReuseBlocked=false;
 const stats={httpFreshReuses:0,contentReuses:0,computed:0,writes:0,pruned:0,imageFetches:0,downloadBytes:0,computeDurationMs:0};
 const boundedEntries=Number.isFinite(maxEntries)&&maxEntries>0?Math.min(5000,Math.floor(maxEntries)):5000;
 const maxFiles=Math.max(2,boundedEntries*2);let pruning=null,initialized=false,writesSincePrune=0;
 async function prune(){
  await originalBytes.prune();
  if(!directory)return;
  if(pruning)return pruning;
  pruning=(async()=>{
   try{
    const entries=await fs.readdir(directory);
    // Interrupted atomic writes are derived cache too, not unbounded leftovers.
    for(const name of entries.filter(name=>/^(?:url|body)-[a-f0-9]{64}\.json\.[a-f0-9-]+\.tmp$/.test(name))){await fs.rm(path.join(directory,name),{force:true});stats.pruned++;}
    const names=entries.filter(name=>/^(?:url|body)-[a-f0-9]{64}\.json$/.test(name));
    if(names.length>maxFiles){
     const files=await Promise.all(names.map(async name=>({name,mtime:(await fs.stat(path.join(directory,name))).mtimeMs})));
     files.sort((a,b)=>a.mtime-b.mtime||a.name.localeCompare(b.name));
     for(const file of files.slice(0,names.length-maxFiles)){await fs.unlink(path.join(directory,file.name));stats.pruned++;}
    }
   }catch{/* Missing/racing cache files are harmless misses. */}
   writesSincePrune=0;
  })().finally(()=>{pruning=null});
  return pruning;
 }
 const read=async name=>{
  if(!directory)return null;
  let handle;
  try{
   // Malformed derived files cannot allocate unbounded memory on a read-only peek.
   handle=await fs.open(path.join(directory,name),'r');const stat=await handle.stat();
   const bound=name.startsWith('url-')?2048:64*1024;
   if(!stat.isFile()||stat.size<2||stat.size>bound)return null;
   const buffer=Buffer.alloc(stat.size+1);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
   if(bytesRead!==stat.size)return null;return JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));
  }catch{return null}finally{await handle?.close().catch(()=>{})}
 };
 const write=async(name,value,stopped=()=>false)=>{
  if(!directory||stopped())return;
  let temporary;
  try{
   await fs.mkdir(directory,{recursive:true});
   if(stopped())return;
   const file=path.join(directory,name);temporary=file+'.'+randomUUID()+'.tmp';
   await fs.writeFile(temporary,JSON.stringify(value));
   if(stopped()){await fs.rm(temporary,{force:true});return}
   await fs.rename(temporary,file);stats.writes++;writesSincePrune++;
  }catch{if(temporary)await fs.rm(temporary,{force:true}).catch(()=>{});/* A cache write must never prevent a current source observation. */}
 };
 const readContent=async sha=>{
  if(!/^[a-f0-9]{64}$/.test(sha||''))return null;
  const entry=await read('body-'+sha+'.json');
  return entry?.version===version&&entry.fingerprint?.contentSha256===sha&&entry.checksum===hash(JSON.stringify(entry.fingerprint))?entry.fingerprint:null;
 };
 const current=(url,record)=>Boolean(record)&&latest.get(url)===record&&!record.conflict;
 const validFresh=(entry,time)=>entry?.version===version&&Number.isFinite(entry.observedAt)&&Number.isFinite(entry.expiresAt)&&
  entry.observedAt>=0&&entry.observedAt<=time&&entry.expiresAt>time&&entry.expiresAt-entry.observedAt<=24*3600_000;
 const permitted=(url,entry)=>{
  const record=latest.get(url);
  return !record||entry.observedAt>record.observedAt||entry.observedAt===record.observedAt&&record.ready===true&&entry.contentSha256===record.sha&&entry.expiresAt===record.expiresAt;
 };
 function recordObservation(url,observedAt,sha,expiresAt){
  if(typeof url!=='string'||url.length>8192||!Number.isFinite(observedAt)||observedAt<0)return null;
  const previous=latest.get(url);
  if(previous&&observedAt<previous.observedAt)return null;
  const conflict=Boolean(previous&&observedAt===previous.observedAt&&(previous.conflict||previous.sha!==sha||previous.expiresAt!==expiresAt));
  const record={observedAt,sha,expiresAt,conflict,ready:false};
  if(!latest.has(url)&&latest.size>=boundedEntries){
   const oldest=latest.keys().next().value;latest.delete(oldest);completed.delete(oldest);
   // Do not forget an unavailable watermark and then restore an older disk row.
   // Recent completed entries remain usable; disk-only reuse stays conservative.
   diskReuseBlocked=true;
  }
  latest.set(url,record);completed.delete(url);return record;
 }
 async function invalidate(url,record){
  if(!record||!directory||latest.get(url)!==record)return;
  if(urlWriters.has(url))return; // The active writer detects replacement and removes its own stale result.
  if(urlWriters.size>=boundedEntries){diskReuseBlocked=true;return;}
  urlWriters.add(url);
  try{await fs.rm(path.join(directory,'url-'+hash(url)+'.json'),{force:true});}
  catch{diskReuseBlocked=true;}
  finally{urlWriters.delete(url);}
 }
 async function publish(url,record,value,stopped){
  if(!directory||!current(url,record)||stopped()||urlWriters.has(url))return;
  if(urlWriters.size>=boundedEntries){diskReuseBlocked=true;return;}
  urlWriters.add(url);
  try{
   await write('url-'+hash(url)+'.json',value,()=>stopped()||!current(url,record));
   // A newer observation may arrive while the atomic rename is settling.
   // No other same-URL writer can publish until this stale result is removed.
   if(stopped()||!current(url,record))await fs.rm(path.join(directory,'url-'+hash(url)+'.json'),{force:true});
  }catch{diskReuseBlocked=true;}
  finally{urlWriters.delete(url);}
 }
 const remember=(value,record=null)=>{
  const observedAt=Date.parse(value?.imageObservedAt),expiresAt=value?.imageCacheExpiresAt,time=now();
  if(typeof value?.url==='string'&&value.url.length<=8192&&Number.isFinite(time)&&
   validFresh({version,observedAt,expiresAt},time)&&/^[a-f0-9]{64}$/.test(value.contentSha256||'')){
   // Successful disk-only peeks also establish the known original clock/hash.
   // Never let a late disk restoration replace a newer observed invalidation.
   if(!record){
    const known=latest.get(value.url);
    if(!permitted(value.url,{observedAt,expiresAt,contentSha256:value.contentSha256})||
     diskReuseBlocked&&!(known?.ready&&!known.conflict&&known.observedAt===observedAt&&known.sha===value.contentSha256&&known.expiresAt===expiresAt))return value;
    record=recordObservation(value.url,observedAt,value.contentSha256,expiresAt);
   }
   if(!current(value.url,record))return value;
   record.ready=true;
   if(Buffer.byteLength(JSON.stringify(value),'utf8')>64*1024)return value;
   if(completed.size>=boundedEntries&&!completed.has(value.url))completed.delete(completed.keys().next().value);
   completed.set(value.url,structuredClone(value));
  }else if(value?.url&&(!record||latest.get(value.url)===record))completed.delete(value.url);
  return value;
 };
 // Synchronous final-publication check. Only settled known metadata is exposed:
 // no disk read, transport, fingerprint, byte restoration, mutation or renewal.
 function peekKnownObservation(url){
  if(pendingOverflow||pending.has(url))return {status:'unavailable',reason:'pending'};
  const record=latest.get(url);if(!record)return {status:'unknown'};
  const time=now();if(!Number.isFinite(time)||time<0||record.observedAt>time)return {status:'unavailable',reason:'invalid_clock'};
  if(record.conflict)return {status:'unavailable',reason:'same_time_conflict'};
  if(!record.ready)return {status:'unavailable',reason:'original_unavailable'};
  if(record.expiresAt<=time)return {status:'unavailable',reason:'expired'};
  return {status:'available',contentSha256:record.sha,imageObservedAt:new Date(record.observedAt).toISOString(),imageCacheExpiresAt:record.expiresAt};
 }
 // Cache-only access: never calls load(), fetchImage(), fingerprint(), prune(),
 // writes, or byte restoration. Pending and absent entries are ordinary misses.
 async function peek(url,{stopped=()=>false}={}){
  if(typeof url!=='string'||url.length>8192||stopped()||pendingOverflow||pending.has(url))return null;
  const time=now();if(!Number.isFinite(time)||time<0)return null;const ready=completed.get(url);
  if(ready&&ready.imageCacheExpiresAt>time&&Date.parse(ready.imageObservedAt)<=time)return structuredClone(ready);
  completed.delete(url);if(diskReuseBlocked)return null;
  const cached=await read('url-'+hash(url)+'.json');
  if(stopped()||pendingOverflow||pending.has(url)||diskReuseBlocked||!validFresh(cached,time)||!permitted(url,cached))return null;
  const value=await readContent(cached.contentSha256);
  if(stopped()||pendingOverflow||pending.has(url)||diskReuseBlocked||!value||!validFresh(cached,now())||!permitted(url,cached))return null;
  return structuredClone(remember({...value,url,imageObservedAt:new Date(cached.observedAt).toISOString(),imageCacheExpiresAt:cached.expiresAt,imageCacheSource:'http_fresh'}));
 }
 // Bounds are per caller. In particular, never make another caller's pending
 // download inherit this signal/deadline. Fully verified persisted content is safe.
 async function get(url,options){
  if(!options?.signal&&!Number.isFinite(options?.deadlineAt))return load(url);
  const controller=new AbortController(),clock=options.now||now;
  const context={...options,signal:controller.signal,now:clock};
  let timer;
  const abort=()=>controller.abort();
  const stopped=()=>{
   if(Number.isFinite(context.deadlineAt)&&clock()>=context.deadlineAt)abort();
   return controller.signal.aborted;
  };
  const cancelled=new Promise(resolve=>controller.signal.addEventListener('abort',()=>resolve(null),{once:true}));
  options.signal?.addEventListener('abort',abort,{once:true});
  if(options.signal?.aborted)abort();
  const scheduleDeadline=()=>{
   if(stopped()||!Number.isFinite(context.deadlineAt))return;
   timer=setTimeout(scheduleDeadline,Math.min(2_147_483_647,Math.max(1,context.deadlineAt-clock())));
  };
  try{
   scheduleDeadline();
   if(stopped())return null;
   // A non-cooperative injected reader may settle later. load() checks bounds
   // after every stage so that late results cannot compute or populate cache.
   return await Promise.race([load(url,context,stopped),cancelled]);
  }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort)}
 }
 async function load(url,context,stopped=()=>false){
  if(stopped())return null;
  const tracked=typeof url==='string'&&url.length<=8192&&(pending.has(url)||pending.size<boundedEntries);
  if(tracked)pending.set(url,(pending.get(url)||0)+1);else pendingOverflow++;
  let observation=null;
  try{
  if(!initialized){initialized=true;await prune()}
  if(stopped())return null;
  const key='url-'+hash(url)+'.json',cached=await read(key),time=now();
  if(stopped())return null;
  // Observation-only metadata cannot change the ordinary get request path.
  // remember() separately refuses to promote any superseded/untrusted disk hit.
  if(validFresh(cached,time)){
   const value=await readContent(cached.contentSha256);
   if(stopped())return null;
   if(value){
    const result={...value,url,imageObservedAt:new Date(cached.observedAt).toISOString(),imageCacheExpiresAt:cached.expiresAt,imageCacheSource:'http_fresh'};
    await reuseBytes(result,{stopped});if(stopped())return null;
    stats.httpFreshReuses++;return remember(result);
   }
  }
  if(stopped())return null;
  stats.imageFetches++;const response=await fetchImage(url,context);
  if(!response?.buffer)return null;
  const observedAt=now(),sha=hash(response.buffer),expiresAt=observedAt+freshLifetime(response,observedAt),canStore=!/\bno-store\b/i.test(response.cacheControl||'');
  observation=recordObservation(url,observedAt,sha,expiresAt);await invalidate(url,observation);
  if(stopped())return null;
  stats.downloadBytes+=response.buffer.length;
  let value=canStore?await readContent(sha):null;
  if(stopped())return null;
  if(value)stats.contentReuses++;
  else{
   const start=performance.now();value=await fingerprint(response.buffer,url);stats.computeDurationMs+=performance.now()-start;
   if(stopped()||!value)return null;
   stats.computed++;
  }
  const {url:_url,imageObservedAt:_observed,imageCacheExpiresAt:_expiry,imageCacheSource:_source,...content}=value;
  content.contentSha256=sha;
  if(canStore){
   await write('body-'+sha+'.json',{version,fingerprint:content,checksum:hash(JSON.stringify(content))},stopped);
   if(stopped())return null;

   if(writesSincePrune>=Math.min(100,maxFiles))await prune();
  }
  if(stopped())return null;
  const result={...content,url,imageObservedAt:new Date(observedAt).toISOString(),imageCacheExpiresAt:expiresAt,imageCacheSource:'current_body'};
  // Geometry may reuse only complete successfully fingerprinted original bodies.
  // Public HTTP freshness permits bounded retention; every lookup preserves the
  // source observation and exact URL/hash binding. Missing bytes never refetch.
  if(expiresAt>observedAt){await originalBytes.put({...result,buffer:response.buffer},{stopped,signal:context?.signal});if(stopped())return null}
  observeBytes({...result,buffer:response.buffer});
  if(expiresAt>observedAt&&observation&&current(url,observation)){
   await publish(url,observation,{version,contentSha256:sha,observedAt,expiresAt},stopped);
   if(stopped())return null;
   return remember(result,observation);
  }
  return result;
  }finally{
   if(observation&&latest.get(url)===observation&&!observation.ready)await invalidate(url,observation);
   if(tracked){const count=pending.get(url)-1;if(count)pending.set(url,count);else pending.delete(url);}else pendingOverflow--;
  }
 }
 function observeBytes(value){
  if(typeof observeImageBytes!=='function')return;
  try{
   const observed=observeImageBytes(Object.freeze({buffer:Buffer.from(value.buffer),url:value.url,contentSha256:value.contentSha256,imageObservedAt:value.imageObservedAt}));
   if(observed&&typeof observed.then==='function')Promise.resolve(observed).catch(()=>{});
  }catch{/* Observation cannot alter fingerprint collection or initiate transport. */}
 }
 async function reuseBytes(value,{stopped=()=>false}={}){
  if(!value||stopped())return 'stopped';
  const result=await originalBytes.get(value,{stopped});
  if(stopped())return 'stopped';
  if(result.value)observeBytes(result.value);
  else if(typeof observeImageByteMiss==='function'){
   try{const pending=observeImageByteMiss(value,result.reason);if(pending&&typeof pending.then==='function')Promise.resolve(pending).catch(()=>{})}catch{/* Optional diagnostic. */}
  }
  return result.reason;
 }
 return {get,peek,peekKnownObservation,stats,prune,reuseBytes,get byteStats(){return originalBytes.stats}};
}
