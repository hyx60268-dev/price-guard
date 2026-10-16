import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { encrypt,decrypt } from './crypto.mjs';

// Numeric epoch milliseconds preserve deadlines beyond ISO Date's range.
// JSON cannot represent Infinity, so indefinite server holds have an explicit tag.
export const yahooRetryAt=value=>value?.reason==='http_429'&&(value.retryAt==='indefinite'||typeof value.retryAt==='number'&&Number.isFinite(value.retryAt)&&value.retryAt>0)?value.retryAt==='indefinite'?Infinity:value.retryAt:0;
export function mergeYahooRequestAccess(...sources){
 // Missing fields in legacy snapshots and an explicit empty record are safe.
 // A present malformed hold is not absence: fail closed instead of resetting it.
 for(const source of sources){
  if(source===undefined)continue;
  if(!source||typeof source!=='object'||Array.isArray(source)||Object.keys(source).length&&!yahooRetryAt(source))throw Error('Yahoo 冷却状态无效，停止以免重置冷却');
 }
 const retryAt=Math.max(0,...sources.map(yahooRetryAt));
 return retryAt?{reason:'http_429',retryAt:retryAt===Infinity?'indefinite':retryAt}:{};
}
export function createYahooRequestAccess({initial={},persist=async value=>value}={}){
 let state=mergeYahooRequestAccess(initial),writes=Promise.resolve();
 const snapshot=()=>({...state});
 const flush=()=>{const operation=writes.then(async()=>{state=mergeYahooRequestAccess(state,await persist(snapshot()));return snapshot()});writes=operation.catch(()=>{});return operation};
 return {snapshot,flush,async block(retryAt){state=mergeYahooRequestAccess(state,{reason:'http_429',retryAt:retryAt===Infinity?'indefinite':retryAt});return flush()}};
}
export async function loadYahooRequestAccess({root,password,initial={}}={}){
 if(!root)return createYahooRequestAccess({initial});
 if(typeof password!=='string'||password.length<8)throw Error('Yahoo 冷却状态需要仪表盘密钥');
 const directory=path.join(root,'state'),filename=path.join(directory,'yahoo-request-access.json.enc');
 const read=async file=>{try{return JSON.parse(decrypt(await fs.readFile(file),password).toString('utf8'))}catch(error){if(error.code==='ENOENT')return {};throw Error('Yahoo 冷却状态无法校验，停止以免重置冷却')}};
 const [stored,latest,discovery]=await Promise.all([read(filename),read(path.join(directory,'latest.json.enc')),read(path.join(directory,'discovery.json.enc'))]);
 const persist=async value=>{
  // Workflow writers share the pages lock. Merge restored and local state by
  // maximum deadline, then atomically checkpoint before any retry is admitted.
  const merged=mergeYahooRequestAccess(await read(filename),value);
  await fs.mkdir(directory,{recursive:true});const temporary=filename+'.tmp-'+randomUUID();
  try{await fs.writeFile(temporary,encrypt(Buffer.from(JSON.stringify(merged)),password));await fs.rename(temporary,filename)}
  finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error})}
  return merged;
 };
 const result=createYahooRequestAccess({initial:mergeYahooRequestAccess(stored,latest.yahooRequestAccess,discovery.yahooRequestAccess,initial),persist});
 if(yahooRetryAt(result.snapshot()))await result.flush();
 return result;
}
