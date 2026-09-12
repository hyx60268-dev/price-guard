import { cardsFromPage,settle } from './browser.mjs';
import { imageSimilarity,imageHash } from './image.mjs';
import { isRejected,titleScore,yen } from './rules.mjs';

function queryFor(title=''){
  return title.replace(/新品|未使用|未開封|正規品|中国限定|海外限定|匿名配送|送料無料/gi,' ').replace(/\s+/g,' ').trim();
}

export async function discoverYahooProfile(page,profileUrl,settings){
  await page.goto(profileUrl,{waitUntil:'domcontentloaded',timeout:45000}); await settle(page,settings.scanDelayMs);
  let unchanged=0,last=0;
  for(let i=0;i<45&&unchanged<4;i++){
    await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
    await page.waitForTimeout(850);
    const count=await page.locator('a[href*="/item/"]').count();
    if(count===last)unchanged++;else unchanged=0;last=count;
  }
  const cards=await cardsFromPage(page,'yahoo-profile'), result=[];
  for(const card of cards){
    if(isRejected(card.text))continue;
    const price=yen(card.text); if(!Number.isFinite(price))continue;
    const title=(card.title||card.text).replace(/[¥￥]\s*[0-9][0-9,]*/g,'').trim();
    result.push({id:card.id,url:card.url,title,ownPrice:price,image:card.image});
  }
  return [...new Map(result.map(x=>[x.id,x])).values()];
}

export async function yahooCompare(page,item,settings){
  const query=queryFor(item.title);
  const url=`https://paypayfleamarket.yahoo.co.jp/search/${encodeURIComponent(query)}?open=1`;
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000}); await settle(page,settings.scanDelayMs);
  const cards=await cardsFromPage(page,'yahoo');
  const ownHash=await imageHash(item.image);
  const candidates=[];
  for(const card of cards.slice(0,30)){
    if(card.id===item.id||isRejected(card.text))continue;
    const price=yen(card.text); if(!Number.isFinite(price))continue;
    const tScore=titleScore(query,card.title+' '+card.text);
    let iScore=null;
    if(tScore>=0.52&&ownHash&&card.image)iScore=imageSimilarity(ownHash,await imageHash(card.image));
    const accepted=tScore>=0.88 || (tScore>=0.62 && iScore!==null && iScore>=0.58);
    if(accepted)candidates.push({...card,price,titleScore:tScore,imageScore:iScore});
  }
  candidates.sort((a,b)=>a.price-b.price);
  const lowest=candidates[0]||null;
  const recommended=lowest&&lowest.price<item.ownPrice?Math.max(1,Math.floor(lowest.price)-1):item.ownPrice;
  return {query,searchUrl:url,lowestPrice:lowest?.price??null,lowestUrl:lowest?.url??'',recommendedPrice:recommended,candidates:candidates.slice(0,5),status:candidates.length?'ok':'manual_review'};
}
