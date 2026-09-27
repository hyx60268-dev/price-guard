import { imageFingerprints,imageSetSimilarity,primaryProductSimilarity } from './image.mjs';
import { offerIdentityGuard } from './offer-identity.mjs';
import { rejectedByMemory } from '../../public/match-memory.js';
import {
  collectibleIdentityRequiresVisualProof,distinctiveCoverage,exactIdentityTitleEquivalent,
  hasExplicitDefect,MATCHING_RULES_VERSION,listingSpecificationEquivalent,listingTextEquivalent,
  productFamily,semanticSameItem,titleScore,visualListingEquivalent
} from './rules.mjs';
import { queryFor } from './yahoo.mjs';

const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36';
let requestGate=Promise.resolve(),nextRequestAt=0;
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

async function fetchHtml(url,settings={},attempts=2){
  let last;
  for(let attempt=1;attempt<=attempts;attempt++){
    await requestTurn(settings.rakumaRequestIntervalMs);
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
    try{
      const response=await fetch(url,{headers:{'user-agent':UA,'accept-language':'ja-JP,ja;q=0.9'},signal:controller.signal,redirect:'follow'});
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const html=await response.text();
      if(html.length<8000)throw new Error(`页面内容异常短 (${html.length} bytes)`);
      return html;
    }catch(error){last=error;if(attempt<attempts)await wait(900*attempt)}finally{clearTimeout(timeout)}
  }
  throw new Error(`ラクマ请求失败：${String(last)}`);
}

export function extractRakumaSearchCards(html=''){
  const source=String(html),cards=[];
  const link=/<a\b[^>]*class=["'][^"']*link_search_image[^"']*["'][^>]*>/gi;
  for(const match of source.matchAll(link)){
    const tag=match[0],window=source.slice(match.index,match.index+8000);
    const url=attribute(tag,'href'),id=url.match(/item\.fril\.jp\/([a-f0-9]+)/i)?.[1]||'';
    const title=attribute(tag,'data-rat-item_name')||attribute(tag,'title').replace(/\s+[^ ]+の商品詳細ページへのリンク$/,'');
    const price=Number(attribute(tag,'data-rat-price'));
    const sellerId=(attribute(tag,'data-rat-itemid').split('/')[0]||'').trim();
    const category=attribute(tag,'data-rat-igenre');
    const image=decodeHtml(window.match(/data-original=["']([^"']*img\.fril\.jp[^"']*)["']/i)?.[1]||'');
    if(id&&url&&title&&Number.isFinite(price))cards.push({id,url,title,text:title,price,sellerId,category,image,source:'rakuma_search'});
  }
  return [...new Map(cards.map(card=>[card.id,card])).values()];
}

export function extractRakumaDetail(html='',url=''){
  const source=String(html),scripts=[...source.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  let product;
  for(const script of scripts){
    try{const value=JSON.parse(decodeHtml(script[1]).trim());if(value?.['@type']==='Product'){product=value;break}}catch{}
  }
  if(!product?.name||!product?.offers)throw new Error('ラクマ商品详情结构已变化');
  const availability=String(product.offers.availability||'');
  const images=[product.image,...[...source.matchAll(/(?:data-original|src|content)=["'](https:\/\/img\.fril\.jp\/img\/[^"']+)["']/gi)].map(match=>decodeHtml(match[1]))]
    .filter(Boolean).map(value=>String(value).replace('/m/','/l/').replace('/s/','/l/'));
  const sellerId=source.match(/seller_user_id(?:&quot;|")\s*:\s*(?:&quot;|")?(\d+)/i)?.[1]||'';
  const category=[...source.matchAll(/data-rat-igenre=["']([^"']+)["']/gi)].map(match=>decodeHtml(match[1]))[0]||'';
  const condition=decodeHtml(source.match(/(?:item_condition|item-status-status)[^\n]{0,180}?(?:&quot;|>|:)\s*([^<"&]{2,30})/i)?.[1]||'');
  return {
    id:String(url).match(/item\.fril\.jp\/([a-f0-9]+)/i)?.[1]||'',url,
    title:decodeHtml(product.name),description:decodeHtml(product.description||''),
    price:Number(product.offers.price),status:/InStock$/i.test(availability)?'OPEN':'SOLD',sellerId,category,condition,
    images:[...new Set(images)].slice(0,10)
  };
}

export async function rakumaCompare(item,settings={},dependencies={}){
  const getHtml=dependencies.fetchHtml||fetchHtml,fingerprint=dependencies.imageFingerprints||imageFingerprints;
  const query=queryFor(item.title),searchUrl=`https://fril.jp/s?query=${encodeURIComponent(query)}&transaction=selling&sort=sell_price&order=asc`;
  const ownDescription=item.yahoo?.ownDescription||item.description||'';
  const ownCategory=item.yahoo?.ownCategory||'';
  const ownImages=[...(item.yahoo?.ownImages||[]),...(item.images||[]),item.image].filter(Boolean);
  const ownImageEvidence=await Promise.all([...new Set(ownImages)].slice(0,8).map(fingerprint));
  const ownFingerprints=ownImageEvidence.filter(Boolean),rejected=[];
  const cards=extractRakumaSearchCards(await getHtml(searchUrl,settings));
  const screened=[];
  for(const card of cards){
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
  const lowerUnconfirmed=rejected.filter(row=>Number(row.price)<Number(item.ownPrice)&&['detail_error','sale_description_unavailable','collectible_variant_image_unconfirmed','primary_variant_unconfirmed'].includes(row.reason));
  return {
    rulesVersion:MATCHING_RULES_VERSION,query,searchUrl,status:lowerUnconfirmed.length?'incomplete':'ok',
    lowestPrice:competitors[0]?.price??null,lowestUrl:competitors[0]?.url??searchUrl,
    candidates:competitors.slice(0,5),cardCount:cards.length,preliminaryCount:preliminary.length,
    detailCheckedCount:preliminary.length,competitorCount:competitors.length,rejected:rejected.slice(-30),
    unconfirmedLowerCount:lowerUnconfirmed.length,plausibleMinPrice:lowerUnconfirmed.length?Math.min(...lowerUnconfirmed.map(row=>row.price)):null,
    matchLabel:lowerUnconfirmed.length?'存在尚未核验的ラクマ低价候选':competitors.length?'已核验ラクマ在售同款':'ラクマ未发现同款',
    checkedAt:new Date().toISOString()
  };
}
