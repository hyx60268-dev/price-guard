import { cardsFromPage,settle } from './browser.mjs';
import { coherentIndependentImages,imageFingerprints,imageSetSimilarity } from './image.mjs';
import { coherentPrices,conditionCompatible,hasExplicitDefect,hasVariantMismatch,isLikelyVariantOffer,isRejected,productFamily,semanticSameItem,titleScore,yen } from './rules.mjs';

async function mapLimit(values,limit,worker){
  const output=new Array(values.length);let cursor=0;
  async function run(){while(true){const index=cursor++;if(index>=values.length)return;output[index]=await worker(values[index],index)}}
  await Promise.all(Array.from({length:Math.min(limit,values.length)},run));return output;
}

// 闲鱼搜索卡片的价格节点有时只有数字，没有 ￥ 符号；正文里还会混有
// “10 人想要”等数字。因此优先解析专用价格节点，只有节点缺失时才回退正文。
function cardPrice(card={}){
  const explicit=yen(card.priceText)||yen(card.text);
  if(Number.isFinite(explicit))return explicit;
  const plain=String(card.priceText||'').replaceAll(',','').match(/(?:^|\s)(\d+(?:\.\d{1,2})?)(?:\s|$)/);
  return plain?Number(plain[1]):null;
}

async function verifyDetail(context,candidate,item,settings,ownFingerprints){
  const query=item.xianyuQuery||item.title||'';
  const detail=await context.newPage();
  try{
    await detail.goto(candidate.url,{waitUntil:'domcontentloaded',timeout:25000});
    await settle(detail,Math.max(900,Math.min(1600,settings.scanDelayMs||1200)));
    const state=await detail.evaluate(()=>{
      const visible=element=>{const style=getComputedStyle(element),rect=element.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0};
      const root=document.querySelector('main')||document.body;
      const text=(root?.innerText||'').replace(/\s+/g,' ').slice(0,6500);
      const visibleTitles=[...root.querySelectorAll('h1,h2,[class*="itemTitle" i],[class*="title" i]')]
        .filter(visible).filter(element=>element.getBoundingClientRect().top<1200).map(element=>element.innerText||element.getAttribute('title')||'');
      const titleCandidates=[document.querySelector('meta[property="og:title"]')?.content,...visibleTitles,document.title?.replace(/[-|_].*闲鱼.*$/,'')]
        .filter(Boolean).map(value=>value.replace(/\s+/g,' ').trim()).filter(value=>value.length>=3&&value.length<=300);
      const optionNodes=[...root.querySelectorAll('[role="radio"], [class*="sku" i] button, [class*="spec" i] button, [class*="variant" i] button')].filter(visible);
      const ogImage=document.querySelector('meta[property="og:image"]')?.content;
      const images=[ogImage,...[...root.querySelectorAll('img')].filter(visible).filter(image=>{
        const rect=image.getBoundingClientRect();return rect.top<1400&&(image.naturalWidth>=120||rect.width>=120)&&(image.naturalHeight>=120||rect.height>=120);
      }).map(image=>image.currentSrc||image.src).filter(Boolean)];
      const blocked=/访问频繁|安全验证|滑块|验证码|请稍后重试|被挤爆/.test(text);
      const loginVisible=[...document.querySelectorAll('iframe[src*="login"], [class*="login" i]')].some(visible);
      const sellerLink=[...root.querySelectorAll('a[href*="/personal"],a[href*="/user"],a[href*="seller"]')].find(visible);
      const sellerUrl=sellerLink?.href||'',sellerName=(sellerLink?.innerText||sellerLink?.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim();
      return {text,titles:[...new Set(titleCandidates)].slice(0,30),images:[...new Set(images.filter(Boolean))].slice(0,16),optionCount:optionNodes.length,blocked,loginVisible,sellerUrl,sellerName};
    }).catch(()=>({text:'',titles:[],images:[],optionCount:0,blocked:false,loginVisible:false}));
    if(state.blocked)return {accepted:false,reason:'detail_blocked'};
    if(state.loginVisible||/login|signin/i.test(detail.url()))return {accepted:false,reason:'detail_login_required'};
    if(state.text.length<80)return {accepted:false,reason:'detail_unreadable'};
    const ranked=(state.titles||[]).map(title=>({title,score:titleScore(query,title)})).sort((a,b)=>b.score-a.score);
    const detailTitle=ranked[0]?.title||candidate.title||'',titleMatch=ranked[0]?.score??titleScore(query,candidate.title);
    if(hasVariantMismatch(query,detailTitle)||hasExplicitDefect(detailTitle,state.text))return {accepted:false,reason:'detail_variant_or_defect',detailTitle};
    if(state.optionCount>1||isLikelyVariantOffer(`${candidate.text} ${state.text}`,query))return {accepted:false,reason:'multi_variant_or_bait',detailTitle,optionCount:state.optionCount};
    if(!conditionCompatible(item.title||query,`${detailTitle}\n${state.text}`))return {accepted:false,reason:'condition_or_packaging_mismatch',detailTitle};
    const queryFamily=productFamily(query),candidateFamily=productFamily(`${detailTitle}\n${state.text}`);
    if(queryFamily&&candidateFamily!==queryFamily)return {accepted:false,reason:'physical_product_type_unconfirmed',detailTitle,queryFamily,candidateFamily};
    const semantic=semanticSameItem({query,candidate:`${detailTitle}\n${state.text}`});
    const bodyMatch=titleScore(query,state.text);
    const detailFingerprints=(await mapLimit(state.images.slice(0,8),3,imageFingerprints)).filter(Boolean);
    const allCandidateImages=[candidate.fingerprint,...detailFingerprints].filter(Boolean);
    const imageScore=imageSetSimilarity(ownFingerprints,allCandidateImages);
    const independentImages=coherentIndependentImages(detailFingerprints,ownFingerprints,3);
    const textStrong=semantic.accepted&&(titleMatch>=.74||(titleMatch>=.52&&bodyMatch>=.82));
    // 同一商品经常由不同卖家重新拍摄，不能强制像素近似。图片一致，或标题、
    // 正文和商品类别三方面均强一致，都可以进入多卖家价格聚类。
    const visualStrong=ownFingerprints.length?Number.isFinite(imageScore)&&imageScore>=.70:titleMatch>=.88;
    const textualIdentityStrong=semantic.accepted&&titleMatch>=.78&&bodyMatch>=.80&&(!queryFamily||candidateFamily===queryFamily);
    if(!textStrong||!(visualStrong||textualIdentityStrong))return {accepted:false,reason:!textStrong?'detail_title_mismatch':'detail_identity_unconfirmed',detailTitle,titleMatch,bodyMatch,imageScore};
    const sellerKey=state.sellerUrl||state.sellerName||'';
    return {accepted:true,reason:'detail_type_quantity_text_images_verified',detailTitle,titleMatch,bodyMatch,imageScore,optionCount:state.optionCount,semantic,queryFamily,candidateFamily,sellerKey,
      detailImages:state.images.slice(0,6),independentImages,imageSource:'xianyu'};
  }catch(error){return {accepted:false,reason:'detail_error',error:String(error)}}
  finally{await detail.close().catch(()=>{})}
}

export async function xianyuCost(page,item,settings){
  const query=item.xianyuQuery||item.title||'';
  if(!query)return {query,status:'missing_query',samples:[],averageCNY:null};
  const compact=value=>String(value).replace(/(?:中国限定|海外限定|正規品|正规品|新品|未使用|未開封|即日発送|匿名配送|送料無料)/gi,' ').replace(/\s+/g,' ').trim();
  const simplified=compact(query);
  const withoutSeries=simplified.replace(/[^\s]{1,16}(?:系列|シリーズ)/gi,' ').replace(/\s+/g,' ').trim();
  const short=withoutSeries.split(' ').filter(token=>token.length>1).slice(0,6).join(' ');
  const searchQueries=[...new Set([query,simplified,withoutSeries,short].filter(value=>value&&value.length>=3))];
  let cards=[],pageState={loginVisible:false,blocked:false,snippet:''},usedQuery=query,url='';
  for(const candidateQuery of searchQueries){
    usedQuery=candidateQuery;url=`https://www.goofish.com/search?q=${encodeURIComponent(candidateQuery)}`;
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:35000});await settle(page,Math.max(2500,settings.scanDelayMs||1200));
    await page.waitForSelector('a[href*="/item?id="], a[href*="/item/"]',{timeout:6000}).catch(()=>{});
    cards=await cardsFromPage(page,'xianyu');
    pageState=await page.evaluate(()=>{
    const visible=element=>{const style=getComputedStyle(element),rect=element.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0};
    const text=(document.body?.innerText||'').replace(/\s+/g,' ');
    const loginVisible=[...document.querySelectorAll('iframe[src*="login"], [class*="login" i]')].some(visible);
    return {loginVisible,noResults:/没有找到你想要的宝贝|减少筛选内容试试/.test(text),blocked:/访问频繁|安全验证|滑块|验证码|请稍后重试|被挤爆/.test(text),snippet:text.slice(0,180)};
    }).catch(()=>({loginVisible:false,blocked:false,snippet:''}));
    // 闲鱼无搜索结果时仍会在“猜你喜欢”下返回约20个完全无关的链接。
    // 这些链接不能算搜索候选，否则系统会看似扫描成功却永远得不到成本。
    if(pageState.noResults)cards=[];
    if(cards.length||pageState.blocked)break;
  }
  const cardCount=cards.length;
  if(!cardCount&&pageState.blocked)return {query,searchUrl:url,status:'blocked',samples:[],averageCNY:null,cardCount,diagnostic:pageState.snippet};
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
  const checks=await mapLimit(preliminary.slice(0,limit),2,candidate=>verifyDetail(page.context(),candidate,item,settings,ownFingerprints));
  const verified=[],rejected=[];
  checks.forEach((check,index)=>{
    const candidate=preliminary[index];
    if(check.accepted)verified.push({...candidate,...check,fingerprint:undefined});
    else rejected.push({url:candidate.url,title:candidate.title,price:candidate.price,reason:check.reason,titleMatch:check.titleMatch,imageScore:check.imageScore});
  });
  const coherent=coherentPrices(verified).slice(0,settings.maxXianyuSamples||5);
  const prices=coherent.map(sample=>sample.price).sort((a,b)=>a-b),middle=Math.floor(prices.length/2);
  const referenceCNY=prices.length?(prices.length%2?prices[middle]:(prices[middle-1]+prices[middle])/2):null;
  const sellerCount=new Set(coherent.map(sample=>sample.sellerKey).filter(Boolean)).size;
  const sellerEvidence=sellerCount>=2||coherent.length>=3;
  const priceSpread=prices.length>=2?(prices.at(-1)-prices[0])/Math.max(1,prices[middle]):Infinity;
  const status=coherent.length>=2&&sellerEvidence&&priceSpread<=.30?'ok':cardCount?'manual_review':'page_empty';
  return {query,usedQuery,searchAttempts:searchQueries.length,searchUrl:url,status,samples:coherent,averageCNY:status==='ok'?referenceCNY:null,cardCount,
    loginVisible:pageState.loginVisible,preliminaryCount:preliminary.length,verifiedCount:verified.length,rejected:rejected.slice(0,12),
    pricedCardCount:eligible.length,unpricedCardCount:priced.length-eligible.length,
    topCandidates:ranked.slice(0,5).map(card=>({title:card.title.slice(0,120),titleScore:Number(card.titleScore.toFixed(3)),imageScore:Number.isFinite(card.imageScore)?Number(card.imageScore.toFixed(3)):null,price:card.price})),
    sellerCount,priceSpread,
    verification:'detail_text_images_price_cluster_v4',checkedAt:new Date().toISOString(),method:'verified_detail_median_multi_image'};
}
