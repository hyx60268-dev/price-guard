import { reviewedProcurementCatalogIdentity } from './reviewed-procurement-catalog.mjs';
import { PUBLIC_PURCHASABLE_VERIFICATION } from './procurement-evidence.mjs';
import { ALTER_NARBERAL_URL,isAlterNarberalTarget,readAlterProcurementDetail,procurementSourcePlanVersion } from './alter-procurement.mjs';
import { publicHtml,searchExternalImages,externalImageQueries,externalSearchQueries,externalPublicUrl,publicAccessRoute } from './external-images.mjs';
import { imageFingerprints,primaryProductSimilarity } from './image.mjs';
import { offerIdentityGuard } from './offer-identity.mjs';
import { normalize,titleScore } from './rules.mjs';

import { PUBLIC_PROCUREMENT_VERIFICATION,procurementTarget,procurementSource,canonicalProcurementUrl,verifiedPublicCostEvidence,safeProcurementUrl as safe } from './procurement-evidence.mjs';
export { PUBLIC_PROCUREMENT_VERIFICATION,procurementTarget,procurementSource,canonicalProcurementUrl,verifiedPublicCostEvidence } from './procurement-evidence.mjs';
const text=value=>String(value||'').replace(/<[^>]*>/g,' ').replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();
// A brand's own storefronts on different platforms are one source of pricing.
// Do not merge independent retailers merely because they sell that brand.
export function procurementSellerIdentity(name=''){
 const value=String(name).normalize('NFKC');
 const anker=/(?:^|[^a-z])anker(?:$|[^a-z])|安克/i.test(value);
 const official=/官方|旗舰|旗艦|直营|直營/.test(value)&&!/非(?:官方|旗舰|旗艦|直营|直營)|not\s+official/i.test(value);
 return anker&&official?'brand_official:anker':normalize(value);
}
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
 return {status:'quoted',source:'youzan',id:alias,skuId:chosen.skuId,url:canonical,canonicalUrl:canonical,sellerKey:'youzan:'+shop.kdtId,sellerName:shop.shopName,sellerIdentityKey:procurementSellerIdentity(shop.shopName),
  unitCNY:selected.price,shippingCNY:0,landedCNY:selected.price,price:selected.price,currency:'CNY',inStock:true,skuVerified:true,shippingKnown:true,shippingScope:'source_displayed_destination',stock:chosen.stock.stockNum,
  selectedVariant:chosen.selectedVariant,detailTitle:g.title,detailDescription:description,detailImages:images,priceSource:'target_detail',priceEvidence:'visible_selected_sku',condition:'retail_unspecified',quantity:1};
}
// Only these public, bounded fields may leave a detail reader. In particular,
// raw final URLs, HTML, headers and embedded account state never enter a report.
export function safeProcurementDiagnostic(value={}){
 const result={};
 if(['timeout','network','size_limit','redirect_limit','invalid_url','reader_error'].includes(value.failureKind))result.failureKind=value.failureKind;
 for(const key of ['stage','selectionAction'])if(typeof value[key]==='string')result[key]=diagnosticText(value[key],80);
 const host=entry=>typeof entry==='string'&&/^[a-z0-9.-]+$/i.test(entry)?entry.slice(0,100):null;
 if(host(value.finalHost))result.finalHost=host(value.finalHost);
 if(Array.isArray(value.redirectHosts))result.redirectHosts=value.redirectHosts.map(host).filter(Boolean).slice(0,4);
 for(const key of ['httpStatus','redirectCount','responseBytes','schemaScriptCount','schemaParseErrorCount','productCount','matchedProductCount','offerCount','skuCount','visiblePrice','visibleStock','quantity','selectionAttempts']){
  if(typeof value[key]==='number'&&Number.isFinite(value[key])&&value[key]>=0)result[key]=Math.min(value[key],key==='responseBytes'?3_000_000:1_000_000);
 }
 for(const key of ['targetUrlMatched','hasPublicState','loginFormPresent','challengeMarkerPresent','stoppedBeforeAccess'])if(typeof value[key]==='boolean')result[key]=value[key];
 for(const key of ['expectedLabels','visibleLabels'])if(Array.isArray(value[key]))result[key]=value[key].slice(0,8).map(entry=>diagnosticText(entry,100));
 if(Array.isArray(value.visibleRowPrices))result.visibleRowPrices=value.visibleRowPrices.filter(entry=>typeof entry==='number'&&Number.isFinite(entry)&&entry>=0).slice(0,8);
 if(Array.isArray(value.visibleOptions))result.visibleOptions=value.visibleOptions.slice(0,8).map(entry=>({label:diagnosticText(entry?.label,100),active:entry?.active===true,disabled:entry?.disabled===true}));
 return result;
}
function detailFailureKind(error){const value=String(error?.name||'')+' '+String(error?.message||'');return /timeout|timed? ?out|lookup_deadline/i.test(value)?'timeout':/过大/.test(value)?'size_limit':/跳转过多/.test(value)?'redirect_limit':/地址无效/.test(value)?'invalid_url':/fetch|network|ECONN|ENOTFOUND|socket|断流/i.test(value)?'network':'reader_error';}
function fetchDiagnostic(metadata={},url){
 let finalHost;try{finalHost=new URL(metadata.finalUrl||url).hostname}catch{}
 return safeProcurementDiagnostic({stage:'public_detail',finalHost,httpStatus:metadata.httpStatus,redirectHosts:metadata.redirectHosts,
  redirectCount:metadata.redirectCount,responseBytes:metadata.responseBytes,stoppedBeforeAccess:metadata.stoppedBeforeAccess,
  ...(metadata.finalUrl?{targetUrlMatched:canonicalProcurementUrl(metadata.finalUrl)===canonicalProcurementUrl(url)}:{})});
}
function structuredProducts(html){
 const products=[];let scriptCount=0,parseErrors=0;
 for(const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
  scriptCount++;
  try{const walk=node=>{if(!node||typeof node!=='object')return;if([node['@type']].flat().includes('Product'))products.push(node);if(Array.isArray(node))node.forEach(walk);else if(node['@graph'])walk(node['@graph']);};walk(JSON.parse(match[1]));}
  catch{parseErrors++;}
 }
 return {products,scriptCount,parseErrors};
}
export function parsePublicProcurementDetail(html,url,{metadata={}}={}){
 html=String(html||'');
 const source=procurementSource(url),canonical=canonicalProcurementUrl(url),structured=structuredProducts(html);
 const products=structured.products.filter(p=>canonicalProcurementUrl(p.url||p['@id'])===canonical);
 const challenge=/<(?:iframe|form)[^>]*(?:captcha|challenge|baxia)|id=["'](?:captcha|b_captcha)/i.test(html);
 const diagnostic={...fetchDiagnostic(metadata,url),schemaScriptCount:structured.scriptCount,schemaParseErrorCount:structured.parseErrors,
  productCount:structured.products.length,matchedProductCount:products.length,challengeMarkerPresent:challenge,
  hasPublicState:/window\._global\s*=|__NEXT_DATA__|__INITIAL_STATE__|__INIT_DATA__/.test(html),
  loginFormPresent:/<form\b[^>]*>[\s\S]{0,30000}?<input\b[^>]*type\s*=\s*["']password["']/i.test(html)};
 let readable=false;
 const fail=(reason,status='incomplete',reviewComplete=readable)=>({status,reason,reviewComplete,diagnostic:safeProcurementDiagnostic(diagnostic)});
 if(!source)return fail('unsupported_source','unsupported',false);
 const access=metadata.accessRoute||publicAccessRoute(metadata.finalUrl||url);
 if(access==='challenge'||challenge)return fail('source_challenge','unavailable',false);
 if(access==='login'||metadata.httpStatus===401)return fail('source_login_required','unavailable',false);
 if(Number.isFinite(metadata.httpStatus)&&metadata.httpStatus>=400)return fail('source_http_'+metadata.httpStatus,'unavailable',false);
 if(metadata.finalUrl&&canonicalProcurementUrl(metadata.finalUrl)!==canonical)return fail('target_redirect_mismatch','incomplete',false);
 if(!structured.scriptCount)return fail('structured_data_missing','unavailable',false);
 if(!structured.products.length)return fail(structured.parseErrors?'structured_data_invalid':'structured_product_missing','unavailable',false);
 if(!products.length)return fail('target_product_mismatch','incomplete',false);
 if(products.length!==1)return fail('target_product_ambiguous','incomplete',false);
 const p=products[0],offers=[p.offers||[]].flat(),offer=offers[0];diagnostic.offerCount=offers.length;
 const images=[p.image||[]].flat().map(v=>typeof v==='string'?v:v?.url).filter(safe);
 readable=Boolean(p.name&&p.description&&images.length);
 if(offers.length!==1||offer?.['@type']!=='Offer'||offer.lowPrice!==undefined||offer.highPrice!==undefined||offer.priceSpecification?.['@type']==='CompoundPriceSpecification')return fail('price_or_variant_range');
 if(offer.url&&canonicalProcurementUrl(offer.url)!==canonical||offer.itemOffered?.sku&&String(offer.itemOffered.sku)!==String(p.sku)||offer.priceValidUntil&&Date.parse(offer.priceValidUntil)<Date.now())return fail('target_offer_mismatch_or_expired');
 const scalar=value=>typeof value==='number'?value:typeof value==='string'&&/^\d+(?:\.\d{1,2})?$/.test(value)?Number(value):null;
 const unitCNY=scalar(offer.price),skuId=String(p.sku||'');
 if(offer.priceCurrency!=='CNY'||!(unitCNY>0))return fail('cny_detail_price_missing');
 if(!skuId||String(offer.sku||skuId)!==skuId||p.hasVariant||p.isVariantOf&&!p.color&&!p.model)return fail('sku_unconfirmed');
 if(offer.availability!=='https://schema.org/InStock'||offer.itemCondition!=='https://schema.org/NewCondition')return fail('availability_or_condition_unconfirmed');
 const badPrice=/订金|定金|尾款|每期|月供|券后|会员专享|起付|首付|deposit|installment/i.test([p.name,p.description,offer.name,offer.description,offer.priceSpecification?.name].join(' '));
 if(badPrice)return fail('conditional_or_partial_price');
 if(offer.eligibleQuantity&&!(offer.eligibleQuantity.minValue===1&&(!offer.eligibleQuantity.maxValue||offer.eligibleQuantity.maxValue>=1)))return fail('quantity_price_unconfirmed');
 const rate=[offer.shippingDetails||[]].flat();
 if(rate.length!==1||rate[0]?.shippingRate?.currency!=='CNY'||scalar(rate[0]?.shippingRate?.value)===null||rate[0]?.shippingDestination?.addressCountry!=='CN')return fail('shipping_unconfirmed');
 const destination=rate[0].shippingDestination;
 // No destination address is supplied to this collector. A quote limited to a
 // province, locality or postcode cannot become a generally applicable cost.
 if(Object.entries(destination).some(([key,value])=>!['@type','addressCountry'].includes(key)&&value!==undefined&&value!==null&&value!==''))return fail('shipping_destination_unconfirmed');
 const shippingCNY=scalar(rate[0].shippingRate.value),seller=offer.seller;
 if(!seller?.name||!seller?.['@id']||!safe(seller['@id'])||new URL(seller['@id']).hostname!==new URL(url).hostname)return fail('seller_unconfirmed');
 if(!readable)return fail('detail_content_unconfirmed','incomplete',false);
 return {status:'quoted',source,id:canonical,skuId,url:canonical,canonicalUrl:canonical,sellerKey:source+':'+seller['@id'],sellerName:seller.name,sellerIdentityKey:procurementSellerIdentity(seller.name),unitCNY,shippingCNY,landedCNY:unitCNY+shippingCNY,price:unitCNY+shippingCNY,currency:'CNY',inStock:true,skuVerified:true,shippingKnown:true,shippingScope:'CN',selectedVariant:[p.model,p.color,p.size,skuId].filter(Boolean).join(' / '),detailTitle:p.name,detailDescription:text(p.description),detailImages:images,priceSource:'target_detail',priceEvidence:'target_product_offer',condition:'new',conditionEvidence:offer.itemCondition,quantity:1,reviewComplete:true,diagnostic:safeProcurementDiagnostic(diagnostic)};
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
 const options=root?[...root.querySelectorAll('.sku-row__item-name-text')].map(n=>({label:n.innerText.trim(),active:Boolean(n.closest('.sku-row__item--active')),disabled:Boolean(n.closest('.sku-row__item--disabled,[aria-disabled="true"],[disabled]'))})):[];
 const rowPrices=root?[...root.querySelectorAll('.sku-row__item--active .sku-row__item-price')].map(n=>{const value=(n.innerText||'').replace(/[¥￥,\s]/g,'');return /^\d+(?:\.\d{1,2})?$/.test(value)?Number(value):null}):[];
 return {state,blocked,login,mobile:document.querySelector('meta[name="mobile-agent"]')?.content?.match(/url=(.*)$/)?.[1],selected:{visible:Boolean(root),labels:active,options,rowPrices,price:/^\d+(?:\.\d{1,2})?$/.test(priceText)?Number(priceText):null,stock,quantity:Number(root?.querySelector('input')?.value||0),conditionedPrice:/券后|会员专享|新人专享|每期|定金|订金|尾款/.test(header)}};
}
// Require consecutive observations of the selected public SKU. This does not
// retry access challenges, change authentication, or dismiss a login surface.
export async function settleYouzanSelection(page,chosen,{deadline=Date.now()+2500}={}){
 const expected=chosen.options.map(o=>o.value);
 const diagnostic=dom=>({stage:'selected_sku',expectedLabels:expected,visibleLabels:dom.selected?.labels||[],visiblePrice:dom.selected?.price??null,visibleStock:Number.isFinite(dom.selected?.stock)?dom.selected.stock:null,quantity:dom.selected?.quantity??null,visibleRowPrices:dom.selected?.rowPrices||[],visibleOptions:(dom.selected?.options||[]).slice(0,8).map(o=>({label:String(o.label).slice(0,100),active:o.active===true,disabled:o.disabled===true}))});
 const check=dom=>Boolean(dom.selected?.visible)&&JSON.stringify(dom.selected.labels)===JSON.stringify(expected)&&dom.selected.quantity===1&&dom.selected.price>0&&dom.selected.stock===chosen.stock.stockNum&&(!dom.selected.rowPrices?.length||expected.length!==1||dom.selected.rowPrices.length===1&&dom.selected.rowPrices[0]===dom.selected.price);
 let previous=null;
 for(let attempt=0;attempt<3;attempt++){
  const dom=await page.evaluate(readYouzanPublicDOM);
  if(dom.blocked||dom.login)return {ok:false,status:'unavailable',reason:dom.blocked?'source_challenge':'source_login_required',diagnostic:diagnostic(dom)};
  if(previous&&check(dom)&&check(previous)&&dom.selected.price===previous.selected.price&&dom.selected.stock===previous.selected.stock)return {ok:true,dom};
  previous=dom;if(attempt<2&&Date.now()<deadline)await page.waitForTimeout(Math.min(attempt===0?400:600,Math.max(1,deadline-Date.now())));else break;
 }return {ok:false,status:'incomplete',reason:'selected_sku_unsettled',diagnostic:diagnostic(previous||{})};
}
// Opening the sheet can asynchronously apply its default option. Observe first:
// clicking an option from a stale empty selection can toggle the default off.
export async function ensureYouzanSelection(page,chosen,{deadline=Date.now()+15000}={}){
 let settled=await settleYouzanSelection(page,chosen,{deadline});
 if(settled.ok||settled.status==='unavailable')return settled;
 let selectionAttempts=0;
 for(let attempt=0;attempt<2&&Date.now()<deadline;attempt++){
  let clicked=false;
  for(const option of chosen.options){
   const before=await page.evaluate(readYouzanPublicDOM);
   if(before.blocked||before.login)return {...settled,status:'unavailable',reason:before.blocked?'source_challenge':'source_login_required',diagnostic:{...settled.diagnostic,selectionAttempts}};
   const row=before.selected?.options?.find(row=>row.label===option.value);
   if(!before.selected?.visible||!row||row.disabled)return {...settled,diagnostic:{...settled.diagnostic,selectionAttempts,selectionAction:'target_option_not_available'}};
   if(row.active)continue;
   // Resolve an inactive target at action time. If it becomes selected while
   // Playwright waits, a timeout is re-observed, not converted into a blind click.
   const exact=new RegExp('^'+option.value.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&')+'$');
   selectionAttempts++;clicked=true;
   try{await page.locator('.sku-container:visible .sku-row__item-name-text:not(.sku-row__item--active *)').filter({hasText:exact}).click({timeout:Math.max(1,Math.min(2500,deadline-Date.now()))});}
   catch(error){if(error.name!=='TimeoutError'&&!/Timeout.*exceeded/i.test(error.message||''))throw error;}
  }
  settled=await settleYouzanSelection(page,chosen,{deadline});
  if(settled.ok||settled.status==='unavailable')return settled.ok?settled:{...settled,diagnostic:{...settled.diagnostic,selectionAttempts}};
  // One corrective selection is allowed only for an explicitly empty selected
  // state. Never reselect a proven option to paper over a price/stock mismatch.
  if(!clicked||settled.diagnostic?.visibleLabels?.length)break;
 }
 return {...settled,diagnostic:{...settled.diagnostic,selectionAttempts}};
}
export async function readPublicProcurementDetail(url,{item,context,getContext,deadline=Date.now()+45000,html=publicHtml}={}){
 const source=procurementSource(url);if(!source)return {status:'unsupported',reason:'unsupported_source',reviewComplete:false};
 const remaining=()=>Math.max(1,Math.min(15000,deadline-Date.now()));
 const staticRead=async()=>{try{const response=await html(url,{deadline,withMetadata:true});return parsePublicProcurementDetail(typeof response==='string'?response:response?.html,url,{metadata:typeof response==='string'?{}:response?.metadata||{}});}catch(error){return {status:'unavailable',reason:'detail_fetch_error',reviewComplete:false,diagnostic:safeProcurementDiagnostic({...fetchDiagnostic(error.publicMetadata||{},url),failureKind:detailFailureKind(error)})};}};
 if(source==='alter_shanghai')return readAlterProcurementDetail(url,{item,context,getContext,deadline});
 if(source!=='youzan')return staticRead();
 const browser=context||await getContext?.();
 if(!browser)return staticRead();
 const page=await browser.newPage();let response,dom={},redirectHosts=[];
 const diagnostic=()=>safeProcurementDiagnostic({...fetchDiagnostic({finalUrl:page.url(),httpStatus:response?.status?.(),redirectHosts,redirectCount:redirectHosts.length},url),hasPublicState:Boolean(dom.state?.goodsData?.goods),skuCount:dom.state?.goodsData?.skuInfo?.skus?.length||0,challengeMarkerPresent:dom.blocked===true});
 const fail=(reason,status='incomplete',reviewComplete=false,extra={})=>({status,reason,reviewComplete,diagnostic:safeProcurementDiagnostic({...diagnostic(),...extra})});
 const access=()=>{const route=publicAccessRoute(page.url());if(dom.blocked||route==='challenge')return fail('source_challenge','unavailable');if(dom.login||route==='login'||response?.status?.()===401)return fail('source_login_required','unavailable');if(response?.status?.()>=400)return fail('source_http_'+response.status(),'unavailable');return null;};
 const navigate=async target=>{response=await page.goto(target,{waitUntil:'domcontentloaded',timeout:remaining()});if(page.url()!==target)redirectHosts.push(new URL(page.url()).hostname);};
 try{
  await navigate(url);dom=await page.evaluate(readYouzanPublicDOM);
  if(access())return access();
  if(dom.mobile&&!dom.state){const mobile=new URL(dom.mobile,page.url()).href;if(procurementSource(mobile)!=='youzan'||canonicalProcurementUrl(mobile)!==canonicalProcurementUrl(url))return fail('target_redirect_mismatch');await navigate(mobile);dom=await page.evaluate(readYouzanPublicDOM);if(access())return access();}
  await page.waitForFunction(()=>Boolean(document.querySelector('.goods-title__main-text')),{},{timeout:remaining()}).catch(()=>{});
  dom=await page.evaluate(readYouzanPublicDOM);if(access())return access();
  if(canonicalProcurementUrl(page.url())!==canonicalProcurementUrl(url))return fail('target_redirect_mismatch');
  const data=dom.state?.goodsData,alias=new URL(canonicalProcurementUrl(url)).searchParams.get('alias');
  if(!data?.goods)return fail('public_state_unavailable','unavailable');
  if(data.alias!==alias||data.goods.alias!==alias)return fail('target_product_mismatch');
  // A matching alias can arrive before the actual product payload. An empty
  // shell is an unread page, not a completed negative SKU review.
  const goods=data.goods;
  if(typeof goods.title!=='string'||!goods.title.trim()||!(goods.pictures||[]).some(p=>safe(p?.url))||typeof goods.soldStatus!=='string'||!goods.soldStatus||typeof goods.isDisplay!=='number'||typeof goods.isPhysical!=='boolean')return fail('public_product_content_unavailable','unavailable');
  const chosen=chooseYouzanSku(data,item);if(!chosen.ok)return fail(chosen.reason,'incomplete',true);
  const props=data.skuInfo?.props||[];
  if(!dom.selected.visible&&props.length)await page.getByText(props[0].k,{exact:true}).filter({visible:true}).first().click({timeout:remaining()});
  const settled=await ensureYouzanSelection(page,chosen,{deadline});if(!settled.ok)return fail(settled.reason,settled.status,false,settled.diagnostic);dom=settled.dom;
  const variant=dom.selected.labels.join(' / '),quote=youzanQuoteFromPublicState(dom.state,item,url,{...dom.selected,variant,skuId:variant===chosen.selectedVariant?chosen.skuId:null});
  return {...quote,reviewComplete:quote.reason!=='target_product_unconfirmed',diagnostic:diagnostic()};
 }catch(error){return fail('detail_read_error','unavailable',false,{stage:'public_detail',failureKind:detailFailureKind(error)});}
 finally{await page.close().catch(()=>{})}
}

function rejected(records,item,candidate){return Object.values(records||{}).some(r=>!r.deleted&&r.accountId===item.accountId&&(r.itemId===item.id||r.itemId===item.relistedFrom&&r.ownTitle===item.title&&r.ownImage===item.image)&&(r.candidateId===candidate.id||r.candidateId===candidate.skuId||r.candidateId===candidate.canonicalUrl||canonicalProcurementUrl(r.candidateUrl||r.url)===candidate.canonicalUrl));}
function diagnosticText(value,limit=160){
 return String(value??'').replace(/<[^>]*>/g,' ').replace(/https?:\/\/[^\s"'<>]+/gi,'[url omitted]').replace(/\b(?:set-cookie|cookie|authorization|token|password|session)\s*[:=][^,;\n]*/gi,'[sensitive omitted]').replace(/\s+/g,' ').trim().slice(0,limit);
}
function searchExample(row,reason){let host='';try{host=new URL(row.url).hostname.slice(0,100)}catch{}return {host,title:diagnosticText(row.title,100),reason};}
// Direct detail recall only. Every returned page still passes SKU, availability,
// target identity and price verification; an entry is never an accepted quote.
export function knownProcurementUrls(item={}){
 if(isAlterNarberalTarget(item))return [ALTER_NARBERAL_URL];
 return /Anker/i.test(item.title||'')&&/AeroClip\s*2/i.test(item.title||'')&&/張凌赫|张凌赫/.test(item.title||'')
  ?['https://detail.youzan.com/show/goods?alias=2osy35s5abbdhtd']:[];
}
export async function alternativeProcurementCost(item,{deadline=Date.now()+90000,maxDetails=8,search=searchExternalImages,detail=readPublicProcurementDetail,fingerprint=imageFingerprints,matchCorrections={},context,getContext}={}){
 const target=procurementTarget(item),checkedAt=new Date().toISOString(),report={status:'incomplete',averageCNY:null,samples:[],purchasableOffers:[],sellerCount:0,verification:PUBLIC_PROCUREMENT_VERIFICATION,sourcePlanVersion:procurementSourcePlanVersion(item),checkedAt,target,diagnostics:[],searched:0,detailCheckedCount:0,searchResults:[],unsupportedTargets:0,duplicateUrls:0};
 const diagnose=row=>{if(report.diagnostics.length<16)report.diagnostics.push({...row,source:row.source?diagnosticText(row.source,32):undefined,url:row.url&&row.url.length<=512?canonicalProcurementUrl(row.url)||undefined:undefined,reason:diagnosticText(row.reason)})};
 if(['accountId','id','title','image'].some(key=>!target[key])){diagnose({stage:'target',reason:'target_identity_missing'});return {...report,reason:'target_identity_missing'};}
 if(Date.now()>=deadline)return {...report,status:'deferred',reason:'budget_exhausted'};
 const own=await fingerprint(item.image);if(!own){diagnose({stage:'target',reason:'target_image_unavailable'});return {...report,status:'unavailable',reason:'target_image_unavailable'};}
 const seen=new Set();let sourcesCompleted=0,sourceFailure=false;
 const selectCandidates=(rows,summary)=>{const unique=new Set(),accepted=[];for(const row of rows){const url=canonicalProcurementUrl(row.url);let reason;
  if(!url){report.unsupportedTargets++;if(summary)summary.unsupportedTargets++;reason='unsupported_detail_target';}
  else if(seen.has(url)||unique.has(url)){report.duplicateUrls++;if(summary)summary.duplicateUrls++;reason='duplicate_detail_url';}
  else{unique.add(url);accepted.push(row);continue}
  if(summary&&summary.rejectedExamples.length<3)summary.rejectedExamples.push(searchExample(row,reason));
 }return accepted;};
 const consume=async rows=>{for(const row of rows){if(Date.now()>=deadline||seen.size>=maxDetails)return;
  const url=canonicalProcurementUrl(row.url);if(!url||seen.has(url))continue;seen.add(url);
  try{const quote=await detail(url,{item,context,getContext,deadline});report.detailCheckedCount++;
   if(quote.status!=='quoted'){if(quote.status==='unavailable'||quote.status==='error'||quote.reviewComplete===false)sourceFailure=true;diagnose({source:procurementSource(url),reason:quote.reason,url,...(quote.diagnostic?{detail:safeProcurementDiagnostic(quote.diagnostic)}:{})});continue}
   if(rejected(matchCorrections,item,quote)){diagnose({source:quote.source,reason:'rejected_by_memory',url});continue}
   const query=externalImageQueries(item.title)[0],candidate=colorText([quote.brand,quote.series,quote.detailTitle,quote.selectedVariant].filter(Boolean).join(' '));
   const titleMatch=titleScore(query,candidate),fp=await fingerprint(quote.detailImages?.[0]),primaryImageScore=primaryProductSimilarity(own,fp);
   // Search queries deliberately strip descriptors and may truncate. Only the
   // original offer can provide quantity, condition and version constraints.
   const conditionText=value=>typeof value==='string'?value:value?.name||value?.text||value?.label||value?.key||'';
   const ownDescription=[item.sourceDetail?.description,item.yahoo?.ownDescription,item.description,conditionText(item.sourceDetail?.condition),conditionText(item.condition)].filter(Boolean).join('\n');
   const ownTitle=[item.title,item.sourceDetail?.title].filter(Boolean).join('\n');
   // Lossless equivalent spelling only: preserve every character outside these
   // observed aliases, including condition, quantity and suffixes past 80 chars.
   const identityText=value=>colorText(value).replace(/白色/g,'ホワイト').replace(/红色/g,'レッド').replace(/黑色/g,'ブラック').replace(/蓝色/g,'ブルー').replace(/ギフトボックス/g,'礼盒').replace(/コラボ/g,'联名');
   // NewCondition is explicit source evidence; normal retail / unknown condition
   // is not. Do not infer new/sealed from a shop name or a matching photograph.
   const candidateDescription=[quote.brand,quote.series,quote.detailDescription,quote.conditionEvidence==='https://schema.org/NewCondition'?'新品':''].filter(Boolean).join('\n');
   const sealed=/(?:未開封|未拆封|未开封|全新未拆)/;
   const candidateOriginal=[quote.detailTitle,quote.selectedVariant,quote.detailDescription].filter(Boolean).join('\n');
   const sealConflict=/(?:已[开拆]封|開封済|拆封验货|不是.{0,3}未[开拆]封|非.{0,3}未[开拆]封|不(?:保证|确定).{0,4}未[开拆]封)/;
   const guard=offerIdentityGuard({ownTitle:identityText(ownTitle),ownDescription:identityText(ownDescription),candidateTitle:identityText([quote.brand,quote.series,quote.detailTitle,quote.selectedVariant].filter(Boolean).join(' ')),candidateDescription:identityText(candidateDescription),primaryImageScore});
   if(sealed.test(ownTitle+'\n'+ownDescription)&&(!sealed.test(candidateOriginal)||sealConflict.test(candidateOriginal))){
    // A reviewed catalog identity can expose this real retail offer separately.
    // It does not establish unopened condition and never enters cost samples.
    const physicalCompatible=guard.accepted||guard.reason==='condition_or_packaging_mismatch';
    const catalogIdentity=physicalCompatible&&quote.condition==='retail_unspecified'&&!sealConflict.test(candidateOriginal)&&titleMatch>=.62
     ?reviewedProcurementCatalogIdentity({item,quote,ownPrimary:own,sourcePrimary:fp}):null;
    if(catalogIdentity)report.purchasableOffers.push({...quote,checkedAt:new Date().toISOString(),verification:PUBLIC_PURCHASABLE_VERIFICATION,
     target,catalogIdentity,eligibility:'condition_unconfirmed',condition:'retail_unspecified',
     identity:{method:'reviewed_catalog_identity',accepted:true,titleScore:titleMatch,primaryImageScore}});
    diagnose({source:quote.source,reason:'sealed_condition_unconfirmed',url,titleScore:titleMatch,primaryImageScore,purchasableOffer:Boolean(catalogIdentity)});continue;
   }
   if(!guard.accepted||!(primaryImageScore>=.98)||titleMatch<.62){diagnose({source:quote.source,reason:guard.accepted?'identity_unconfirmed':guard.reason,url,titleScore:titleMatch,primaryImageScore});continue}
   report.samples.push({...quote,sellerIdentityKey:procurementSellerIdentity(quote.sellerName),checkedAt:new Date().toISOString(),verification:PUBLIC_PROCUREMENT_VERIFICATION,target,identity:{accepted:true,titleScore:titleMatch,primaryImageScore}});
   if(verifiedPublicCostEvidence(report.samples,{target}).ready)return;
  }catch(e){sourceFailure=true;diagnose({source:procurementSource(url),reason:String(e?.message||e).slice(0,160),url})}
 }};
 const known=knownProcurementUrls(item).map(url=>({url}));
 await consume(selectCandidates([...known,...(item.procurementSource?.samples||[])]));
 for(const query of externalSearchQueries(item.title).slice(0,2))for(const provider of ['duckduckgo','bing']){
  if(Date.now()>=deadline||seen.size>=maxDetails||verifiedPublicCostEvidence(report.samples,{target}).ready)break;
  const summary={provider,query:diagnosticText(query+' 购买 现货'),returned:0,rejected:0,accepted:0,unsupportedTargets:0,duplicateUrls:0,rejectedExamples:[]};
  report.searchResults.push(summary);
  try{report.searched++;let selectedBeforeLimit=false;
   const found=await search(query+' 购买 现货',{provider,deadline,candidateSelector:rows=>{selectedBeforeLimit=true;return selectCandidates(rows,summary)}});sourcesCompleted++;
   const candidates=Array.isArray(found)?found:found.candidates||[];
   summary.returned=Number.isFinite(found.returned)?found.returned:candidates.length;
   summary.rejected=Number.isFinite(found.rejected)?found.rejected:0;
   for(const row of (found.rejectedExamples||[]).slice(0,3))if(summary.rejectedExamples.length<3)summary.rejectedExamples.push(searchExample(row,'search_relevance'));
   const selected=(selectedBeforeLimit?candidates:selectCandidates(candidates,summary)).slice(0,5);summary.accepted=selected.length;
   await consume(selected);
  }catch(e){sourceFailure=true;summary.error=diagnosticText(e?.message||e);diagnose({stage:'search',source:provider,reason:summary.error})}
 }
 const evidence=verifiedPublicCostEvidence(report.samples,{target});Object.assign(report,{samples:evidence.samples,sellerCount:evidence.sellerCount,priceSpread:evidence.priceSpread});
 if(evidence.ready)return {...report,status:'ok',averageCNY:evidence.referenceCNY,selectedQuote:evidence.selectedQuote,selectionMode:evidence.selectionMode,checkedAt:evidence.selectedQuote.checkedAt,reviewedAt:new Date().toISOString(),reviewVersion:1};
 if(Date.now()>=deadline)return {...report,status:'deferred',reason:'budget_exhausted'};
 if(sourceFailure||!sourcesCompleted&&!report.detailCheckedCount)return {...report,status:report.samples.length?'incomplete':'unavailable',reason:'source_unavailable'};
 return {...report,reason:evidence.sellerCount?'independent_sellers_insufficient':'no_verified_detail',reviewedAt:new Date().toISOString(),reviewVersion:1};
}
