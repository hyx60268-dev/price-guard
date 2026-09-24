import fs from 'node:fs/promises';
import path from 'node:path';
import { encrypt, decrypt } from './crypto.mjs';

// One circuit shared by price scanning, discovery (including cache refresh),
// and later cloud runs. It never attempts to solve a platform challenge.
// A different user-supplied session seed uses a different encryption key.
export async function loadXianyuAccess(root,key,{clock=Date.now}={}) {
  const file=path.join(root,'state','xianyu-access.json.enc');
  let state={};
  try{state=JSON.parse(decrypt(await fs.readFile(file),key).toString())}catch{}
  const access=()=>{
    const retry=Date.parse(state.retryAt||'');
    const allowed=!Number.isFinite(retry)||clock()>=retry;
    return {allowed,reason:state.reason||null,retryAt:state.retryAt||null,failures:state.failures||0};
  };
  return {access,async record(result={}){
    const blocked=['blocked','login_required'].includes(result.status);
    if(blocked){
      const failures=Math.min(4,(Number(state.failures)||0)+1);
      const delay=3600000*Math.min(6,2**(failures-1));
      state={reason:result.status,failures,failedAt:new Date(clock()).toISOString(),retryAt:new Date(clock()+delay).toISOString()};
    }else if(result.status==='ok'&&result.accessibleDetailCount>0){
      state={};
    }else return;
    await fs.mkdir(path.dirname(file),{recursive:true});
    const tmp=`${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp,encrypt(Buffer.from(JSON.stringify(state)),key),{mode:0o600});
    await fs.rename(tmp,file);
  }};
}

export function deferredXianyuAccess(access) {
  return {status:'deferred_access',accessReason:access.reason,retryAt:access.retryAt,samples:[],averageCNY:null};
}
