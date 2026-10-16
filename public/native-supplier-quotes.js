// Native detail observations are an informational lane only. They must never
// become procurement references merely because they have a price or a SKU.
export const NATIVE_QUOTE_VERSION='native_supplier_quote_v1';
// Bilibili/Dewu detail URL contracts are not yet verified. A host or historical
// announcement alone cannot authorize an import from those platforms.
const hosts={xianyu:['www.goofish.com','goofish.com'],taobao:['item.taobao.com'],tmall:['detail.tmall.com'],youzan:['detail.youzan.com'],alter_shanghai:['www.alter-shanghai.cn']};
const currencies=new Set(['CNY','USD','JPY','EUR','GBP','HKD','TWD','SGD']);
const text=value=>typeof value==='string'?value.replace(/\s+/g,' ').trim():'';
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):typeof value==='string'?text(value):value;
function semantic(item,key){
 const alias=key==='description'?'ownDescription':'ownCondition';
 const value=item.sourceDetail&&Object.hasOwn(item.sourceDetail,key)?item.sourceDetail[key]:item.yahoo&&Object.hasOwn(item.yahoo,alias)?item.yahoo[alias]:item[key];
 return key==='condition'&&value!=null&&typeof value!=='string'?JSON.stringify(stable(value)):text(value);
}
export function nativeQuoteTarget(item={}){
 return {...Object.fromEntries(['accountId','id','title','image'].map(key=>[key,String(item[key]||'')])),description:semantic(item,'description'),condition:semantic(item,'condition')};
}
export function nativeQuoteUrl(value,platform,productId,skuId){
 try{
  const url=new URL(value),keys=[...url.searchParams.keys()];
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||!hosts[platform]?.includes(url.hostname)||url.href!==value||keys.some(key=>/^(?:access_token|token|auth|authorization|session|cookie|password|code)$/i.test(key)))return null;
  const identityKeys=keys.filter(key=>/^(?:id|itemid|item_id|skuid|sku_id|sku|alias|productid|product_id)$/i.test(key));
  const idKey=platform==='youzan'?'alias':'id';
  if(identityKeys.some(key=>![idKey,'skuId'].includes(key))||url.searchParams.getAll('skuId').length>1||url.searchParams.has('skuId')&&url.searchParams.get('skuId')!==skuId)return null;
  if(platform==='alter_shanghai')return url.pathname===`/m/spotPage/${productId}.html`&&/^\d+$/.test(productId)&&!identityKeys.length?url.origin+url.pathname:null;
  const route=platform==='xianyu'?'/item':platform==='youzan'?'/show/goods':'/item.htm';
  if(url.pathname!==route||url.searchParams.getAll(idKey).length!==1||url.searchParams.get(idKey)!==productId||!(platform==='youzan'?/^[a-z0-9]+$/:/^\d+$/).test(productId))return null;
  // Keep original finalUrl in provenance, but tracking changes cannot bypass a
  // product rejection. SKU is separately bound and checked when present in URL.
  return (platform==='xianyu'?'https://www.goofish.com':url.origin)+route+'?'+idKey+'='+productId;
 }catch{return null}
}
function targetMatches(target,item){
 const current=nativeQuoteTarget(item);
 return ['accountId','id','title','image'].every(key=>Boolean(current[key])&&target?.[key]===current[key])&&['description','condition'].every(key=>typeof target?.[key]==='string'&&target[key]===current[key]);
}
const documentedState=(value,states)=>value&&states.includes(value.status)&&(value.status==='unknown'?value.evidence===null:Boolean(text(value.evidence)));
const currencyPatterns={CNY:/\b(?:CNY|RMB)\b|人民币/i,USD:/\bUSD\b|US dollars?|美元/i,JPY:/\bJPY\b|日[元圆圓]/i,EUR:/\bEUR\b|欧元/i,GBP:/\bGBP\b|英镑/i,HKD:/\bHKD\b|港[币幣元]/i,TWD:/\bTWD\b|新[台臺][币幣]/i,SGD:/\bSGD\b|新加坡[元币幣]/i};
export function validNativeSupplierQuote(quote,item={}, {now=Date.now(),ownedSellerKeys=[]}={}){
 if(!quote||quote.verification!==NATIVE_QUOTE_VERSION||quote.use!=='reference_only'||quote.isOwn!==false||!targetMatches(quote.target,item))return false;
 const age=now-Date.parse(quote.checkedAt||'');
 if(!(age>=0&&age<86400000)||quote.checkedAt!==quote.provenance?.fetchedAt||quote.provenance?.pageKind!=='target_detail'||quote.provenance?.httpStatus!==200||!/^[a-f0-9]{64}$/.test(quote.provenance?.contentSha256||''))return false;
 if(!quote.canonicalUrl||nativeQuoteUrl(quote.url,quote.source,quote.productId,quote.skuId)!==quote.canonicalUrl||quote.url!==quote.provenance.finalUrl||!text(quote.productId)||!text(quote.skuId)||!text(quote.selectedVariant)||!text(quote.detailTitle)||!text(quote.sellerName)||!text(quote.sellerKey)||!quote.sellerKey.startsWith(quote.source+':')||!text(quote.sellerKey.slice(quote.source.length+1)))return false;
 if(ownedSellerKeys.includes(quote.sellerKey)||item.platform===quote.source&&[item.sellerId,item.sourceDetail?.sellerId,item.sourceDetail?.seller?.id].some(id=>id&&quote.sellerKey===quote.source+':'+id)||[item.url,item.ownUrl].some(url=>nativeQuoteUrl(url,quote.source,quote.productId,quote.skuId)===quote.canonicalUrl))return false;
 if(!Number.isInteger(quote.quantity)||quote.quantity<1||!text(quote.saleContents)||quote.priceKind!=='selected_sku_total'||quote.purchaseType!=='ordinary'||quote.priceCondition!=='unconditional'||!Number.isFinite(quote.nativePrice)||quote.nativePrice<=0||!currencies.has(quote.currency)||!text(quote.priceEvidence)||!currencyPatterns[quote.currency]?.test(text(quote.currencyEvidence)))return false;
 if(/\d\s*(?:元)?起|起价|起售价|定金|订金|预售|券后|(?:starts?|starting)\s+(?:at|from)|\bdeposit\b|\d\s*[-~～]\s*\d/i.test(quote.priceEvidence))return false;
 if(!(quote.priceEvidence.match(/\d[\d,]*(?:\.\d+)?/g)||[]).some(value=>Number(value.replaceAll(',',''))===quote.nativePrice))return false;
 if(!documentedState(quote.availability,['in_stock','out_of_stock','unknown'])||!documentedState(quote.condition,['new','used','unknown']))return false;
 if(!['pending','catalog_only'].includes(quote.identity?.status)||quote.identity.status==='catalog_only'&&!text(quote.identity.evidence))return false;
 const shipping=quote.shipping;
 if(shipping?.destinationCountry!=='CN'||!['unknown','published_terms'].includes(shipping.status))return false;
 if(shipping.status==='unknown')return shipping.amount===null&&shipping.currency===null&&shipping.scope===null&&shipping.evidence===null;
 return Number.isFinite(shipping.amount)&&shipping.amount>=0&&shipping.currency===quote.currency&&Boolean(text(shipping.scope))&&Boolean(text(shipping.evidence))&&shipping.applicability==='unconfirmed';
}
export function nativeQuoteBlockers(quote){
 const reasons=['尚未通过采购成本核验'];
 if(quote.identity.status==='pending')reasons.push('同款、规格和数量待核验');
 if(quote.identity.status==='catalog_only')reasons.push('仅确认目录款式，实物条件待核验');
 if(quote.availability.status==='unknown')reasons.push('库存未注明');
 if(quote.availability.status==='out_of_stock')reasons.push('缺货');
 if(quote.condition.status==='unknown')reasons.push('商品成色／封装未注明');
 reasons.push(quote.shipping.status==='unknown'?'中国境内运费未知':'运费适用地区待核验');
 return reasons;
}
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function nativeSupplierQuotesMarkup(item={},options={}){
 const quotes=(Array.isArray(item.nativeSupplierQuotes)?item.nativeSupplierQuotes:[]).filter(quote=>validNativeSupplierQuote(quote,item,options));
 if(!quotes.length)return '';
 return `<section class="procurement-evidence native-supplier-quotes"><h3>供应商原币报价</h3><p>以下为详情页观察值，尚未计入成本、利润或本轮成本核验完成数。</p><ul class="samples">${quotes.map(quote=>`<li><a target="_blank" rel="noopener" href="${escape(quote.url)}">${escape(quote.sellerName)} · ${escape(quote.detailTitle)}</a><span>${escape(quote.nativePrice.toLocaleString('zh-CN',{maximumFractionDigits:2}))} ${escape(quote.currency)}／${escape(quote.quantity)} 件（${escape(quote.saleContents)}）</span><span>所选规格：${escape(quote.selectedVariant)} · SKU ${escape(quote.skuId)}</span><span>库存：${{in_stock:'页面显示有货',out_of_stock:'页面显示缺货',unknown:'未知'}[quote.availability.status]} · 成色：${{new:'页面注明全新',used:'页面注明二手',unknown:'未知'}[quote.condition.status]}</span>${quote.shipping.status==='published_terms'?`<span>页面运费 ${escape(quote.shipping.amount)} ${escape(quote.shipping.currency)}，范围：${escape(quote.shipping.scope)}；适用性待核验</span>`:'<span>中国境内运费：未知</span>'}<span>待补证据：${escape(nativeQuoteBlockers(quote).join('；'))}</span><span>原始观察时间：${escape(quote.checkedAt)}</span></li>`).join('')}</ul></section>`;
}
