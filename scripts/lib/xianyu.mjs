import { cardsFromPage,settle } from './browser.mjs';
import { coherentIndependentImages,imageFingerprints,imageSetSimilarity } from './image.mjs';
import { coherentPrices,conditionCompatible,hasExplicitDefect,hasVariantMismatch,isLikelyVariantOffer,isRejected,productFamily,semanticSameItem,titleScore,yen } from './rules.mjs';

async function mapLimit(values,limit,worker){
  const output=new Array(values.length);let cursor=0;
  async function run(){while(true){const index=cursor++;if(index>=values.length)return;output[index]=await worker(values[index],index)}}
  await Promise.all(Array.from({length:Math.min(limit,values.length)},run));return output;
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
    const visualStrong=ownFingerprints.length?Number.isFinite(imageScore)&&imageScore>=.70:titleMatch>=.88;
    if(!textStrong||!visualStrong)return {accepted:false,reason:!textStrong?'detail_title_mismatch':'detail_image_mismatch',detailTitle,titleMatch,bodyMatch,imageScore};
    const sellerKey=state.sellerUrl||state.sellerName||'';
    return {accepted:true,reason:'detail_type_quantity_text_images_verified',detailTitle,titleMatch,bodyMatch,imageScore,optionCount:state.optionCount,semantic,queryFamily,candidateFamily,sellerKey,
      detailImages:state.images.slice(0,6),independentImages,imageSource:'xianyu'};
  }catch(error){return {accepted:false,reason:'detail_error',error:String(error)}}
  finally{await detail.close().catch(()=>{})}
}

export async function xianyuCost(page,item,settings){
  const query=item.xianyuQuery||item.title||'';
  if(!query)return {query,status:'missing_query',samples:[],averageCNY:null};
  const url=`https://www.goofish.com/search?q=${encodeURIComponent(query)}`;
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:35000});await settle(page,Math.max(2500,settings.scanDelayMs||1200));
  await page.waitForSelector('a[href*="/item?id="], a[href*="/item/"]',{timeout:6000}).catch(()=>{});
  const cards=await cardsFromPage(page,'xianyu'),cardCount=cards.length;
  const pageState=await page.evaluate(()=>{
    const visible=element=>{const style=getComputedStyle(element),rect=element.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0};
    const text=(document.body?.innerText||'').replace(/\s+/g,' ');
    const loginVisible=[...document.querySelectorAll('iframe[src*="login"], [class*="login" i]')].some(visible);
    return {loginVisible,blocked:/访问频繁|安全验证|滑块|验证码|请稍后重试|被挤爆/.test(text),snippet:text.slice(0,180)};
  }).catch(()=>({loginVisible:false,blocked:false,snippet:''}));
  if(!cardCount&&pageState.blocked)return {query,searchUrl:url,status:'blocked',samples:[],averageCNY:null,cardCount,diagnostic:pageState.snippet};
  if(!cardCount&&(pageState.loginVisible||/login|signin/i.test(page.url())))return {query,searchUrl:url,status:'login_required',samples:[],averageCNY:null,cardCount,diagnostic:pageState.snippet};

  const ownUrls=[...(item.yahoo?.ownImages||[]),...(item.images||[]),item.image].filter(Boolean).slice(0,5);
  const ownFingerprints=(await mapLimit([...new Set(ownUrls)],3,imageFingerprints)).filter(Boolean);
  const eligible=cards.slice(0,30).filter(card=>{
    if(isRejected(card.text)||isLikelyVariantOffer(card.text,query)||hasVariantMismatch(query,card.title))return false;
    card.price=yen(card.text);return Number.isFinite(card.price)&&card.price>1;
  });
  const scored=await mapLimit(eligible,4,async card=>{
    const titleMatch=titleScore(query,card.title),fingerprint=card.image?await imageFingerprints(card.image):null;
    const imageScore=imageSetSimilarity(ownFingerprints,[fingerprint]);
    return {...card,titleScore:titleMatch,imageScore,fingerprint};
  });
  const preliminary=scored.filter(card=>card.titleScore>=.82||(card.titleScore>=.25&&card.imageScore>=.72)||card.imageScore>=.88)
    .sort((a,b)=>(b.imageScore??0)-(a.imageScore??0)||b.titleScore-a.titleScore||a.price-b.price);
  const limit=Math.max(2,Number(settings.maxXianyuDetailChecks)||6);
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
  return {query,searchUrl:url,status,samples:coherent,averageCNY:status==='ok'?referenceCNY:null,cardCount,
    loginVisible:pageState.loginVisible,preliminaryCount:preliminary.length,verifiedCount:verified.length,rejected:rejected.slice(0,12),
    sellerCount,priceSpread,
    verification:'detail_text_images_price_cluster_v3',checkedAt:new Date().toISOString(),method:'verified_detail_median_multi_image'};
}
