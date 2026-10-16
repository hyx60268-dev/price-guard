// Local full-cycle integration. Explicit injected readers only; no runner,
// publication hook, rate policy or implicit marketplace/image request.
import {createHash} from 'node:crypto';
import {rejectedByMemory} from '../../public/match-memory.js';
import {exactQueryFor} from './yahoo.mjs';
import {explicitSaleContents,semanticQuantity,titleScore} from './rules.mjs';
import {graphImageReader} from './graph-image-reader.mjs';
import {createRakumaVerificationContext,extractRakumaDetail,extractRakumaSearchCards,
  nextRakumaSearchPage,screenRakumaCard,verifyRakumaDetail} from './rakuma.mjs';

const GATES=['identity','quantity','condition','correction','ownership','price','availability','shipping'];
const unknownGates=()=>Object.fromEntries(GATES.map(gate=>[gate,'unknown']));
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key=target=>`${target.accountId}:${target.id}`;
const unknownReasons=new Set(['availability_unconfirmed','shipping_unconfirmed','detail_error',
  'sale_description_unavailable','collectible_variant_image_unconfirmed','primary_variant_unconfirmed',
  'physical_product_type_unconfirmed']);
const gateFor=reason=>reason==='availability_unconfirmed'?'availability':reason==='saved_user_correction'?'correction':
  /own_seller|managed_shop/.test(reason)?'ownership':reason==='not_open'?'availability':reason==='sale_unit_mismatch'?'quantity':
  /defect|condition|packaging/.test(reason)?'condition':reason==='shipping_unconfirmed'?'shipping':'identity';
const rejectDecision=(reason,{unknown=unknownReasons.has(reason)}={})=>{
  const gates=unknownGates();if(!unknown)gates[gateFor(reason)]='reject';return {gates,reason};
};
const stamp=value=>typeof value==='number'?value:Date.parse(value||'');
const statusValues=value=>[value?.httpStatus,value?.status].filter(status=>status!==undefined)
  .map(status=>typeof status==='number'||typeof status==='string'&&/^\d{3}$/.test(status)?Number(status):NaN);
const deniedStatus=value=>statusValues(value).some(status=>[401,403,429].includes(status));
function sourceDenied(source={}){
  const error=new Error('Rakuma source access denied; no alternate route');error.code='ACCESS_DENIED';
  for(const field of ['httpStatus','status','retryAfter','retryAt','reason'])if(source[field]!==undefined)error[field]=source[field];
  return error;
}
function verifyPageTransport(page,requestedUrl){
  if(deniedStatus(page))throw sourceDenied(page);
  const statuses=statusValues(page);
  // Complete HTML requires 200. Missing, partial, cached or contradictory
  // transport evidence never becomes a valid current price or empty result.
  if(!statuses.length||statuses.some(status=>status!==200))throw new Error('rakuma_response_status_unproven');
  for(const field of ['url','finalUrl','finalURL','responseUrl','responseURL','redirectedUrl','redirectedURL']){
    if(page[field]===undefined)continue;
    let finalUrl;try{finalUrl=new URL(page[field]).href;}catch{throw new Error('rakuma_response_url_unproven');}
    if(finalUrl!==requestedUrl)throw new Error('rakuma_response_url_mismatch');
  }
  if(page.redirected===true)throw new Error('rakuma_redirected_response');
}
const definitiveCardReasons=new Set(['managed_shop','saved_user_correction','physical_product_type_unconfirmed',
  'explicit_variant_mismatch','description_color_mismatch','defect']);
const cleanItemUrl=value=>{
  const url=new URL(value);
  if(url.protocol!=='https:'||url.hostname!=='item.fril.jp'||url.port||url.username||url.password||
    !/^\/[a-f0-9]+\/?$/i.test(url.pathname)||url.search||url.hash)throw new Error('rakuma_detail_request_invalid');
  return url.href;
};
const searchUrl=value=>{
  const url=new URL(value);
  if(url.protocol!=='https:'||url.hostname!=='fril.jp'||url.port||url.username||url.password||url.pathname!=='/s'||url.hash||
    !url.searchParams.get('query')||url.searchParams.get('transaction')!=='selling'||
    url.searchParams.get('sort')!=='sell_price'||url.searchParams.get('order')!=='asc'||
    [...url.searchParams.keys()].some(k=>!['query','transaction','sort','order','page'].includes(k))||
    [...new Set(url.searchParams.keys())].some(k=>url.searchParams.getAll(k).length!==1)||
    (url.searchParams.has('page')&&!/^[1-9]\d*$/.test(url.searchParams.get('page'))))throw new Error('rakuma_search_request_invalid');
  return url.href;
};
export function rakumaGraphSearchSpec(title,{accessScope='public'}={}){
  return {accessScope,query:{url:`https://fril.jp/s?query=${encodeURIComponent(exactQueryFor(title))}&transaction=selling&sort=sell_price&order=asc`}};
}
// One whole sale offer, never a manufacturer SKU or cross-account identity.
// Contents and quantities inside a bundle remain full-detail matching gates.
export function rakumaCycleOwnIdentity(target,detail,{cycleId,observedAt}={}){
  return {skuId:`rakuma-cycle-offer:${digest([cycleId,key(target),'rakuma',detail.id,observedAt,
    detail.title,detail.description,detail.category,detail.condition,detail.images])}`,
    quantity:1,quantityBasis:'whole_listing_sale_unit',scope:'cycle_target_offer',canonicalSku:false};
}
export function createRakumaGraphAdapter({fetchPage,imageFingerprints,resolveOwnIdentity=rakumaCycleOwnIdentity,
  settings={},now=Date.now,shippingDestination='JP',accessScope='public'}={}){
  if(typeof fetchPage!=='function'||typeof imageFingerprints!=='function'||typeof resolveOwnIdentity!=='function')
    throw new Error('Explicit Rakuma page, image and identity readers are required');
  const coverageProofs=new Map(),ownIdentities=new Map();
  const contextKey=(target,own,cycleId)=>digest([cycleId,key(target),own.observedAt,own.data]);
  const current=(raw,context)=>raw?.cycleId===context.cycleId&&raw.fromCache===false&&
    Number.isFinite(raw.observedAt)&&raw.observedAt<=now()&&
    (context.deadlineAt===undefined||raw.observedAt<=context.deadlineAt);
  const currentItem=(target,own)=>{
    const detail=own.data;
    // Never recover missing current own evidence from cached target fields.
    return {...target,title:detail.title,description:detail.description,category:detail.category,
      image:detail.images?.[0]||'',images:[...(detail.images||[])],sellerId:detail.sellerId,
      sourceDetail:{...detail,description:[detail.description,detail.condition].filter(Boolean).join('\n')},yahoo:undefined};
  };
  async function fetchRaw(request,context){
    if(request.source!=='rakuma'||request.accessScope!==accessScope||request.parameters!==undefined)
      throw new Error('rakuma_reader_scope_unsupported');
    const url=request.kind==='search'?searchUrl(request.query?.url):request.kind==='detail'?cleanItemUrl(request.url):null;
    if(!url)throw new Error('rakuma_read_kind_unsupported');
    let page;
    try{page=await fetchPage(url,{...settings,...context});}
    catch(error){if(error?.code==='request_deferred')throw error;if(error?.code==='RAKUMA_SOURCE_ACCESS_DENIED'||error?.code==='ACCESS_DENIED'||deniedStatus(error))throw sourceDenied(error);throw error;}
    verifyPageTransport(page,url);
    const observedAt=stamp(page?.observedAt);
    if(typeof page?.html!=='string'||page.fromCache!==false||!Number.isFinite(observedAt)||observedAt>now()||
      (context.deadlineAt!==undefined&&observedAt>context.deadlineAt))throw new Error('rakuma_current_page_unproven');
    if(/captcha|アクセスが集中|アクセスを制限|access denied|認証が必要/i.test(page.html))throw sourceDenied({...page,reason:'challenge'});
    let data;
    if(request.kind==='detail')data=extractRakumaDetail(page.html,url);
    else{
      const cards=extractRakumaSearchCards(page.html),empty=/商品が見つかりません|商品はありません|0件の/.test(page.html);
      const anchors=[...page.html.matchAll(/<a\b[^>]*class=["'][^"']*link_search_image[^"']*["'][^>]*>/gi)].length;
      if((!cards.length&&!empty)||anchors!==cards.length||empty&&cards.length)throw new Error('rakuma_search_manifest_unreadable');
      const next=nextRakumaSearchPage(page.html,url),pageNumber=Number(new URL(url).searchParams.get('page')||1);
      if(next&&Number(new URL(next).searchParams.get('page'))!==pageNumber+1)throw new Error('rakuma_search_pagination_gap');
      if(!next&&/(?:rel=["']next["']|aria-label=["'](?:次|Next)|>\s*(?:次へ|次のページ)\s*<)/i.test(page.html))
        throw new Error('rakuma_search_pagination_unproven');
      data={offers:cards.map(card=>({url:card.url,card})),complete:!next,nextQuery:next?{url:searchUrl(next)}:null,
        paginationComplete:!next,truncated:false,coverageScope:'exact_query_results'};
    }
    const raw={cycleId:context.cycleId,observedAt,fromCache:false,data};
    if(request.kind==='search'){
      const proofRef=`rakuma-query-page:${digest([request,raw,page.html])}`;
      raw.coverageProofRef=proofRef;coverageProofs.set(proofRef,digest([request,raw]));
    }
    return raw;
  }
  function assessDiscoveryCoverage(request,raw,context={}){
    let startsAtFirstPage=false,sameQuery=false;
    try{
      const original=new URL(searchUrl(context.originalQuery?.url)),current=new URL(searchUrl(request.query?.url));
      startsAtFirstPage=Number(original.searchParams.get('page')||1)===1;
      original.searchParams.delete('page');current.searchParams.delete('page');
      original.searchParams.sort();current.searchParams.sort();sameQuery=original.href===current.href;
    }catch{}
    const accepted=request.source==='rakuma'&&startsAtFirstPage&&sameQuery&&coverageProofs.get(raw?.coverageProofRef)===digest([request,raw]);
    return {accepted,scope:'exact_query_page',exhaustive:accepted&&raw.data.complete,proofRef:accepted?raw.coverageProofRef:null};
  }
  async function validateOwn(target,own,context){
    const detail=own?.data;
    if(!current(own,context)||!detail?.description?.trim()||!detail.title||!detail.images?.length||
      detail.status!=='OPEN'||target.platform!=='rakuma'||cleanItemUrl(target.own.url)!==detail.url||
      detail.id!==target.id||!detail.sellerId||target.title!==detail.title||
      target.sellerId&&String(target.sellerId)!==String(detail.sellerId))return {complete:false,reason:'current_own_detail_unverified'};
    const identity=await resolveOwnIdentity(target,structuredClone(detail),{...context,observedAt:own.observedAt});
    if(typeof identity?.skuId!=='string'||!identity.skuId.trim()||!Number.isSafeInteger(identity.quantity)||identity.quantity<=0)
      return {complete:false,reason:'own_sale_identity_unverified'};
    ownIdentities.set(contextKey(target,own,context.cycleId),structuredClone(identity));
    return {complete:true,identity,sourceObservedAt:own.observedAt};
  }
  function screenCandidate(target,own,candidate,context){
    if(context.source!=='rakuma'||context.purpose!=='pricing'||!current(own,context)||context.origin!=='discovered'||
      !(context.ownIdentity||ownIdentities.has(contextKey(target,own,context.cycleId))))return {decision:'detail'};
    if(!candidate?.card?.title||!candidate.card.itemStatus)return {decision:'detail'};
    const item=currentItem(target,own),verification=createRakumaVerificationContext(item,{imageFingerprints:()=>null});
    const screened=screenRakumaCard(item,candidate.card,settings,verification),reason=screened.rejection?.reason;
    // Weak or abbreviated headings are missing evidence, not a proven conflict.
    if(definitiveCardReasons.has(reason))return {decision:'reject',...rejectDecision(reason,{unknown:false})};
    if(reason==='own_seller_or_not_open'){
      const card=candidate.card,ownSeller=verification.ownSellerId;
      if(card.itemStatus==='SOLD')return {decision:'reject',...rejectDecision('not_open',{unknown:false})};
      if(item.platform==='rakuma'&&(card.id===item.id||ownSeller&&card.sellerId===ownSeller))
        return {decision:'reject',...rejectDecision('own_seller',{unknown:false})};
    }
    const ownContents=`${item.title}\n${verification.ownDescription}`;
    const ownQuantity=semanticQuantity(ownContents),cardQuantity=semanticQuantity(candidate.card.title);
    if(!explicitSaleContents(ownContents).ambiguous&&!explicitSaleContents(candidate.card.title).ambiguous&&
      Number.isFinite(ownQuantity)&&Number.isFinite(cardQuantity)&&ownQuantity!==cardQuantity)
      return {decision:'reject',...rejectDecision('sale_unit_mismatch',{unknown:false})};
    return {decision:'detail'};
  }
  async function validateOffer(target,own,raw,context){
    if(context.purpose!=='pricing')return rejectDecision('rakuma_pricing_only',{unknown:true});
    const identity=ownIdentities.get(contextKey(target,own,context.cycleId))||context.ownIdentity;
    if(context.source!=='rakuma'||!current(own,context)||!current(raw,context)||!identity||!own.data?.description?.trim())
      return rejectDecision('sale_description_unavailable');
    const detail=raw.data,item=currentItem(target,own);
    // Each node receives its own deadline/signal; never retain a previous
    // decision's image-reader closure or cancelled own-image promise.
    const fingerprint=graphImageReader(imageFingerprints,context,{now});
    const verification=createRakumaVerificationContext(item,{imageFingerprints:fingerprint});
    const card=(context.origin==='discovered'?context.candidate?.card:null)||{id:detail.id,url:detail.url,title:detail.title,price:detail.price,
      sellerId:detail.sellerId,category:detail.category,image:detail.images?.[0],itemStatus:detail.status};
    if(rejectedByMemory(settings.matchCorrections,item,'rakuma',{...card,...detail}))return rejectDecision('saved_user_correction');
    if(!detail.description?.trim())return rejectDecision('sale_description_unavailable');
    const checked=await verifyRakumaDetail(item,card,{...detail,description:[detail.description,detail.condition].filter(Boolean).join('\n')},settings,
      {imageFingerprints:fingerprint,observedAt:new Date(raw.observedAt).toISOString()},verification);
    if(!checked.accepted)return rejectDecision(checked.rejection.reason);
    const gates=Object.fromEntries(GATES.map(gate=>[gate,'pass']));
    if(!Number.isFinite(detail.price)||detail.price<=0||detail.currency!=='JPY')gates.price='unknown';
    if(!detail.sellerId||!settings.ownedOffers?.rakuma?.items?.has||!settings.ownedOffers?.rakuma?.sellers?.has)gates.ownership='unknown';
    if(!detail.shippingKnown||!detail.shippingMethod||/未定/.test(detail.shippingMethod)||shippingDestination!=='JP')gates.shipping='unknown';
    return {gates,reason:Object.values(gates).includes('unknown')?'payable_quote_incomplete':null,
      quote:{id:detail.id,title:detail.title,detailTitle:detail.title,image:detail.images?.[0]||card.image,
        titleScore:titleScore(item.title,detail.title),price:detail.price,currency:detail.currency,shipping:detail.shippingJPY,shippingCurrency:detail.currency,
        shippingDestination,shippingMethod:detail.shippingMethod,sellerId:detail.sellerId,available:detail.status==='OPEN',
        targetKey:key(target),skuId:identity.skuId,quantity:identity.quantity,quantityBasis:identity.quantityBasis,
        url:detail.url,platform:'rakuma',matchMethod:checked.competitor.matchMethod,
        imageScore:checked.competitor.imageScore,primaryImageScore:checked.competitor.primaryImageScore}};
  }
  return {fetchRaw,validateOwn,screenCandidate,validateOffer,assessDiscoveryCoverage};
}
