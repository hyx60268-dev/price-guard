import { imageFingerprints,imageSetSimilarity } from './image.mjs';
import { conditionCompatible,hasExplicitDefect,isRejected,listingSpecificationEquivalent,listingTextEquivalent,productFamily,semanticQuantity,semanticSameItem,titleScore } from './rules.mjs';

const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36';
const DEFAULT_REQUEST_INTERVAL_MS=5500;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS=60000;
let requestIntervalMs=DEFAULT_REQUEST_INTERVAL_MS,rateLimitCooldownMs=DEFAULT_RATE_LIMIT_COOLDOWN_MS;
let requestGate=Promise.resolve(),nextRequestAt=0;

function wait(milliseconds){return new Promise(resolve=>setTimeout(resolve,milliseconds))}

function yahooRequestTurn(){
  const turn=requestGate.then(async()=>{
    const delay=Math.max(0,nextRequestAt-Date.now());
    if(delay)await wait(delay);
    nextRequestAt=Date.now()+requestIntervalMs;
  });
  requestGate=turn.catch(()=>{});
  return turn;
}

function yahooCooldown(milliseconds){
  nextRequestAt=Math.max(nextRequestAt,Date.now()+milliseconds);
}

function applyYahooSettings(settings={}){
  requestIntervalMs=Math.max(4000,Number(settings.yahooRequestIntervalMs)||DEFAULT_REQUEST_INTERVAL_MS);
  rateLimitCooldownMs=Math.max(15000,Number(settings.yahooRateLimitCooldownMs)||DEFAULT_RATE_LIMIT_COOLDOWN_MS);
}

function exactQueryFor(title=''){
  return title.replace(/新品|未使用|未開封|正規品|中国限定|海外限定|匿名配送|送料無料/gi,' ')
    .replace(/[【】\[\]（）()<>《》/／]/g,' ').replace(/\s+/g,' ').trim();
}

// Yahoo の検索は長い完全一致語だと表記揺れを拾えないため、検索時だけ商品種別や
// 「ペア/セット」などの一般語を外す。同一商品判定には下の exactQuery を使うので、
// 広く呼び戻しても別キャラ・別数量・別版を最低価格として採用しない。
export function queryFor(title=''){
  const exact=exactQueryFor(title);
  const recall=exact
    .replace(/日本非売品|日本未発売|非売品|国内限定|フランス限定|香港限定|会場限定|限定/gi,' ')
    .replace(/アクリルスタンド|アクスタ|アクリルブロック|ぬいぐるみ|マスコット|キーホルダー|キーチェーン|ストラップ|フィギュア|フォトカード|ポストカード|トレカ|コレクションカード|缶バッジ/gi,' ')
    .replace(/\d+\s*(?:ピース|体|点|個|枚|本)(?:入り|入)?|\d+\s*box|\d+\s*体セット/gi,' ')
    .replace(/(?:ペア|セット)(?=\s|$)/gi,' ')
    .replace(/[&＆×「」『』#＃]/g,' ').replace(/\s+/g,' ').trim();
  return recall.length>=3?recall:exact;
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

export function extractCategoryIds(raw={}){
  return [...new Set([
    ...(raw.genreCategoryIds||[]),
    raw.category?.id,raw.category?.productCategoryId,
    ...(raw.category?.path||[]).map(category=>category?.id)
  ].filter(value=>value!==undefined&&value!==null))];
}

async function fetchHtml(url,attempts=2){
  let last;
  for(let attempt=1;attempt<=attempts;attempt++){
    await yahooRequestTurn();
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),15000);
    try{
      const response=await fetch(url,{headers:{'user-agent':UA,'accept-language':'ja-JP,ja;q=0.9'},signal:controller.signal,redirect:'follow'});
      if(response.status===429){
        const retryAfter=Number(response.headers.get('retry-after'));
        const waitMs=Number.isFinite(retryAfter)&&retryAfter>0
          ?Math.min(120000,retryAfter*1000)
          :Math.min(120000,rateLimitCooldownMs*attempt);
        yahooCooldown(waitMs);
        if(attempt<attempts){console.warn(`[Yahoo 限流] ${Math.ceil(waitMs/1000)} 秒后重试 (${attempt}/${attempts})`);await new Promise(resolve=>setTimeout(resolve,waitMs));continue}
      }
      if(!response.ok) throw new Error(`HTTP ${response.status}`);
      const html=await response.text();
      if(html.length<10000) throw new Error(`页面内容异常短 (${html.length} bytes)`);
      return html;
    }catch(error){
      last=error;
      if(attempt<attempts) await new Promise(resolve=>setTimeout(resolve,1000*attempt));
    }finally{clearTimeout(timeout)}
  }
  throw new Error(`Yahoo 请求失败：${String(last)}`);
}

export async function fetchYahooResult(url,settings={}){
  applyYahooSettings(settings);
  return searchResult(extractNextData(await fetchHtml(url)));
}

export async function fetchYahooItemBundle(id,settings={}){
  applyYahooSettings(settings);
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
    categoryIds:extractCategoryIds(raw),source:'search',recommendationType:'',recommendationScore:null
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

export async function discoverYahooProfile(_unusedPage,profileUrl,settings={}){
  applyYahooSettings(settings);
  const first=await fetchYahooResult(`${profileUrl}?page=1`,settings);
  const pages=Math.max(1,Math.ceil(Number(first.totalResultsAvailable||first.items.length)/100));
  const all=[...first.items];
  for(let page=2;page<=pages;page++){
    const result=await fetchYahooResult(`${profileUrl}?page=${page}`,settings);
    all.push(...result.items);
  }
  const items=[...new Map(all.filter(x=>x.itemStatus==='OPEN').map(x=>[x.id,liveItem(x)])).values()];
  return {items,totalResults:Number(first.totalResultsAvailable||all.length),pages};
}

export async function yahooCompare(_unusedPage,item,settings={}){
  applyYahooSettings(settings);
  const query=queryFor(item.title);
  const exactQuery=exactQueryFor(item.title);
  const searchUrl=`https://paypayfleamarket.yahoo.co.jp/search/${encodeURIComponent(query)}?open=1`;
  let search=null,ownBundle=null,searchError='',itemPageError='';
  // 正常時は検索ページ 1 回だけ。商品ページは検索が失敗した時の推薦候補フォールバックに限定する。
  // これで 89 商品の基礎リクエストを半減し、Yahoo の公開ページ制限内で定期確認できる。
  try{search=await fetchYahooResult(searchUrl,settings)}catch(error){searchError=String(error)}
  if(!search){
    try{ownBundle=await fetchYahooItemBundle(item.id,settings)}catch(error){itemPageError=String(error)}
  }
  if(!search&&!ownBundle)throw new Error(`搜索与商品页均失败：${searchError}; ${itemPageError}`);

  const searchCards=(search?.items||[]).filter(raw=>raw.itemStatus==='OPEN').map(searchCard);
  let recommendationCards=ownBundle?.recommendations||[];
  let ownDetail=ownBundle?.detail||null;
  const ownSearchCard=searchCards.find(card=>card.id===item.id);
  let ownCategory=categoryText(ownDetail,ownSearchCard)||item.yahoo?.ownCategory||'';
  let preliminary=[];
  const rejected=[];
  const screenCards=cards=>{
    const accepted=[];
    for(const card of cards.sort((a,b)=>a.price-b.price)){
    if(card.id===item.id||!Number.isFinite(card.price))continue;
    if(isRejected(card.title)){rejected.push({id:card.id,price:card.price,reason:'title_rejected'});continue}
    const tScore=titleScore(exactQuery,card.title);
    const recallScore=titleScore(query,card.title);
    const semantic=semanticSameItem({query:item.title,candidate:card.title,queryCategory:ownCategory,candidateCategory:categoryText(null,card)});
    const fromRecommendation=recommendationEvidence(card);
    const strongTitle=tScore>=0.88&&!['variant_mismatch','product_mismatch'].includes(semantic.reason);
    if(strongTitle||semantic.accepted||(fromRecommendation&&tScore>=0.5&&semantic.reason==='weak_anchors')){
      accepted.push({...card,titleScore:tScore,recallScore,semantic,fromRecommendation});
    }else rejected.push({id:card.id,price:card.price,reason:semantic.reason||'weak_title',titleScore:tScore,recallScore});
    }
    return accepted;
  };
  let cards=mergeCards([searchCards,recommendationCards]);
  preliminary=screenCards(cards);

  // 搜索页没有召回更低同款时，读取自己的商品页，把「この商品に似ている商品」
  // 和「この商品を見ている人におすすめ」中的在售候选合并进来。只对搜索
  // 结果较少的长尾商品执行，兼顾准确率和 20 分钟任务预算。
  const recommendationFallbackLimit=Math.max(1,Number(settings.yahooRecommendationFallbackMaxCards)||20);
  const packagedSet=Number(semanticQuantity(item.title))>1||/(?:box|セット|コンプ|全\s*\d+\s*種)/i.test(item.title);
  if(preliminary.length<2&&!ownBundle&&(searchCards.length<=recommendationFallbackLimit||packagedSet)){
    try{
      ownBundle=await fetchYahooItemBundle(item.id,settings);ownDetail=ownBundle.detail;
      ownCategory=categoryText(ownDetail,ownSearchCard)||ownCategory;
      recommendationCards=ownBundle.recommendations||[];cards=mergeCards([searchCards,recommendationCards]);
      preliminary=screenCards(cards);
    }catch(error){itemPageError=String(error)}
  }

  // 出现可能同款候选时读取自己的详情全文和全部商品图。后续必须同时通过实物类型、
  // 规格数量、详情文字和图片验证；标题相似不再能单独成为最低价证据。
  if(preliminary.length&&!ownDetail){
    try{ownBundle=await fetchYahooItemBundle(item.id,settings);ownDetail=ownBundle.detail;ownCategory=categoryText(ownDetail,ownSearchCard)||ownCategory}
    catch(error){itemPageError=String(error)}
  }
  const ownImages=[...(ownDetail?.images||[]).map(image=>typeof image==='string'?image:image?.url).filter(Boolean),ownDetail?.thumbnailImageUrl,...(item.yahoo?.ownImages||[]),item.image].filter(Boolean);
  const maxImages=Math.max(3,Math.min(10,Number(settings.maxYahooImages)||8));
  const ownFingerprints=(await Promise.all([...new Set(ownImages)].slice(0,maxImages).map(imageFingerprints))).filter(Boolean);
  const ownConditionText=`${item.title}\n${ownDetail?.title||''}\n${ownDetail?.description||''}\n${ownDetail?.condition?.name||ownDetail?.condition||''}`;

  const competitors=[];
  let detailCheckedCount=0;
  const maxDetailChecks=Math.max(1,Number(settings.maxYahooDetailChecks)||2);
  for(let index=0;index<preliminary.length&&detailCheckedCount<maxDetailChecks;index++){
    const card=preliminary[index];
    detailCheckedCount++;
    try{
      const bundle=await fetchYahooItemBundle(card.id,settings),detail=bundle.detail;
      if(detail.status!=='OPEN'){rejected.push({id:card.id,price:card.price,reason:'not_open'});continue}
      if(hasExplicitDefect(detail.title,detail.description)){rejected.push({id:card.id,price:Number(detail.price),reason:'defect'});continue}
      const candidateConditionText=`${detail.title||''}\n${detail.description||''}\n${detail.condition?.name||detail.condition||''}`;
      if(!conditionCompatible(ownConditionText,candidateConditionText)){
        rejected.push({id:card.id,price:Number(detail.price),reason:'condition_or_packaging_mismatch'});continue
      }
      const detailCategory=categoryText(detail,card);
      const semantic=semanticSameItem({query:item.title,candidate:`${detail.title}\n${detail.description||''}`,queryCategory:ownCategory,candidateCategory:detailCategory});
      const detailTitleScore=titleScore(exactQuery,detail.title);
      const queryFamily=productFamily(item.title,ownCategory),candidateFamily=productFamily(`${detail.title}\n${detail.description||''}`,detailCategory);
      const familyConfirmed=queryFamily&&candidateFamily?queryFamily===candidateFamily:!queryFamily&&!candidateFamily&&detailTitleScore>=.95;
      if(!familyConfirmed){rejected.push({id:card.id,price:Number(detail.price),reason:'physical_product_type_unconfirmed',queryFamily,candidateFamily,titleScore:detailTitleScore});continue}
      const specificationEquivalent=listingSpecificationEquivalent(ownDetail?.title||item.title,detail.title||'',ownCategory,detailCategory);
      // 官网拆盒角色图、实物端盒图可能完全不同。只要详情全文中的品牌、系列、
      // 商品类型和明确数量规格一致，就允许规格证据补足标题相似度；不同角色、
      // 数量、版本和商品形态仍会在 specificationEquivalent/semantic 中被拒绝。
      if(!semantic.accepted&&!specificationEquivalent){rejected.push({id:card.id,price:Number(detail.price),reason:semantic.reason||'detail_mismatch',titleScore:detailTitleScore});continue}
      if(!specificationEquivalent&&detailTitleScore<.72){rejected.push({id:card.id,price:Number(detail.price),reason:'weak_detail_title',titleScore:detailTitleScore});continue}
      const detailImages=[...(detail.images||[]).map(image=>typeof image==='string'?image:image?.url).filter(Boolean),card.image].filter(Boolean);
      const detailFingerprints=(await Promise.all([...new Set(detailImages)].slice(0,maxImages).map(imageFingerprints))).filter(Boolean);
      const imageScore=imageSetSimilarity(ownFingerprints,detailFingerprints);
      const imageThreshold=Math.max(.75,Number(settings.yahooImageMatchThreshold)||.80);
      const textEquivalent=listingTextEquivalent(ownDetail?.title||item.title,ownDetail?.description||'',detail.title||'',detail.description||'')||specificationEquivalent;
      if(!textEquivalent&&(!ownFingerprints.length||!detailFingerprints.length||!Number.isFinite(imageScore)||imageScore<imageThreshold)){
        rejected.push({id:card.id,price:Number(detail.price),reason:'physical_image_unconfirmed',titleScore:detailTitleScore,imageScore});continue
      }
      const detailImage=detailImages[0]||card.image;
      competitors.push({...card,url:`https://paypayfleamarket.yahoo.co.jp/item/${detail.id}`,title:detail.title,
        text:`${detail.title}\n${detail.description||''}`,image:detailImage,price:Number(detail.price),itemStatus:detail.status,
        titleScore:detailTitleScore,imageScore,semantic,queryFamily,candidateFamily,matchMethod:textEquivalent?'detail_type_quantity_equivalent_text':'detail_type_quantity_text_images'});
    }catch(error){rejected.push({id:card.id,price:card.price,reason:'detail_error',error:String(error)})}
  }

  competitors.sort((a,b)=>a.price-b.price);
  const own={id:item.id,url:item.url||item.ownUrl,title:item.title,image:item.image,price:Number(item.ownPrice),titleScore:1,imageScore:1,isOwn:true};
  const comparable=[own,...competitors].filter(x=>Number.isFinite(x.price)).sort((a,b)=>a.price-b.price);
  const lowest=comparable[0]||null;
  const market=marketPriceDecision(item.ownPrice,competitors.map(value=>value.price),settings);
  const {marketPrices,marketMedianPrice,marketMinPrice,marketMaxPrice,underpriced}=market;
  const recommended=lowest&&!lowest.isOwn?Math.max(1,Math.floor(lowest.price)-1):market.recommendedPrice;
  const sourceCovered=Boolean(search||ownBundle);
  const matchLabel=lowest&&!lowest.isOwn?'已核验在售同款':underpriced?'售价明显低于同款市场':'未发现更低同款';
  return {
    query,searchUrl,lowestPrice:lowest?.price??item.ownPrice,lowestUrl:lowest?.url??item.url,
    recommendedPrice:recommended,candidates:competitors.slice(0,5),cardCount:cards.length,
    searchCardCount:searchCards.length,recommendationCardCount:recommendationCards.length,
    preliminaryCount:preliminary.length,detailCheckedCount,rejected:rejected.slice(0,30),
    competitorCount:competitors.length,status:'ok',comparisonStatus:lowest?.isOwn?(underpriced?'underpriced':'no_lower_found'):'competitor_lower',
    marketSampleCount:marketPrices.length,marketMedianPrice,marketMinPrice,marketMaxPrice,underpriced,
    matchLabel,matchConfidence:lowest&&!lowest.isOwn?'高':sourceCovered?'覆盖检查':'需复核',checkedAt:new Date().toISOString(),ownImages:[...new Set(ownImages)].slice(0,8),
    ownDescription:ownDetail?.description||item.yahoo?.ownDescription||'',ownCategory,
    sourceStatus:{search:search?'ok':'error',itemPage:ownBundle?'fallback':'skipped'},searchError,itemPageError
  };
}

export function marketPriceDecision(ownPrice,prices=[],settings={}){
  const marketPrices=prices.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
  const middle=Math.floor(marketPrices.length/2);
  const marketMedianPrice=!marketPrices.length?null:marketPrices.length%2?marketPrices[middle]:(marketPrices[middle-1]+marketPrices[middle])/2;
  const marketMinPrice=marketPrices[0]??null,marketMaxPrice=marketPrices.at(-1)??null;
  const underpriceRatio=Math.min(.9,Math.max(.3,Number(settings.yahooUnderpriceRatio)||.7));
  const underpriceGap=Math.max(500,Number(settings.yahooUnderpriceMinimumGapJPY)||1500);
  const underpriced=marketPrices.length>=2&&Number.isFinite(marketMedianPrice)&&Number(ownPrice)<=marketMedianPrice*underpriceRatio&&marketMedianPrice-Number(ownPrice)>=underpriceGap;
  return {marketPrices,marketMedianPrice,marketMinPrice,marketMaxPrice,underpriced,
    recommendedPrice:underpriced&&Number.isFinite(marketMinPrice)?Math.max(Number(ownPrice),Math.floor(marketMinPrice)-1):Number(ownPrice)};
}
