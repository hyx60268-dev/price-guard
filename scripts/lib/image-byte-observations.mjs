import { createHash } from 'node:crypto';

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
  maxImageBytes=bounded(options.maxImageBytes,limits.maxImageBytes),entries=new Map();
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
  bytes+=owned.length;accepted++;return true;
 }
 function get(fingerprint){
  const key=observationKey(fingerprint),value=key&&entries.get(key);
  return value?Object.freeze({...value,buffer:Buffer.from(value.buffer)}):null;
 }
 function observeTransfer(value){
  if(!value||!Number.isSafeInteger(value.fetches)||value.fetches<0||!Number.isSafeInteger(value.settledFetches)||value.settledFetches<0||!Number.isSafeInteger(value.completedDecodedBytes)||value.completedDecodedBytes<0||!Number.isFinite(value.durationMs)||value.durationMs<0||!Number.isSafeInteger(value.unknownBodyTransfers)||value.unknownBodyTransfers<0)return;
  for(const key of Object.keys(transfers))transfers[key]+=value[key];
 }
 function clear(){entries.clear();bytes=0}
 return Object.freeze({observe,get,clear,observeTransfer,get transferStats(){return Object.freeze({...transfers})},get stats(){return Object.freeze({images:entries.size,bytes,accepted,rejected,evicted})}});
}
