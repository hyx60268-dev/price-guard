import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { encrypt, decrypt } from './crypto.mjs';
import { loadXianyuAccess } from './xianyu-access.mjs';

const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const validState=state=>state&&Array.isArray(state.cookies)&&Array.isArray(state.origins)&&state.cookies.every(cookie=>cookie&&typeof cookie.name==='string'&&typeof cookie.value==='string'&&typeof cookie.domain==='string');
const relevant=cookie=>/(^|\.)(goofish|idlefish|taobao)\.com$/i.test(cookie.domain.replace(/^\./,''));

// Never use the dashboard password for authentication data. Nothing here goes
// into public/data; only ciphertext is retained in the existing Actions cache.
export async function loadXianyuSession(root,{env=process.env,now=Date.now(),log=console.log}={}) {
  const parts=['XIANYU_AUTH_PART_1','XIANYU_AUTH_PART_2','XIANYU_AUTH_PART_3'].map(key=>env[key]||'').join('');
  const options=[['parts',parts,true],['gzip',env.XIANYU_STORAGE_STATE_GZIP_B64,true],['base64',env.XIANYU_STORAGE_STATE_B64,false]];
  let state,seed,source;
  for(const [label,value,compressed] of options){
    if(!value)continue;
    try{
      const bytes=Buffer.from(value,'base64');
      const candidate=JSON.parse((compressed?zlib.gunzipSync(bytes):bytes).toString());
      if(!validState(candidate))throw new Error('invalid_state');
      state=candidate;seed=value;source=label;break;
    }catch{log(`[闲鱼会话] ${label} 格式无效，未输出授权内容`)}
  }
  if(!state){
    log('[闲鱼会话] 没有可加载的授权文件');
    const gate=await loadXianyuAccess(root,hash('price-guard/anonymous-access/v1'));
    return {file:undefined,source:'anonymous',access:gate.access,persist:async(_context,result)=>{await gate.record(result);return false}}
  }
  const key=hash(`price-guard/xianyu-session/v1\n${seed}`),seedId=hash(seed);
  const gate=await loadXianyuAccess(root,key);
  const cache=path.join(root,'state','xianyu-session.json.enc');let lastSaved=0;
  try{
    const saved=JSON.parse(decrypt(await fs.readFile(cache),key).toString()),time=Date.parse(saved.verifiedAt||'');
    if(saved.version===1&&saved.seedId===seedId&&validState(saved.state)&&Number.isFinite(time)&&time<=now&&now-time<7*86400000){state=saved.state;source='refreshed';lastSaved=time}
  }catch{}
  const cookies=state.cookies.filter(relevant),expired=cookies.filter(c=>c.expires>0&&c.expires*1000<=now).length;
  log(`[闲鱼会话] 来源=${source} 相关Cookie=${cookies.length} 已过期=${expired}；加载不代表详情访问成功`);
  const file=path.join(root,'.auth','xianyu.json');
  await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(state),{mode:0o600});
  return {file,source,access:gate.access,async persist(context,result){
    await gate.record(result);
    // Search cards alone are not access evidence. A failed login or challenge
    // cannot replace last-known usable state, even if an earlier detail worked.
    if(!context||!result?.accessibleDetailCount||['blocked','login_required','error'].includes(result.status))return false;
    const updated=await context.storageState({indexedDB:true});
    if(!validState(updated)||!updated.cookies.some(relevant))return false;
    const time=Date.now();if(time<lastSaved)return false;
    const sealed=encrypt(Buffer.from(JSON.stringify({version:1,seedId,verifiedAt:new Date(time).toISOString(),state:updated})),key);
    await fs.mkdir(path.dirname(cache),{recursive:true});const temp=`${cache}.${process.pid}.tmp`;
    await fs.writeFile(temp,sealed,{mode:0o600});await fs.rename(temp,cache);lastSaved=time;
    log('[闲鱼会话] 已加密保存详情访问成功后的更新；这不等于同款成本核验通过');return true;
  }};
}
