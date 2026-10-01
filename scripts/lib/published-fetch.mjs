import { setTimeout as sleep } from 'node:timers/promises';

const transientStatus=new Set([408,429,500,502,503,504]);
function retryAfterMs(value){
  if(!value)return 0;
  if(/^\d+(?:\.\d+)?$/.test(value.trim()))return Number(value)*1000;
  const date=Date.parse(value);return Number.isFinite(date)?Math.max(0,date-Date.now()):0;
}

// Keep the baseline fail-closed; only transient transport failures are retried.
export async function fetchPublishedBytes(url,{
  fetchImpl=fetch,wait=sleep,warn=console.warn,attempts=3,timeoutMs=30000,maxRetryDelayMs=30000,label='发布状态',
}={}){
  for(let attempt=1;attempt<=attempts;attempt++){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(new DOMException('发布状态下载超时','TimeoutError')),timeoutMs);
    let failure,delay=Math.min(1000*2**(attempt-1),maxRetryDelayMs);
    try{
      const response=await fetchImpl(url,{headers:{'cache-control':'no-cache'},signal:controller.signal});
      if(response.status===404){await response.body?.cancel();return null}
      if(!response.ok){
        const retryDelay=retryAfterMs(response.headers.get('retry-after'));
        await response.body?.cancel();
        failure=Object.assign(new Error(`HTTP ${response.status}`),{retryable:transientStatus.has(response.status)&&retryDelay<=maxRetryDelayMs});
        delay=Math.max(delay,retryDelay);
      }else return Buffer.from(await response.arrayBuffer());
    }catch(error){
      failure=error;
      failure.retryable=controller.signal.aborted||error instanceof TypeError||['ECONNRESET','ETIMEDOUT','EAI_AGAIN'].includes(error.code);
    }finally{clearTimeout(timer)}
    if(!failure.retryable||attempt===attempts)throw new Error(`${label}恢复失败（${attempt} 次尝试）：${failure.message}，停止发布以免使用过期基准`,{cause:failure});
    warn(`[发布状态重试] ${label}：${failure.message}，${delay}ms 后重试 ${attempt+1}/${attempts}`);
    await wait(delay);
  }
  throw new Error(`${label}恢复失败：没有有效尝试，停止发布`);
}
