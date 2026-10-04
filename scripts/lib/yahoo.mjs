import { isOwnedOffer } from '../../public/owned-offers.js';
import {planYahooDetailQueue} from './yahoo-detail-queue.mjs';
import { knownYahooCandidates,yahooTargetShipping } from './yahoo-known-refresh.mjs';
import { extractYahooBundleComponents } from './merchant-bundles.mjs';
import { merchantNameFromTitle } from './merchant-names.mjs';
import { imageFingerprints,imageSetSimilarity,primaryProductSimilarity } from './image.mjs';
import { offerIdentityGuard } from './offer-identity.mjs';
import { reviewedListingCandidate,reviewedListingIdentity } from './reviewed-listing-identities.mjs';
import { rejectedByMemory } from '../../public/match-memory.js';
import { descriptionColorMismatch } from './rules.mjs';
import { coherentPrices,collectibleIdentityRequiresVisualProof,conditionCompatible,distinctiveCoverage,exactIdentityTitleEquivalent,hasExplicitDefect,hasExplicitVariantMismatch,isRejected,listingSpecificationEquivalent,listingTextEquivalent,lotterySeriesEquivalent,lotterySeriesNeedsVisualConfirmation,MATCHING_RULES_VERSION,packagedAssortmentEquivalent,sealedSingleBoxEquivalent,sealedSingleBoxTextCompatible,productFamily,saleUnitEquivalent,semanticSameItem,titleScore,visualListingEquivalent } from './rules.mjs';

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

export function exactQueryFor(title=''){
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
  const candidates=Object.entries(groups).flatMap(([section,group])=>(group?.recommendItems?.items||[]).map(raw=>({raw,section})));
  return candidates.filter(({raw})=>raw?.itemId).map(({raw,section})=>({
    id:raw.itemId,url:`https://paypayfleamarket.yahoo.co.jp/item/${raw.itemId}`,title:raw.title||'',text:raw.title||'',
    image:raw.image?.url||'',price:Number(raw.price),sellerId:raw.seller?.id||'',itemStatus:null,
    categoryIds:raw.genreCategoryIds||[],source:'recommendation',recommendationSection:section,recommendationType:raw.log?.rctype||'',
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
  const html=await fetchHtml(url),result=searchResult(extractNextData(html));
  return /^https:\/\/paypayfleamarket\.yahoo\.co\.jp\/user\//.test(url)?{...result,profileName:merchantNameFromTitle('yahoo',html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'')}:result;
}

export async function fetchYahooItemBundle(id,settings={}){
  applyYahooSettings(settings);
  const html=await fetchHtml(`https://paypayfleamarket.yahoo.co.jp/item/${id}`),nextData=extractNextData(html);
  const detail=extractItemData(nextData);
  return {detail,shipping:yahooTargetShipping(html,detail),recommendations:extractRecommendationCards(nextData),components:extractYahooBundleComponents(html)};
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

export function candidateEvidenceOrder(a,b){
  // 比价的首要目标是找到最低在售同款。候选已经通过初筛后，先核验低价，
  // 不能让 Yahoo 的相似度分数把更低的候选挤出详情检查预算。
  // 一番くじも例外にしない。シリーズ名が短い低价候选を後回しにすると、高价候选
  // だけで检查上限を使い切り、画面に見えている同款低价を无视して提价してしまう。
  if(a.price!==b.price)return a.price-b.price;
  const aCondition=Number.isFinite(a.conditionPriority)?a.conditionPriority:1,bCondition=Number.isFinite(b.conditionPriority)?b.conditionPriority:1;
  if(aCondition!==bCondition)return aCondition-bCondition;
  // A live search result is actionable evidence. Stale/sold recommendation
  // cards used to consume the detail budget before the OPEN exact-title card.
  const sourcePriority=card=>card.sources?.includes('search')?0:card.sources?.includes('prior_verified')?1:2;
  const aSource=sourcePriority(a),bSource=sourcePriority(b);
  if(aSource!==bSource)return aSource-bSource;
  if(a.titleScore!==b.titleScore)return b.titleScore-a.titleScore;
  const aRecommended=a.fromRecommendation?1:0,bRecommended=b.fromRecommendation?1:0;
  if(aRecommended!==bRecommended)return bRecommended-aRecommended;
  const aVector=Number.isFinite(a.recommendationScore)?a.recommendationScore:-1;
  const bVector=Number.isFinite(b.recommendationScore)?b.recommendationScore:-1;
  if(aVector!==bVector)return bVector-aVector;
  return 0;
}

export function visualRecallEligible({query='',candidate='',queryCategory='',candidateCategory='',imageScore=null,threshold=.84}={}){
  if(!Number.isFinite(imageScore)||imageScore<Math.max(.80,Number(threshold)||.84))return false;
  if(hasExplicitVariantMismatch(query,candidate)||hasExplicitVariantMismatch(candidate,query))return false;
  const semantic=semanticSameItem({query,candidate,queryCategory,candidateCategory});
  if(['variant_mismatch','product_mismatch'].includes(semantic.reason))return false;
  const queryFamily=productFamily(query,queryCategory),candidateFamily=productFamily(candidate,candidateCategory);
  return !(queryFamily&&candidateFamily&&queryFamily!==candidateFamily);
}

export function unresolvedRaiseCandidates(preliminary=[],rejected=[]){
  // 已确认售出、规格不符、状态不符的商品不能限制在售市场价；只有尚未读取详情，
  // 或详情请求失败而仍有疑点的候选，才作为提价安全上限继续保留。
  const decisions=new Map();
  for(const item of rejected)if(item?.id&&preliminary.some(card=>card.id===item.id))decisions.set(item.id,item.reason||'rejected');
  const definitive=new Set(['not_open','own_seller','defect','condition_or_packaging_mismatch','physical_product_type_unconfirmed','sale_unit_mismatch','description_color_mismatch','variant_mismatch','product_mismatch','title_rejected']);
  // 图片不足、系列信息不全或详情请求失败只是“尚未证实”，不是“已经证伪”。
  // 这些低价项必须继续限制提价上限，避免证据不足反而导致激进提价。
  return preliminary.filter(card=>!definitive.has(decisions.get(card.id)));
}

export async function discoverYahooProfile(_unusedPage,profileUrl,settings={},dependencies={}){
  applyYahooSettings(settings);
  const getResult=dependencies.fetchYahooResult||fetchYahooResult;
  const first=await getResult(`${profileUrl}?page=1`,settings);
  const pages=Math.max(1,Math.ceil(Number(first.totalResultsAvailable||first.items.length)/100));
  const all=[...first.items];
  for(let page=2;page<=pages;page++){
    const result=await getResult(`${profileUrl}?page=${page}`,settings);
    all.push(...result.items);
  }
  const items=[...new Map(all.filter(x=>x.itemStatus==='OPEN').map(x=>[x.id,liveItem(x)])).values()];
  const total=Number(first.totalResultsAvailable??all.length);
  const complete=new Set(all.map(item=>item.id)).size>=total;
  if(!complete)throw new Error('Yahoo 主页分页不完整，保留已有库存');
  return {items,totalResults:total,pages,complete};
}

export async function yahooCompare(_unusedPage,item,settings={},dependencies={}){
  const knownOnly=settings.yahooKnownOnly===true;
  const requestedKnown=new Set(settings.yahooKnownCandidateIds||[]);
  const knownCardsInput=knownOnly?knownYahooCandidates(item,settings).filter(card=>!requestedKnown.size||requestedKnown.has(card.id)).slice(0,2):[];
  if(knownOnly&&!knownCardsInput.length)return {candidates:[],rejected:[],knownRefresh:{mode:'failed',reason:'no_eligible_known_offer'}};
  const getBundle=dependencies.fetchYahooItemBundle||fetchYahooItemBundle;
  const getResult=dependencies.fetchYahooResult||fetchYahooResult;
  const fingerprint=dependencies.imageFingerprints||imageFingerprints;
  applyYahooSettings(settings);
  const externalOwn=item.platform==='rakuma';
  const ownSellerId=externalOwn?'':String(item.sellerId||settings.ownSellerId||'').trim();
  const query=queryFor(item.title);
  const exactQuery=exactQueryFor(item.title);
  const searchUrl=`https://paypayfleamarket.yahoo.co.jp/search/${encodeURIComponent(query)}?open=1`;
  let search=null,searchObservedAt=null,ownBundle=null,searchError='',itemPageError='';
  // 商品页里的 vector 推荐正是 App 展示的「この商品に似ている商品」。它比宽泛
  // 搜索更容易召回标题译名不同、但首图和本体相同的商品，因此每轮以商品页为主。
  // 已有有效竞品由快查更新，广搜沿用较低频率；尚无匹配的商品按正常复查资格继续找。
  // 仅推荐页/详情检查不得充当广搜时间，否则未搜索也会反复推迟下一次广搜。
  if(externalOwn){if(item.sourceDetail)ownBundle={detail:item.sourceDetail,recommendations:[]};else itemPageError='ラクマ自有商品详情未读取'}
  else try{ownBundle=await getBundle(item.id,settings)}catch(error){itemPageError=String(error)}
  const broadSearchHours=Math.max(1,Number(settings.yahooBroadSearchHours)||6);
  const lastBroadSearch=Date.parse(item.yahoo?.searchCheckedAt||'');
  const quoteAge=Date.now()-Date.parse(item.yahoo?.checkedAt||'');
  const hasCurrentKnownOffer=item.yahoo?.cacheReason!=='request_error'&&Number.isFinite(quoteAge)&&quoteAge>=-60_000&&quoteAge<=6*3_600_000&&knownYahooCandidates(item,settings).length>0;
  const broadSearchInterval=hasCurrentKnownOffer?broadSearchHours*3_600_000:Math.max(1,Number(settings.yahooFreshMinutes)||20)*60_000;
  const broadSearchDue=!knownOnly&&(settings.forceYahooBroadSearch===true||!Number.isFinite(lastBroadSearch)||lastBroadSearch>Date.now()+60_000||Date.now()-lastBroadSearch>=broadSearchInterval);
  if(!knownOnly&&(externalOwn||broadSearchDue||!ownBundle)){
    try{search=await getResult(searchUrl,settings);searchObservedAt=search?new Date().toISOString():null}catch(error){searchError=String(error)}
  }
  if(!search&&!ownBundle)throw new Error(`搜索与商品页均失败：${searchError}; ${itemPageError}`);
  if(knownOnly){
    const own=ownBundle?.detail,seller=String(own?.seller?.id||own?.sellerId||'').trim();
    const sameTitle=(a,b)=>String(a||'').normalize('NFKC').replace(/\s+/g,' ').trim()===String(b||'').normalize('NFKC').replace(/\s+/g,' ').trim();
    let reason=own?.id!==item.id?'own_id_mismatch':own?.status!=='OPEN'?'own_not_open':!seller||!ownSellerId||seller!==ownSellerId?'own_seller_unconfirmed':!sameTitle(own?.title,item.title)?'own_title_changed':!own?.description?.trim()?'own_description_unavailable':!Array.isArray(own?.images)||!own.images.length?'own_images_unavailable':!Number.isFinite(Number(own?.price))||Number(own.price)<=0?'own_price_unavailable':!ownBundle.shipping?.shippingKnown||ownBundle.shipping.currency!=='JPY'?'own_shipping_unconfirmed':null;
    if(reason)return {candidates:[],rejected:[],knownRefresh:{mode:'failed',reason}};
    item={...item,ownPrice:Number(own.price)};
  }

  const searchCards=(search?.items||[]).filter(raw=>raw.itemStatus==='OPEN').map(searchCard);
  const priorCards=(knownOnly?knownCardsInput:item.yahoo?.candidates||[]).filter(card=>card?.id&&Number.isFinite(Number(card.price))).map(card=>({...card,source:'prior_verified'}));
  let recommendationCards=knownOnly?[]:ownBundle?.recommendations||[];
  let ownDetail=ownBundle?.detail||null;
  const ownSearchCard=searchCards.find(card=>card.id===item.id);
  let ownCategory=(externalOwn?ownDetail?.category:categoryText(ownDetail,ownSearchCard))||item.yahoo?.ownCategory||'';
  let preliminary=[];
  const rejected=[];
  const screenCards=cards=>{
    const accepted=[];
    for(const card of cards.sort((a,b)=>a.price-b.price)){
    if(card.id===item.id||!Number.isFinite(card.price))continue;
    if(rejectedByMemory(settings.matchCorrections,item,'yahoo',card)){rejected.push({id:card.id,price:card.price,reason:'saved_user_correction'});continue}
    if(isOwnedOffer(settings.ownedOffers,'yahoo',card)||ownSellerId&&card.sellerId===ownSellerId){rejected.push({id:card.id,price:card.price,reason:'own_seller'});continue}
    if(isRejected(card.title)){rejected.push({id:card.id,price:card.price,reason:'title_rejected'});continue}
    const tScore=titleScore(exactQuery,card.title);
    const recallScore=titleScore(query,card.title);
    const candidateCategory=categoryText(null,card);
    const semantic=semanticSameItem({query:item.title,candidate:card.title,queryCategory:ownCategory,candidateCategory});
    const lotterySeriesUnconfirmed=lotterySeriesNeedsVisualConfirmation(item.title,card.title);
    const conditionPriority=/(?:新品|未開封|未使用|未拆封|全新)/i.test(card.title)?0:
      /(?:中古|開封済|箱なし|箱無し|本体のみ|展示品)/i.test(card.title)?2:1;
    const fromRecommendation=recommendationEvidence(card);
    const strongTitle=tScore>=0.88&&!['variant_mismatch','product_mismatch'].includes(semantic.reason);
    const anchors=distinctiveCoverage(item.title,card.title);
    const sameFamily=productFamily(item.title,ownCategory)&&productFamily(item.title,ownCategory)===productFamily(card.title,candidateCategory);
    const recommendationRecall=fromRecommendation&&Number(card.recommendationScore)>=.9&&sameFamily&&semantic.reason!=='variant_mismatch'&&
      !hasExplicitVariantMismatch(item.title,card.title)&&!hasExplicitVariantMismatch(card.title,item.title)&&
      (anchors.matchedCount>=2||anchors.matchedLength>=6);
    // Missing set size in a card is unknown, not a conflict. Read the sale text;
    // only the downstream full-description gate may accept a pair/box.
    const detailRecall=anchors.matchedCount>=2&&recallScore>=.6&&
      !hasExplicitVariantMismatch(item.title,card.title)&&!hasExplicitVariantMismatch(card.title,item.title);
    // Recommendation titles often omit the prize/model. Fetch sale details to
    // resolve this ambiguity, never accept the recommendation itself as proof.
    const ambiguousRecommendation=fromRecommendation&&sameFamily&&anchors.matchedCount>=3&&Number(card.recommendationScore)>=.9;
    if(strongTitle||semantic.accepted||recommendationRecall||detailRecall||ambiguousRecommendation||(fromRecommendation&&tScore>=0.5&&semantic.reason==='weak_anchors')){
      accepted.push({...card,titleScore:tScore,recallScore,semantic,fromRecommendation,lotterySeriesUnconfirmed,conditionPriority});
    }else rejected.push({id:card.id,price:card.price,reason:semantic.reason||'weak_title',titleScore:tScore,recallScore});
    }
    return accepted;
  };
  let cards=mergeCards([searchCards,recommendationCards,priorCards]);
  preliminary=knownOnly?priorCards.map(card=>({...card,titleScore:0,semantic:{}})):screenCards(cards);

  // 出现可能同款候选时读取自己的详情全文和全部商品图。商品页同时返回 Yahoo 自己的
  // 「相似商品 / 看过此商品的人也推荐」候选；读取后必须重新合并并筛选，不能只拿详情
  // 而丢掉这些候选。
  if(preliminary.length&&!ownDetail&&!externalOwn){
    try{
      ownBundle=await getBundle(item.id,settings);ownDetail=ownBundle.detail;ownCategory=categoryText(ownDetail,ownSearchCard)||ownCategory;
      recommendationCards=ownBundle.recommendations||[];cards=mergeCards([searchCards,recommendationCards,priorCards]);
      rejected.length=0;preliminary=screenCards(cards);
    }
    catch(error){itemPageError=String(error)}
  }
  const ownImages=[...(ownDetail?.images||[]).map(image=>typeof image==='string'?image:image?.url).filter(Boolean),ownDetail?.thumbnailImageUrl,...(knownOnly?[]:[...(item.yahoo?.ownImages||[]),item.image])].filter(Boolean);
  const maxImages=Math.max(3,Math.min(10,Number(settings.maxYahooImages)||8));
  const ownImageEvidence=await Promise.all([...new Set(ownImages)].slice(0,maxImages).map(fingerprint));
  const ownFingerprints=ownImageEvidence.filter(Boolean);

  // Yahoo's recommendation rail often contains the exact item under a short or translated
  // title.  Give lower-priced recommendation thumbnails a second chance using the image,
  // then still require the normal full detail/variant/condition validation below.  This is
  // recall only: a thumbnail match can never become a competitor without detail verification.
  const liveCards=mergeCards([searchCards,recommendationCards]);
  const liveById=new Map(liveCards.map(card=>[card.id,card]));
  const acceptedIds=new Set(preliminary.map(card=>card.id));
  // This exact reviewed link may arrive as an image-only recommendation. Its
  // card is a recall hint, never a substitute for the full live detail below.
  for(const card of cards){
    if(acceptedIds.has(card.id)||card.id===item.id||!Number.isFinite(card.price)||
      rejectedByMemory(settings.matchCorrections,item,'yahoo',card)||isOwnedOffer(settings.ownedOffers,'yahoo',card)||
      ownSellerId&&card.sellerId===ownSellerId||isRejected(card.title))continue;
    if(!reviewedListingCandidate({platform:'yahoo',own:ownDetail,ownPrimary:ownImageEvidence[0],candidate:liveById.get(card.id)||card}))continue;
    preliminary.push({...card,titleScore:titleScore(exactQuery,card.title),recallScore:titleScore(query,card.title),
      semantic:semanticSameItem({query:item.title,candidate:card.title,queryCategory:ownCategory,candidateCategory:categoryText(null,card)}),
      fromRecommendation:recommendationEvidence(card),lotterySeriesUnconfirmed:lotterySeriesNeedsVisualConfirmation(item.title,card.title),conditionPriority:1});
    acceptedIds.add(card.id);
  }
  const visualRecallLimit=Math.max(0,Math.min(30,Number(settings.yahooRecommendationFallbackMaxCards)||20));
  const visualRecallThreshold=Math.max(.80,Number(settings.yahooRecommendationVisualRecallThreshold)||.84);
  const visualRecallCards=cards.filter(card=>
    !acceptedIds.has(card.id)&&card.id!==item.id&&!rejectedByMemory(settings.matchCorrections,item,'yahoo',card)&&card.image&&
    !isOwnedOffer(settings.ownedOffers,'yahoo',card)&&Number.isFinite(card.price)&&(!ownSellerId||card.sellerId!==ownSellerId)&&!isRejected(card.title)
  ).sort((a,b)=>Number(ownImages.includes(b.image))-Number(ownImages.includes(a.image))||a.price-b.price).slice(0,visualRecallLimit);
  const visualFingerprints=await Promise.all(visualRecallCards.map(card=>fingerprint(card.image)));
  for(let index=0;index<visualRecallCards.length;index++){
    const card=visualRecallCards[index],candidateCategory=categoryText(null,card);
    const previewImageScore=imageSetSimilarity(ownFingerprints,[visualFingerprints[index]]);
    if(!visualRecallEligible({query:item.title,candidate:card.title,queryCategory:ownCategory,candidateCategory,imageScore:previewImageScore,threshold:visualRecallThreshold}))continue;
    const tScore=titleScore(exactQuery,card.title),recallScore=titleScore(query,card.title);
    const semantic=semanticSameItem({query:item.title,candidate:card.title,queryCategory:ownCategory,candidateCategory});
    const conditionPriority=/(?:新品|未開封|未使用|未拆封|全新)/i.test(card.title)?0:
      /(?:中古|開封済|箱なし|箱無し|本体のみ|展示品)/i.test(card.title)?2:1;
    preliminary.push({...card,titleScore:tScore,recallScore,semantic,fromRecommendation:recommendationEvidence(card),visualRecall:true,
      previewImageScore,lotterySeriesUnconfirmed:lotterySeriesNeedsVisualConfirmation(item.title,card.title),conditionPriority});
    acceptedIds.add(card.id);
  }
  if(acceptedIds.size)for(let index=rejected.length-1;index>=0;index--)if(acceptedIds.has(rejected[index]?.id))rejected.splice(index,1);
  preliminary.sort(candidateEvidenceOrder);
  const maxDetailChecks=knownOnly?Math.min(2,knownCardsInput.length):Math.max(1,Number(settings.maxYahooDetailChecks)||8);
  // Recheck at most two known external listings before spending the rest of
  // the same budget on cheaper unknown offers. Priority is never acceptance:
  // every selected listing still passes current detail, ownership and variant
  // checks below. Six of the default eight slots remain for lower-price recall.
  const prior=item.yahoo||{},audit=prior.audit||{};
  const eligiblePrior=Boolean(item.accountId)&&Boolean(audit.accountId)&&prior.rulesVersion===MATCHING_RULES_VERSION&&Number.isFinite(Date.parse(prior.checkedAt||''))&&
    ['ok','incomplete'].includes(prior.evidenceStatus||prior.status)&&
    audit.ownItemId===item.id&&audit.accountId===item.accountId;
  const priorMethods=new Set(['detail_type_quantity_text_images','detail_type_quantity_equivalent_text','strong_visual_primary_product',
    'exact_bidirectional_title_identity','same_packaging_assortment','lottery_release_prize_character','same_sealed_single_box_primary','reviewed_sealed_box_identity']);
  const priorById=new Map((eligiblePrior?prior.candidates||[]:[]).filter(card=>!card.isOwn&&card.id&&card.sellerId&&card.title&&card.image&&Number.isFinite(Number(card.price))&&Number(card.price)>0&&priorMethods.has(card.matchMethod)).map(card=>[card.id,card]));
  const normalized=value=>String(value||'').normalize('NFKC').replace(/\s+/g,' ').trim();
  const known=card=>{
    const current=liveById.get(card.id)||card;
    if(reviewedListingCandidate({platform:'yahoo',own:ownDetail,ownPrimary:ownImageEvidence[0],candidate:current}))return true;
    const previous=priorById.get(card.id);
    return Boolean(previous&&['id','sellerId','title','image'].every(key=>normalized(previous[key])===normalized(current[key])));
  };
  const recheckLimit=Math.min(2,Math.max(1,Math.floor(maxDetailChecks/4)));
  const knownCards=preliminary.filter(known),knownIds=new Set(knownCards.map(card=>card.id));
  // Unselected old links follow new candidates even when their cached price is
  // lower. Otherwise a third known link could consume a reserved discovery slot.
  preliminary=[...knownCards.slice(0,recheckLimit),...preliminary.filter(card=>!knownIds.has(card.id)),...knownCards.slice(recheckLimit)];
  const detailQueue=knownOnly?null:planYahooDetailQueue({item,detail:ownDetail,candidates:preliminary,knownIds,knownLimit:recheckLimit,limit:maxDetailChecks,prior:item.yahoo?.detailQueue});
  if(detailQueue)preliminary=detailQueue.cards;
  const ownCondition=typeof ownDetail?.condition==='string'?ownDetail.condition:
    ownDetail?.condition?.name||ownDetail?.condition?.text||ownDetail?.condition?.label||ownDetail?.condition?.key||'';
  const ownConditionText=`${item.title}\n${ownDetail?.title||''}\n${ownDetail?.description||''}\n${ownCondition}`;

  const competitors=[];
  let detailCheckedCount=0;
  for(let index=0;index<preliminary.length&&detailCheckedCount<maxDetailChecks;index++){
    const card=preliminary[index];
    if(knownOnly&&Date.now()>=settings.yahooKnownRefreshDeadline)break;
    detailCheckedCount++;
    let currentDetailRead=false,currentPrimaryImageScore=null;
    try{
      const bundle=await getBundle(card.id,settings),detail=bundle.detail;
      currentDetailRead=detail?.id===card.id&&Boolean(detail?.title?.trim()&&detail?.description?.trim()&&detail?.status)&&Number.isFinite(Number(detail?.price))&&Number(detail.price)>0;
      if(knownOnly&&detail?.id!==card.id){rejected.push({id:card.id,reason:'detail_id_mismatch'});continue}
      if(knownOnly&&(!Array.isArray(detail?.images)||!detail.images.length)){rejected.push({id:card.id,reason:'detail_images_unavailable'});continue}
      if(knownOnly&&(!bundle.shipping?.shippingKnown||bundle.shipping.currency!=='JPY'||bundle.shipping.shippingJPY!==0)){rejected.push({id:card.id,reason:'shipping_unconfirmed'});continue}
      // Never compare against a title-only fallback when our sale description is missing.
      if(!ownDetail?.description?.trim()||!detail?.description?.trim()){
        rejected.push({id:card.id,price:Number(detail?.price),reason:'sale_description_unavailable'});continue
      }
      if(detail.status!=='OPEN'){rejected.push({id:card.id,price:card.price,reason:'not_open'});continue}
      if(!Number.isFinite(Number(detail.price))||Number(detail.price)<=0){rejected.push({id:card.id,price:card.price,reason:'detail_price_unavailable'});continue}
      const detailSellerId=String(detail.seller?.id||detail.sellerId||(knownOnly?'':card.sellerId)||'').trim();
      if(isOwnedOffer(settings.ownedOffers,'yahoo',{...card,sellerId:detailSellerId})||ownSellerId&&detailSellerId===ownSellerId){rejected.push({id:card.id,price:Number(detail.price),reason:'own_seller'});continue}
      if(knownOnly&&(!detailSellerId||detailSellerId!==card.sellerId)){rejected.push({id:card.id,reason:'detail_seller_changed_or_missing'});continue}
      if(hasExplicitDefect(detail.title,detail.description)){rejected.push({id:card.id,price:Number(detail.price),reason:'defect'});continue}
      const candidateCondition=typeof detail.condition==='string'?detail.condition:
        detail.condition?.name||detail.condition?.text||detail.condition?.label||detail.condition?.key||'';
      const candidateConditionText=`${detail.title||''}\n${detail.description||''}\n${candidateCondition}`;
      if(!conditionCompatible(ownConditionText,candidateConditionText)){
        rejected.push({id:card.id,price:Number(detail.price),reason:'condition_or_packaging_mismatch'});continue
      }
      const detailCategory=categoryText(detail,card);
      const semantic=semanticSameItem({query:item.title,candidate:`${detail.title}\n${detail.description||''}`,queryCategory:ownCategory,candidateCategory:detailCategory});
      const detailTitleScore=titleScore(exactQuery,detail.title);
      const queryFamily=productFamily(item.title,ownCategory),candidateFamily=productFamily(`${detail.title}\n${detail.description||''}`,detailCategory);
      const familyConfirmed=queryFamily&&candidateFamily?queryFamily===candidateFamily:!queryFamily&&!candidateFamily&&detailTitleScore>=.95;
      if(!familyConfirmed){rejected.push({id:card.id,price:Number(detail.price),reason:'physical_product_type_unconfirmed',queryFamily,candidateFamily,titleScore:detailTitleScore});continue}
      const ownFullText=`${ownDetail?.title||item.title}\n${ownDetail?.description||''}`;
      const candidateFullText=`${detail.title||''}\n${detail.description||''}`;
      if(descriptionColorMismatch(ownFullText,candidateFullText)){
        rejected.push({id:card.id,price:Number(detail.price),reason:'description_color_mismatch'});continue
      }
      // The title is not the whole offer.  A seller may put "2点セット" or
      // "1BOX" only in the description; no title/image shortcut may override that
      // explicit sale-unit conflict.
      if(!saleUnitEquivalent(ownFullText,candidateFullText)){
        rejected.push({id:card.id,price:Number(detail.price),reason:'sale_unit_mismatch'});continue
      }
      const specificationEquivalent=listingSpecificationEquivalent(ownFullText,candidateFullText,ownCategory,detailCategory);
      // Identity equivalence is a title-to-title check.  Descriptions often contain
      // related artists, bonus names or search keywords that are not variants of the
      // item being sold; feeding those into the title identity check caused exact-title
      // listings (for example the FAN HO trilogy) to be rejected by the image threshold.
      const exactTitleEquivalent=exactIdentityTitleEquivalent(ownDetail?.title||item.title,detail.title||'',ownCategory,detailCategory);
      // 官网拆盒角色图、实物端盒图可能完全不同。只要详情全文中的品牌、系列、
      // 商品类型和明确数量规格一致，就允许规格证据补足标题相似度；不同角色、
      // 数量、版本和商品形态仍会在 specificationEquivalent/semantic 中被拒绝。
      const detailImages=[...(detail.images||[]).map(image=>typeof image==='string'?image:image?.url).filter(Boolean),...(knownOnly?[]:[card.image])].filter(Boolean);
      const detailImageEvidence=await Promise.all([...new Set(detailImages)].slice(0,maxImages).map(fingerprint));
      const detailFingerprints=detailImageEvidence.filter(Boolean);
      const imageScore=imageSetSimilarity(ownFingerprints,detailFingerprints);
      const primaryImageScore=primaryProductSimilarity(ownImageEvidence[0],detailImageEvidence[0]);
      currentPrimaryImageScore=primaryImageScore;
      const sharedIdentity=offerIdentityGuard({ownTitle:ownDetail.title||item.title,ownDescription:ownDetail.description,candidateTitle:detail.title||'',candidateDescription:detail.description,ownCategory,candidateCategory:detailCategory,primaryImageScore});
      if(!sharedIdentity.accepted){rejected.push({id:card.id,price:Number(detail.price),reason:sharedIdentity.reason,imageScore,primaryImageScore});continue}
      // Generic character/type titles identify neither the artwork nor colour.
      // Hash similarity over ANY photo (including identical logos/backs) is not
      // enough. Without near-identical primary evidence, leave these for review.
      if(['neck_pillow','acrylic_stand','acrylic_block','acrylic_shaker','card'].includes(queryFamily)&&
        (!Number.isFinite(primaryImageScore)||primaryImageScore<.98)){
        rejected.push({id:card.id,price:Number(detail.price),reason:'primary_variant_unconfirmed',titleScore:detailTitleScore,imageScore,primaryImageScore});continue
      }
      const imageThreshold=Math.max(.75,Number(settings.yahooImageMatchThreshold)||.80);
      const visualThreshold=Math.max(imageThreshold,Number(settings.yahooStrongVisualMatchThreshold)||.86);
      const visualEquivalent=visualListingEquivalent({query:ownFullText,candidate:candidateFullText,queryCategory:ownCategory,candidateCategory:detailCategory,imageScore,threshold:visualThreshold});
      const reviewedIdentity=sealedSingleBoxTextCompatible({query:ownFullText,candidate:candidateFullText})&&
        Number.isFinite(Number(detail.price))&&Number(detail.price)>0
        ?reviewedListingIdentity({platform:'yahoo',own:ownDetail,candidate:detail,ownPrimary:ownImageEvidence[0],candidatePrimary:detailImageEvidence[0]}):null;
      const sealedBoxEquivalent=Boolean(reviewedIdentity)||sealedSingleBoxEquivalent({query:ownFullText,candidate:candidateFullText,primaryImageScore});
      const identityNeedsVisualProof=collectibleIdentityRequiresVisualProof(
        ownFullText,candidateFullText,ownCategory,detailCategory
      );
      const lotteryEquivalent=lotterySeriesEquivalent(ownFullText,candidateFullText);
      if(identityNeedsVisualProof&&!visualEquivalent&&!sealedBoxEquivalent&&!lotteryEquivalent){
        rejected.push({id:card.id,price:Number(detail.price),reason:'collectible_variant_image_unconfirmed',titleScore:detailTitleScore,imageScore,primaryImageScore});continue
      }
      const lotterySeriesUnconfirmed=lotterySeriesNeedsVisualConfirmation(ownFullText,candidateFullText)&&!visualEquivalent;
      if(lotterySeriesUnconfirmed){
        rejected.push({id:card.id,price:Number(detail.price),reason:'lottery_series_unconfirmed',titleScore:detailTitleScore,imageScore});continue
      }
      const assortmentEquivalent=card.fromRecommendation&&Number(card.recommendationScore)>=.9&&packagedAssortmentEquivalent({
        query:ownFullText,candidate:candidateFullText,queryCategory:ownCategory,candidateCategory:detailCategory,imageScore
      });
      if(!semantic.accepted&&!specificationEquivalent&&!exactTitleEquivalent&&!visualEquivalent&&!sealedBoxEquivalent&&!assortmentEquivalent&&!lotteryEquivalent){rejected.push({id:card.id,price:Number(detail.price),reason:semantic.reason||'detail_mismatch',titleScore:detailTitleScore,imageScore});continue}
      if(!specificationEquivalent&&!exactTitleEquivalent&&!visualEquivalent&&!sealedBoxEquivalent&&!assortmentEquivalent&&!lotteryEquivalent&&detailTitleScore<.72){rejected.push({id:card.id,price:Number(detail.price),reason:'weak_detail_title',titleScore:detailTitleScore,imageScore});continue}
      const textEquivalent=listingTextEquivalent(ownDetail?.title||item.title,ownDetail?.description||'',detail.title||'',detail.description||'')||specificationEquivalent||exactTitleEquivalent||assortmentEquivalent||lotteryEquivalent;
      if(!textEquivalent&&!visualEquivalent&&!sealedBoxEquivalent&&(!ownFingerprints.length||!detailFingerprints.length||!Number.isFinite(imageScore)||imageScore<imageThreshold)){
        rejected.push({id:card.id,price:Number(detail.price),reason:'physical_image_unconfirmed',titleScore:detailTitleScore,imageScore});continue
      }
      const detailImage=detailImages[0]||card.image;
      competitors.push({...card,url:`https://paypayfleamarket.yahoo.co.jp/item/${detail.id}`,title:detail.title,
        text:`${detail.title}\n${detail.description||''}`,sellerId:String(detail.seller?.id||card.sellerId||''),image:detailImage,price:Number(detail.price),itemStatus:detail.status,
        titleScore:detailTitleScore,imageScore,primaryImageScore,semantic,queryFamily,candidateFamily,
        ...(reviewedIdentity?{identityEvidence:reviewedIdentity}:{}),
        ...(knownOnly?{checkedAt:new Date().toISOString(),shippingJPY:0,shippingSource:bundle.shipping.shippingSource,priceSource:'current_target_detail'}:{}),
        matchMethod:reviewedIdentity?'reviewed_sealed_box_identity':sealedBoxEquivalent?'same_sealed_single_box_primary':lotteryEquivalent?'lottery_release_prize_character':assortmentEquivalent?'same_packaging_assortment':exactTitleEquivalent?'exact_bidirectional_title_identity':visualEquivalent?'strong_visual_primary_product':textEquivalent?'detail_type_quantity_equivalent_text':'detail_type_quantity_text_images'});
    }catch(error){rejected.push({id:card.id,price:card.price,reason:'detail_error',error:String(error)})}
    finally{
      const rejection=[...rejected].reverse().find(row=>row.id===card.id);
      const inspectedImageMismatch=['collectible_variant_image_unconfirmed','primary_variant_unconfirmed','physical_image_unconfirmed','lottery_series_unconfirmed'].includes(rejection?.reason)&&Number.isFinite(currentPrimaryImageScore);
      const incompleteRead=/unavailable|error/.test(rejection?.reason||'')||/unconfirmed/.test(rejection?.reason||'')&&!inspectedImageMismatch;
      if(currentDetailRead&&!incompleteRead)detailQueue?.record(card);
    }
  }

  competitors.sort((a,b)=>a.price-b.price);
  const own={id:item.id,url:item.url||item.ownUrl,title:item.title,image:item.image,price:Number(item.ownPrice),titleScore:1,imageScore:1,isOwn:true};
  const comparable=[own,...competitors].filter(x=>Number.isFinite(x.price)).sort((a,b)=>a.price-b.price);
  const lowest=comparable[0]||null;
  const unresolvedCandidates=unresolvedRaiseCandidates(preliminary,rejected);
  const checkedIds=new Set([...competitors,...rejected].map(candidate=>candidate.id));
  const provisionalFloor=lowest&&!lowest.isOwn?Number(lowest.price):Number(item.ownPrice);
  const uncheckedLowerCandidates=preliminary.filter(candidate=>Number(candidate.price)<provisionalFloor&&!checkedIds.has(candidate.id));
  const market=marketPriceDecision(item.ownPrice,competitors,settings,{plausibleCompetitors:unresolvedCandidates,ownSellerId});
  const {marketPrices,marketMedianPrice,marketMinPrice,marketMaxPrice,underpriced}=market;
  const reviewReasons=new Set(['detail_price_unavailable','primary_variant_unconfirmed','sale_description_unavailable','collectible_variant_image_unconfirmed','lottery_series_unconfirmed','physical_image_unconfirmed','detail_error']);
  const pendingReviews=rejected.filter(candidate=>reviewReasons.has(candidate.reason));
  const unconfirmedLowerCandidates=rejected.filter(candidate=>reviewReasons.has(candidate.reason)&&Number(candidate.price)<Number(item.ownPrice));
  const verificationIncomplete=knownOnly||Boolean(broadSearchDue&&!search)||uncheckedLowerCandidates.length>0||unconfirmedLowerCandidates.length>0||!competitors.length&&pendingReviews.length>0||!ownDetail?.description?.trim();
  const recommended=verificationIncomplete?Number(item.ownPrice):lowest&&!lowest.isOwn?Math.max(1,Math.floor(lowest.price)-1):market.recommendedPrice;
  const sourceCovered=Boolean(search||ownBundle);
  const matchLabel=verificationIncomplete?'存在待核验候选或详情缺失，暂不改价':lowest&&!lowest.isOwn?'已核验在售同款':underpriced?'与下一家同款存在提价空间':competitors.length?'已核验同款，你当前最低':'未发现同款';
  return {
    rulesVersion:MATCHING_RULES_VERSION,
    query,searchUrl,lowestPrice:lowest?.price??item.ownPrice,lowestUrl:lowest?.url??item.url,
    ...(knownOnly?{evidenceStatus:'incomplete',searchComplete:false,ownObservedPrice:item.ownPrice,knownRefresh:{mode:'details_only',reason:competitors.length?'verified_known_offers':'no_verified_known_offer'}}:{}),
    recommendedPrice:recommended,candidates:competitors.slice(0,5),cardCount:cards.length,
    detailQueue:knownOnly?item.yahoo?.detailQueue:detailQueue?.snapshot(),
    searchCardCount:searchCards.length,recommendationCardCount:recommendationCards.length,
    preliminaryCount:preliminary.length,unresolvedCandidateCount:unresolvedCandidates.length,uncheckedLowerCandidateCount:uncheckedLowerCandidates.length,unconfirmedLowerCandidateCount:unconfirmedLowerCandidates.length,detailCheckedCount,rejected:rejected.slice(-30),
    competitorCount:competitors.length,status:verificationIncomplete?'incomplete':'ok',comparisonStatus:verificationIncomplete?'verification_incomplete':lowest?.isOwn?(underpriced?'underpriced':'no_lower_found'):'competitor_lower',
    marketSampleCount:marketPrices.length,marketMedianPrice,marketMinPrice,marketMaxPrice,underpriced,
    verifiedMinPrice:market.verifiedMinPrice,plausibleMinPrice:market.plausibleMinPrice,
    raiseGuardMinPrice:market.raiseGuardMinPrice,raiseRoomJPY:market.raiseRoomJPY,ownIsDefiniteLowest:market.ownIsDefiniteLowest,
    matchLabel,matchConfidence:competitors.length?'高':sourceCovered?'覆盖检查':'需复核',checkedAt:new Date().toISOString(),ownImages:[...new Set(ownImages)].slice(0,8),
    audit:{ownItemId:item.id,accountId:item.accountId||null,ownDetailLoaded:Boolean(ownDetail?.description?.trim()),rulesVersion:MATCHING_RULES_VERSION,knownRecheckIds:knownCards.slice(0,recheckLimit).map(card=>card.id)},
    ownDescription:ownDetail?.description||item.yahoo?.ownDescription||'',ownCategory,
    ownListedAt:ownDetail?.openDate||null,ownListingId:item.id,
    searchCheckedAt:search?searchObservedAt:(item.yahoo?.searchCheckedAt||null),
    sourceStatus:{search:knownOnly?'not_requested_known_refresh':search?'ok':broadSearchDue?'error':'rotating_cache',itemPage:ownBundle?'ok':'error'},searchError,itemPageError
  };
}

export function marketPriceDecision(ownPrice,prices=[],settings={},safeguards={}){
  const unique=new Map();
  const ownSellerId=String(safeguards.ownSellerId||'').trim();
  prices.forEach((value,index)=>{
    const sample=typeof value==='object'&&value?value:{price:value};
    if(ownSellerId&&sample.platform!=='rakuma'&&sample.sellerId===ownSellerId)return;
    const platform=sample.platform||'yahoo';
    const price=Number(sample.price),key=sample.sellerId?`${platform}:seller:${sample.sellerId}`:sample.id?`${platform}:item:${sample.id}`:`${platform}:sample:${index}`;
    if(!Number.isFinite(price))return;
    const current=unique.get(key);if(!current||price<current.price)unique.set(key,{...sample,price});
  });
  const raw=[...unique.values()].sort((a,b)=>a.price-b.price);
  const verifiedMinPrice=raw[0]?.price??null;
  const plausiblePrices=(safeguards.plausibleCompetitors||[])
    .filter(value=>!ownSellerId||typeof value!=='object'||!value||value.platform==='rakuma'||value.sellerId!==ownSellerId)
    .map(value=>Number(typeof value==='object'&&value?value.price:value)).filter(Number.isFinite);
  const plausibleMinPrice=plausiblePrices.length?Math.min(...plausiblePrices):null;
  const guardPrices=[verifiedMinPrice,plausibleMinPrice].filter(Number.isFinite);
  const raiseGuardMinPrice=guardPrices.length?Math.min(...guardPrices):null;
  const ownIsDefiniteLowest=Number.isFinite(raiseGuardMinPrice)&&Number(ownPrice)<raiseGuardMinPrice;
  const coherent=coherentPrices(raw);
  const marketSamples=coherent.length>=2?coherent:raw;
  const marketPrices=marketSamples.map(sample=>sample.price).sort((a,b)=>a-b);
  const middle=Math.floor(marketPrices.length/2);
  const marketMedianPrice=!marketPrices.length?null:marketPrices.length%2?marketPrices[middle]:(marketPrices[middle-1]+marketPrices[middle])/2;
  const marketMinPrice=marketPrices[0]??null,marketMaxPrice=marketPrices.at(-1)??null;
  const underpriceGap=Math.max(500,Number(settings.yahooUnderpriceMinimumGapJPY)||1500);
  const minimumRaiseRatio=Math.max(0,Number(settings.minimumRaiseGapRatio)||.03);
  const maxSpreadRatio=Math.max(1.05,Math.min(2,Number(settings.yahooMarketMaxSpreadRatio)||1.35));
  const marketSpreadOk=Number.isFinite(marketMinPrice)&&marketMinPrice>0&&Number.isFinite(marketMaxPrice)&&marketMaxPrice/marketMinPrice<=maxSpreadRatio;
  const raiseRoomJPY=Number.isFinite(raiseGuardMinPrice)?raiseGuardMinPrice-Number(ownPrice):null;
  // The next available same offer, not a high-price median, sets the opportunity.
  // A single *detail-verified* seller is a limited-sample reference, not a market median.
  const singleVerified=raw.length===1&&Boolean(raw[0].matchMethod)&&Boolean(raw[0].url);
  const underpriced=(coherent.length>=2&&marketSpreadOk||singleVerified)&&ownIsDefiniteLowest&&
    Number.isFinite(raiseRoomJPY)&&raiseRoomJPY>=underpriceGap&&
    raiseRoomJPY/Math.max(1,Number(ownPrice))>=minimumRaiseRatio;
  return {marketPrices,marketMedianPrice,marketMinPrice,marketMaxPrice,verifiedMinPrice,plausibleMinPrice,raiseGuardMinPrice,
    ownIsDefiniteLowest,raiseRoomJPY,marketSpreadOk,underpriced,singleVerified,
    recommendedPrice:underpriced&&Number.isFinite(raiseGuardMinPrice)?Math.max(Number(ownPrice),Math.floor(raiseGuardMinPrice)-1):Number(ownPrice)};
}
