import { canonicalSaleTitle } from './discovery.mjs';

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
 return Object.values(records).filter(qualifiesMerchantItem).filter(r=>
  [r.listedAt,r.firstSeenAt,r.soldAt,r.soldObservedAt,r.firstSeenSold].some(t=>Date.parse(t)>=since)
 ).map(r=>({
  ...r,id:r.key,sourceId:r.id,sourceTitle:r.title,sourceDescription:r.description||'',sourcePriceJPY:r.price,
  sourcePlatform:r.merchant.platform,sourceUrl:r.url,seller:r.merchant,sourceImages:r.images||[r.image].filter(Boolean),
  event:r.status==='SOLD'?(r.soldAt?'sold':r.soldObservedAt?'observed_sold':'undated_sold'):(r.listedAt?'listed':'observed_listing'),
  eventAt:r.status==='SOLD'?(r.soldAt||r.soldObservedAt||r.firstSeenSold):(r.listedAt||r.firstSeenAt),
  ...merchantListingDraft(r)
 })).sort((a,b)=>Date.parse(b.eventAt)-Date.parse(a.eventAt));
}
// Use the user's 商品文案重写 sections. Unknown quantity/condition remains an
// explicit draft field; never invent authenticity, exclusivity or shipping.
export function merchantListingDraft(item={}){
 const name=canonicalSaleTitle(item.title||''),region=/中国限定/.test(`${item.title} ${item.description}`)?'中国限定':/海外限定/.test(`${item.title} ${item.description}`)?'海外限定':'';
 const title=Array.from([region,name].filter(Boolean).join(' ')).slice(0,40).join('');
 const contents=item.contents||'内容・数量は元の商品ページで確認してください。';
 const condition=typeof item.condition==='string'&&item.condition.trim()?item.condition.trim():'状態は元の商品ページで確認してください。';
 const jp=[`${name}です。`,'', '【商品内容】',contents,'','【状態】',condition,'','海外製品のため、塗装や印刷の個体差、輸送時の外箱のスレなどが見られる場合があります。掲載画像と商品内容をご確認ください。'].join('\n');
 const zh=['中文翻译：',`${name}。`,region?`限定信息：来源页面标注“${region}”。`:'','', '【商品内容】',item.contents||'请在原商品页面确认内容和数量。','','【状态】',/新品|未使用/.test(condition)?'来源页面标注新品／未使用；发布前请核对实际采购品状态。':'请在原商品页面确认状态。','','海外商品可能存在涂装、印刷个体差异，以及运输导致的外盒擦痕。请确认图片和商品内容。'].join('\n');
 return {proposedTitle:title,proposedDescription:jp,translatedDescription:zh,copyStatus:'draft',copyNote:'文案草稿：发布前需按实际采购商品确认数量、状态及包装。'};
}
