import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash,randomUUID } from 'node:crypto';

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

// Persist only derived image fingerprints, never login state or source HTML.
// A fresh URL entry follows the source's explicit public cache lifetime (capped
// at24h). Otherwise the image body is read again; identical actual bytes can
// reuse computation by SHA256. Neither path renews product identity timestamps.
export function createFingerprintLoader({directory,fetchImage,fingerprint,now=Date.now,maxEntries=5000}={}){
 const stats={httpFreshReuses:0,contentReuses:0,computed:0,writes:0,pruned:0,imageFetches:0,downloadBytes:0,computeDurationMs:0};
 const boundedEntries=Number.isFinite(maxEntries)&&maxEntries>0?Math.min(5000,Math.floor(maxEntries)):5000;
 const maxFiles=Math.max(2,boundedEntries*2);let pruning=null,initialized=false,writesSincePrune=0;
 async function prune(){
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
  try{return JSON.parse(await fs.readFile(path.join(directory,name),'utf8'))}catch{return null}
 };
 const write=async(name,value)=>{
  if(!directory)return;
  let temporary;
  try{
   await fs.mkdir(directory,{recursive:true});
   const file=path.join(directory,name);temporary=file+'.'+randomUUID()+'.tmp';
   await fs.writeFile(temporary,JSON.stringify(value));await fs.rename(temporary,file);stats.writes++;writesSincePrune++;
  }catch{if(temporary)await fs.rm(temporary,{force:true}).catch(()=>{});/* A cache write must never prevent a current source observation. */}
 };
 const readContent=async sha=>{
  if(!/^[a-f0-9]{64}$/.test(sha||''))return null;
  const entry=await read('body-'+sha+'.json');
  return entry?.version===version&&entry.fingerprint?.contentSha256===sha&&entry.checksum===hash(JSON.stringify(entry.fingerprint))?entry.fingerprint:null;
 };
 async function get(url){
  if(!initialized){initialized=true;await prune()}
  const key='url-'+hash(url)+'.json',cached=await read(key),time=now();
  if(cached?.version===version&&Number.isFinite(cached.observedAt)&&Number.isFinite(cached.expiresAt)&&cached.observedAt>=0&&cached.observedAt<=time&&cached.expiresAt>time&&cached.expiresAt-cached.observedAt<=24*3600_000){
   const value=await readContent(cached.contentSha256);
   if(value){stats.httpFreshReuses++;return {...value,url,imageObservedAt:new Date(cached.observedAt).toISOString(),imageCacheExpiresAt:cached.expiresAt,imageCacheSource:'http_fresh'}};
  }
  stats.imageFetches++;const response=await fetchImage(url);
  if(!response?.buffer)return null;
  stats.downloadBytes+=response.buffer.length;
  const observedAt=now(),sha=hash(response.buffer),canStore=!/\bno-store\b/i.test(response.cacheControl||'');
  let value=canStore?await readContent(sha):null;
  if(value)stats.contentReuses++;
  else{const start=performance.now();value=await fingerprint(response.buffer,url);stats.computeDurationMs+=performance.now()-start;if(!value)return null;stats.computed++;}
  const {url:_url,imageObservedAt:_observed,imageCacheExpiresAt:_expiry,imageCacheSource:_source,...content}=value;
  content.contentSha256=sha;
  const expiresAt=observedAt+freshLifetime(response,observedAt);
  if(canStore){
   await write('body-'+sha+'.json',{version,fingerprint:content,checksum:hash(JSON.stringify(content))});
   await write(key,{version,contentSha256:sha,observedAt,expiresAt});
   if(writesSincePrune>=Math.min(100,maxFiles))await prune();
  }
  return {...content,url,imageObservedAt:new Date(observedAt).toISOString(),imageCacheExpiresAt:expiresAt,imageCacheSource:'current_body'};
 }
 return {get,stats,prune};
}
