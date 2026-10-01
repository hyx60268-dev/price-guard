import { expandMerchantBundles } from './merchant-bundles.mjs';
import { merchantCopy } from './merchant-copy.mjs';

export { merchantProfile } from '../../public/merchant-config.js';
export function qualifiesMerchantItem(item={}){
 return Number.isFinite(item.price)&&item.price>4999&&/中国限定|海外限定/.test(`${item.title||''}\n${item.description||''}`);
}
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
  records[key]={...old,...item,merchant,key,firstSeenAt:old.firstSeenAt||stamp,lastSeenAt:stamp,listedAt,soldAt,
   soldObservedAt:old.soldObservedAt||(transitioned?stamp:null),
   soldWindowStart:old.soldWindowStart||(transitioned?old.lastSeenAt:null),
   firstSeenSold:old.firstSeenSold||(!old.firstSeenAt&&item.status==='SOLD'?stamp:null)};
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
  ...merchantListingDraft(r)
 })).sort((a,b)=>Date.parse(b.eventAt)-Date.parse(a.eventAt));
}
export function merchantListingDraft(item={}){return merchantCopy(item)}
