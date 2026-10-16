import { RequestDeferredError,isRequestDeferred } from './request-cooldown.mjs';
import { isOwnedOffer } from '../../public/owned-offers.js';
import { imageFingerprints,imageSetSimilarity,primaryProductSimilarity } from './image.mjs';
import { offerIdentityGuard } from './offer-identity.mjs';
import { rejectedByMemory } from '../../public/match-memory.js';
import {
  collectibleIdentityRequiresVisualProof,distinctiveCoverage,exactIdentityTitleEquivalent,
  hasExplicitDefect,MATCHING_RULES_VERSION,listingSpecificationEquivalent,listingTextEquivalent,
  productFamily,semanticSameItem,titleScore,visualListingEquivalent
} from './rules.mjs';
import { exactQueryFor } from './yahoo.mjs';
import { parseShopProfile } from '../../public/shop-profile.js';

const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36';
let requestGate=Promise.resolve(),nextRequestAt=0;
let sourceAccessHold=null;
// Every wait and transport stage has the caller's original budget. A fetch
// implementation that ignores abort still cannot produce late evidence/retries.
function requestBounds({signal,deadline=Infinity,timeoutMs=Infinity}={}){
  const controller=new AbortController(),expires=Math.min(deadline,Date.now()+timeoutMs);
  let timer;
  const stopped=()=>signal?.reason instanceof Error?signal.reason:new DOMException('Request aborted','AbortError');
  const abort=()=>controller.abort(stopped());
  const expire=()=>{
    const remaining=expires-Date.now();
    if(remaining>0){timer=setTimeout(expire,Math.min(2147483647,remaining));return}
    controller.abort(Date.now()>=deadline?new RequestDeferredError('request_deadline'):new DOMException('Request timed out','TimeoutError'));
  };
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  if(Number.isFinite(expires))expire();
  const check=()=>{
    if(signal?.aborted)throw stopped();
    if(Date.now()>=deadline)throw new RequestDeferredError('request_deadline');
    if(controller.signal.aborted)throw controller.signal.reason;
  };
  return {signal:controller.signal,check,
    async run(operation){
      check();let listener;
      const aborted=new Promise((_,reject)=>{listener=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',listener,{once:true})});
      try{const result=await Promise.race([typeof operation==='function'?operation():operation,aborted]);check();return result}
      finally{controller.signal.removeEventListener('abort',listener)}
    },
    close(){clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort()}
  };
}
async function retryWait(milliseconds,options){
  const bounds=requestBounds(options);let timer;
  try{bounds.check();await bounds.run(new Promise(resolve=>{timer=setTimeout(resolve,milliseconds)}))}
  finally{clearTimeout(timer);bounds.close()}
}
function requestDeadline(options,settings,platform){
  return Math.min(...[options.deadlineAt,options.deadline,options.requestDeadline,settings.deadlineAt,settings.deadline,settings.requestDeadline,options[platform+'RequestDeadline'],settings[platform+'RequestDeadline']]
    .filter(value=>typeof value==='number'&&!Number.isNaN(value)),Infinity);
}


function decodeHtml(value=''){
  return String(value)
    .replace(/&#(\d+);/g,(_,code)=>String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi,(_,code)=>String.fromCodePoint(parseInt(code,16)))
    .replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'")
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&nbsp;/g,' ');
}

function attribute(source,name){
  const match=String(source).match(new RegExp(`${name}=["']([^"']*)["']`,'i'));
  return decodeHtml(match?.[1]||'');
}

function requestTurn(interval=1200,{signal,deadline=Infinity}={}){
  const bounds=requestBounds({signal,deadline});
  const turn=requestGate.then(async()=>{
    bounds.check();if(sourceAccessHold)throw sourceAccessHold;
    let delay;
    while((delay=nextRequestAt-Date.now())>0){
      if(nextRequestAt>=deadline)throw new RequestDeferredError('request_cooldown_deadline',nextRequestAt);
      await retryWait(delay,{signal:bounds.signal,deadline});
      bounds.check();if(sourceAccessHold)throw sourceAccessHold;
    }
    bounds.check();nextRequestAt=Date.now()+Math.max(800,Number(interval)||1200);
  });
  requestGate=turn.catch(()=>{});
  return bounds.run(turn).finally(()=>bounds.close());
}

function denySource(response){
  const raw=response.headers.get('retry-after'),date=Date.parse(raw||'');
  const retryAfter=raw&&/^\d{1,10}$/.test(raw)?raw:Number.isFinite(date)?new Date(date).toUTCString():null;
  const error=new Error(`ラクマ access denied: HTTP ${response.status}; no alternate source route`);
  Object.assign(error,{code:'RAKUMA_SOURCE_ACCESS_DENIED',httpStatus:response.status,retryAfter,observedAt:new Date().toISOString()});
  sourceAccessHold=error;return error;
}
export function rakumaAccessDiagnostic(){
  if(!sourceAccessHold)return null;
  const {code,httpStatus,retryAfter,observedAt}=sourceAccessHold;return {code,httpStatus,retryAfter,observedAt};
}

export async function fetchRakumaPage(url,options={},dependencies={},attempts=2){
  if(!/^https:\/\/(?:fril\.jp|item\.fril\.jp)\//i.test(url||''))throw new Error('ラクマ公开链接无效');
  // Do not route around access denials. The hold lasts for this worker process,
  // including already-queued calls; callers retain prior inventory as stale.
  if(sourceAccessHold)throw sourceAccessHold;
  const settings={...options.settings,...options},deadline=requestDeadline(options,settings,'rakuma'),signal=options.signal||settings.signal;
  const directFetch=dependencies.fetchImpl||fetch;
  if(options.attempts!==undefined)attempts=Math.max(1,Math.min(2,Number(options.attempts)||2));
  let last;
  for(let attempt=1;attempt<=attempts;attempt++){
    await requestTurn(settings.rakumaRequestIntervalMs,{signal,deadline});
    if(sourceAccessHold)throw sourceAccessHold;
    const bounds=requestBounds({signal,deadline,timeoutMs:20000});
    try{
      bounds.check();
      const response=await bounds.run(()=>Promise.resolve(directFetch(url,{headers:{'user-agent':UA,'accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','accept-language':'ja-JP,ja;q=0.9','cache-control':'no-cache','referer':'https://fril.jp/'},signal:bounds.signal,redirect:'follow'})).then(response=>{
        // Keep observed process holds even if the caller expires as headers arrive.
        if([401,403,429].includes(response.status))throw denySource(response);
        return response;
      }));
      if(!response.ok)throw Object.assign(new Error(`HTTP ${response.status}`),{httpStatus:response.status,retryAfter:response.headers.get('retry-after')});
      const html=await bounds.run(()=>response.text()),observedAt=Date.now();
      if(html.length<8000)throw new Error(`页面内容异常短 (${html.length} bytes)`);
      return {html,status:response.status,observedAt,fromCache:false,...(response.url?{url:response.url,finalUrl:response.url}:{}),redirected:response.redirected===true};
    }catch(error){
      if(sourceAccessHold)throw sourceAccessHold;
      if(signal?.aborted||isRequestDeferred(error))throw error;
      if(Date.now()>=deadline)throw new RequestDeferredError('request_deadline',nextRequestAt);
      last=error;
    }finally{bounds.close()}
    if(attempt<attempts){
      if(Date.now()+900*attempt>=deadline)throw new RequestDeferredError('request_deadline',nextRequestAt);
      await retryWait(900*attempt,{signal,deadline});
    }
  }
  const error=new Error(`ラクマ请求失败：${String(last)}`,{cause:last});
  if(last?.httpStatus!==undefined)Object.assign(error,{httpStatus:last.httpStatus,retryAfter:last.retryAfter??null});
  throw error;
}

export async function fetchRakumaHtml(url,settings={},dependencies={},attempts=2){
  return (await fetchRakumaPage(url,settings,dependencies,attempts)).html;
}


export function extractRakumaSearchCards(html='',kind='search'){
  const source=String(html),cards=[];
  const link=new RegExp(`<a\\b[^>]*class=["'][^"']*link_${kind}_image[^"']*["'][^>]*>`,'gi');
  for(const match of source.matchAll(link)){
    const tag=match[0],end=source.indexOf('</a>',match.index),window=source.slice(match.index,end<0?match.index+tag.length:end);
    const url=attribute(tag,'href'),id=url.match(/item\.fril\.jp\/([a-f0-9]+)/i)?.[1]||'';
    const title=attribute(tag,'data-rat-item_name')||attribute(tag,'title').replace(/\s+[^ ]+の商品詳細ページへのリンク$/,'');
    const price=Number(attribute(tag,'data-rat-price').replace(/[\[\],]/g,''));
    const sellerId=(attribute(tag,'data-rat-itemid').split('/')[0]||'').trim();
    const category=attribute(tag,'data-rat-igenrenamepath')||attribute(tag,'data-rat-igenre');
    const image=decodeHtml(window.match(/data-original=["']([^"']*img\.fril\.jp[^"']*)["']/i)?.[1]||'');
    const itemStatus=/sold[-_ ]?out|item-sold|SOLD OUT/i.test(window)?'SOLD':'OPEN';
    if(id&&url&&title&&Number.isFinite(price)&&price>0)cards.push({id,url,title,text:title,price,sellerId,category,image,itemStatus,source:`rakuma_${kind}`});
  }
  return [...new Map(cards.map(card=>[card.id,card])).values()];
}

function nextRakumaProfilePage(html,currentUrl,profileUrl,pageNumber){
  const source=String(html),profile=new URL(profileUrl);
  const invalid=()=>Object.assign(new Error('ラクマ店铺分页链接异常或未证明完整，保留原清单'),{code:'RAKUMA_PROFILE_PAGINATION_UNPROVEN'});
  const navAttribute=(tag,name)=>{
    const match=tag.match(new RegExp('(?:^|\\s)'+name+'\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')','i'));
    return decodeHtml(match?.[1]??match?.[2]??'');
  };
  const tags=[...source.matchAll(/<(?:link|a)\b[^>]*>/gi)].map(match=>match[0]);
  const next=tags.filter(tag=>navAttribute(tag,'rel').toLowerCase().split(/\s+/).includes('next'));
  if(!next.length){
    // An unreadable next control or a forward numbered link cannot prove that
    // inventory ended. Backward page links alone are normal on the final page.
    if(/<(?:link|a|button)\b[^>]*(?:\brel\s*=\s*(?:["'][^"']*\bnext\b|next\b)|\baria-label\s*=\s*["'][^"']*(?:next|次)|\bclass\s*=\s*["'][^"']*\bnext\b)/i.test(source)||/<(?:a|button)\b[^>]*>\s*(?:next|次へ|次のページ)\s*</i.test(source))throw invalid();
    for(const tag of tags){
      const href=navAttribute(tag,'href');if(!href)continue;
      let target;try{target=new URL(href,currentUrl)}catch{continue}
      if(target.origin!==profile.origin||!target.pathname.startsWith(profile.pathname+'/page/'))continue;
      const suffix=target.pathname.slice((profile.pathname+'/page/').length);
      if(!/^[1-9]\d*$/.test(suffix)||Number(suffix)>pageNumber)throw invalid();
    }
    return null;
  }
  const destinations=new Set();
  for(const tag of next){
    const href=navAttribute(tag,'href');if(!href)throw invalid();
    let target;try{target=new URL(href,currentUrl)}catch{throw invalid()}
    if(target.origin!==profile.origin||target.username||target.password||target.search||target.hash||
      target.pathname!==profile.pathname+'/page/'+(pageNumber+1))throw invalid();
    destinations.add(target.href);
  }
  if(destinations.size!==1)throw invalid();
  return [...destinations][0];
}

function assertRakumaProfileTransport(page,requestedUrl){
  const invalid=()=>Object.assign(new Error('Rakuma 店铺响应来源不匹配，保留原清单'),{code:'RAKUMA_PROFILE_RESPONSE_MISMATCH'});
  if(page?.redirected===true)throw invalid();
  for(const field of ['url','finalUrl','finalURL','responseUrl','responseURL','redirectedUrl','redirectedURL']){
    if(page?.[field]===undefined)continue;
    let finalUrl;try{finalUrl=new URL(page[field]).href}catch{throw invalid()}
    if(finalUrl!==new URL(requestedUrl).href)throw invalid();
  }
}

export async function discoverRakumaProfile(profileUrl,settings={},dependencies={}){
  const parsed=parseShopProfile(profileUrl);
  if(parsed?.platform!=='rakuma')throw new Error('不是ラクマ店铺主页');
  const getPage=dependencies.fetchPage||dependencies.fetchRakumaPage||
    (dependencies.fetchHtml?async(url,options)=>({html:await dependencies.fetchHtml(url,options)}):fetchRakumaPage);
  const seenPages=new Set(),items=new Map(),observations=[];
  let url=parsed.profileUrl,pages=0;
  while(url){
    if(seenPages.has(url)||pages>=500)throw new Error('ラクマ店铺分页未完整结束，保留原清单');
    seenPages.add(url);const page=await getPage(url,settings,dependencies);assertRakumaProfileTransport(page,url);
    const html=page.html;observations.push(page);pages++;
    if(!/class=["'][^"']*item-list|商品はありません|出品した商品はありません/.test(html))throw new Error('ラクマ店铺商品清单不可读');
    const cards=extractRakumaSearchCards(html,'shop');
    if(!cards.length&&!/商品はありません|出品した商品はありません|0件中/.test(html))throw new Error('ラクマ店铺卡片解析失败，不能视为清空店铺');
    for(const card of cards)if(card.itemStatus==='OPEN')items.set(card.id,{...card,platform:'rakuma',ownPrice:card.price});
    url=nextRakumaProfilePage(html,url,parsed.profileUrl,pages);
  }
  return {items:[...items.values()],pages,totalResults:items.size,complete:true,
    ...(observations.every(page=>page.fromCache===false&&Number.isFinite(page.observedAt)&&page.observedAt<=Date.now())
      ?{observedAt:Math.min(...observations.map(page=>page.observedAt)),fromCache:false}:{})};
}

async function observedRakumaPage(url,settings,dependencies){
  const page=dependencies.fetchPage?await dependencies.fetchPage(url,settings):dependencies.fetchHtml?{html:await dependencies.fetchHtml(url,settings),observedAt:new Date().toISOString()}:await fetchRakumaPage(url,settings,dependencies);
  const observed=typeof page?.observedAt==='number'?page.observedAt:Date.parse(page?.observedAt||'');
  if(typeof page?.html!=='string'||!Number.isFinite(observed)||observed>Date.now())throw new Error('ラクマ page observation unavailable');
  return {html:page.html,observedAt:new Date(observed).toISOString()};
}

export async function fetchRakumaItem(item,settings={},dependencies={}){
  const url=item.url||item.ownUrl;
  if(!/^https:\/\/item\.fril\.jp\/[a-f0-9]+\/?$/i.test(url||''))throw new Error('ラクマ商品链接无效');
  const page=await observedRakumaPage(url,settings,dependencies);
  return {...extractRakumaDetail(page.html,url),sourceObservedAt:page.observedAt};
}

export function extractRakumaDetail(html='',url=''){
  const source=String(html),scripts=[...source.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  let product;
  for(const script of scripts){
    try{const value=JSON.parse(decodeHtml(script[1]).trim());if(value?.['@type']==='Product'){product=value;break}}catch{}
  }
  if(!product?.name||!product?.offers)throw new Error('ラクマ商品详情结构已变化');
  if(!Number.isFinite(Number(product.offers.price))||Number(product.offers.price)<=0)throw new Error('ラクマ商品详情没有有效实价');
  const availability=String(product.offers.availability||'');
  const productImages=(Array.isArray(product.image)?product.image:[product.image]).filter(Boolean);
  const imageItem=String(productImages[0]||'').match(/\/img\/(\d+)\//)?.[1];
  const images=[...productImages,...[...source.matchAll(/(?:data-original|src|content)=["'](https:\/\/img\.fril\.jp\/img\/[^"']+)["']/gi)].map(match=>decodeHtml(match[1])).filter(image=>imageItem&&image.includes(`/img/${imageItem}/`))]
    .filter(Boolean).map(value=>String(value).replace('/m/','/l/').replace('/s/','/l/'));
  const sellerId=source.match(/seller_user_id(?:&quot;|")\s*:\s*(?:&quot;|")?(\d+)/i)?.[1]||'';
  const category=String(product.category||'')||decodeHtml(source.match(/data-rat-igenrenamepath=["']([^"']+)["']/i)?.[1]||'');
  const condition=decodeHtml(source.match(/(?:item_condition|item-status-status)[^\n]{0,180}?(?:&quot;|>|:)\s*([^<"&]{2,30})/i)?.[1]||'');
  const shippingRow=[...source.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].find(m=>/配送料の負担/.test(m[1]));
  const shippingText=decodeHtml(shippingRow?.[1]?.match(/<td\b[^>]*>([\s\S]*?)<\/td>/i)?.[1]||'').replace(/<[^>]+>/g,'').trim();
  const shippingKnown=/送料込|出品者負担/.test(shippingText);
  const shippingMethodRow=[...source.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].find(m=>/配送方法|発送方法/.test(m[1]));
  const shippingMethod=decodeHtml(shippingMethodRow?.[1]?.match(/<td\b[^>]*>([\s\S]*?)<\/td>/i)?.[1]||'').replace(/<[^>]+>/g,'').trim();
  const currency=String(product.offers.priceCurrency||'').trim().toUpperCase();
  return {
    itemPrice:Number(product.offers.price),shippingJPY:shippingKnown?0:null,shippingKnown,shippingText,shippingMethod,currency,
    id:String(url).match(/item\.fril\.jp\/([a-f0-9]+)/i)?.[1]||'',url,
    title:decodeHtml(product.name),description:decodeHtml(product.description||''),
    price:Number(product.offers.price),status:/InStock$/i.test(availability)?'OPEN':/OutOfStock$|SoldOut$/i.test(availability)?'SOLD':'UNKNOWN',sellerId,category,condition,
    images:[...new Set(images)].slice(0,10)
  };
}

export function nextRakumaSearchPage(html,url){
 const current=new URL(url),page=Number(current.searchParams.get('page')||1),next=[];
 for(const match of String(html).matchAll(/<a\b[^>]*>/gi)){
  const href=attribute(match[0],'href');if(!href)continue;
  const candidate=new URL(href,url),p=Number(candidate.searchParams.get('page'));
  if(candidate.origin===current.origin&&candidate.pathname==='/s'&&candidate.searchParams.get('query')===current.searchParams.get('query')&&candidate.searchParams.get('sort')===current.searchParams.get('sort')&&candidate.searchParams.get('order')===current.searchParams.get('order')&&candidate.searchParams.get('transaction')===current.searchParams.get('transaction')&&p>page)next.push(candidate);
 }
 next.sort((a,b)=>Number(a.searchParams.get('page'))-Number(b.searchParams.get('page')));return next[0]?.href||null;
}

// Legacy-compatible target context; graph callers supply current own detail only.
export function createRakumaVerificationContext(item,dependencies={}){
  const fingerprint=dependencies.imageFingerprints||imageFingerprints;
  const ownDescription=item.sourceDetail?.description||item.yahoo?.ownDescription||item.description||'';
  const ownCategory=item.sourceDetail?.category||item.yahoo?.ownCategory||item.category||'';
  const ownImages=[...(item.sourceDetail?.images||[]),...(item.yahoo?.ownImages||[]),...(item.images||[]),item.image].filter(Boolean);
  const ownSellerId=item.platform==='rakuma'?String(item.sourceDetail?.sellerId||item.sellerId||''):'';
  let ownImageEvidence=null,ownFingerprints=null;
  const ensureOwnImages=async()=>{if(!ownImageEvidence){ownImageEvidence=await Promise.all([...new Set(ownImages)].slice(0,8).map(fingerprint));ownFingerprints=ownImageEvidence.filter(Boolean);}return {ownImageEvidence,ownFingerprints};};
  return {ownDescription,ownCategory,ownImages,ownSellerId,ensureOwnImages};
}

// A positive card screen only admits a full detail read; it is never a match.
export function screenRakumaCard(item,card,settings={},context=createRakumaVerificationContext(item)){
  const {ownCategory,ownSellerId}=context;
  if(isOwnedOffer(settings.ownedOffers,'rakuma',card)){return {accepted:false,rejection:{...card,reason:'managed_shop'}}}
  if(card.itemStatus!=='OPEN'||item.platform==='rakuma'&&(card.id===item.id||ownSellerId&&card.sellerId===ownSellerId)){return {accepted:false,rejection:{...card,reason:'own_seller_or_not_open'}}}
  if(rejectedByMemory(settings.matchCorrections,item,'rakuma',card)){return {accepted:false,rejection:{...card,reason:'saved_user_correction'}}}
  const semantic=semanticSameItem({query:item.title,candidate:card.title,queryCategory:ownCategory,candidateCategory:card.category});
  const ownFamily=productFamily(item.title,ownCategory),cardFamily=productFamily(card.title,card.category);
  if(ownFamily&&cardFamily&&ownFamily!==cardFamily){return {accepted:false,rejection:{...card,reason:'physical_product_type_unconfirmed'}}}
  const conflict=offerIdentityGuard({ownTitle:item.title,candidateTitle:card.title,ownCategory,candidateCategory:card.category,requireDescriptions:false,checkImages:false});
  // Missing card condition/contents need details; explicit title conflicts do not.
  if(!conflict.accepted&&['explicit_variant_mismatch','description_color_mismatch','defect'].includes(conflict.reason)){return {accepted:false,rejection:{...card,reason:conflict.reason}}}
  const score=titleScore(item.title,card.title),anchors=distinctiveCoverage(item.title,card.title);
  if(semantic.accepted||score>=.62||(score>=.45&&anchors.matchedCount>=2))return {accepted:true,card:{...card,titleScore:score,semantic}};
  else return {accepted:false,rejection:{...card,reason:semantic.reason||'weak_title',titleScore:score}};
}

// Shared full-detail identity, ownership, availability, shipping and image gates.
export async function verifyRakumaDetail(item,card,detail,settings={},dependencies={},context=createRakumaVerificationContext(item,dependencies)){
  const {ownDescription,ownCategory,ownSellerId}=context;
  const fingerprint=dependencies.imageFingerprints||imageFingerprints;
  if(isOwnedOffer(settings.ownedOffers,'rakuma',{...card,...detail})||ownSellerId&&detail.sellerId===ownSellerId){return {accepted:false,rejection:{...card,reason:'own_seller'}}}
  if(detail.status!=='OPEN'){return {accepted:false,rejection:{...card,reason:detail.status==='SOLD'?'not_open':'availability_unconfirmed'}}}
  if(!ownDescription.trim()||!detail.description.trim()){return {accepted:false,rejection:{...card,reason:'sale_description_unavailable'}}}
  if(hasExplicitDefect(detail.title,detail.description)){return {accepted:false,rejection:{...card,reason:'defect'}}}
  const textIdentity=offerIdentityGuard({ownTitle:item.title,ownDescription,candidateTitle:detail.title,candidateDescription:detail.description,ownCategory,candidateCategory:detail.category,checkImages:false});
  if(!textIdentity.accepted){return {accepted:false,rejection:{...card,reason:textIdentity.reason}}}
  const {ownImageEvidence,ownFingerprints}=await context.ensureOwnImages();
  const detailImages=[...detail.images,card.image].filter(Boolean);
  const detailEvidence=await Promise.all([...new Set(detailImages)].slice(0,8).map(fingerprint));
  const detailFingerprints=detailEvidence.filter(Boolean);
  const imageScore=imageSetSimilarity(ownFingerprints,detailFingerprints);
  const primaryImageScore=primaryProductSimilarity(ownImageEvidence[0],detailEvidence[0]);
  const identity=offerIdentityGuard({ownTitle:item.title,ownDescription,candidateTitle:detail.title,candidateDescription:detail.description,ownCategory,candidateCategory:detail.category,primaryImageScore});
  if(!identity.accepted){return {accepted:false,rejection:{...card,reason:identity.reason,imageScore,primaryImageScore}}}
  const semantic=semanticSameItem({query:`${item.title}\n${ownDescription}`,candidate:`${detail.title}\n${detail.description}`,queryCategory:ownCategory,candidateCategory:detail.category});
  const specificationEquivalent=listingSpecificationEquivalent(`${item.title}\n${ownDescription}`,`${detail.title}\n${detail.description}`,ownCategory,detail.category);
  const exactTitleEquivalent=exactIdentityTitleEquivalent(item.title,detail.title,ownCategory,detail.category);
  const textEquivalent=listingTextEquivalent(item.title,ownDescription,detail.title,detail.description);
  const visualEquivalent=visualListingEquivalent({query:`${item.title}\n${ownDescription}`,candidate:`${detail.title}\n${detail.description}`,queryCategory:ownCategory,candidateCategory:detail.category,imageScore,threshold:Number(settings.yahooStrongVisualMatchThreshold)||.86});
  if(collectibleIdentityRequiresVisualProof(item.title,detail.title,ownCategory,detail.category)&&!visualEquivalent){
    return {accepted:false,rejection:{...card,reason:'collectible_variant_image_unconfirmed',imageScore,primaryImageScore}}
  }
  if(!semantic.accepted&&!specificationEquivalent&&!exactTitleEquivalent&&!textEquivalent&&!visualEquivalent){
    return {accepted:false,rejection:{...card,reason:semantic.reason||'detail_mismatch',imageScore,primaryImageScore}}
  }
  if(!detail.shippingKnown){return {accepted:false,rejection:{...card,reason:'shipping_unconfirmed'}}}
  const queryFamily=productFamily(`${item.title}\n${ownDescription}`,ownCategory),candidateFamily=productFamily(`${detail.title}\n${detail.description}`,detail.category);
  return {accepted:true,competitor:{...card,...detail,checkedAt:dependencies.observedAt,platform:'rakuma',image:detail.images[0]||card.image,imageScore,primaryImageScore,queryFamily,candidateFamily,matchMethod:visualEquivalent?'strong_visual_primary_product':'detail_type_quantity_equivalent_text'}};
}

export async function rakumaCompare(item,settings={},dependencies={}){
  const observations=[];
  const getPage=async url=>{const page=await observedRakumaPage(url,settings,dependencies);observations.push(Date.parse(page.observedAt));return page;};
  const query=exactQueryFor(item.title),searchUrl=`https://fril.jp/s?query=${encodeURIComponent(query)}&transaction=selling&sort=sell_price&order=asc`;
  const context=createRakumaVerificationContext(item,dependencies),{ownDescription}=context,rejected=[];
  const collected=new Map();let nextPage=searchUrl,searchPages=0;
  const maxPages=Math.max(1,Math.min(10,Number(settings.maxRakumaSearchPages)||5));
  while(nextPage&&searchPages<maxPages){
   const {html}=await getPage(nextPage);
   if(!/link_search_image|商品が見つかりません|商品はありません|該当する商品|0件の/.test(html))throw new Error('ラクマ搜索结果不可读，不能视为未发现同款');
   for(const card of extractRakumaSearchCards(html))collected.set(card.id,card);
   nextPage=nextRakumaSearchPage(html,nextPage);searchPages++;
  }
  const cards=[...collected.values()],searchComplete=!nextPage;
  const screened=[];
  for(const card of cards){
    const decision=screenRakumaCard(item,card,settings,context);
    if(decision.accepted)screened.push(decision.card);else rejected.push(decision.rejection);
  }
  screened.sort((a,b)=>a.price-b.price||b.titleScore-a.titleScore);
  const preliminary=screened.slice(0,Math.max(1,Number(settings.maxRakumaDetailChecks)||6));
  const competitors=[];
  for(const card of preliminary){
    try{
      const page=await getPage(card.url),detail=extractRakumaDetail(page.html,card.url);
      const decision=await verifyRakumaDetail(item,card,detail,settings,{...dependencies,observedAt:page.observedAt},context);
      if(decision.accepted)competitors.push(decision.competitor);else rejected.push(decision.rejection);
    }catch(error){if(error?.code==='RAKUMA_SOURCE_ACCESS_DENIED')throw error;rejected.push({...card,reason:'detail_error',error:String(error)})}
  }
  competitors.sort((a,b)=>a.price-b.price);
  const unresolved=[...screened.slice(preliminary.length),...rejected.filter(row=>['availability_unconfirmed','shipping_unconfirmed','detail_error','sale_description_unavailable','collectible_variant_image_unconfirmed','primary_variant_unconfirmed'].includes(row.reason))];
  const lowerUnconfirmed=unresolved.filter(row=>Number(row.price)<Number(item.ownPrice));
  return {
    audit:{ownItemId:item.id,accountId:item.accountId||null,ownDetailLoaded:Boolean(ownDescription.trim())},
    rulesVersion:MATCHING_RULES_VERSION,query,searchUrl,searchPages,searchComplete,status:!searchComplete||lowerUnconfirmed.length||!ownDescription.trim()||!competitors.length&&unresolved.length?'incomplete':'ok',
    lowestPrice:competitors[0]?.price??null,lowestUrl:competitors[0]?.url??searchUrl,
    candidates:competitors.slice(0,5),cardCount:cards.length,preliminaryCount:preliminary.length,
    detailCheckedCount:preliminary.length,competitorCount:competitors.length,rejected:rejected.slice(-30),
    unconfirmedLowerCount:lowerUnconfirmed.length,plausibleMinPrice:unresolved.length?Math.min(...unresolved.map(row=>row.price)):null,
    matchLabel:lowerUnconfirmed.length?'存在尚未核验的ラクマ低价候选':competitors.length?'已核验ラクマ在售同款':'ラクマ未发现同款',
    checkedAt:new Date(Math.min(...observations)).toISOString()
  };
}
