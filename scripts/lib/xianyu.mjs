import { cardsFromPage,settle } from './browser.mjs';
import { imageHash,imageSimilarity } from './image.mjs';
import { average,hasVariantMismatch,isRejected,titleScore,yen } from './rules.mjs';

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
  const ownHash=await imageHash(item.image), samples=[];
  for(const card of cards.slice(0,30)){
    if(isRejected(card.text)||hasVariantMismatch(query,card.title+' '+card.text))continue;
    const price=yen(card.text); if(!Number.isFinite(price)||price<=1)continue;
    const tScore=titleScore(query,card.title+' '+card.text);
    let iScore=null;
    if(tScore>=0.42&&ownHash&&card.image)iScore=imageSimilarity(ownHash,await imageHash(card.image));
    // 闲鱼标题常较短，但角色/版本不同必须排除；图片兜底只接受高度相似。
    const accepted=tScore>=0.88 || (tScore>=0.70&&iScore!==null&&iScore>=0.86);
    if(accepted)samples.push({...card,price,titleScore:tScore,imageScore:iScore});
  }
  samples.sort((a,b)=>b.titleScore-a.titleScore||a.price-b.price);
  const selected=samples.slice(0,settings.maxXianyuSamples);
  return {query,searchUrl:url,status:selected.length?'ok':cardCount?'manual_review':'page_empty',samples:selected,averageCNY:average(selected.map(x=>x.price)),cardCount,loginVisible:pageState.loginVisible};
}
