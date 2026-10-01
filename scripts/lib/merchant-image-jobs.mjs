import { inspectExternalImages } from './external-images.mjs';
import { reconcileReviewedProductImages } from './reviewed-product-images.mjs';
import { mapLimit } from './worker-pool.mjs';
import { merchantImageSet,mergeMerchantImages,usableMerchantImage } from '../../public/merchant-image-evidence.js';
export const IMAGE_LOOKUP_VERSION=6;
export function imageCoverage(products=[]){
 const counts={total:products.length,verified:0,partial:0,pending:0,failed:0,unmatched:0,officialReady:0,photosReady:0};
 for(const item of products){
  const set=merchantImageSet(item);
  if(set.officialCount)counts.officialReady++;
  if(set.photoCount>=2)counts.photosReady++;
  if(set.complete)counts.verified++;
  else if(set.status==='partial')counts.partial++;
  else if(['error','unavailable'].includes(item.webImageStatus))counts.failed++;
  else if(item.webImageStatus==='not_found')counts.unmatched++;
  else counts.pending++;
 }
 return counts;
}
// A single previously verified image is progress, never a complete publication
// set. Keep it across failures and continue looking for the missing evidence.
export async function runMerchantImageJobs(items,{deadline,inspect=inspectExternalImages,log=()=>{},now=Date.now}={}){
 for(const item of items){
  const before=(item.webImages||[]).length;item.webImages=reconcileReviewedProductImages(item,item.webImages||[]);
  if(item.webImages.length!==before){item.webImageVersion=0;item.webImageRetryAt=null;}
 }
 const tasks=items.filter(p=>!merchantImageSet(p).complete)
  .sort((a,b)=>(Date.parse(a.webImageCheckedAt)||0)-(Date.parse(b.webImageCheckedAt)||0));
 let attempted=0;
 await mapLimit(tasks,2,async item=>{
  if(now()>=deadline)return;
  if(item.webImageVersion===IMAGE_LOOKUP_VERSION&&Date.parse(item.webImageRetryAt)>now())return;
  attempted++;
  let result;
  try{result=await inspect(item,{deadline:Math.min(deadline,now()+60000)})}
  catch(e){result={photos:[],status:'error',reason:'lookup_exception',failures:[{stage:'lookup',reason:String(e.message||e).slice(0,160)}]}}
  const stamp=now(),photos=mergeMerchantImages(item.webImages||[],(result.photos||[]).filter(usableMerchantImage));
  item.webImages=photos;
  const set=merchantImageSet(item),status=set.complete?'verified':photos.length?'partial':result.status==='verified'?'error':result.status;
  item.webImageVersion=IMAGE_LOOKUP_VERSION;item.webImageCheckedAt=new Date(stamp).toISOString();
  item.webImageStatus=status;item.webImageReason=set.complete?'complete_image_set':set.status==='partial'?set.missing.join('+'):result.reason;
  item.webImageRetryAt=set.complete?null:new Date(stamp+(result.status==='not_found'?6*3600000:20*60000)).toISOString();
  const candidates=[...new Map([...(item.webImageDiagnostics?.candidates||[]),...(result.candidates||[])].map(p=>[p.sourceUrl+'|'+p.url,p])).values()].slice(-24);
  item.webImageDiagnostics={searches:result.searches||0,pagesRead:result.pagesRead||0,imagesChecked:result.imagesChecked||0,searchResults:result.searchResults||[],failures:(result.failures||[]).slice(0,12),lastAttemptStatus:result.status,lastAttemptReason:result.reason,imageSet:{official:set.officialCount,photos:set.photoCount,complete:set.complete,missing:set.missing},candidates};
  log({key:item.key,status,reason:item.webImageReason,photos:photos.length,...item.webImageDiagnostics});
 });
 return {attempted};
}
