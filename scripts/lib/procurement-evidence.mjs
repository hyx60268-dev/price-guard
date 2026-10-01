export const PUBLIC_PROCUREMENT_VERIFICATION='public_procurement_detail_v1';
export const procurementTarget=item=>({accountId:String(item?.accountId||''),id:String(item?.id||''),title:String(item?.title||''),image:String(item?.image||'')});
const amount=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
export const safeProcurementUrl=url=>{try{const u=new URL(url);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&u.hostname.includes('.')&&!/^(?:localhost|.*\.localhost|.*\.local|\d+(?:\.\d+){3}|\[)/i.test(u.hostname)}catch{return false}};
const safe=safeProcurementUrl;
export function procurementSource(url){
 try{const u=new URL(url);if(!safe(url))return null;
  if(u.hostname==='detail.youzan.com'&&u.pathname==='/show/goods'&&/^[a-z0-9]+$/.test(u.searchParams.get('alias')||'')||/(?:^|\.)youzan\.com$/.test(u.hostname)&&/^\/(?:v2\/goods|wscgoods\/detail)\/[a-z0-9]+$/.test(u.pathname))return 'youzan';
  if(u.hostname==='item.jd.com'&&/^\/\d+\.html$/.test(u.pathname))return 'jd';
  if(['item.taobao.com','detail.tmall.com'].includes(u.hostname)&&u.pathname==='/item.htm'&&/^\d+$/.test(u.searchParams.get('id')||''))return u.hostname.includes('tmall')?'tmall':'taobao';
  if(u.hostname==='weidian.com'&&u.pathname==='/item.html'&&/^\d+$/.test(u.searchParams.get('itemID')||''))return 'weidian';
  if(u.hostname==='detail.1688.com'&&/^\/offer\/\d+\.html$/.test(u.pathname))return '1688';
 }catch{}return null;
}
export function canonicalProcurementUrl(value){
 try{const u=new URL(value);const source=procurementSource(value);if(!source)return null;
  if(source==='youzan'){const alias=u.searchParams.get('alias')||u.pathname.split('/').pop();return 'https://detail.youzan.com/show/goods?alias='+alias}
  if(['jd','1688'].includes(source))return u.origin+u.pathname;
  const key=source==='weidian'?'itemID':'id';return u.origin+u.pathname+'?'+key+'='+u.searchParams.get(key);
 }catch{return null}
}
function targetEqual(a,b){return ['accountId','id','title','image'].every(k=>Boolean(a?.[k])&&a[k]===b?.[k])}
export function verifiedPublicCostEvidence(samples=[],{now=Date.now(),maxAgeHours=24,target}={}){
 const valid=[],urls=new Set(),sellers=new Set(),identities=new Set(),evidenceTarget=target||samples[0]?.target;const time=typeof now==='number'?now:Date.parse(now);
 for(const s of samples){
  const age=time-Date.parse(s.checkedAt||'');
  if(s.verification!==PUBLIC_PROCUREMENT_VERIFICATION||s.currency!=='CNY'||s.priceSource!=='target_detail'||s.skuVerified!==true||s.inStock!==true||s.shippingKnown!==true||!s.skuId||!s.selectedVariant||!s.detailTitle||!s.detailDescription||!s.detailImages?.length||!s.detailImages.every(safe)||!s.sellerKey||!s.sellerName||!s.sellerIdentityKey||!s.identity?.accepted||s.identity.primaryImageScore<.98||s.identity.titleScore<.62||!Number.isFinite(s.identity.primaryImageScore)||!Number.isFinite(s.identity.titleScore))continue;
  if(!targetEqual(s.target,evidenceTarget)||!(age>=0&&age<=maxAgeHours*3600000))continue;
  if(!(amount(s.unitCNY)>0)||amount(s.shippingCNY)===null||s.landedCNY!==s.unitCNY+s.shippingCNY||s.price!==s.landedCNY)continue;
  const url=canonicalProcurementUrl(s.url);if(!url||url!==s.canonicalUrl||!procurementSource(s.url)||urls.has(url)||sellers.has(s.sellerKey)||identities.has(s.sellerIdentityKey))continue;
  urls.add(url);sellers.add(s.sellerKey);identities.add(s.sellerIdentityKey);valid.push(s);
 }
 const prices=valid.map(s=>s.price).sort((a,b)=>a-b),mid=Math.floor(prices.length/2),median=prices.length?prices.length%2?prices[mid]:(prices[mid-1]+prices[mid])/2:null;
 const priceSpread=prices.length>=2?(prices.at(-1)-prices[0])/median:Infinity;
 return {ready:valid.length>=2&&priceSpread<=.30,median,sellerCount:valid.length,samples:valid,priceSpread};
}
