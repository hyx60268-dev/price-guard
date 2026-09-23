import { cardsFromPage,settle } from './browser.mjs';
import { coherentIndependentImages,imageFingerprints,imageSetSimilarity } from './image.mjs';
import { coherentPrices,collectibleIdentityRequiresVisualProof,conditionCompatible,hasExplicitDefect,hasExplicitVariantMismatch,hasVariantMismatch,isLikelyVariantOffer,productFamily,saleUnitEquivalent,semanticQuantity,semanticSameItem,titleScore,yen } from './rules.mjs';
import { xianyuQueryFor } from './discovery.mjs';
import { detailStateFailure,readXianyuDetailDOM,verifiedCostEvidence,XIANYU_VERIFICATION } from './xianyu-evidence.mjs';

async function mapLimit(values,limit,worker){
  const output=new Array(values.length);let cursor=0;
  async function run(){while(true){const index=cursor++;if(index>=values.length)return;output[index]=await worker(values[index],index)}}
  await Promise.all(Array.from({length:Math.min(limit,values.length)},run));return output;
}

const transientNavigationError=error=>/ERR_(?:NETWORK_IO_SUSPENDED|NETWORK_CHANGED|INTERNET_DISCONNECTED|CONNECTION_RESET|CONNECTION_CLOSED|TIMED_OUT)|Navigation timeout|Target page, context or browser has been closed/i.test(String(error?.message||error));

async function gotoWithRetry(page,url,options={},attempts=3){
  let lastError;
  for(let attempt=1;attempt<=attempts;attempt++){
    try{return await page.goto(url,options)}catch(error){
      lastError=error;
      if(!transientNavigationError(error)||attempt===attempts)throw error;
      await page.waitForTimeout(800*attempt).catch(()=>{});
      await page.goto('about:blank',{waitUntil:'commit',timeout:5000}).catch(()=>{});
    }
  }
  throw lastError;
}

// 闲鱼搜索卡片的价格节点有时只有数字，没有 ￥ 符号；正文里还会混有
// “10 人想要”等数字。因此优先解析专用价格节点，只有节点缺失时才回退正文。
function cardPrice(card={}){
  const explicit=yen(card.priceText);
  if(Number.isFinite(explicit))return explicit;
  const plain=String(card.priceText||'').replaceAll(',','').match(/(?:^|\s)(\d+(?:\.\d{1,2})?)(?:\s|$)/);
  return plain?Number(plain[1]):yen(card.text);
}

async function verifyDetail(context,candidate,item,settings,ownFingerprints){
  const query=item.xianyuQuery||xianyuQueryFor(item.title||'');
  const detail=await context.newPage();
  try{
    await gotoWithRetry(detail,candidate.url,{waitUntil:'domcontentloaded',timeout:25000});
    await settle(detail,Math.max(900,Math.min(1600,settings.scanDelayMs||1200)));
    let state={};
    for(let attempt=0;attempt<5;attempt++){
      state=await detail.evaluate(readXianyuDetailDOM);
      if(state.blocked||state.loginVisible||!detailStateFailure(state))break;
      if(attempt<4)await detail.waitForTimeout(2000);
    }
    const failure=detailStateFailure(state);
    if(failure)return {accepted:false,reason:failure};
    const ranked=(state.titles||[]).map(title=>({title,score:titleScore(query,title)})).sort((a,b)=>b.score-a.score);
    const detailTitle=ranked[0]?.title||'';
    // 闲鱼会把商品说明、推荐标签和同系列角色拼进 og:title/card 文本。
    // 规格冲突只能看商品标题头，不能把后面的关联词误判为“另一款”。
    const identityTitle=String(detailTitle)
      .split(/【(?:商品信息|商品状态|成色|包装|配送|温馨提示|提醒)】|(?:商品信息|商品状态|成色|包装|配送方式)[:：]/)[0]
      .replace(/\s+/g,' ').trim().slice(0,220)||String(candidate.title||'').slice(0,220);
    const titleMatch=titleScore(query,identityTitle);
    const queryQuantity=semanticQuantity(query),candidateQuantity=semanticQuantity(identityTitle);
    const quantityMismatch=Number.isFinite(queryQuantity)&&Number.isFinite(candidateQuantity)&&queryQuantity!==candidateQuantity||
      Number.isFinite(candidateQuantity)&&candidateQuantity>1&&!Number.isFinite(queryQuantity)||
      Number.isFinite(queryQuantity)&&queryQuantity>1&&!Number.isFinite(candidateQuantity);
    // 通用标题规则会把卖家的包邮、尺寸、活动说明当成“另一款”固有名。
    // 中文标题已覆盖大部分商品锚点时，只保留明确数量冲突；多款/选款仍在下一关拦截。
    const variantMismatch=quantityMismatch||!saleUnitEquivalent(query,identityTitle)||
      hasExplicitVariantMismatch(query,identityTitle)||hasExplicitVariantMismatch(identityTitle,query)||
      (hasVariantMismatch(query,identityTitle)&&titleMatch<.62);
    const explicitDefect=hasExplicitDefect(identityTitle,state.text);
    if(variantMismatch||explicitDefect)return {accepted:false,reason:variantMismatch?'detail_variant_mismatch':'detail_explicit_defect',detailTitle:identityTitle,titleMatch,queryQuantity,candidateQuantity};
    if(state.optionCount>1||isLikelyVariantOffer(`${candidate.text} ${state.text}`,query))return {accepted:false,reason:'multi_variant_or_bait',detailTitle:identityTitle,titleMatch,optionCount:state.optionCount};
    if(!conditionCompatible(item.title||query,`${identityTitle}\n${state.text}`))return {accepted:false,reason:'condition_or_packaging_mismatch',detailTitle:identityTitle,titleMatch};
    const queryFamily=productFamily(query),candidateFamily=productFamily(`${identityTitle}\n${state.text}`);
    if(queryFamily&&candidateFamily!==queryFamily)return {accepted:false,reason:'physical_product_type_unconfirmed',detailTitle:identityTitle,titleMatch,queryFamily,candidateFamily};
    const semantic=semanticSameItem({query,candidate:`${identityTitle}\n${state.text}`});
    const bodyMatch=titleScore(query,state.text);
    const detailFingerprints=(await mapLimit(state.images.slice(0,8),3,imageFingerprints)).filter(Boolean);
    const imageScore=imageSetSimilarity(ownFingerprints,detailFingerprints);
    const independentImages=coherentIndependentImages(detailFingerprints,ownFingerprints,3);
    const textStrong=semantic.accepted&&(titleMatch>=.74||(titleMatch>=.52&&bodyMatch>=.82));
    // 同一商品经常由不同卖家重新拍摄，不能强制像素近似。图片一致，或标题、
    // 正文和商品类别三方面均强一致，都可以进入多卖家价格聚类。
    const visualStrong=ownFingerprints.length?Number.isFinite(imageScore)&&imageScore>=.70:titleMatch>=.88;
    const textualIdentityStrong=semantic.accepted&&titleMatch>=.78&&bodyMatch>=.80&&(!queryFamily||candidateFamily===queryFamily);
    if(collectibleIdentityRequiresVisualProof(query,identityTitle)&&!(imageScore>=.86))return {accepted:false,reason:'detail_variant_image_unconfirmed',detailTitle:identityTitle,titleMatch,bodyMatch,imageScore};
    if(!textStrong||!(visualStrong||textualIdentityStrong))return {accepted:false,reason:!textStrong?'detail_title_mismatch':'detail_identity_unconfirmed',detailTitle:identityTitle,titleMatch,bodyMatch,imageScore,semanticReason:semantic.reason};
    const sellerKey=state.sellerKey;
    return {accepted:true,reason:'detail_type_quantity_text_images_verified',price:state.price,priceSource:'target_detail',detailTitle:identityTitle,titleMatch,bodyMatch,imageScore,optionCount:state.optionCount,semantic,queryFamily,candidateFamily,sellerKey,
      detailImages:state.images.slice(0,6),independentImages,imageSource:'xianyu'};
  }catch(error){return {accepted:false,reason:'detail_error',error:String(error)}}
  finally{await detail.close().catch(()=>{})}
}

export async function xianyuCost(page,item,settings){
  const query=item.xianyuQuery||xianyuQueryFor(item.title||'');
  if(!query)return {query,status:'missing_query',samples:[],averageCNY:null};
  const compact=value=>String(value).replace(/(?:中国限定|海外限定|正規品|正规品|新品|未使用|未開封|即日発送|匿名配送|送料無料)/gi,' ').replace(/\s+/g,' ').trim();
  const simplified=compact(query);
  const withoutSeries=simplified.replace(/[^\s]{1,16}(?:系列|シリーズ)/gi,' ').replace(/\s+/g,' ').trim();
  const short=withoutSeries.split(' ').filter(token=>token.length>1).slice(0,6).join(' ');
  const searchQueries=[...new Set([query,simplified,withoutSeries,short].filter(value=>value&&value.length>=3))];
  let cards=[],pageState={loginVisible:false,blocked:false,snippet:''},usedQuery=query,url='',searchAttempts=0;
  for(const candidateQuery of searchQueries){
    searchAttempts++;
    usedQuery=candidateQuery;url=`https://www.goofish.com/search?q=${encodeURIComponent(candidateQuery)}`;
    await gotoWithRetry(page,url,{waitUntil:'domcontentloaded',timeout:35000});await settle(page,Math.max(2500,settings.scanDelayMs||1200));
    await page.waitForSelector('a[href*="/item?id="], a[href*="/item/"]',{timeout:6000}).catch(()=>{});
    cards=await cardsFromPage(page,'xianyu');
    pageState=await page.evaluate(()=>{
    const visible=element=>{const style=getComputedStyle(element),rect=element.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0};
    const text=(document.body?.innerText||'').replace(/\s+/g,' ');
    const loginVisible=[...document.querySelectorAll('iframe[src*="login"], [class*="login" i]')].some(visible);
    const challenge=[...document.querySelectorAll('iframe')].some(frame=>visible(frame)&&/baxia|captcha|_____tmd_____|\/punish/i.test(`${frame.id} ${frame.getAttribute('src')||''}`));
    return {loginVisible,noResults:/没有找到你想要的宝贝|减少筛选内容试试/.test(text),blocked:challenge||/访问频繁|安全验证|滑块|验证码|请稍后重试|被挤爆/.test(text),snippet:text.slice(0,180)};
    }).catch(()=>({loginVisible:false,blocked:false,snippet:''}));
    // 闲鱼无搜索结果时仍会在“猜你喜欢”下返回约20个完全无关的链接。
    // 这些链接不能算搜索候选，否则系统会看似扫描成功却永远得不到成本。
    if(pageState.noResults)cards=[];
    if(cards.length||pageState.blocked||pageState.loginVisible)break;
  }
  const cardCount=cards.length;
  if(pageState.blocked)return {query,searchUrl:url,status:'blocked',samples:[],averageCNY:null,cardCount,diagnostic:'搜索页安全验证，未采用推荐商品'};
  if(!cardCount&&(pageState.loginVisible||/login|signin/i.test(page.url())))return {query,searchUrl:url,status:'login_required',samples:[],averageCNY:null,cardCount,diagnostic:pageState.snippet};

  const ownUrls=[...(item.yahoo?.ownImages||[]),...(item.images||[]),item.image].filter(Boolean).slice(0,5);
  const ownFingerprints=(await mapLimit([...new Set(ownUrls)],3,imageFingerprints)).filter(Boolean);
  // 搜索卡片文字经常包含平台推荐词、系列名和不完整规格。旧逻辑在打开详情
  // 之前就用这些噪声判定规格，导致 20～30 张卡片全部被清空。首轮只解析
  // 价格；多规格、瑕疵、数量、正文和图片全部在详情页严格核验。
  const priced=cards.slice(0,30).map(card=>({...card,price:cardPrice(card)}));
  const eligible=priced.filter(card=>Number.isFinite(card.price)&&card.price>1);
  const scored=await mapLimit(eligible,4,async card=>{
    const titleMatch=titleScore(query,card.title),fingerprint=card.image?await imageFingerprints(card.image):null;
    const imageScore=imageSetSimilarity(ownFingerprints,[fingerprint]);
    return {...card,titleScore:titleMatch,imageScore,fingerprint};
  });
  const limit=Math.max(2,Number(settings.maxXianyuDetailChecks)||6);
  // Search ranking is useful evidence, but never final same-item evidence.  The
  // old .82 title gate rejected every Chinese result when the source title was
  // partly Japanese, so no detail page was ever opened.  Send the best search
  // results to the strict detail verifier instead; only verified details can
  // contribute a cost.
  const ranked=scored.sort((a,b)=>Math.max(b.imageScore??0,b.titleScore)-Math.max(a.imageScore??0,a.titleScore)||a.price-b.price);
  const signalled=ranked.filter(card=>card.titleScore>=.18||card.imageScore>=.52);
  const preliminary=(signalled.length?signalled:ranked).slice(0,limit);
  const checks=[];
  for(const candidate of preliminary){
    const check=await verifyDetail(page.context(),candidate,item,settings,ownFingerprints);checks.push(check);
    if(['detail_blocked','detail_login_required'].includes(check.reason))break;
  }
  const verified=[],rejected=[];
  checks.forEach((check,index)=>{
    const candidate=preliminary[index];
    if(check.accepted)verified.push({...candidate,...check,fingerprint:undefined});
    else rejected.push({url:candidate.url,title:candidate.title,price:candidate.price,reason:check.reason,detailTitle:check.detailTitle,titleMatch:check.titleMatch,bodyMatch:check.bodyMatch,imageScore:check.imageScore,semanticReason:check.semanticReason,error:check.error});
  });
  const evidence=verifiedCostEvidence(coherentPrices(verified).slice(0,settings.maxXianyuSamples||5));
  const {samples:coherent,sellerCount,priceSpread,median:referenceCNY}=evidence;
  const status=checks.some(check=>check.reason==='detail_blocked')?'blocked':checks.some(check=>check.reason==='detail_login_required')?'login_required':evidence.ready?'ok':cardCount?'manual_review':'page_empty';
  return {query,usedQuery,searchAttempts,searchUrl:url,status,samples:coherent,averageCNY:status==='ok'?referenceCNY:null,cardCount,
    detailCheckedCount:checks.length,diagnostic:status==='blocked'?'目标详情触发安全验证；已停止本轮闲鱼检查':status==='login_required'?'目标详情要求登录；已停止本轮闲鱼检查':null,
    loginVisible:pageState.loginVisible,preliminaryCount:preliminary.length,verifiedCount:verified.length,rejected:rejected.slice(0,12),
    pricedCardCount:eligible.length,unpricedCardCount:priced.length-eligible.length,
    topCandidates:ranked.slice(0,5).map(card=>({title:card.title.slice(0,120),titleScore:Number(card.titleScore.toFixed(3)),imageScore:Number.isFinite(card.imageScore)?Number(card.imageScore.toFixed(3)):null,price:card.price})),
    sellerCount,priceSpread,
    verification:XIANYU_VERIFICATION,checkedAt:new Date().toISOString(),method:'verified_detail_median_multi_image'};
}
