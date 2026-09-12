import { cardsFromPage,settle } from './browser.mjs';
import { imageHash,imageSimilarity } from './image.mjs';
import { average,coherentPrices,hasVariantMismatch,isLikelyVariantOffer,isRejected,titleScore,yen } from './rules.mjs';

async function verifyDetail(context,candidate,query,settings){
  const detail=await context.newPage();
  try{
    await detail.goto(candidate.url,{waitUntil:'domcontentloaded',timeout:35000});
    await settle(detail,Math.max(1000,Math.min(1800,settings.scanDelayMs||1800)));
    const state=await detail.evaluate(()=>{
      const visible=element=>{const style=getComputedStyle(element),rect=element.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0};
      const root=document.querySelector('main')||document.body;
      // 页面后部常带“猜你喜欢”，只检查商品主体前段，避免推荐卡片的多款文案污染判断。
      const text=(root?.innerText||'').replace(/\s+/g,' ').slice(0,6000);
      const visibleTitles=[...document.querySelectorAll('h1,h2,[class*="itemTitle" i],[class*="title" i]')]
        .filter(visible).map(element=>element.innerText||element.getAttribute('title')||'');
      const titleCandidates=[document.querySelector('meta[property="og:title"]')?.content,...visibleTitles,document.title?.replace(/[-|_].*闲鱼.*$/,'')]
        .filter(Boolean).map(value=>value.replace(/\s+/g,' ').trim()).filter(value=>value.length>=3&&value.length<=300);
      const optionNodes=[...root.querySelectorAll('[role="radio"], [class*="sku" i] button, [class*="spec" i] button, [class*="variant" i] button')].filter(visible);
      const blocked=/访问频繁|安全验证|滑块|验证码|请稍后重试|被挤爆/.test(text);
      const loginVisible=[...document.querySelectorAll('iframe[src*="login"], [class*="login" i]')].some(visible);
      return {text,titles:[...new Set(titleCandidates)].slice(0,30),optionCount:optionNodes.length,blocked,loginVisible};
    }).catch(()=>({text:'',titles:[],optionCount:0,blocked:false,loginVisible:false}));
    if(state.blocked)return {accepted:false,reason:'detail_blocked'};
    if(state.loginVisible||/login|signin/i.test(detail.url()))return {accepted:false,reason:'detail_login_required'};
    if(state.text.length<80)return {accepted:false,reason:'detail_unreadable'};
    const ranked=(state.titles||[]).map(title=>({title,score:titleScore(query,title)})).sort((a,b)=>b.score-a.score);
    const detailTitle=ranked[0]?.title||'';
    if(!detailTitle||ranked[0].score<.70||hasVariantMismatch(query,detailTitle))return {accepted:false,reason:'detail_title_mismatch',detailTitle};
    if(state.optionCount>1||isLikelyVariantOffer(`${candidate.text} ${state.text}`,query))return {accepted:false,reason:'multi_variant_or_bait',detailTitle,optionCount:state.optionCount};
    return {accepted:true,reason:'detail_verified',detailTitle,optionCount:state.optionCount};
  }catch(error){return {accepted:false,reason:'detail_error',error:String(error)}}
  finally{await detail.close().catch(()=>{})}
}

export async function xianyuCost(page,item,settings){
  const query=item.xianyuQuery||'';
  if(!query)return {query,status:'missing_query',samples:[],averageCNY:null};
  const url=`https://www.goofish.com/search?q=${encodeURIComponent(query)}`;
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000}); await settle(page,Math.max(3500,settings.scanDelayMs));
  await page.waitForSelector('a[href*="/item?id="], a[href*="/item/"]',{timeout:8000}).catch(()=>{});
  const cards=await cardsFromPage(page,'xianyu');
  const cardCount=cards.length;
  const pageState=await page.evaluate(()=>{
    const visible=element=>{const style=getComputedStyle(element),rect=element.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0};
    const text=(document.body?.innerText||'').replace(/\s+/g,' ');
    const loginVisible=[...document.querySelectorAll('iframe[src*="login"], [class*="login" i]')].some(visible);
    return {loginVisible,blocked:/访问频繁|安全验证|滑块|验证码|请稍后重试|被挤爆/.test(text),snippet:text.slice(0,180)};
  }).catch(()=>({loginVisible:false,blocked:false,snippet:''}));
  if(!cardCount && pageState.blocked) return {query,searchUrl:url,status:'blocked',samples:[],averageCNY:null,cardCount,diagnostic:pageState.snippet};
  if(!cardCount && (pageState.loginVisible || /login|signin/i.test(page.url()))) return {query,searchUrl:url,status:'login_required',samples:[],averageCNY:null,cardCount,diagnostic:pageState.snippet};
  const ownHash=await imageHash(item.image), preliminary=[];
  for(const card of cards.slice(0,30)){
    if(isRejected(card.text)||isLikelyVariantOffer(card.text,query)||hasVariantMismatch(query,card.title))continue;
    const price=yen(card.text); if(!Number.isFinite(price)||price<=1)continue;
    // 只用商品卡片自身标题做同款判断，绝不因为详情/摘要中顺带出现目标名称而通过。
    const tScore=titleScore(query,card.title);
    let iScore=null;
    if(tScore>=0.42&&ownHash&&card.image)iScore=imageSimilarity(ownHash,await imageHash(card.image));
    // 闲鱼标题常较短，但角色/版本不同必须排除；图片兜底只接受高度相似。
    const accepted=tScore>=0.88 || (tScore>=0.70&&iScore!==null&&iScore>=0.86);
    if(accepted)preliminary.push({...card,price,titleScore:tScore,imageScore:iScore});
  }
  preliminary.sort((a,b)=>b.titleScore-a.titleScore||a.price-b.price);
  const verified=[],rejected=[];
  for(const candidate of preliminary.slice(0,Math.max(settings.maxXianyuSamples*2,6))){
    const check=await verifyDetail(page.context(),candidate,query,settings);
    if(check.accepted)verified.push({...candidate,...check});
    else rejected.push({url:candidate.url,title:candidate.title,price:candidate.price,reason:check.reason});
  }
  // 至少两个详情验证通过且价格处于同一合理区间，才自动采用均价；否则交给人工输入。
  const coherent=coherentPrices(verified).slice(0,settings.maxXianyuSamples);
  const status=coherent.length>=2?'ok':cardCount?'manual_review':'page_empty';
  return {query,searchUrl:url,status,samples:coherent,averageCNY:status==='ok'?average(coherent.map(x=>x.price)):null,cardCount,loginVisible:pageState.loginVisible,
    preliminaryCount:preliminary.length,verifiedCount:verified.length,rejected:rejected.slice(0,10),verification:'detail_and_price_cluster'};
}
