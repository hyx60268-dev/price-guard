import { publicHtml,searchExternalImages,externalImageQueries,externalPublicUrl } from './external-images.mjs';
import { imageFingerprints,primaryProductSimilarity } from './image.mjs';
import { offerIdentityGuard } from './offer-identity.mjs';
import { normalize,titleScore } from './rules.mjs';

import { PUBLIC_PROCUREMENT_VERIFICATION,procurementTarget,procurementSource,canonicalProcurementUrl,verifiedPublicCostEvidence,safeProcurementUrl as safe } from './procurement-evidence.mjs';
export { PUBLIC_PROCUREMENT_VERIFICATION,procurementTarget,procurementSource,canonicalProcurementUrl,verifiedPublicCostEvidence } from './procurement-evidence.mjs';
const text=value=>String(value||'').replace(/<[^>]*>/g,' ').replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();
// Read JSON literals already delivered to the public page. Never evaluate scripts.
export function embeddedPublicJSON(html,assignment='window._global'){
 const anchor=html.indexOf(assignment);if(anchor<0)return null;
 const start=html.indexOf('{',anchor);if(start<0)return null;
 let depth=0,string=false,escaped=false;
 for(let i=start;i<html.length;i++){
  const c=html[i];if(string){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')string=false}
  else if(c==='"')string=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){try{return JSON.parse(html.slice(start,i+1))}catch{return null}}
 }return null;
}
const colorText=value=>String(value||'').normalize('NFKC').replace(/ホワイト|同款白|凌赫白|白色|白(?=[】」])/g,' 白色 ').replace(/レッド|凌赫红|红色|红(?=[】」])/g,' 红色 ').replace(/ブラック|黑色/g,' 黑色 ').replace(/ブルー|蓝色/g,' 蓝色 ').replace(/張凌赫/g,'张凌赫');
export function chooseYouzanSku(goodsData,item){
 const g=goodsData?.goods||{},info=goodsData?.skuInfo||{},props=info.props||[];
 const query=colorText(item.title||'');
 const candidates=(info.skus||[]).map(sku=>{
  const options=props.map(prop=>({key:prop.k,value:prop.v?.find(v=>String(v.id)===String(sku[prop.k_s]))?.name||''}));
  return {skuId:String(sku.skuId||''),options,selectedVariant:options.map(o=>o.value).join(' / '),stock:info.skuStocks?.find(v=>String(v.skuId)===String(sku.skuId)),sku};
 }).filter(s=>s.skuId&&s.options.every(o=>o.value));
 if(!candidates.length&&!(props.length)&&info.spuPrice?.skuId&&info.spuStock?.skuId===info.spuPrice.skuId)candidates.push({skuId:String(info.spuPrice.skuId),options:[],selectedVariant:g.title,stock:info.spuStock,sku:{disableStatus:0}});
 const matched=candidates.filter(candidate=>candidate.options.every(option=>{
  if(candidates.length===1)return true;
  const value=colorText(option.value),color=value.match(/白色|红色|黑色|蓝色/)?.[0];
  if(color)return query.includes(color);
  return normalize(query).includes(normalize(option.value));
 }));
 if(matched.length!==1)return {ok:false,reason:matched.length?'sku_ambiguous':'sku_unconfirmed'};
 const chosen=matched[0];if(chosen.sku.disableStatus!==0||chosen.stock?.disable!==false||!(chosen.stock.stockNum>0))return {ok:false,reason:'out_of_stock',skuId:chosen.skuId};
 return {ok:true,...chosen};
}
export function youzanQuoteFromPublicState(state,item,url,selected){
 const data=state?.goodsData,g=data?.goods||{},shop=data?.shop||{},delivery=data?.delivery||{};
 const canonical=canonicalProcurementUrl(url),alias=canonical&&new URL(canonical).searchParams.get('alias');
 if(!data||g.alias!==alias||data.alias!==alias||String(g.kdtId)!==String(shop.kdtId)||g.soldStatus!=='SALE'||g.isDisplay!==1||g.isPhysical!==true||g.isVirtual||g.isVirtualCoupon||g.isInstallment||g.itemType!=='NORMAL'||state.isCloseBusiness)return {status:'incomplete',reason:'target_product_unconfirmed'};
 const chosen=chooseYouzanSku(data,item);if(!chosen.ok)return {status:'incomplete',...chosen};
 if(selected?.skuId!==chosen.skuId||selected.variant!==chosen.selectedVariant||selected.quantity!==1||!selected.visible||!(selected.price>0)||selected.stock!==chosen.stock.stockNum||selected.conditionedPrice)return {status:'incomplete',reason:'selected_sku_price_unconfirmed'};
 const shipping=delivery.postage;
 // This public template reports cents. Only explicit free express is supported:
 // region-dependent rates and unspecific range values remain unconfirmed.
 if(delivery.supportExpress!==true||delivery.canExpressReach!==true||shipping?.isDelivery!==true||shipping.min!==0||shipping.max!==0||!/免运费/.test(shipping.desc||''))return {status:'incomplete',reason:'shipping_unconfirmed'};
 if(!shop.shopName||!shop.kdtId)return {status:'incomplete',reason:'seller_unconfirmed'};
 const images=(g.pictures||[]).map(p=>p.url).filter(safe);
 const description=[g.subTitle,chosen.selectedVariant,...(g.itemCatePropDetailModel?.propNameList||[])].filter(Boolean).join('；');
 return {status:'quoted',source:'youzan',id:alias,skuId:chosen.skuId,url:canonical,canonicalUrl:canonical,sellerKey:'youzan:'+shop.kdtId,sellerName:shop.shopName,sellerIdentityKey:normalize(shop.shopName),
  unitCNY:selected.price,shippingCNY:0,landedCNY:selected.price,price:selected.price,currency:'CNY',inStock:true,skuVerified:true,shippingKnown:true,shippingScope:'source_displayed_destination',stock:chosen.stock.stockNum,
  selectedVariant:chosen.selectedVariant,detailTitle:g.title,detailDescription:description,detailImages:images,priceSource:'target_detail',priceEvidence:'visible_selected_sku',condition:'retail_unspecified',quantity:1};
}
function structuredProducts(html){
 const output=[];for(const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi))try{
  const walk=node=>{if(!node||typeof node!=='object')return;if([node['@type']].flat().includes('Product'))output.push(node);if(Array.isArray(node))node.forEach(walk);else if(node['@graph'])walk(node['@graph']);};walk(JSON.parse(match[1]));
 }catch{}return output;
}
export function parsePublicProcurementDetail(html,url){
 const source=procurementSource(url),canonical=canonicalProcurementUrl(url);if(!source)return {status:'unsupported',reason:'unsupported_source'};
 if(/<(?:iframe|form)[^>]*(?:captcha|challenge|baxia)|id=["'](?:captcha|b_captcha)/i.test(html))return {status:'unavailable',reason:'source_challenge'};
 const products=structuredProducts(html).filter(p=>canonicalProcurementUrl(p.url||p['@id'])===canonical);
 if(products.length!==1)return {status:'incomplete',reason:source==='youzan'?'sku_selection_required':'target_product_unconfirmed'};
 const p=products[0],offers=[p.offers||[]].flat(),offer=offers[0];
 if(offers.length!==1||offer?.['@type']!=='Offer'||offer.lowPrice!==undefined||offer.highPrice!==undefined||offer.priceSpecification?.['@type']==='CompoundPriceSpecification')return {status:'incomplete',reason:'price_or_variant_range'};
 if(offer.url&&canonicalProcurementUrl(offer.url)!==canonical||offer.itemOffered?.sku&&String(offer.itemOffered.sku)!==String(p.sku)||offer.priceValidUntil&&Date.parse(offer.priceValidUntil)<Date.now())return {status:'incomplete',reason:'target_offer_mismatch_or_expired'};
 const scalar=value=>typeof value==='number'?value:typeof value==='string'&&/^\d+(?:\.\d{1,2})?$/.test(value)?Number(value):null;
 const unitCNY=scalar(offer.price),skuId=String(p.sku||'');
 if(offer.priceCurrency!=='CNY'||!(unitCNY>0))return {status:'incomplete',reason:'cny_detail_price_missing'};
 if(!skuId||String(offer.sku||skuId)!==skuId||p.hasVariant||p.isVariantOf&&!p.color&&!p.model)return {status:'incomplete',reason:'sku_unconfirmed'};
 if(offer.availability!=='https://schema.org/InStock'||offer.itemCondition!=='https://schema.org/NewCondition')return {status:'incomplete',reason:'availability_or_condition_unconfirmed'};
 const badPrice=/订金|定金|尾款|每期|月供|券后|会员专享|起付|首付|deposit|installment/i.test([p.name,p.description,offer.name,offer.description,offer.priceSpecification?.name].join(' '));
 if(badPrice)return {status:'incomplete',reason:'conditional_or_partial_price'};
 if(offer.eligibleQuantity&&!(offer.eligibleQuantity.minValue===1&&(!offer.eligibleQuantity.maxValue||offer.eligibleQuantity.maxValue>=1)))return {status:'incomplete',reason:'quantity_price_unconfirmed'};
 const rate=[offer.shippingDetails||[]].flat();
 if(rate.length!==1||rate[0]?.shippingRate?.currency!=='CNY'||scalar(rate[0]?.shippingRate?.value)===null||rate[0]?.shippingDestination?.addressCountry!=='CN')return {status:'incomplete',reason:'shipping_unconfirmed'};
 const shippingCNY=scalar(rate[0].shippingRate.value),seller=offer.seller;
 if(!seller?.name||!seller?.['@id']||!safe(seller['@id'])||new URL(seller['@id']).hostname!==new URL(url).hostname)return {status:'incomplete',reason:'seller_unconfirmed'};
 const images=[p.image||[]].flat().map(v=>typeof v==='string'?v:v.url).filter(safe);
 if(!p.name||!p.description||!images.length)return {status:'incomplete',reason:'detail_content_unconfirmed'};
 return {status:'quoted',source,id:canonical,skuId,url:canonical,canonicalUrl:canonical,sellerKey:source+':'+seller['@id'],sellerName:seller.name,sellerIdentityKey:normalize(seller.name),unitCNY,shippingCNY,landedCNY:unitCNY+shippingCNY,price:unitCNY+shippingCNY,currency:'CNY',inStock:true,skuVerified:true,shippingKnown:true,shippingScope:'CN',selectedVariant:[p.model,p.color,p.size,skuId].filter(Boolean).join(' / '),detailTitle:p.name,detailDescription:text(p.description),detailImages:images,priceSource:'target_detail',priceEvidence:'target_product_offer',condition:'new',quantity:1};
}
// This function is serialized into the page. It only reads public DOM content;
// does not access session tokens, hidden account state or private endpoints.
export function readYouzanPublicDOM(){
 const visible=node=>{if(!node)return false;for(let n=node;n;n=n.parentElement){const s=getComputedStyle(n);if(n.hidden||s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false}const r=node.getBoundingClientRect();return r.width>0&&r.height>0};
 const blocked=[...document.querySelectorAll('iframe,form')].some(n=>visible(n)&&/captcha|challenge|baxia|\/punish/i.test((n.getAttribute('src')||'')+' '+n.id));
 const login=[...document.querySelectorAll('iframe[src*="login"],[role="dialog"][class*="login"]')].some(visible);
 let state=null;
 for(const script of document.querySelectorAll('script')){const value=script.textContent||'',anchor=value.indexOf('window._global =');if(anchor<0)continue;const start=value.indexOf('{',anchor);let depth=0,quoted=false,escaped=false;
  for(let i=start;i<value.length;i++){const c=value[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false}else if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){try{const all=JSON.parse(value.slice(start,i+1));state={goodsData:{alias:all.goodsData?.alias,goods:all.goodsData?.goods,shop:{kdtId:all.goodsData?.shop?.kdtId,shopName:all.goodsData?.shop?.shopName},skuInfo:all.goodsData?.skuInfo,delivery:{supportExpress:all.goodsData?.delivery?.supportExpress,canExpressReach:all.goodsData?.delivery?.canExpressReach,postage:all.goodsData?.delivery?.postage}},isCloseBusiness:all.isCloseBusiness};}catch{}break}}
 }
 const root=[...document.querySelectorAll('.sku-container')].find(visible),active=root?[...root.querySelectorAll('.sku-row__item--active .sku-row__item-name-text')].map(n=>n.innerText.trim()):[];
 const priceText=root?.querySelector('.sku__price-num')?.innerText?.trim()||'',stock=Number((root?.querySelector('.sku-header')?.innerText||'').match(/剩余\s*(\d+)\s*件/)?.[1]);
 const header=root?.querySelector('.sku-header')?.innerText||'';
 return {state,blocked,login,mobile:document.querySelector('meta[name="mobile-agent"]')?.content?.match(/url=(.*)$/)?.[1],selected:{visible:Boolean(root),labels:active,price:/^\d+(?:\.\d{1,2})?$/.test(priceText)?Number(priceText):null,stock,quantity:Number(root?.querySelector('input')?.value||0),conditionedPrice:/券后|会员专享|新人专享|每期|定金|订金|尾款/.test(header)}};
}
export async function readPublicProcurementDetail(url,{item,context,getContext,deadline=Date.now()+45000,html=publicHtml}={}){
 const source=procurementSource(url);if(!source)return {status:'unsupported',reason:'unsupported_source'};
 const remaining=()=>Math.max(1,Math.min(15000,deadline-Date.now()));
 if(source!=='youzan')return parsePublicProcurementDetail(await html(url,{deadline}),url);
 const browser=context||await getContext?.();
 if(!browser)return parsePublicProcurementDetail(await html(url,{deadline}),url);
 const page=await browser.newPage();
 try{
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:remaining()});
  let dom=await page.evaluate(readYouzanPublicDOM);
  if(dom.mobile&&!dom.state){const mobile=new URL(dom.mobile,page.url()).href;if(procurementSource(mobile)!=='youzan'||canonicalProcurementUrl(mobile)!==canonicalProcurementUrl(url))return {status:'incomplete',reason:'target_redirect_mismatch'};await page.goto(mobile,{waitUntil:'domcontentloaded',timeout:remaining()});}
  await page.waitForFunction(()=>Boolean(document.querySelector('.goods-title__main-text')),{},{timeout:remaining()}).catch(()=>{});
  dom=await page.evaluate(readYouzanPublicDOM);if(dom.blocked||dom.login)return {status:'unavailable',reason:dom.blocked?'source_challenge':'source_login_required'};
  if(canonicalProcurementUrl(page.url())!==canonicalProcurementUrl(url))return {status:'incomplete',reason:'target_redirect_mismatch'};
  const chosen=chooseYouzanSku(dom.state?.goodsData,item);if(!chosen.ok)return {status:'incomplete',reason:chosen.reason};
  const props=dom.state?.goodsData?.skuInfo?.props||[];
  if(!dom.selected.visible&&props.length)await page.getByText(props[0].k,{exact:true}).first().click({timeout:remaining()});
  for(const option of chosen.options){const active=await page.locator('.sku-container .sku-row__item--active .sku-row__item-name-text').allTextContents();if(!active.some(v=>v.trim()===option.value))await page.locator('.sku-container .sku-row__item-name-text').filter({hasText:option.value}).click({timeout:remaining()});}
  await page.waitForFunction(labels=>{const root=document.querySelector('.sku-container');return root&&labels.every(label=>[...root.querySelectorAll('.sku-row__item--active .sku-row__item-name-text')].some(n=>n.innerText.trim()===label))},chosen.options.map(o=>o.value),{timeout:remaining()});
  dom=await page.evaluate(readYouzanPublicDOM);if(dom.blocked||dom.login)return {status:'unavailable',reason:dom.blocked?'source_challenge':'source_login_required'};
  const variant=dom.selected.labels.join(' / ');return youzanQuoteFromPublicState(dom.state,item,url,{...dom.selected,variant,skuId:variant===chosen.selectedVariant?chosen.skuId:null});
 }finally{await page.close().catch(()=>{})}
}
function rejected(records,item,candidate){return Object.values(records||{}).some(r=>!r.deleted&&r.accountId===item.accountId&&(r.itemId===item.id||r.itemId===item.relistedFrom&&r.ownTitle===item.title&&r.ownImage===item.image)&&(r.candidateId===candidate.id||r.candidateId===candidate.skuId||r.candidateId===candidate.canonicalUrl||canonicalProcurementUrl(r.candidateUrl||r.url)===candidate.canonicalUrl));}
export async function alternativeProcurementCost(item,{deadline=Date.now()+90000,maxDetails=8,search=searchExternalImages,detail=readPublicProcurementDetail,fingerprint=imageFingerprints,matchCorrections={},context,getContext}={}){
 const target=procurementTarget(item),checkedAt=new Date().toISOString(),report={status:'incomplete',averageCNY:null,samples:[],sellerCount:0,verification:PUBLIC_PROCUREMENT_VERIFICATION,checkedAt,target,diagnostics:[],searched:0,detailCheckedCount:0};
 if(Object.values(target).some(v=>!v))return {...report,reason:'target_identity_missing'};
 if(Date.now()>=deadline)return {...report,status:'deferred',reason:'budget_exhausted'};
 const own=await fingerprint(item.image);if(!own)return {...report,status:'unavailable',reason:'target_image_unavailable'};
 const seen=new Set();let sourcesCompleted=0,sourceFailure=false;
 const consume=async rows=>{for(const row of rows){if(Date.now()>=deadline||seen.size>=maxDetails)return;
  const url=canonicalProcurementUrl(row.url);if(!url||seen.has(url))continue;seen.add(url);
  try{const quote=await detail(url,{item,context,getContext,deadline});report.detailCheckedCount++;
   if(quote.status!=='quoted'){if(quote.status==='unavailable'||quote.status==='error')sourceFailure=true;report.diagnostics.push({source:procurementSource(url),reason:quote.reason,url});continue}
   if(rejected(matchCorrections,item,quote)){report.diagnostics.push({source:quote.source,reason:'rejected_by_memory',url});continue}
   const query=externalImageQueries(item.title)[0],candidate=colorText(quote.detailTitle+' '+quote.selectedVariant);
   const titleMatch=titleScore(query,candidate),fp=await fingerprint(quote.detailImages?.[0]),primaryImageScore=primaryProductSimilarity(own,fp);
   const guard=offerIdentityGuard({ownTitle:colorText(query),ownDescription:item.yahoo?.ownDescription||item.description||'',candidateTitle:candidate,candidateDescription:quote.detailDescription,primaryImageScore});
   if(!guard.accepted||!(primaryImageScore>=.98)||titleMatch<.62){report.diagnostics.push({source:quote.source,reason:guard.accepted?'identity_unconfirmed':guard.reason,url,titleScore:titleMatch,primaryImageScore});continue}
   report.samples.push({...quote,checkedAt:new Date().toISOString(),verification:PUBLIC_PROCUREMENT_VERIFICATION,target,identity:{accepted:true,titleScore:titleMatch,primaryImageScore}});
   if(verifiedPublicCostEvidence(report.samples,{target}).ready)return;
  }catch(e){sourceFailure=true;report.diagnostics.push({source:procurementSource(url),reason:String(e?.message||e).slice(0,160),url})}
 }};
 const known=/Anker/i.test(item.title)&&/AeroClip\s*2/i.test(item.title)&&/張凌赫|张凌赫/.test(item.title)?[{url:'https://detail.youzan.com/show/goods?alias=2osy35s5abbdhtd'}]:[];
 await consume([...known,...(item.procurementSource?.samples||[])]);
 for(const query of externalImageQueries(item.title).slice(0,2))for(const provider of ['duckduckgo','bing']){
  if(Date.now()>=deadline||seen.size>=maxDetails||verifiedPublicCostEvidence(report.samples,{target}).ready)break;
  try{report.searched++;const found=await search(query+' 购买 现货',{provider,deadline});sourcesCompleted++;await consume(Array.isArray(found)?found:found.candidates||[])}catch(e){sourceFailure=true;report.diagnostics.push({source:provider,reason:String(e?.message||e).slice(0,160)})}
 }
 const evidence=verifiedPublicCostEvidence(report.samples,{target});Object.assign(report,{samples:evidence.samples,sellerCount:evidence.sellerCount,priceSpread:evidence.priceSpread});
 if(evidence.ready)return {...report,status:'ok',averageCNY:evidence.median,reviewedAt:new Date().toISOString(),reviewVersion:1};
 if(Date.now()>=deadline)return {...report,status:'deferred',reason:'budget_exhausted'};
 if(sourceFailure||!sourcesCompleted&&!report.detailCheckedCount)return {...report,status:report.samples.length?'incomplete':'unavailable',reason:'source_unavailable'};
 return {...report,reason:evidence.sellerCount?'independent_sellers_insufficient':'no_verified_detail',reviewedAt:new Date().toISOString(),reviewVersion:1};
}
