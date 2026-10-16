// Readers are injected deliberately; importing this adapter starts no requests.
import {graphImageReader} from './graph-image-reader.mjs';
import {createHash} from 'node:crypto';
import {extractNextData,extractItemData,extractRecommendationCards,searchResult,searchCard,categoryText,
  queryFor,exactQueryFor,screenYahooCard,evaluateYahooDetail} from './yahoo.mjs';
import {yahooTargetShipping} from './yahoo-known-refresh.mjs';
import {VALIDATION_GATES,SourceDeniedError} from './full-cycle-graph.mjs';
import {rejectedByMemory} from '../../public/match-memory.js';
import {isOwnedOffer} from '../../public/owned-offers.js';
const HOST='paypayfleamarket.yahoo.co.jp';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text=value=>typeof value==='string'?value.trim():'';
const images=detail=>(detail.images||[]).map(row=>typeof row==='string'?row:row?.url).filter(Boolean);
const gates=(gate,state='unknown')=>Object.fromEntries(VALIDATION_GATES.map(key=>[key,key===gate?state:'unknown']));
const unknown=reason=>({gates:gates(),reason});
const reject=(reason,gate='identity')=>({gates:gates(gate,'reject'),reason});
const allPass=()=>Object.fromEntries(VALIDATION_GATES.map(key=>[key,'pass']));
const key=target=>`${target.accountId}:${target.id}`;
const condition=detail=>typeof detail.condition==='string'?detail.condition:
  detail.condition?.name||detail.condition?.text||detail.condition?.label||detail.condition?.key||'';
const definiteReasons=new Map([
  ['own_seller','ownership'],['saved_user_correction','correction'],['not_open','availability'],
  ['defect','condition'],['condition_or_packaging_mismatch','condition'],['sale_unit_mismatch','quantity'],
  ['description_color_mismatch','identity'],['variant_mismatch','identity'],['product_mismatch','identity'],['title_rejected','identity']
]);
function requestUrl(request){
  if(request.source!=='yahoo'||request.accessScope!=='public'||!['search','detail'].includes(request.kind))throw new Error('yahoo_request_scope_unsupported');
  if(request.parameters!==undefined&&Object.keys(request.parameters).length)throw new Error('yahoo_request_parameters_unsupported');
  if(request.kind==='search'&&(!request.query||Object.keys(request.query).some(k=>k!=='url')))throw new Error('yahoo_query_parameters_unsupported');
  const url=new URL(request.kind==='search'?request.query.url:request.url);
  if(url.protocol!=='https:'||url.host!==HOST||url.username||url.password||url.hash)throw new Error('yahoo_request_url_unsupported');
  if(request.kind==='detail'&&(!/^\/item\/[a-zA-Z0-9_-]+$/.test(url.pathname)||url.search))throw new Error('yahoo_detail_url_unsupported');
  if(request.kind==='search'&&([...new Set(url.searchParams.keys())].some(k=>url.searchParams.getAll(k).length!==1)||!/^\/search\/[^/]+$/.test(url.pathname)||url.searchParams.get('open')!=='1'||[...url.searchParams.keys()].some(k=>k!=='open')))throw new Error('yahoo_search_url_unsupported');
  return url;
}
export function yahooGraphSearchSpec(title){return {accessScope:'public',query:{url:`https://${HOST}/search/${encodeURIComponent(queryFor(title))}?open=1`}};}
export function createYahooGraphAdapter({fetchPage,imageFingerprints,settings={},now=Date.now,shippingDestination='JP'}={}){
  if(typeof fetchPage!=='function'||typeof imageFingerprints!=='function')throw new Error('Injected reader and image fingerprints are required');
  const ownContexts=new Map(),coverageProofs=new Map();
  const current=(raw,context={})=>raw?.fromCache===false&&raw?.cycleId===context.cycleId&&Number.isFinite(raw?.observedAt)&&raw.observedAt<=now()&&(context.deadlineAt===undefined||raw.observedAt<=context.deadlineAt);
  async function fetchRaw(request,context){
    const url=requestUrl(request);let response;
    try{response=await fetchPage(url.href,{...context,source:'yahoo',accessScope:'public'});}catch(error){
      if(error?.code==='request_deferred')throw error;
      if([401,403,429].includes(error?.httpStatus)||error?.code==='ACCESS_DENIED'){
        const denied=new SourceDeniedError('Yahoo source denied access');for(const field of ['httpStatus','retryAfter','retryAt','reason'])if(error[field]!==undefined)denied[field]=error[field];throw denied;
      }throw error;
    }
    const statuses=[response?.status,response?.httpStatus].filter(value=>value!==undefined),denied=statuses.find(value=>[401,403,429].includes(value));
    if(denied){const error=new SourceDeniedError(`Yahoo HTTP ${denied}`);error.httpStatus=denied;error.retryAfter=response.retryAfter??null;throw error;}
    if(!statuses.length||statuses.some(value=>value!==200)||typeof response.html!=='string'||response.fromCache!==false||!Number.isFinite(response.observedAt)||response.observedAt>now())throw new Error('yahoo_current_response_unavailable');
    if(response.redirected===true||[response.url,response.finalUrl].filter(Boolean).some(value=>new URL(value).href!==url.href))throw new Error('yahoo_redirected_response');
    const next=extractNextData(response.html),envelope={cycleId:context.cycleId,observedAt:response.observedAt,fromCache:false,source:'yahoo',url:url.href,bodyHash:createHash('sha256').update(response.html).digest('hex')};
    if(request.kind==='search'){
      const result=searchResult(next),cards=result.items.map(searchCard),ids=cards.map(card=>card.id);
      if(!cards.every(card=>/^[a-zA-Z0-9_-]+$/.test(card.id||''))||new Set(ids).size!==ids.length)throw new Error('yahoo_search_card_ids_invalid');
      const total=result.totalResultsAvailable,returned=result.totalResultsReturned;
      const complete=Number.isSafeInteger(total)&&total>=0&&total===cards.length&&(returned===undefined||returned===cards.length)&&result.truncated!==true&&(result.offset===undefined||result.offset===0)&&!result.nextPage&&!result.nextUrl;
      const raw={...envelope,data:{offers:cards.map(card=>({...card,card})),complete,paginationComplete:complete,truncated:false,coverageScope:'exact_query_results',total,returned:cards.length,queryUrl:url.href}};
      raw.coverageProofRef=`yahoo-first-page:${hash([request,raw])}`;coverageProofs.set(raw.coverageProofRef,hash([request,raw]));return raw;
    }
    const detail=extractItemData(next);if(detail.id!==url.pathname.split('/').at(-1))throw new Error('yahoo_detail_id_mismatch');
    const shipping=yahooTargetShipping(response.html,detail);
    return {...envelope,data:{id:detail.id,title:detail.title||'',description:detail.description||'',category:categoryText(detail),images:images(detail),sellerId:String(detail.seller?.id||detail.sellerId||''),price:Number(detail.price),currency:shipping.currency,status:detail.status,condition:condition(detail),bundle:{detail,shipping,recommendations:extractRecommendationCards(next)}}};
  }
  function validateOwn(target,raw,context={}){
    const data=raw?.data,detail=data?.bundle?.detail;
    if(!current(raw,context)||raw.source!=='yahoo'||!detail||detail.id!==target.id||raw.url!==target.own?.url||text(data.title)!==text(target.title)||!text(data.title)||!text(data.description)||!text(data.sellerId)||!data.images?.length||data.status!=='OPEN'||!(data.price>0)||target.sellerId&&data.sellerId!==target.sellerId)return {complete:false,reason:'own_current_detail_unverified'};
    const identity={skuId:`listing:${hash({cycleId:context.cycleId,observedAt:raw.observedAt,target:key(target),title:data.title,description:data.description,category:data.category,images:data.images,condition:data.condition,sellerId:data.sellerId})}`,quantity:1,quantityBasis:'whole_listing_unit_with_sale_content_guard',scope:'current_target_physical_offer',canonicalProduct:false};
    ownContexts.set(key(target),{identity,raw});return {complete:true,identity};
  }
  function ownContext(target,raw,context){
    if(!current(raw,context))return null;
    const identity=context.ownIdentity||ownContexts.get(key(target))?.identity,data=raw.data;
    if(!identity||!text(data?.title)||!text(data?.description)||!data?.images?.length)return null;
    const detail=data.bundle?.detail||{id:target.id,title:data.title,description:data.description,images:data.images,condition:data.condition,status:data.status,seller:{id:data.sellerId}};
    return {identity,detail,data,item:{...target,title:data.title,sellerId:data.sellerId,image:data.images[0],description:data.description}};
  }
  const cardFor=candidate=>candidate?.card||candidate||{};
  function screenCandidate(target,ownRaw,candidate,context={}){
    const own=ownContext(target,ownRaw,context);if(!own)return {decision:'detail'};const card=cardFor(candidate);
    if(context.origin==='known'){
      if(rejectedByMemory(settings.matchCorrections,own.item,'yahoo',card))return {decision:'reject',...reject('saved_user_correction','correction')};
      if(isOwnedOffer(settings.ownedOffers,'yahoo',{id:card.id,url:card.url}))return {decision:'reject',...reject('own_seller','ownership')};return {decision:'detail'};
    }
    if(card.id===target.id&&['yahoo','yahoo_fleamarket'].includes(target.platform))return {decision:'reject',...reject('own_seller','ownership')};
    if(!Number.isFinite(card.price))return {decision:'detail'};
    const result=screenYahooCard(own.item,card,{ownSellerId:own.data.sellerId,ownCategory:own.data.category,settings});
    return result.definitive&&result.rejection&&definiteReasons.has(result.rejection.reason)?{decision:'reject',...reject(result.rejection.reason,definiteReasons.get(result.rejection.reason))}:{decision:'detail'};
  }
  function candidatesFromOwn(target,ownRaw,context={}){
    if(context.source!=='yahoo'||context.purpose!=='pricing'||!current(ownRaw,context)||ownRaw.source!=='yahoo')return [];
    return (ownRaw.data?.bundle?.recommendations||[]).map(card=>({...card,card:{...card,sources:['recommendation']}}));
  }
  async function validateOffer(target,ownRaw,raw,context={}){
    if(context.purpose!=='pricing'||context.source!=='yahoo')return unknown('yahoo_supplier_use_unsupported');
    const own=ownContext(target,ownRaw,context),detail=raw?.data?.bundle?.detail;
    if(!own||!current(raw,context)||raw.source!=='yahoo'||!detail)return unknown('current_detail_unavailable');
    const observedCard=cardFor(context.candidate),sellerId=raw.data.sellerId;
    if(!['OPEN','SOLD'].includes(detail.status))return unknown('availability_unconfirmed');
    if(!text(sellerId))return unknown('detail_seller_missing');
    if(!settings.ownedOffers?.yahoo?.items?.has||!settings.ownedOffers?.yahoo?.sellers?.has)return unknown('managed_inventory_index_missing');
    if(context.origin!=='known'&&observedCard.sellerId&&sellerId!==observedCard.sellerId)return unknown('detail_seller_changed');
    const card={...observedCard,id:detail.id,url:raw.url,title:detail.title,price:Number(detail.price),sellerId,image:raw.data.images[0],sources:observedCard.sources||[observedCard.source||'search']};
    if(rejectedByMemory(settings.matchCorrections,own.item,'yahoo',card))return reject('saved_user_correction','correction');
    if(isOwnedOffer(settings.ownedOffers,'yahoo',card)||sellerId===own.data.sellerId||detail.id===target.id)return reject('own_seller','ownership');
    const screening=screenYahooCard(own.item,card,{ownSellerId:own.data.sellerId,ownCategory:own.data.category,settings}),enriched=screening.card||card;
    const maxImages=Math.max(3,Math.min(10,Number(settings.maxYahooImages)||8)),fingerprint=graphImageReader(imageFingerprints,context,{now});
    const ownImageEvidence=await Promise.all(own.data.images.slice(0,maxImages).map(fingerprint));
    const result=await evaluateYahooDetail({item:own.item,card:enriched,bundle:raw.data.bundle,ownDetail:own.detail,knownOnly:true,ownSellerId:own.data.sellerId,ownConditionText:`${own.data.title}\n${own.data.description}\n${own.data.condition||''}`,ownCategory:own.data.category,exactQuery:exactQueryFor(own.data.title),maxImages,ownFingerprints:ownImageEvidence.filter(Boolean),ownImageEvidence,settings},{imageFingerprints:fingerprint});
    if(!result.candidate){const reason=result.rejection?.reason||'identity_unconfirmed';return definiteReasons.has(reason)?reject(reason,definiteReasons.get(reason)):unknown(reason);}
    const shipping=raw.data.bundle.shipping,method=detail.deliveryMethod?.name||detail.deliveryMethod?.id;
    if(shippingDestination!=='JP'||!text(method)||!shipping.shippingKnown||shipping.currency!=='JPY'||detail.currency&&detail.currency!=='JPY')return unknown('target_shipping_or_currency_unconfirmed');
    return {gates:allPass(),quote:{targetKey:key(target),skuId:own.identity.skuId,quantity:own.identity.quantity,quantityBasis:own.identity.quantityBasis,
      id:detail.id,title:detail.title,detailTitle:detail.title,image:raw.data.images[0],titleScore:result.candidate.titleScore,imageScore:result.candidate.imageScore,primaryImageScore:result.candidate.primaryImageScore,...(result.candidate.identityEvidence?{identityEvidence:result.candidate.identityEvidence}:{}),price:Number(detail.price),currency:'JPY',shipping:shipping.shippingJPY,shippingCurrency:'JPY',shippingDestination,shippingMethod:method,available:true,sellerId,url:raw.url,matchMethod:result.candidate.matchMethod,identityVerifiedAt:raw.observedAt,observationTime:raw.observedAt,coverageScope:'observed_exact_query_and_recommendations'}};
  }
  function assessDiscoveryCoverage(request,raw,context={}){
    try{requestUrl(request);}catch{return {accepted:false};}
    const accepted=coverageProofs.get(raw.coverageProofRef)===hash([request,raw])&&current(raw,context)&&raw.source==='yahoo'&&raw.url===request.query?.url&&raw.data?.queryUrl===request.query?.url&&typeof raw.data?.complete==='boolean'&&raw.data?.paginationComplete===raw.data?.complete&&raw.data?.truncated===false;
    return {accepted,scope:'exact_query_page',exhaustive:accepted&&raw.data.complete,proofRef:accepted?`yahoo-first-page:${raw.bodyHash}`:null};
  }
  return {fetchRaw,validateOwn,validateOffer,screenCandidate,candidatesFromOwn,assessDiscoveryCoverage};
}
