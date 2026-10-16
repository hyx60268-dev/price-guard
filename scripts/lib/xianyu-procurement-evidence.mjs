import { procurementTarget,procurementTargetsEqual,safeProcurementUrl } from './procurement-evidence.mjs';
import { offerIdentityGuard } from './offer-identity.mjs';
import { semanticQuantity } from './rules.mjs';

export const XIANYU_COST_VERIFICATION='xianyu_purchasable_detail_v1';
export const xianyuOfferQuantity=value=>semanticQuantity(String(value||'').replace(/(\d+)\s*(?:套|セット)/g,'$1個'));
export function canonicalXianyuOffer(value){
 try{const u=new URL(value),ids=u.searchParams.getAll('id');
  if(u.protocol!=='https:'||u.hostname!=='www.goofish.com'||u.pathname!=='/item'||u.username||u.password||u.port||ids.length!==1||!/^\d+$/.test(ids[0]))return null;
  return 'https://www.goofish.com/item?id='+ids[0];
 }catch{return null}
}

// Text is read only from the target detail, never recommendations/search cards.
// Unknown availability or destination-specific freight is not a landed quote.
export function xianyuPurchaseTerms(text=''){
 const value=String(text).normalize('NFKC');
 const unavailable=/已售出|已卖出|售罄|售完|已下架|无货|無貨|缺货|暂无现货|无现货|非现货|不是现货|预售|預售|预约|預約|售出勿拍|勿拍|求购|求購|收购|收購/;
 const available=value.match(/现货|現貨|有现货|有現貨|在售|有货|有貨|可直接拍|可拍下/);
 const freight=value.match(/全国包邮|全國包郵|全国免运费|全國免運費/);
 const restricted=/不包邮|不包郵|不免运费|到付|偏远|偏遠|除外|不含.{0,6}运费|运费另|邮费另|郵費另|不发|不發|仅限|僅限|满\s*\d+|滿\s*\d+|新疆|西藏|港澳台|加运费|加邮费/;
 return {inStock:Boolean(available)&&!unavailable.test(value),availabilityEvidence:available?.[0]||'',
  shippingKnown:Boolean(freight)&&!restricted.test(value),shippingCNY:freight&&!restricted.test(value)?0:null,
  shippingScope:freight&&!restricted.test(value)?'CN':'',shippingEvidence:freight?.[0]||''};
}

export function xianyuQuoteSelection(sample){
 return Object.fromEntries(['canonicalUrl','sellerKey','selectedVariant','quantity','unitCNY','shippingCNY','landedCNY','currency','shippingScope','checkedAt'].map(key=>[key,sample[key]]));
}

// A price cluster is a benchmark, not an amount a seller will accept. Only
// complete, fresh, target-bound offers can supply an automatic purchase cost.
export function verifiedPurchasableXianyuEvidence(samples=[],{target,now=Date.now(),maxAgeHours=24,ownedSellerKeys=[]}={}){
 const expected=target,valid=[],ids=new Set(),sellers=new Set(),owned=new Set(ownedSellerKeys);
 const time=typeof now==='number'?now:Date.parse(now),hours=Math.min(24,Math.max(0,Number(maxAgeHours)||24));
 for(const s of samples){
  const url=canonicalXianyuOffer(s.url),age=time-Date.parse(s.checkedAt||'');
  if(!expected?.description||!procurementTargetsEqual(expected,s.target)||s.costVerification!==XIANYU_COST_VERIFICATION||
   !url||url!==s.canonicalUrl||new URL(url).searchParams.get('id')!==String(s.id)||ids.has(url)||
   !/^goofish:\d+$/.test(s.sellerKey||'')||sellers.has(s.sellerKey)||owned.has(s.sellerKey)||s.isOwn===true||
   s.priceSource!=='target_detail'||s.currency!=='CNY'||s.currencyEvidence!=='target_price_cny'||
   !(age>=0&&age<hours*3600000)||!s.detailTitle||!s.detailDescription||!s.selectedVariant||
   !s.detailImages?.length||!s.detailImages.every(safeProcurementUrl)||s.identity?.accepted!==true)continue;
  if(!s.purchaseTermsText||!s.purchaseTermsText.includes(s.detailDescription))continue;
  const terms=xianyuPurchaseTerms(s.purchaseTermsText);
  if(!terms.inStock||!terms.shippingKnown||s.inStock!==true||s.availabilityEvidence!==terms.availabilityEvidence||
   s.shippingKnown!==true||s.shippingCNY!==terms.shippingCNY||s.shippingScope!==terms.shippingScope||s.shippingEvidence!==terms.shippingEvidence)continue;
  const ownText=expected.title+'\n'+expected.description+'\n'+expected.condition,candidateText=s.detailTitle+'\n'+s.detailDescription;
  const quantity=xianyuOfferQuantity(candidateText),ownQuantity=xianyuOfferQuantity(ownText);
  if(!Number.isInteger(quantity)||quantity<1||quantity!==ownQuantity||s.quantity!==quantity||
   s.selectedVariant!==s.detailTitle||!offerIdentityGuard({ownTitle:expected.title,ownDescription:expected.description+'\n'+expected.condition,
    candidateTitle:s.detailTitle,candidateDescription:s.detailDescription,primaryImageScore:s.primaryImageScore}).accepted)continue;
  if(!Number.isFinite(s.unitCNY)||s.unitCNY<=0||s.landedCNY!==s.unitCNY+s.shippingCNY||s.price!==s.landedCNY)continue;
  ids.add(url);sellers.add(s.sellerKey);valid.push(s);
 }
 const prices=valid.map(s=>s.price).sort((a,b)=>a-b),mid=Math.floor(prices.length/2);
 const benchmarkMedianCNY=prices.length?(prices.length%2?prices[mid]:(prices[mid-1]+prices[mid])/2):null;
 const priceSpread=prices.length>=2?(prices.at(-1)-prices[0])/benchmarkMedianCNY:Infinity;
 const selectedSample=valid.length>=2&&priceSpread<=.30?[...valid].sort((a,b)=>a.price-b.price||a.canonicalUrl.localeCompare(b.canonicalUrl))[0]:null;
 return {ready:Boolean(selectedSample),samples:valid,sellerCount:valid.length,priceSpread,benchmarkMedianCNY,
  benchmarkCheckedAt:valid.length?new Date(Math.min(...valid.map(s=>Date.parse(s.checkedAt)))).toISOString():null,
  referenceCNY:selectedSample?.price??null,selectedSample,selectedQuote:selectedSample?xianyuQuoteSelection(selectedSample):null};
}

export function verifiedXianyuCost(item={},options={}){
 const cost=item.xianyu||{},target=procurementTarget(item);
 if(!procurementTargetsEqual(target,cost.target)||cost.costVerification!==XIANYU_COST_VERIFICATION)return null;
 const evidence=verifiedPurchasableXianyuEvidence(cost.samples,{...options,target,maxAgeHours:options.xianyuFreshHours??options.maxAgeHours});
 if(!evidence.ready||cost.averageCNY!==evidence.referenceCNY||cost.checkedAt!==evidence.selectedQuote.checkedAt||
  JSON.stringify(cost.selectedQuote)!==JSON.stringify(evidence.selectedQuote))return null;
 return {...cost,averageCNY:evidence.referenceCNY,samples:evidence.samples,benchmarkMedianCNY:evidence.benchmarkMedianCNY,benchmarkCheckedAt:evidence.benchmarkCheckedAt,
  referenceProvider:'xianyu',sourceLabel:'闲鱼供应商实价',selectedQuote:evidence.selectedQuote};
}
