import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createFingerprintLoader } from './image-fingerprint-cache.mjs';

const cache=new Map(),diagnostics=new Map();
const transferTotals={fetches:0,settledFetches:0,completedDecodedBytes:0,durationMs:0,unknownBodyTransfers:0};
export const imageTransferStats=()=>({...transferTotals});
const imageByteObservations=new AsyncLocalStorage();
const observeImageBytes=value=>{
  const scope=imageByteObservations.getStore();
  if(scope?.active)return scope.pool.observe(value);
};
// The pool belongs to one comparison. Promise branches inherit that scope;
// other concurrent comparisons never observe its bodies. Clear on every exit,
// and ignore late work that outlives the owning comparison.
export function withImageByteObservations(pool,fn){
  const scope={pool,active:true};
  return imageByteObservations.run(scope,async()=>{
    try{return await fn()}
    finally{scope.active=false;try{pool?.clear()}catch{/* Best-effort cleanup. */}}
  });
}
function recordDiagnostic(url,value){
  if(!diagnostics.has(url)&&diagnostics.size>=500)diagnostics.delete(diagnostics.keys().next().value);
  diagnostics.set(url,{...value,checkedAt:new Date().toISOString()});
}
// Only bounded, non-sensitive metadata; never response bodies, error text or arbitrary headers.
export function imageFingerprintDiagnostic(url){
  const value=diagnostics.get(url);return value?{...value}:null;
}

function bitsToHex(bits){
  return BigInt(`0b${bits}`).toString(16).padStart(16,'0');
}

const requestStopped=({signal,deadlineAt,now=Date.now}={})=>signal?.aborted||(Number.isFinite(deadlineAt)&&now()>=deadlineAt);
const boundedStatus=status=>Number.isInteger(status)&&status>=100&&status<=599?status:null;
function boundedRetryAfter(response){
  const retry=response.headers.get('retry-after'),date=Date.parse(retry||'');
  return retry&&/^\d{1,10}$/.test(retry)?retry:Number.isFinite(date)?new Date(date).toUTCString():null;
}
function observeTransfer(observer,metrics){
  if(observer==null)return;
  try{
    const result=observer(Object.freeze(metrics));
    if(result&&typeof result.then==='function'){
      // An audit observer must finish synchronously. Consume rejected async
      // callbacks without awaiting them or turning their failure into a retry.
      Promise.resolve(result).catch(()=>{});
      throw new Error('async_observer');
    }
  }catch{throw Object.assign(new Error('image_transfer_observation_failed'),{auditReason:'image_transfer_observation_failed'})}
}

async function download(url,context={}){
  const attempts=context.auditTransport===true?1:2;
  for(let attempt=1;attempt<=attempts;attempt++){
    if(requestStopped(context))return null;
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),12000),start=performance.now();
    const abort=()=>controller.abort();
    context.signal?.addEventListener('abort',abort,{once:true});
    let httpStatus=null,receivedBytes=0,bodyCompleted=false,transportStarted=false,accessDenial=null;
    const record=(reason,extra={})=>recordDiagnostic(url,{stage:'download',reason,attempt,httpStatus,elapsedMs:Math.round(performance.now()-start),...extra});
    try{
      if(requestStopped(context)){abort();return null}
      observeTransfer(context.observeImageTransferStart,{fetches:1});
      transportStarted=true;
      const initiated={fetches:1,settledFetches:0,completedDecodedBytes:0,durationMs:0,unknownBodyTransfers:0};
      transferTotals.fetches++;
      const activeScope=imageByteObservations.getStore();
      if(activeScope?.active)try{activeScope.pool.observeTransfer?.(initiated)}catch{/* Counts cannot change source access. */}
      const response=await fetch(url,{headers:{'user-agent':'Mozilla/5.0','accept':'image/avif,image/webp,image/*,*/*;q=0.8'},signal:controller.signal,redirect:context.auditTransport===true?'manual':'follow'});
      httpStatus=response.status;
      if(context.stopOnAccessDenial===true&&[401,403,429].includes(httpStatus)){
        const retryAfter=boundedRetryAfter(response);
        record('http_error',{retryAfter});
        accessDenial=Object.assign(new Error('source_denied'),{auditReason:'source_denied',httpStatus:boundedStatus(httpStatus),retryAfter});
        throw accessDenial;
      }
      if(requestStopped(context)){abort();return null}
      if(!response.ok){
        const retryAfter=boundedRetryAfter(response);
        record('http_error',{retryAfter});
        // Authentication/access/rate-limit responses are not transient image retries.
        if([401,403,429].includes(response.status)||attempt===attempts)return null;
        continue;
      }
      const length=Number(response.headers.get('content-length'));
      if(Number.isFinite(length)&&length>12_000_000){record('body_too_large',{declaredBytes:length});return null}
      const buffer=Buffer.from(await response.arrayBuffer());receivedBytes=buffer.length;bodyCompleted=true;
      if(requestStopped(context)){abort();return null}
      const encoding=response.headers.get('content-encoding');
      if(!encoding&&Number.isFinite(length)&&length>0&&buffer.length!==length){record('body_length_mismatch',{declaredBytes:length,receivedBytes:buffer.length});return null}
      if(buffer.length>12_000_000){record('body_too_large',{receivedBytes:buffer.length});return null}
      record('body_received',{receivedBytes:buffer.length});
      return {buffer,cacheControl:response.headers.get('cache-control'),cacheAge:response.headers.get('age'),responseDate:response.headers.get('date')};
    }catch(error){
      if(accessDenial&&error===accessDenial||error?.auditReason==='image_transfer_observation_failed')throw error;
      if(requestStopped(context)){record(Number.isFinite(context.deadlineAt)&&context.now()>=context.deadlineAt?'deadline':'aborted');return null}
      record(controller.signal.aborted||['AbortError','TimeoutError'].includes(error?.name)?'timeout':'network_error');
      if(attempt===attempts)return null;
    }finally{
      clearTimeout(timeout);context.signal?.removeEventListener('abort',abort);
      // One observation per actual fetch attempt, including failures and late
      // settlements after the bounded loader returned. Bytes are completed,
      // decoded arrayBuffer bytes, not Content-Length or estimated wire bytes.
      // An expired/cache-only call starts no transport and emits no event.
      if(transportStarted){
        const scope=imageByteObservations.getStore();
        const transfer={fetches:0,settledFetches:1,completedDecodedBytes:receivedBytes,durationMs:Math.max(0,performance.now()-start),unknownBodyTransfers:!bodyCompleted&&httpStatus>=200&&httpStatus<300?1:0};
        for(const key of Object.keys(transferTotals))transferTotals[key]+=transfer[key];
        if(scope?.active)try{scope.pool.observeTransfer?.(transfer)}catch{/* Optional local counters cannot change transport. */}
        try{observeTransfer(context.observeImageTransfer,{fetches:1,bytes:receivedBytes,
          durationMs:Math.min(Number.MAX_SAFE_INTEGER,Math.max(0,Math.round(performance.now()-start))),httpStatus:boundedStatus(httpStatus)})}
        // Preserve a source denial if the observer also fails. Throwing here
        // bypasses the retry catch above and cannot initiate another request.
        catch(error){throw accessDenial||error}
      }
    }
  }
  return null;
}

async function differenceHash(buffer){
  const {data}=await sharp(buffer).greyscale().resize(9,8,{fit:'fill'}).raw().toBuffer({resolveWithObject:true});
  let bits='';
  for(let y=0;y<8;y++)for(let x=0;x<8;x++)bits+=data[y*9+x]>data[y*9+x+1]?'1':'0';
  return bitsToHex(bits);
}

async function averageHash(buffer){
  const {data}=await sharp(buffer).greyscale().resize(8,8,{fit:'fill'}).raw().toBuffer({resolveWithObject:true});
  const mean=[...data].reduce((sum,value)=>sum+value,0)/data.length;
  return bitsToHex([...data].map(value=>value>=mean?'1':'0').join(''));
}

async function calculateFingerprints(buffer,url){
  try{
    const center=await sharp(buffer).resize(256,256,{fit:'cover',position:'centre'}).png().toBuffer();
    const [dHash,aHash,centerHash,stats,metadata,border,grid]=await Promise.all([
      differenceHash(buffer),averageHash(buffer),differenceHash(center),sharp(buffer).resize(32,32,{fit:'inside'}).stats(),sharp(buffer).metadata(),
      sharp(buffer).rotate().resize(48,48,{fit:'fill'}).removeAlpha().raw().toBuffer({resolveWithObject:true}),
      sharp(buffer).rotate().toColourspace('srgb').removeAlpha().resize(16,16,{fit:'fill'}).raw().toBuffer()
    ]);
    const color=(stats.channels||[]).slice(0,3).map(channel=>Math.round(channel.mean||0));
    const sums=[0,0,0],squares=[0,0,0];let count=0;
    for(let y=0;y<border.info.height;y++)for(let x=0;x<border.info.width;x++){
      if(x>=6&&x<border.info.width-6&&y>=6&&y<border.info.height-6)continue;
      const offset=(y*border.info.width+x)*border.info.channels;
      for(let channel=0;channel<3;channel++){const value=border.data[offset+channel]??0;sums[channel]+=value;squares[channel]+=value*value}count++;
    }
    const background=sums.map(value=>Math.round(value/Math.max(1,count)));
    const backgroundSpread=squares.map((value,index)=>Math.round(Math.sqrt(Math.max(0,value/Math.max(1,count)-(sums[index]/Math.max(1,count))**2))));
    const aspectRatio=metadata.width&&metadata.height?metadata.width/metadata.height:null;
    return {dHash,aHash,centerHash,color,background,backgroundSpread,aspectRatio,colorGrid:[...grid],url,contentSha256:createHash('sha256').update(buffer).digest('hex')};
  }catch{recordDiagnostic(url,{...imageFingerprintDiagnostic(url),stage:'fingerprint',reason:'decode_error'});return null}
}

let persistentLoader=createFingerprintLoader({fetchImage:download,fingerprint:calculateFingerprints,observeImageBytes});
let cacheClock=Date.now;
export function configureImageFingerprintCache({directory,now=Date.now}={}){
 cache.clear();diagnostics.clear();for(const key of Object.keys(transferTotals))transferTotals[key]=0;cacheClock=now;persistentLoader=createFingerprintLoader({directory,fetchImage:download,fingerprint:calculateFingerprints,now,observeImageBytes});
 return persistentLoader.stats;
}
const makeFingerprints=(url,options)=>url?persistentLoader.get(url,options):null;

export async function imageFingerprints(url,options){
  if(!url)return null;
  const bounded=options?.signal||Number.isFinite(options?.deadlineAt);
  const context=bounded?{...options,now:options.now||cacheClock}:undefined;
  if(bounded&&requestStopped(context))return null;
  const prior=cache.get(url);
  if(prior&&!prior.pending&&!(prior.expiresAt>cacheClock()))cache.delete(url);
  if(bounded){
    // Resolved, explicitly HTTP-fresh results can be reused without refreshing
    // their observation. Pending operations belong only to their own callers.
    if(prior&&!prior.pending&&prior.expiresAt>cacheClock()){
      const value=await prior.promise;return requestStopped(context)?null:value;
    }
    return makeFingerprints(url,context);
  }
  if(!cache.has(url)){
    if(cache.size>500)cache.delete(cache.keys().next().value);
    const entry={pending:true,expiresAt:0,promise:null};
    entry.promise=Promise.resolve().then(()=>makeFingerprints(url)).then(value=>{
      entry.pending=false;entry.expiresAt=value?.imageCacheExpiresAt||0;
      if(!(entry.expiresAt>cacheClock())&&cache.get(url)===entry)cache.delete(url);
      return value;
    },error=>{if(cache.get(url)===entry)cache.delete(url);throw error});
    cache.set(url,entry);
  }
  return cache.get(url).promise;
}

export async function imageHash(url){
  return (await imageFingerprints(url))?.dHash||null;
}

export function imageSimilarity(a,b){
  if(!a||!b)return null;
  try{
    let x=BigInt(`0x${a}`)^BigInt(`0x${b}`),distance=0;
    while(x){distance+=Number(x&1n);x>>=1n}
    return 1-distance/64;
  }catch{return null}
}

export function fingerprintSimilarity(a,b){
  if(!a||!b)return null;
  const hashes=[imageSimilarity(a.dHash,b.dHash),imageSimilarity(a.aHash,b.aHash),imageSimilarity(a.centerHash,b.centerHash)].filter(Number.isFinite);
  if(!hashes.length)return null;
  hashes.sort((x,y)=>y-x);
  let score=hashes[0]*.55+(hashes[1]??hashes[0])*.3+(hashes[2]??hashes[0])*.15;
  if(a.color?.length===3&&b.color?.length===3){
    const distance=Math.sqrt(a.color.reduce((sum,value,index)=>sum+(value-b.color[index])**2,0))/(Math.sqrt(3)*255);
    score=score*.75+(1-distance)*.25;
  }
  return Math.max(0,Math.min(1,score));
}

export function imageSetSimilarity(left=[],right=[]){
  let best=null;
  for(const a of left.filter(Boolean))for(const b of right.filter(Boolean)){
    const score=fingerprintSimilarity(a,b);
    if(Number.isFinite(score)&&(best===null||score>best))best=score;
  }
  return best;
}

// For ambiguous variants, a matching secondary box/logo is not product evidence.
// Require a near-duplicate PRIMARY image, with spatial colour as a hard gate.
// This is deliberately conservative: different photos go to review, not pricing.
export function primaryProductSimilarity(a,b){
  if(!a?.colorGrid?.length||a.colorGrid.length!==b?.colorGrid?.length)return null;
  // Blank placeholders contain no spatial product evidence, even when identical.
  if([a,b].some(value=>[value.dHash,value.aHash,value.centerHash].every(hash=>/^(?:0{16}|f{16})$/i.test(hash||''))))return null;
  const hashes=[imageSimilarity(a.dHash,b.dHash),imageSimilarity(a.aHash,b.aHash),imageSimilarity(a.centerHash,b.centerHash)];
  if(hashes.some(value=>!Number.isFinite(value)))return null;
  const distance=a.colorGrid.reduce((sum,value,index)=>sum+Math.abs(value-b.colorGrid[index]),0)/(a.colorGrid.length*255);
  return Math.min(...hashes,1-distance);
}

export function backgroundSimilarity(a,b){
  if(!a?.background?.length||!b?.background?.length)return null;
  const colorDistance=Math.sqrt(a.background.reduce((sum,value,index)=>sum+(value-b.background[index])**2,0))/(Math.sqrt(3)*255);
  const spreadDistance=a.backgroundSpread?.length&&b.backgroundSpread?.length
    ?Math.sqrt(a.backgroundSpread.reduce((sum,value,index)=>sum+(value-b.backgroundSpread[index])**2,0))/(Math.sqrt(3)*128):0;
  const aspectPenalty=Number.isFinite(a.aspectRatio)&&Number.isFinite(b.aspectRatio)
    ?Math.min(1,Math.abs(Math.log(a.aspectRatio/b.aspectRatio))/1.2):0;
  return Math.max(0,Math.min(1,1-colorDistance*.65-spreadDistance*.2-aspectPenalty*.15));
}

export function coherentIndependentImages(candidates=[],sourceImages=[],minimum=2){
  const unique=[...new Map(candidates.filter(item=>item?.url).map(item=>[item.url,item])).values()];
  const independent=unique.filter(candidate=>!sourceImages.some(source=>{
    const score=fingerprintSimilarity(candidate,source);return Number.isFinite(score)&&score>=.90;
  }));
  let best=[];
  for(const seed of independent){
    const group=independent.filter(candidate=>{
      const score=backgroundSimilarity(seed,candidate);return !Number.isFinite(score)||score>=.72;
    });
    if(group.length>best.length)best=group;
  }
  return best.length>=minimum?best.map(item=>item.url):[];
}
