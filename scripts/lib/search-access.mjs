import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { encrypt,decrypt } from './crypto.mjs';

const reasons=new Set(['search_challenge','search_response_unavailable']);
export function searchService(provider){if(provider==='bing'||provider==='bing_web')return 'bing';if(provider==='duckduckgo')return provider;throw Error('unsupported_search_provider');}
// Only service access state crosses process boundaries. Queries, URLs, HTML and
// account identities remain in memory and never enter this encrypted record.
export function mergeExternalSearchAccess(...sources){
 const output={};
 for(const source of sources)for(const provider of ['bing','bing_web','duckduckgo']){
  const row=source?.[provider],until=Date.parse(row?.retryUntil||'');
  if(!Number.isFinite(until)||!reasons.has(row?.reason))continue;
  if(until>(Date.parse(output[provider]?.retryUntil||'')||0)||until===Date.parse(output[provider]?.retryUntil||'')&&row.reason==='search_challenge')output[provider]={retryUntil:new Date(until).toISOString(),reason:row.reason};
 }
 return output;
}
export function createSearchAccess({initial={},now=Date.now,persist=async value=>value,cacheMs=60000}={}){
 let access=mergeExternalSearchAccess(initial),writes=Promise.resolve();
 const tails=new Map(),pending=new Map(),cache=new Map();
 const snapshot=()=>mergeExternalSearchAccess(access);
 const guard=provider=>{searchService(provider);const records=[access[provider],provider==='bing_web'&&access.bing?.reason==='search_challenge'?access.bing:null];if(records.some(row=>(Date.parse(row?.retryUntil||'')||0)>now()))throw Error('search_provider_cooldown');};
 const save=()=>{const operation=writes.then(async()=>{const saved=await persist(snapshot());access=mergeExternalSearchAccess(access,saved);return snapshot();});writes=operation.catch(()=>{});return operation;};
 async function block(provider,reason){
  const service=searchService(provider);if(!reasons.has(reason))throw Error('unsupported_search_failure');
  const key=reason==='search_challenge'?service:provider;
  // A skip or duplicate observation during an existing barrier never renews it.
  if((Date.parse(access[key]?.retryUntil||'')||0)>now()&&access[key].reason===reason)return snapshot();
  const until=Math.max(Date.parse(access[key]?.retryUntil||'')||0,now()+20*60000);
  access=mergeExternalSearchAccess(access,{[key]:{retryUntil:new Date(until).toISOString(),reason}});
  return save();
 }
 async function waitWithin(promise,deadline){
  if(!Number.isFinite(deadline))return promise;
  const remaining=deadline-now();if(remaining<=0)throw Error('lookup_deadline');let timer;
  try{
   const result=await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('lookup_deadline')),Math.min(remaining,2147483647));})]);
   if(now()>=deadline)throw Error('lookup_deadline');return result;
  }finally{clearTimeout(timer);}
 }
 async function request(provider,query,load,{deadline=Infinity}={}){
  const service=searchService(provider);guard(provider);if(now()>=deadline)throw Error('lookup_deadline');
  const key=provider+'\0'+query,found=cache.get(key);
  if(found&&found.expiresAt>now())return found.html;
  const existing=pending.get(key);
  // A caller with less time can await an existing request using its own timer.
  // A longer-lived caller queues separately: a short leader may abort its fetch.
  if(existing&&existing.deadline>=deadline)return waitWithin(existing.promise,deadline);
  const work=(tails.get(service)||Promise.resolve()).catch(()=>{}).then(async()=>{
   // Recheck after acquiring this service's gate. Never retry a challenge, and
   // never issue a request whose own waiting budget has already expired.
   guard(provider);if(now()>=deadline)throw Error('lookup_deadline');
   const completed=cache.get(key);if(completed&&completed.expiresAt>now())return completed.html;
   const html=await load();
   cache.set(key,{html,expiresAt:now()+cacheMs});while(cache.size>32)cache.delete(cache.keys().next().value);
   return html;
  });
  const entry={promise:work,deadline};tails.set(service,work.catch(()=>{}));pending.set(key,entry);
  const complete=()=>{if(pending.get(key)===entry)pending.delete(key);};work.then(complete,complete);
  return waitWithin(work,deadline);
 }

 return {snapshot,block,request,flush:save};
}
export async function loadSearchAccess({root,password,initial={},now=Date.now}={}){
 if(!root)return createSearchAccess({initial,now});
 if(typeof password!=='string'||password.length<8)throw Error('搜索访问状态需要仪表盘密钥');
 const directory=path.join(root,'state'),filename=path.join(directory,'search-access.json.enc');
 const read=async file=>{try{return JSON.parse(decrypt(await fs.readFile(file),password).toString('utf8'));}catch(error){if(error.code==='ENOENT')return {};throw Error('搜索访问状态无法校验，停止以免重置冷却');}};
 const [stored,latest,discovery]=await Promise.all([read(filename),read(path.join(directory,'latest.json.enc')),read(path.join(directory,'discovery.json.enc'))]);
 const persist=async value=>{
  // Normal scan and merchant stages are sequential. Merge the latest disk value
  // again before an atomic write so a restored older snapshot cannot shorten it.
  const merged=mergeExternalSearchAccess(await read(filename),value);
  await fs.mkdir(directory,{recursive:true});const temporary=filename+'.tmp-'+randomUUID();
  try{await fs.writeFile(temporary,encrypt(Buffer.from(JSON.stringify(merged)),password));await fs.rename(temporary,filename);}
  finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  return merged;
 };
 const result=createSearchAccess({initial:mergeExternalSearchAccess(stored,latest.externalSearchAccess,discovery.externalSearchAccess,initial),now,persist});
 if(Object.keys(result.snapshot()).length)await result.flush();
 return result;
}
