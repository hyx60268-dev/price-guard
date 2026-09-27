import { imageFingerprints,imageSetSimilarity,primaryProductSimilarity } from './image.mjs';
import { offerIdentityGuard } from './offer-identity.mjs';
import { rejectedByMemory } from '../../public/match-memory.js';
import {
  collectibleIdentityRequiresVisualProof,distinctiveCoverage,exactIdentityTitleEquivalent,
  hasExplicitDefect,MATCHING_RULES_VERSION,listingSpecificationEquivalent,listingTextEquivalent,
  productFamily,semanticSameItem,titleScore,visualListingEquivalent
} from './rules.mjs';
import { queryFor } from './yahoo.mjs';
import { parseShopProfile } from '../../public/shop-profile.js';

const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36';
let requestGate=Promise.resolve(),nextRequestAt=0;
let proxyPreferredUntil=0;
const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));

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

function requestTurn(interval=1200){
  const turn=requestGate.then(async()=>{
    const delay=Math.max(0,nextRequestAt-Date.now());if(delay)await wait(delay);
    nextRequestAt=Date.now()+Math.max(800,Number(interval)||1200);
  });
  requestGate=turn.catch(()=>{});return turn;
}

async function responseHtml(response){
  if(!response.ok)throw new Error(`HTTP ${response.status}`);
  const html=await response.text();
  if(html.length<8000)throw new Error(`页面内容异常短 (${html.length} bytes)`);
  return html;
}

async function fetchViaReader(url,settings={},fetchImpl=fetch,attempts=2){
  // Rakuma currently returns HTTP 403 to GitHub-hosted runner IPs even for its
  // public pages. Reader fetches only the same public URL and returns full HTML;
  // no account, cookie or private data is sent through it.
  const readerUrl=`https://r.jina.ai/${url}`;
  let last;
  for(let attempt=1;attempt<=attempts;attempt++){
    await requestTurn(Math.max(1500,Number(settings.rakumaRequestIntervalMs)||1200));
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),45000);
    try{
      const response=await fetchImpl(readerUrl,{headers:{'user-agent':UA,'accept-language':'ja-JP,ja;q=0.9','x-return-format':'html','x-no-cache':'true'},signal:controller.signal,redirect:'follow'});
      return await responseHtml(response);
    }catch(error){last=error;if(attempt<attempts)await wait(1200*attempt)}finally{clearTimeout(timeout)}
  }
  throw new Error(`ラクマ公开页面代理请求失败：${String(last)}`);
}

export async function fetchRakumaHtml(url,settings={},dependencies={},attempts=2){
  if(!/^https:\/\/(?:fril\.jp|item\.fril\.jp)\//i.test(url||''))throw new Error('ラクマ公开链接无效');
  const directFetch=dependencies.fetchImpl||fetch,readerFetch=dependencies.readerFetchImpl||fetch;
  if(Date.now()<proxyPreferredUntil)return fetchViaReader(url,settings,readerFetch,attempts);
  let last;
  for(let attempt=1;attempt<=attempts;attempt++){
    await requestTurn(settings.rakumaRequestIntervalMs);
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
    try{
      const response=await directFetch(url,{headers:{'user-agent':UA,'accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','accept-language':'ja-JP,ja;q=0.9','cache-control':'no-cache','referer':'https://fril.jp/'},signal:controller.signal,redirect:'follow'});
      return await responseHtml(response);
    }catch(error){
      last=error;
      // Do not send dozens of requests that Rakuma has already rejected. The
      // fallback remains preferred for this process after a 403.
      if(/HTTP 403/.test(String(error))){if(!dependencies.disableProxyMemory)proxyPreferredUntil=Date.now()+6*60*60_000;break}
      if(attempt<attempts)await wait(900*attempt);
    }finally{clearTimeout(timeout)}
  }
  try{return await fetchViaReader(url,settings,readerFetch,attempts)}
  catch(readerError){throw new Error(`ラクマ请求失败：${String(last)}；${String(readerError)}`)}
}

const fetchHtml=fetchRakumaHtml;

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

export async function discoverRakumaProfile(profileUrl,settings={},dependencies={}){
  const parsed=parseShopProfile(profileUrl);
  if(parsed?.platform!=='rakuma')throw new Error('不是ラクマ店铺主页');
  const getHtml=dependencies.fetchHtml||fetchHtml,seenPages=new Set(),items=new Map();
  let url=parsed.profileUrl,pages=0;
  while(url){
    if(seenPages.has(url)||pages>=500)throw new Error('ラクマ店铺分页未完整结束，保留原清单');
    seenPages.add(url);const html=await getHtml(url,settings);pages++;
    if(!/class=["'][^"']*item-list|商品はありません|出品した商品はありません/.test(html))throw new Error('ラクマ店铺商品清单不可读');
    const cards=extractRakumaSearchCards(html,'shop');
    if(!cards.length&&!/商品はありません|出品した商品はありません|0件中/.test(html))throw new Error('ラクマ店铺卡片解析失败，不能视为清空店铺');
    for(const card of cards)if(card.itemStatus==='OPEN')items.set(card.id,{...card,platform:'rakuma',ownPrice:card.price});
    const next=[...html.matchAll(/<link\b[^>]*>/gi)].map(x=>x[0]).find(tag=>attribute(tag,'rel')==='next');
    if(!next){url=null;continue}
    const target=new URL(attribute(next,'href'),parsed.profileUrl);
    if(target.origin!=='https://fril.jp'||!target.pathname.startsWith(new URL(parsed.profileUrl).pathname+'/page/'))throw new Error('ラクマ店铺分页链接异常');
    url=target.href;
  }
  return {items:[...items.values()],pages,totalResults:items.size,complete:true};
}

export async function fetchRakumaItem(item,settings={},dependencies={}){
  const url=item.url||item.ownUrl;
  if(!/^https:\/\/item\.fril\.jp\/[a-f0-9]+\/?$/i.test(url||''))throw new Error('ラクマ商品链接无效');
  return extractRakumaDetail(await (dependencies.fetchHtml||fetchHtml)(url,settings),url);
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
  return {
    id:String(url).match(/item\.fril\.jp\/([a-f0-9]+)/i)?.[1]||'',url,
    title:decodeHtml(product.name),description:decodeHtml(product.description||''),
    price:Number(product.offers.price),status:/InStock$/i.test(availability)?'OPEN':'SOLD',sellerId,category,condition,
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

export async function rakumaCompare(item,settings={},dependencies={}){
  const getHtml=dependencies.fetchHtml||fetchHtml,fingerprint=dependencies.imageFingerprints||imageFingerprints;
  const query=queryFor(item.title),searchUrl=`https://fril.jp/s?query=${encodeURIComponent(query)}&transaction=selling&sort=sell_price&order=asc`;
  const ownDescription=item.sourceDetail?.description||item.yahoo?.ownDescription||item.description||'';
  const ownCategory=item.sourceDetail?.category||item.yahoo?.ownCategory||item.category||'';
  const ownImages=[...(item.sourceDetail?.images||[]),...(item.yahoo?.ownImages||[]),...(item.images||[]),item.image].filter(Boolean);
  const ownSellerId=item.platform==='rakuma'?String(item.sourceDetail?.sellerId||item.sellerId||''):'';
  const ownImageEvidence=await Promise.all([...new Set(ownImages)].slice(0,8).map(fingerprint));
  const ownFingerprints=ownImageEvidence.filter(Boolean),rejected=[];
  const collected=new Map();let nextPage=searchUrl,searchPages=0;
  const maxPages=Math.max(1,Math.min(10,Number(settings.maxRakumaSearchPages)||5));
  while(nextPage&&searchPages<maxPages){
   const html=await getHtml(nextPage,settings);
   if(!/link_search_image|商品が見つかりません|商品はありません|該当する商品|0件の/.test(html))throw new Error('ラクマ搜索结果不可读，不能视为未发现同款');
   for(const card of extractRakumaSearchCards(html))collected.set(card.id,card);
   nextPage=nextRakumaSearchPage(html,nextPage);searchPages++;
  }
  const cards=[...collected.values()],searchComplete=!nextPage;
  const screened=[];
  for(const card of cards){
    if(card.itemStatus!=='OPEN'||item.platform==='rakuma'&&(card.id===item.id||ownSellerId&&card.sellerId===ownSellerId)){rejected.push({...card,reason:'own_seller_or_not_open'});continue}
    if(rejectedByMemory(settings.matchCorrections,item,'rakuma',card)){rejected.push({...card,reason:'saved_user_correction'});continue}
    const semantic=semanticSameItem({query:item.title,candidate:card.title,queryCategory:ownCategory,candidateCategory:card.category});
    const score=titleScore(item.title,card.title),anchors=distinctiveCoverage(item.title,card.title);
    if(semantic.accepted||score>=.62||(score>=.45&&anchors.matchedCount>=2))screened.push({...card,titleScore:score,semantic});
    else rejected.push({...card,reason:semantic.reason||'weak_title',titleScore:score});
  }
  screened.sort((a,b)=>a.price-b.price||b.titleScore-a.titleScore);
  const preliminary=screened.slice(0,Math.max(1,Number(settings.maxRakumaDetailChecks)||6));
  const competitors=[];
  for(const card of preliminary){
    try{
      const detail=extractRakumaDetail(await getHtml(card.url,settings),card.url);
      if(ownSellerId&&detail.sellerId===ownSellerId){rejected.push({...card,reason:'own_seller'});continue}
      if(detail.status!=='OPEN'){rejected.push({...card,reason:'not_open'});continue}
      if(!ownDescription.trim()||!detail.description.trim()){rejected.push({...card,reason:'sale_description_unavailable'});continue}
      if(hasExplicitDefect(detail.title,detail.description)){rejected.push({...card,reason:'defect'});continue}
      const detailImages=[...detail.images,card.image].filter(Boolean);
      const detailEvidence=await Promise.all([...new Set(detailImages)].slice(0,8).map(fingerprint));
      const detailFingerprints=detailEvidence.filter(Boolean);
      const imageScore=imageSetSimilarity(ownFingerprints,detailFingerprints);
      const primaryImageScore=primaryProductSimilarity(ownImageEvidence[0],detailEvidence[0]);
      const identity=offerIdentityGuard({ownTitle:item.title,ownDescription,candidateTitle:detail.title,candidateDescription:detail.description,ownCategory,candidateCategory:detail.category,primaryImageScore});
      if(!identity.accepted){rejected.push({...card,reason:identity.reason,imageScore,primaryImageScore});continue}
      const semantic=semanticSameItem({query:`${item.title}\n${ownDescription}`,candidate:`${detail.title}\n${detail.description}`,queryCategory:ownCategory,candidateCategory:detail.category});
      const specificationEquivalent=listingSpecificationEquivalent(`${item.title}\n${ownDescription}`,`${detail.title}\n${detail.description}`,ownCategory,detail.category);
      const exactTitleEquivalent=exactIdentityTitleEquivalent(item.title,detail.title,ownCategory,detail.category);
      const textEquivalent=listingTextEquivalent(item.title,ownDescription,detail.title,detail.description);
      const visualEquivalent=visualListingEquivalent({query:`${item.title}\n${ownDescription}`,candidate:`${detail.title}\n${detail.description}`,queryCategory:ownCategory,candidateCategory:detail.category,imageScore,threshold:Number(settings.yahooStrongVisualMatchThreshold)||.86});
      if(collectibleIdentityRequiresVisualProof(item.title,detail.title,ownCategory,detail.category)&&!visualEquivalent){
        rejected.push({...card,reason:'collectible_variant_image_unconfirmed',imageScore,primaryImageScore});continue
      }
      if(!semantic.accepted&&!specificationEquivalent&&!exactTitleEquivalent&&!textEquivalent&&!visualEquivalent){
        rejected.push({...card,reason:semantic.reason||'detail_mismatch',imageScore,primaryImageScore});continue
      }
      const queryFamily=productFamily(`${item.title}\n${ownDescription}`,ownCategory),candidateFamily=productFamily(`${detail.title}\n${detail.description}`,detail.category);
      competitors.push({...card,...detail,platform:'rakuma',image:detail.images[0]||card.image,imageScore,primaryImageScore,queryFamily,candidateFamily,matchMethod:visualEquivalent?'strong_visual_primary_product':'detail_type_quantity_equivalent_text'});
    }catch(error){rejected.push({...card,reason:'detail_error',error:String(error)})}
  }
  competitors.sort((a,b)=>a.price-b.price);
  const unresolved=[...screened.slice(preliminary.length),...rejected.filter(row=>['detail_error','sale_description_unavailable','collectible_variant_image_unconfirmed','primary_variant_unconfirmed'].includes(row.reason))];
  const lowerUnconfirmed=unresolved.filter(row=>Number(row.price)<Number(item.ownPrice));
  return {
    audit:{ownItemId:item.id,accountId:item.accountId||null,ownDetailLoaded:Boolean(ownDescription.trim())},
    rulesVersion:MATCHING_RULES_VERSION,query,searchUrl,searchPages,searchComplete,status:!searchComplete||lowerUnconfirmed.length||!ownDescription.trim()||!competitors.length&&unresolved.length?'incomplete':'ok',
    lowestPrice:competitors[0]?.price??null,lowestUrl:competitors[0]?.url??searchUrl,
    candidates:competitors.slice(0,5),cardCount:cards.length,preliminaryCount:preliminary.length,
    detailCheckedCount:preliminary.length,competitorCount:competitors.length,rejected:rejected.slice(-30),
    unconfirmedLowerCount:lowerUnconfirmed.length,plausibleMinPrice:unresolved.length?Math.min(...unresolved.map(row=>row.price)):null,
    matchLabel:lowerUnconfirmed.length?'存在尚未核验的ラクマ低价候选':competitors.length?'已核验ラクマ在售同款':'ラクマ未发现同款',
    checkedAt:new Date().toISOString()
  };
}
