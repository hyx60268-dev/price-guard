import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { encrypt,decrypt } from './crypto.mjs';
import { reconcileDurableState } from './state.mjs';
import { mergeYahooRequestAccess } from './yahoo-request-access.mjs';
import { mergeExternalSearchAccess } from './search-access.mjs';
import { mergeScanAdmission } from './scan-admission.mjs';
import { xianyuAccessKey } from './xianyu-session.mjs';
// Rakuma's dedicated merge is loaded only when its checkpoint exists.
export function mergeXianyuAccess(...records){
 let latest={};
 for(const row of records){
  if(row==null)continue;
  if(!row||typeof row!=='object'||Array.isArray(row))throw Error('Invalid Xianyu cooldown checkpoint');
  if(!Object.keys(row).length)continue;
  if(!['blocked','login_required'].includes(row.reason)||!Number.isFinite(Date.parse(row.retryAt))||!Number.isFinite(Date.parse(row.failedAt))||!Number.isInteger(row.failures)||row.failures<1||row.failures>4)throw Error('Invalid Xianyu cooldown checkpoint');
  if(Date.parse(row.retryAt)>(Date.parse(latest.retryAt)||0))latest={...row};
 }
 return latest;
}
function strictSearch(...records){
 for(const row of records){
  if(row==null)continue;
  if(typeof row!=='object'||Array.isArray(row))throw Error('Invalid search cooldown checkpoint');
  for(const [provider,hold] of Object.entries(row))if(!['bing','bing_web','duckduckgo'].includes(provider)||!['search_challenge','search_response_unavailable'].includes(hold?.reason)||!Number.isFinite(Date.parse(hold.retryUntil)))throw Error('Invalid search cooldown checkpoint');
 }
 return mergeExternalSearchAccess(...records);
}
async function read(file,key){try{const data=await fs.readFile(file);return JSON.parse(key?decrypt(data,key).toString('utf8'):data.toString('utf8'))}catch(error){if(error.code==='ENOENT')return undefined;throw Error('Cannot validate cadence checkpoint; refusing to reset state',{cause:error})}}
async function write(file,value,key){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.tmp-'+randomUUID();try{await fs.writeFile(tmp,key?encrypt(Buffer.from(JSON.stringify(value)),key):JSON.stringify(value));await fs.rename(tmp,file)}finally{await fs.unlink(tmp).catch(error=>{if(error.code!=='ENOENT')throw error})}}
export async function restoreCadenceState({root,staged,password,env=process.env}){
 if(!password||password.length<8)throw Error('Dashboard key required for checkpoint');
 const target=path.join(root,'state');
 const stagedLatest=await read(path.join(staged,'latest.json.enc'),password);
 if(!stagedLatest||typeof stagedLatest!=='object'||Array.isArray(stagedLatest))throw Error('Missing complete cadence checkpoint');
 for(const filename of ['latest.json.enc','discovery.json.enc']){
  const [current,saved]=await Promise.all([read(path.join(target,filename),password),read(path.join(staged,filename),password)]);
  if(saved)await write(path.join(target,filename),reconcileDurableState(current||{},saved),password);
 }
 const descriptors=[['yahoo-request-access.json.enc',password,mergeYahooRequestAccess],['search-access.json.enc',password,strictSearch],['scan-admission.json',null,mergeScanAdmission],['xianyu-access.json.enc',xianyuAccessKey(env),mergeXianyuAccess]];
 const rakuma=await read(path.join(staged,'rakuma-request-access.json'));
 const localRakuma=await read(path.join(target,'rakuma-request-access.json'));
 if(rakuma!==undefined||localRakuma!==undefined){
  const {mergeSourceAccessHolds,sourceAccessHoldFromCheckpoint}=await import('./source-access-hold.mjs');
  const unpack=value=>value===undefined?undefined:sourceAccessHoldFromCheckpoint(value,'rakuma');
  await write(path.join(target,'rakuma-request-access.json'),{version:1,source:'rakuma',hold:mergeSourceAccessHolds(unpack(localRakuma),unpack(rakuma))});
 }
 for(const [filename,key,merge] of descriptors){
  const [current,saved]=await Promise.all([read(path.join(target,filename),key),read(path.join(staged,filename),key)]);
  if(current!==undefined||saved!==undefined)await write(path.join(target,filename),merge(current,saved),key);
 }
 const pending='rakuma-request-access.json.pending';
 try{const bytes=await fs.readFile(path.join(staged,pending));await fs.writeFile(path.join(target,pending),bytes,{flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error})}catch(error){if(error.code!=='ENOENT')throw error}
 return {restored:true};
}
