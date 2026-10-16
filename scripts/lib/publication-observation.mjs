const MAX_ATTEMPTS=3, MAX_WAIT_MS=30_000, REQUEST_MS=10_000, DELAY_MS=2_000, MAX_BYTES=256_000;
const ERROR_CODES=new Set(['ETIMEDOUT','ECONNRESET','ENOTFOUND','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT']);
const BODY_REASONS=new Set(['body_unavailable','body_too_large','invalid_json']);
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const elapsed=(now,start)=>Math.max(0,Math.round(now()-start));
function errorKind(error){
 const code=ERROR_CODES.has(error?.cause?.code)?error.cause.code:ERROR_CODES.has(error?.code)?error.code:null;
 return {reason:error?.name==='TimeoutError'||error?.name==='AbortError'||code?.includes('TIMEOUT')?'timeout':'network',...(code?{code}:{})};
}
function retryDirective(response,now){
 const raw=response?.headers?.get('retry-after');if(raw===null||raw===undefined)return null;
 const seconds=raw.length<=150&&/^\d+$/.test(raw.trim())?Number(raw.trim()):null;
 const at=raw.length>150?NaN:seconds!==null?now()+seconds*1000:Date.parse(raw);
 return Number.isFinite(at)&&at>=now()&&at<=8.64e15?{retryAt:new Date(at).toISOString()}:{retryAfterInvalid:true};
}
async function readStatus(response){
 const reader=response.body?.getReader();if(!reader)throw Object.assign(Error(),{observationReason:'body_unavailable'});
 const chunks=[];let size=0;
 try{
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES)throw Object.assign(Error(),{observationReason:'body_too_large'});chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw Object.assign(Error(),{observationReason:'invalid_json'});}
 }finally{try{void reader.cancel().catch(()=>{});}catch{}}
}

// This observes only the already-published dashboard status. It never performs
// source collection or changes any quote, inventory or acceptance timestamp.
export async function observePublication({url,expected,fetchImpl=globalThis.fetch,now=Date.now,monotonic=()=>performance.now(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
 const attempts=[],start=monotonic();let target;
 try{target=new URL(url);}catch{return {observedAt:null,attempts:[{attempt:0,reason:'invalid_url',elapsedMs:0}]};}
 if(target.protocol!=='https:'||target.username||target.password)return {observedAt:null,attempts:[{attempt:0,reason:'invalid_url',elapsedMs:0}]};
 if(!/^[a-f0-9]{40}$/.test(expected?.codeSha||'')||!iso(expected?.dataRevision)||!iso(expected?.cycleCoverage?.finishedAt))return {observedAt:null,attempts:[{attempt:0,reason:'invalid_expected_revision',elapsedMs:0}]};
 for(let attempt=1;attempt<=MAX_ATTEMPTS;attempt++){
  const remaining=MAX_WAIT_MS-(monotonic()-start);if(remaining<=0)break;
  const requestStarted=monotonic(),requestTimeoutMs=Math.max(1,Math.floor(Math.min(REQUEST_MS,remaining)));
  let response,observation,retry=false;
  try{
   response=await fetchImpl(target.href,{redirect:'error',cache:'no-store',headers:{'cache-control':'no-cache',pragma:'no-cache'},signal:AbortSignal.timeout(requestTimeoutMs)});
   const httpStatus=response.status;
   if(!response.ok){
    observation={reason:'http_error',httpStatus};retry=httpStatus>=500&&httpStatus<=599;
   }else{
    const published=await readStatus(response),mismatches=[];
    if(published?.codeSha!==expected.codeSha)mismatches.push('codeSha');
    if(published?.dataRevision!==expected.dataRevision)mismatches.push('dataRevision');
    if(published?.cycleCoverage?.finishedAt!==expected.cycleCoverage.finishedAt)mismatches.push('finishedAt');
    observation={reason:mismatches.length?'revision_mismatch':'observed',httpStatus,...(mismatches.length?{mismatches}:{})};retry=!!mismatches.length;
   }
  }catch(error){observation={...(BODY_REASONS.has(error?.observationReason)?{reason:error.observationReason}:errorKind(error)),...(response?{httpStatus:response.status}:{})};retry=!response||response.ok||response.status>=500;}
  finally{try{void response?.body?.cancel()?.catch(()=>{});}catch{}}
  if(monotonic()-start>MAX_WAIT_MS||monotonic()-requestStarted>requestTimeoutMs){observation={...observation,reason:'deadline_exceeded'};retry=false;}
  const directive=retryDirective(response,now);if(directive){Object.assign(observation,directive);retry=false;}
  attempts.push({attempt,...observation,elapsedMs:elapsed(monotonic,start),requestTimeoutMs});
  if(observation.reason==='observed')return {observedAt:new Date(now()).toISOString(),attempts};
  const wait=Math.min(DELAY_MS,MAX_WAIT_MS-(monotonic()-start));
  if(!retry||attempt===MAX_ATTEMPTS||wait<=0)break;
  await sleep(wait);
 }
 return {observedAt:null,attempts};
}
