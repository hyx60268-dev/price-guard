import { inspectExternalImages } from './external-images.mjs';
import { mapLimit } from './worker-pool.mjs';
import { allowedMerchantPhotoSource } from '../../public/merchant-records.js';
export const IMAGE_LOOKUP_VERSION=4;
const usable=p=>allowedMerchantPhotoSource(p.url)&&allowedMerchantPhotoSource(p.sourceUrl);
export function imageCoverage(products=[]){
 const counts={total:products.length,verified:0,pending:0,failed:0,unmatched:0};
 for(const item of products){
  if([...(item.webImages||[]),...(item.xianyuImages||[])].some(usable))counts.verified++;
  else if(['error','unavailable'].includes(item.webImageStatus))counts.failed++;
  else if(item.webImageStatus==='not_found')counts.unmatched++;
  else counts.pending++;
 }
 return counts;
}
// Two independent items can make progress together; a slow source cannot use
// the entire merchant budget or stop the remaining items after an exception.
export async function runMerchantImageJobs(items,{deadline,inspect=inspectExternalImages,log=()=>{},now=Date.now}={}){
 const tasks=items.filter(p=>![...(p.webImages||[]),...(p.xianyuImages||[])].some(usable))
  .sort((a,b)=>(Date.parse(a.webImageCheckedAt)||0)-(Date.parse(b.webImageCheckedAt)||0));
 let attempted=0;
 await mapLimit(tasks,2,async item=>{
  if(now()>=deadline)return;
  if(item.webImageVersion===IMAGE_LOOKUP_VERSION&&Date.parse(item.webImageRetryAt)>now())return;
  attempted++;
  let result;
  try{result=await inspect(item,{deadline:Math.min(deadline,now()+60000)})}
  catch(e){result={photos:[],status:'error',reason:'lookup_exception',failures:[{stage:'lookup',reason:String(e.message||e).slice(0,160)}]}}
  const stamp=now(),photos=(result.photos||[]).filter(usable);
  const status=photos.length?'verified':result.status==='verified'?'error':result.status;
  item.webImages=photos;item.webImageVersion=IMAGE_LOOKUP_VERSION;item.webImageCheckedAt=new Date(stamp).toISOString();
  item.webImageStatus=status;item.webImageReason=result.reason;
  // A search miss is retried less often than a transport error. Successful
  // evidence is retained and never sent back through the unsuccessful queue.
  item.webImageRetryAt=photos.length?null:new Date(stamp+(status==='not_found'?6*3600000:20*60000)).toISOString();
  item.webImageDiagnostics={searches:result.searches||0,pagesRead:result.pagesRead||0,imagesChecked:result.imagesChecked||0,failures:(result.failures||[]).slice(0,12)};
  log({key:item.key,status,reason:item.webImageReason,photos:photos.length,...item.webImageDiagnostics});
 });
 return {attempted};
}
