import { cardsFromPage,settle } from './browser.mjs';
import { imageHash,imageSimilarity } from './image.mjs';
import { average,isRejected,titleScore,yen } from './rules.mjs';

export async function xianyuCost(page,item,settings){
  const query=item.xianyuQuery||'';
  if(!query)return {query,status:'missing_query',samples:[],averageCNY:null};
  const url=`https://www.goofish.com/search?q=${encodeURIComponent(query)}`;
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000}); await settle(page,Math.max(3500,settings.scanDelayMs));
  if(await page.getByText('登录',{exact:true}).count()) return {query,searchUrl:url,status:'login_required',samples:[],averageCNY:null};
  const cards=await cardsFromPage(page,'xianyu');
  const ownHash=await imageHash(item.image), samples=[];
  for(const card of cards.slice(0,30)){
    if(isRejected(card.text))continue;
    const price=yen(card.text); if(!Number.isFinite(price)||price<=1)continue;
    const tScore=titleScore(query,card.title+' '+card.text);
    let iScore=null;
    if(tScore>=0.42&&ownHash&&card.image)iScore=imageSimilarity(ownHash,await imageHash(card.image));
    const accepted=tScore>=0.82 || (tScore>=0.56&&iScore!==null&&iScore>=0.56);
    if(accepted)samples.push({...card,price,titleScore:tScore,imageScore:iScore});
  }
  samples.sort((a,b)=>b.titleScore-a.titleScore||a.price-b.price);
  const selected=samples.slice(0,settings.maxXianyuSamples);
  return {query,searchUrl:url,status:selected.length?'ok':'manual_review',samples:selected,averageCNY:average(selected.map(x=>x.price))};
}
