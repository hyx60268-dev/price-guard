import { expandMerchantBundles } from './merchant-bundles.mjs';
import { merchantCopy } from './merchant-copy.mjs';
import { reviewedProductImages,reconcileReviewedProductImages } from './reviewed-product-images.mjs';

export { merchantProfile } from '../../public/merchant-config.js';
export function qualifiesMerchantItem(item={}){
 return Number.isFinite(item.price)&&item.price>4999&&/中国限定|海外限定/.test(`${item.title||''}\n${item.description||''}`);
}
const observedText=value=>String(value||'').replace(/\s+/g,' ').trim();
const primaryImage=item=>(item.images||[item.image])[0]||'';
const imageEvidenceFields=['webImages','xianyuImages','webImageVersion','webImageCheckedAt','webImageStatus','webImageReason','webImageRetryAt','webImageDiagnostics','imageCheckedAt','imageLookupStatus','primaryFingerprint'];
const validTime=(value,now)=>{const n=Date.parse(value||'');return Number.isFinite(n)&&n<=now?new Date(n).toISOString():null};
// Missing from a profile is never evidence of a sale. Only explicit SOLD can
// establish a transition; first-seen sold listings with no date stay undated.
export function recordMerchantObservation(previous={},merchant,items=[],now=Date.now()){
 const records={...previous},stamp=new Date(now).toISOString();
 for(const item of items){
  if(!item.id||!['OPEN','SOLD'].includes(item.status))continue;
  const key=merchant.key+':'+item.id,old=records[key]||{};
  const soldAt=validTime(item.soldAt,now)||old.soldAt||null;
  const listedAt=validTime(item.listedAt,now)||old.listedAt||null;
  const transitioned=old.status==='OPEN'&&item.status==='SOLD';
  const observed={...old,...item};
  const observedPrimary=Object.hasOwn(item,'images')?primaryImage(item):Object.hasOwn(item,'image')?(item.image||''):primaryImage(old);
  const identityChanged=Boolean(old.id)&&(['title','description'].some(field=>observedText(observed[field])!==observedText(old[field]))||observedPrimary!==primaryImage(old)||JSON.stringify(observed.condition)!==JSON.stringify(old.condition));
  records[key]={...old,...item,merchant,key,firstSeenAt:old.firstSeenAt||stamp,lastSeenAt:stamp,listedAt,soldAt,
   soldObservedAt:old.soldObservedAt||(transitioned?stamp:null),
   soldWindowStart:old.soldWindowStart||(transitioned?old.lastSeenAt:null),
   firstSeenSold:old.firstSeenSold||(!old.firstSeenAt&&item.status==='SOLD'?stamp:null)};
  if(identityChanged){for(const field of imageEvidenceFields)delete records[key][field];records[key].webImageStatus='pending';records[key].webImageReason='source_identity_changed';records[key].lastDetailAt=item.lastDetailAt||null;if(Object.hasOwn(item,'image')&&!Object.hasOwn(item,'images'))records[key].images=[item.image].filter(Boolean);}
 }
 return records;
}
export function merchantProducts(records={},now=Date.now()){
 const since=now-30*86400000;
 return expandMerchantBundles(records).filter(qualifiesMerchantItem).filter(r=>
  [r.listedAt,r.firstSeenAt,r.soldAt,r.soldObservedAt,r.firstSeenSold].some(t=>Date.parse(t)>=since)
 ).map(r=>({
  ...r,id:r.key,sourceId:r.id,sourceTitle:r.title,sourceDescription:r.description||'',sourcePriceJPY:r.price,
  sourcePlatform:r.merchant.platform,sourceUrl:r.url,seller:r.merchant,sourceImages:r.images||[r.image].filter(Boolean),
  event:r.status==='SOLD'?(r.soldAt?'sold':r.soldObservedAt?'observed_sold':'undated_sold'):(r.listedAt?'listed':'observed_listing'),
  eventAt:r.status==='SOLD'?(r.soldAt||r.soldObservedAt||r.firstSeenSold):(r.listedAt||r.firstSeenAt),
  ...merchantListingDraft(r),webImages:[...reviewedProductImages(r),...reconcileReviewedProductImages(r,r.webImages||[])]
 })).sort((a,b)=>Date.parse(b.eventAt)-Date.parse(a.eventAt));
}
export function merchantListingDraft(item={}){return merchantCopy(item)}
