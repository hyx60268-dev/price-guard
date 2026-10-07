const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const link=value=>/^https:\/\//i.test(value||'')?escape(value):'#';
const cny=value=>Number.isFinite(value)?'¥'+value.toLocaleString('zh-CN',{maximumFractionDigits:2}):'待核验';
export function procurementLabel(item={}){return item.referenceProvider==='public_cn'?(item.referenceSourceLabel||'国内公开采购参考'):'闲鱼采购参考';}

const normalizedText=value=>typeof value==='string'?value.replace(/\s+/g,' ').trim():'';
function normalizedCondition(value){
 if(value===null||value===undefined)return '';
 if(typeof value==='string')return normalizedText(value);
 const stable=entry=>Array.isArray(entry)?entry.map(stable):entry&&typeof entry==='object'?Object.fromEntries(Object.keys(entry).sort().map(key=>[key,stable(entry[key])])):typeof entry==='string'?normalizedText(entry):entry;
 return JSON.stringify(stable(value));
}
function observedSemantic(item,field){
 const normalize=field==='condition'?normalizedCondition:normalizedText;
 if(item.sourceDetail&&Object.hasOwn(item.sourceDetail,field))return {known:true,value:normalize(item.sourceDetail[field])};
 const alias=field==='description'?'ownDescription':'ownCondition';
 if(item.yahoo&&Object.hasOwn(item.yahoo,alias))return {known:true,value:normalize(item.yahoo[alias])};
 return Object.hasOwn(item,field)?{known:true,value:normalize(item[field])}:{known:false};
}
function currentOfferTarget(item,target){
 const binding=item.procurementTarget;
 if(!['accountId','id','title','image'].every(key=>typeof item[key]==='string'&&Boolean(item[key])&&binding?.[key]===item[key]&&target?.[key]===item[key]))return false;
 return ['description','condition'].every(key=>{
  if(typeof binding?.[key]!=='string'||typeof target?.[key]!=='string'||normalizedText(binding[key])!==normalizedText(target[key]))return false;
  const observed=observedSemantic(item,key);
  return !observed.known||observed.value===normalizedText(binding[key]);
 });
}

// Full descriptions and image bytes are checked in the cloud before compact
// publication. The browser independently rejects expired or cross-item quotes.
export function visiblePurchasableOffers(item={},now=Date.now()){
 return (Array.isArray(item.procurementSource?.purchasableOffers)?item.procurementSource.purchasableOffers:[]).filter(offer=>{
  if(!offer||typeof offer!=='object')return false;
  const age=now-Date.parse(offer.checkedAt||'');
  return age>=0&&age<=24*3600000&&offer.verification==='public_purchasable_offer_v1'&&
   offer.eligibility==='condition_unconfirmed'&&offer.condition==='retail_unspecified'&&
   currentOfferTarget(item,offer.target)&&
   offer.identity?.method==='reviewed_catalog_identity'&&offer.catalogIdentity?.method==='reviewed_catalog_identity'&&
   offer.catalogIdentity?.scope==='catalogue_product_only'&&offer.catalogIdentity?.sealVerified===false&&
   offer.status==='quoted'&&offer.inStock===true&&offer.currency==='CNY'&&offer.shippingKnown===true&&
   Number.isFinite(offer.unitCNY)&&offer.unitCNY>0&&Number.isFinite(offer.shippingCNY)&&offer.shippingCNY>=0&&
   offer.landedCNY===offer.unitCNY+offer.shippingCNY&&offer.price===offer.landedCNY&&offer.url===offer.canonicalUrl;
 });
}
function quoteMarkup(sample,label){
 return `<li>${label?'<strong>'+escape(label)+'</strong>':''}<a target="_blank" rel="noopener" href="${link(sample.url||sample.canonicalUrl)}">${escape(sample.sellerName||sample.source||'采购来源')} · ${escape(sample.detailTitle||sample.title||'已核验商品')}</a>${sample.selectedVariant?`<span>规格：${escape(sample.selectedVariant)}</span>`:''}<span>商品 ${cny(sample.unitCNY)}＋国内运费 ${cny(sample.shippingCNY)}＝${cny(sample.landedCNY??sample.price)}</span>${sample.deliveryTerms?`<span>配送条件：${escape(sample.deliveryTerms)}</span>`:''}${sample.checkedAt?`<span>报价时间：${escape(new Date(sample.checkedAt).toLocaleString('zh-CN'))}</span>`:''}</li>`;
}
export function publicProcurementMarkup(item={},options={}){
 const cost=item.procurementSource||{},samples=cost.samples||[],selected=item.referenceProvider==='public_cn';
 const offers=visiblePurchasableOffers(item,options.now??Date.now());
 const statuses={ok:selected?'已用于采购参考':'已有核验参考',incomplete:'规格、库存、运费或卖家证据待补齐',no_verified_cost:'尚无满足条件的采购参考',no_results:'本轮未找到可核验的采购商品',error:'部分采购来源暂时无法读取',unavailable:'采购来源暂时受限，后续继续检查',deferred:'本轮检查时间已用完，后续继续核验'};
 const status=offers.length&&!samples.length?'已找到 '+offers.length+' 个供应商现货报价':statuses[cost.status]||'等待云端检查',quote=cost.selectedQuote;
 const chosen=sample=>Boolean(selected&&cost.status==='ok'&&quote&&sample.canonicalUrl===quote.canonicalUrl&&String(sample.skuId)===String(quote.skuId)&&sample.sellerKey===quote.sellerKey&&Number(sample.landedCNY??sample.price)===Number(quote.landedCNY));
 const verified=samples.length?`<p class="muted">采购参考采用供应商实际可购报价，含国内运费。人工填写的采购价优先使用。</p><ul class="samples">${samples.map(sample=>quoteMarkup(sample,chosen(sample)?'已采用的供应商报价':'')).join('')}</ul>`:'';
 const available=offers.length?`<p>下列同款报价有现货和运费信息。供应商未注明是否原封，尚未计入成本及利润。</p><ul class="samples">${offers.map(sample=>quoteMarkup(sample,'供应商现货报价 · 封装未注明')).join('')}</ul>`:'';
 return `<section class="procurement-evidence"><h3>国内公开采购渠道</h3><p>${escape(status)}${cost.checkedAt?' · '+escape(new Date(cost.checkedAt).toLocaleString('zh-CN')):''}</p>${verified}${available}${!samples.length&&!offers.length?'<ul class="samples"><li>尚未取得符合商品规格的可购买详情报价。</li></ul>':''}</section>`;
}
