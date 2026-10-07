import { ALTER_NARBERAL_URL,isAlterProcurementUrl } from './alter-procurement.mjs';
import { verifiedProcurementAuthority } from './procurement-authority.mjs';
export const PUBLIC_PROCUREMENT_VERIFICATION='public_procurement_detail_v3';
const identityFields=['accountId','id','title','image'];
const semanticFields=['description','condition'];
const normalizedText=value=>typeof value==='string'?value.replace(/\s+/g,' ').trim():'';
function normalizedCondition(value){
 if(value===null||value===undefined)return '';
 if(typeof value==='string')return normalizedText(value);
 // Platforms may expose condition as {name,key}, nested labels, or an ID.
 // Keep every observed field in stable key order instead of discarding objects.
 const stable=entry=>Array.isArray(entry)?entry.map(stable):entry&&typeof entry==='object'
  ?Object.fromEntries(Object.keys(entry).sort().map(key=>[key,stable(entry[key])]))
  :typeof entry==='string'?normalizedText(entry):entry;
 return JSON.stringify(stable(value));
}
function observedSemantic(item,field){
 const normalize=field==='condition'?normalizedCondition:normalizedText;
 // Explicitly observed blanks clear prior text. Never replace them with an older
 // cached description/condition from a different field.
 if(item.sourceDetail&&Object.hasOwn(item.sourceDetail,field))return normalize(item.sourceDetail[field]);
 const alias=field==='description'?'ownDescription':'ownCondition';
 if(item.yahoo&&Object.hasOwn(item.yahoo,alias))return normalize(item.yahoo[alias]);
 return normalize(item[field]);
}
export function procurementTarget(item={}){
 return {...Object.fromEntries(identityFields.map(key=>[key,String(item[key]||'')])),
  description:observedSemantic(item,'description'),condition:observedSemantic(item,'condition')};
}
export function procurementTargetsEqual(a,b){
 // Older four-field bindings are incompatible, even when the new fields are
 // presently unknown. Unknown values may only match explicitly captured unknowns.
 return identityFields.every(key=>typeof a?.[key]==='string'&&Boolean(a[key])&&a[key]===b?.[key])&&
  semanticFields.every(key=>Object.hasOwn(a||{},key)&&Object.hasOwn(b||{},key)&&
   typeof a[key]==='string'&&typeof b[key]==='string'&&normalizedText(a[key])===normalizedText(b[key]));
}

const amount=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
export const safeProcurementUrl=url=>{try{const u=new URL(url);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&u.hostname.includes('.')&&!/^(?:localhost|.*\.localhost|.*\.local|\d+(?:\.\d+){3}|\[)/i.test(u.hostname)}catch{return false}};
const safe=safeProcurementUrl;
// This observed JD mobile route is the same product, not a new source.
// Reject ambiguous identity parameters before stripping tracking parameters.
function jdProductId(u){
 let id;
 if(u.hostname==='item.jd.com')id=u.pathname.match(/^\/(\d+)\.html$/)?.[1];
 else if(u.hostname==='item.m.jd.com'&&u.pathname==='/ware/view.action'){
  const ids=u.searchParams.getAll('wareId');if(ids.length!==1)return null;id=ids[0];
 }
 if(!id||!/^\d+$/.test(id))return null;
 const identities=new Set();
 for(const [key,value]of u.searchParams){
  if(!['wareid','id','sku','skuid','itemid'].includes(key.toLowerCase()))continue;
  if(identities.has(key.toLowerCase())||value!==id)return null;identities.add(key.toLowerCase());
 }
 return id;
}
export function procurementSource(url){
 try{const u=new URL(url);if(!safe(url))return null;
  if(u.hostname==='detail.youzan.com'&&u.pathname==='/show/goods'&&/^[a-z0-9]+$/.test(u.searchParams.get('alias')||'')||/(?:^|\.)youzan\.com$/.test(u.hostname)&&/^\/(?:v2\/goods|wscgoods\/detail)\/[a-z0-9]+$/.test(u.pathname))return 'youzan';
  if(isAlterProcurementUrl(url))return 'alter_shanghai';
  if(jdProductId(u))return 'jd';
  if(['item.taobao.com','detail.tmall.com'].includes(u.hostname)&&u.pathname==='/item.htm'&&/^\d+$/.test(u.searchParams.get('id')||''))return u.hostname.includes('tmall')?'tmall':'taobao';
  if(u.hostname==='weidian.com'&&u.pathname==='/item.html'&&/^\d+$/.test(u.searchParams.get('itemID')||''))return 'weidian';
  if(u.hostname==='detail.1688.com'&&/^\/offer\/\d+\.html$/.test(u.pathname))return '1688';
 }catch{}return null;
}
export function canonicalProcurementUrl(value){
 try{const u=new URL(value);const source=procurementSource(value);if(!source)return null;
  if(source==='youzan'){const alias=u.searchParams.get('alias')||u.pathname.split('/').pop();return 'https://detail.youzan.com/show/goods?alias='+alias}
  if(source==='alter_shanghai')return ALTER_NARBERAL_URL;
  if(source==='jd')return 'https://item.jd.com/'+jdProductId(u)+'.html';
  if(source==='1688')return u.origin+u.pathname;
  const key=source==='weidian'?'itemID':'id';return u.origin+u.pathname+'?'+key+'='+u.searchParams.get(key);
 }catch{return null}
}
export function procurementQuoteSelection(sample){
 const keys=['source','canonicalUrl','skuId','sellerKey','sellerIdentityKey','selectedVariant','unitCNY','shippingCNY','landedCNY','checkedAt','shippingScope','shippingMethod','purchaseLimit','deliveryTerms'];
 return {...Object.fromEntries(keys.filter(key=>sample[key]!==undefined).map(key=>[key,sample[key]])),authority:verifiedProcurementAuthority(sample)};
}
export function verifiedPublicCostEvidence(samples=[],{now=Date.now(),maxAgeHours=24,target}={}){
 const valid=[],urls=new Set(),sellers=new Set(),identities=new Set(),evidenceTarget=target||samples[0]?.target;const time=typeof now==='number'?now:Date.parse(now);
 for(const s of samples){
  const age=time-Date.parse(s.checkedAt||'');
  if(s.verification!==PUBLIC_PROCUREMENT_VERIFICATION||s.currency!=='CNY'||s.priceSource!=='target_detail'||s.skuVerified!==true||s.inStock!==true||s.shippingKnown!==true||!s.skuId||!s.selectedVariant||!s.detailTitle||!s.detailDescription||!s.detailImages?.length||!s.detailImages.every(safe)||!s.sellerKey||!s.sellerName||!s.sellerIdentityKey||!s.identity?.accepted||s.identity.primaryImageScore<.98||s.identity.titleScore<.62||!Number.isFinite(s.identity.primaryImageScore)||!Number.isFinite(s.identity.titleScore))continue;
  if(!procurementTargetsEqual(s.target,evidenceTarget)||!(age>=0&&age<=maxAgeHours*3600000))continue;
  if(!(amount(s.unitCNY)>0)||amount(s.shippingCNY)===null||s.landedCNY!==s.unitCNY+s.shippingCNY||s.price!==s.landedCNY)continue;
  const url=canonicalProcurementUrl(s.url);if(!url||url!==s.canonicalUrl||!procurementSource(s.url)||urls.has(url)||sellers.has(s.sellerKey)||identities.has(s.sellerIdentityKey))continue;
  urls.add(url);sellers.add(s.sellerKey);identities.add(s.sellerIdentityKey);valid.push(s);
 }
 const prices=valid.map(s=>s.price).sort((a,b)=>a-b),mid=Math.floor(prices.length/2),median=prices.length?prices.length%2?prices[mid]:(prices[mid-1]+prices[mid])/2:null;
 const priceSpread=prices.length>=2?(prices.at(-1)-prices[0])/median:Infinity;
 // A reference must be an offer someone actually sells. The median is retained
 // only as a comparison statistic, never as the payable amount.
 const compared=valid.length>=2&&priceSpread<=.30;
 const eligible=compared?valid:valid.filter(sample=>verifiedProcurementAuthority(sample));
 const selectedSample=[...eligible].sort((a,b)=>a.price-b.price||a.canonicalUrl.localeCompare(b.canonicalUrl))[0]||null;
 const authority=selectedSample&&verifiedProcurementAuthority(selectedSample);
 const selectionMode=selectedSample?(authority?(authority.type==='verified_official_store'?'verified_official_offer':'reviewed_supplier_offer'):'compared_seller_offer'):null;
 return {ready:Boolean(selectedSample),referenceCNY:selectedSample?.price??null,selectedSample,
  selectedQuote:selectedSample?procurementQuoteSelection(selectedSample):null,selectionMode,
  median,sellerCount:valid.length,samples:valid,priceSpread};
}
