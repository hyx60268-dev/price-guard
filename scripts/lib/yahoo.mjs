import { imageSimilarity,imageHash } from './image.mjs';
import { hasExplicitDefect,isRejected,semanticSameItem,titleScore } from './rules.mjs';

const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36';

export function queryFor(title=''){
  return title.replace(/新品|未使用|未開封|正規品|中国限定|海外限定|匿名配送|送料無料/gi,' ')
    .replace(/[【】\[\]（）()<>《》/／]/g,' ').replace(/\s+/g,' ').trim();
}

export function extractNextData(html=''){
  const match=String(html).match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if(!match) throw new Error('Yahoo 页面没有 __NEXT_DATA__，可能被风控或页面已改版');
  return JSON.parse(match[1]);
}

function searchResult(nextData){
  const result=nextData?.props?.initialState?.searchState?.search?.result;
  if(!result || !Array.isArray(result.items)) throw new Error('Yahoo 页面数据结构已变化，找不到商品列表');
  return result;
}

export function extractItemData(nextData){
  const item=nextData?.props?.initialState?.itemsState?.items?.item;
  if(!item?.id)throw new Error('Yahoo 商品页数据结构已变化，找不到商品详情');
  return item;
}

export function extractRecommendationCards(nextData){
  const groups=nextData?.props?.initialState?.recommendsState?.recommends?.recommends||{};
  const candidates=Object.values(groups).flatMap(group=>group?.recommendItems?.items||[]);
  return candidates.filter(raw=>raw?.itemId).map(raw=>({
    id:raw.itemId,url:`https://paypayfleamarket.yahoo.co.jp/item/${raw.itemId}`,title:raw.title||'',text:raw.title||'',
    image:raw.image?.url||'',price:Number(raw.price),sellerId:raw.seller?.id||'',itemStatus:null,
    categoryIds:raw.genreCategoryIds||[],source:'recommendation',recommendationType:raw.log?.rctype||'',
    recommendationScore:Number.isFinite(Number(raw.log?.rcsm))?Number(raw.log.rcsm):null
  }));
}

async function fetchHtml(url,attempts=5){
  let last;
  for(let attempt=1;attempt<=attempts;attempt++){
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),45000);
    try{
      const response=await fetch(url,{headers:{'user-agent':UA,'accept-language':'ja-JP,ja;q=0.9'},signal:controller.signal,redirect:'follow'});
      if(response.status===429){
        const retryAfter=Number(response.headers.get('retry-after'));
        const waitMs=Number.isFinite(retryAfter)&&retryAfter>0?retryAfter*1000:Math.min(60000,10000*attempt);
        if(attempt<attempts){console.warn(`[Yahoo 限流] ${Math.ceil(waitMs/1000)} 秒后重试 (${attempt}/${attempts})`);await new Promise(resolve=>setTimeout(resolve,waitMs));continue}
      }
      if(!response.ok) throw new Error(`HTTP ${response.status}`);
      const html=await response.text();
      if(html.length<10000) throw new Error(`页面内容异常短 (${html.length} bytes)`);
      return html;
    }catch(error){
      last=error;
      if(attempt<attempts) await new Promise(resolve=>setTimeout(resolve,Math.min(15000,1000*attempt*attempt)));
    }finally{clearTimeout(timeout)}
  }
  throw new Error(`Yahoo 请求失败：${String(last)}`);
}

async function fetchResult(url){
  return searchResult(extractNextData(await fetchHtml(url)));
}

async function fetchItemBundle(id){
  const nextData=extractNextData(await fetchHtml(`https://paypayfleamarket.yahoo.co.jp/item/${id}`));
  return {detail:extractItemData(nextData),recommendations:extractRecommendationCards(nextData)};
}

function categoryText(detail,card={}){
  const names=(detail?.categoryList||[]).map(category=>category.name);
  const ids=[...(detail?.categoryList||[]).map(category=>category.id),detail?.productCategory?.id,...(card.categoryIds||[])];
  return [...names,...ids.filter(value=>value!==undefined&&value!==null)].join(' ');
}

function liveItem(raw){
  return {
    id:raw.id,
    url:`https://paypayfleamarket.yahoo.co.jp/item/${raw.id}`,
    title:raw.title||'',
    ownPrice:Number(raw.price),
    image:raw.thumbnailImageUrl||'',
    itemStatus:raw.itemStatus,
    sellerId:raw.sellerId||''
  };
}

function searchCard(raw){
  return {
    id:raw.id,url:`https://paypayfleamarket.yahoo.co.jp/item/${raw.id}`,title:raw.title||'',text:raw.title||'',
    image:raw.thumbnailImageUrl||'',price:Number(raw.price),sellerId:raw.sellerId||'',itemStatus:raw.itemStatus,
    categoryIds:raw.genreCategoryIds||[],source:'search',recommendationType:'',recommendationScore:null
  };
}

function mergeCards(groups){
  const merged=new Map();
  for(const card of groups.flat()){
    const prior=merged.get(card.id);
    if(!prior){merged.set(card.id,{...card,sources:[card.source]});continue}
    merged.set(card.id,{...prior,...card,
      image:prior.image||card.image,price:Number.isFinite(prior.price)?prior.price:card.price,
      itemStatus:prior.itemStatus||card.itemStatus,categoryIds:[...new Set([...(prior.categoryIds||[]),...(card.categoryIds||[])])],
      sources:[...new Set([...(prior.sources||[]),card.source])],
      recommendationType:card.recommendationType||prior.recommendationType,
      recommendationScore:Number.isFinite(card.recommendationScore)?card.recommendationScore:prior.recommendationScore
    });
  }
  return [...merged.values()];
}

function recommendationEvidence(card){
  if(!card.sources?.includes('recommendation'))return false;
  if(card.recommendationType==='vector')return Number.isFinite(card.recommendationScore)&&card.recommendationScore>=0.8;
  return false;
}

export async function discoverYahooProfile(_unusedPage,profileUrl){
  const first=await fetchResult(`${profileUrl}?page=1`);
  const pages=Math.max(1,Math.ceil(Number(first.totalResultsAvailable||first.items.length)/100));
  const all=[...first.items];
  for(let page=2;page<=pages;page++){
    const result=await fetchResult(`${profileUrl}?page=${page}`);
    all.push(...result.items);
  }
  const items=[...new Map(all.filter(x=>x.itemStatus==='OPEN').map(x=>[x.id,liveItem(x)])).values()];
  return {items,totalResults:Number(first.totalResultsAvailable||all.length),pages};
}

export async function yahooCompare(_unusedPage,item){
  const query=queryFor(item.title);
  const searchUrl=`https://paypayfleamarket.yahoo.co.jp/search/${encodeURIComponent(query)}?open=1`;
  let search=null,ownBundle=null,searchError='',itemPageError='';
  try{search=await fetchResult(searchUrl)}catch(error){searchError=String(error)}
  try{ownBundle=await fetchItemBundle(item.id)}catch(error){itemPageError=String(error)}
  if(!search&&!ownBundle)throw new Error(`搜索与商品页均失败：${searchError}; ${itemPageError}`);

  const searchCards=(search?.items||[]).filter(raw=>raw.itemStatus==='OPEN').map(searchCard);
  const recommendationCards=ownBundle?.recommendations||[];
  const cards=mergeCards([searchCards,recommendationCards]);
  const ownDetail=ownBundle?.detail||null,ownCategory=categoryText(ownDetail);
  const ownHash=await imageHash(item.image);
  const preliminary=[];
  const rejected=[];

  for(const card of cards.sort((a,b)=>a.price-b.price)){
    if(card.id===item.id||!Number.isFinite(card.price)||card.price>=Number(item.ownPrice))continue;
    if(isRejected(card.title)){rejected.push({id:card.id,price:card.price,reason:'title_rejected'});continue}
    const tScore=titleScore(query,card.title);
    const semantic=semanticSameItem({query:item.title,candidate:card.title,queryCategory:ownCategory,candidateCategory:categoryText(null,card)});
    const fromRecommendation=recommendationEvidence(card);
    if(tScore>=0.88||(semantic.accepted&&(tScore>=0.5||fromRecommendation))){
      preliminary.push({...card,titleScore:tScore,semantic,fromRecommendation});
    }else rejected.push({id:card.id,price:card.price,reason:semantic.reason||'weak_title',titleScore:tScore});
  }

  const competitors=[];
  let detailCheckedCount=0;
  for(let index=0;index<preliminary.length;index++){
    const card=preliminary[index];
    try{
      const bundle=await fetchItemBundle(card.id),detail=bundle.detail;detailCheckedCount++;
      if(detail.status!=='OPEN'){rejected.push({id:card.id,price:card.price,reason:'not_open'});continue}
      if(hasExplicitDefect(detail.title,detail.description)){rejected.push({id:card.id,price:Number(detail.price),reason:'defect'});continue}
      const detailCategory=categoryText(detail,card);
      const semantic=semanticSameItem({query:item.title,candidate:`${detail.title}\n${detail.description||''}`,queryCategory:ownCategory,candidateCategory:detailCategory});
      const detailTitleScore=titleScore(query,detail.title);
      const accepted=detailTitleScore>=0.88||(semantic.accepted&&(detailTitleScore>=0.5||card.fromRecommendation));
      if(!accepted){rejected.push({id:card.id,price:Number(detail.price),reason:semantic.reason||'detail_mismatch',titleScore:detailTitleScore});continue}
      let imageScore=null;
      const detailImage=detail.images?.[0]?.url||card.image;
      if(ownHash&&detailImage)imageScore=imageSimilarity(ownHash,await imageHash(detailImage));
      competitors.push({...card,url:`https://paypayfleamarket.yahoo.co.jp/item/${detail.id}`,title:detail.title,
        text:`${detail.title}\n${detail.description||''}`,image:detailImage,price:Number(detail.price),itemStatus:detail.status,
        titleScore:detailTitleScore,imageScore,semantic,matchMethod:detailTitleScore>=0.88?'detail_title':'detail_semantic'});
      const next=preliminary[index+1];
      if(!next||Number(detail.price)<=next.price)break;
    }catch(error){rejected.push({id:card.id,price:card.price,reason:'detail_error',error:String(error)})}
  }

  competitors.sort((a,b)=>a.price-b.price);
  const own={id:item.id,url:item.url||item.ownUrl,title:item.title,image:item.image,price:Number(item.ownPrice),titleScore:1,imageScore:1,isOwn:true};
  const comparable=[own,...competitors].filter(x=>Number.isFinite(x.price)).sort((a,b)=>a.price-b.price);
  const lowest=comparable[0]||null;
  const recommended=lowest&&lowest.price<item.ownPrice?Math.max(1,Math.floor(lowest.price)-1):item.ownPrice;
  const bothSources=Boolean(search&&ownBundle);
  const matchLabel=lowest&&!lowest.isOwn?'已核验在售同款':bothSources?'未发现更低同款':'仅部分来源成功，需复核';
  return {
    query,searchUrl,lowestPrice:lowest?.price??item.ownPrice,lowestUrl:lowest?.url??item.url,
    recommendedPrice:recommended,candidates:competitors.slice(0,5),cardCount:cards.length,
    searchCardCount:searchCards.length,recommendationCardCount:recommendationCards.length,
    preliminaryCount:preliminary.length,detailCheckedCount,rejected:rejected.slice(0,30),
    competitorCount:competitors.length,status:'ok',comparisonStatus:lowest?.isOwn?'no_lower_found':'competitor_lower',
    matchLabel,matchConfidence:lowest&&!lowest.isOwn?'高':bothSources?'覆盖检查':'需复核',
    sourceStatus:{search:search?'ok':'error',itemPage:ownBundle?'ok':'error'},searchError,itemPageError
  };
}
