import { fetchYahooResult,fetchYahooItemBundle } from './yahoo.mjs';
import { fetchRakumaHtml,extractRakumaSearchCards,fetchRakumaItem } from './rakuma.mjs';
import { readMercariCards,mercariDetail } from './mercari-page.mjs';
import { merchantNameFromTitle } from './merchant-names.mjs';
import { isMixedBundle } from './merchant-bundles.mjs';

export async function merchantCards(merchant,{settings={},page,maxPages=10,deadline=Infinity}={}){
 const cards=new Map();let complete=false,pages=0;
 if(merchant.platform==='yahoo'){
  for(let n=1;n<=maxPages&&Date.now()<deadline;n++){
   const result=await fetchYahooResult(`${merchant.url}?page=${n}&sort=openTime&order=desc`,settings);pages++;
   if(result.profileName)merchant.name=result.profileName;
   for(const raw of result.items||[])cards.set(raw.id,{id:raw.id,title:raw.title,price:Number(raw.price),status:raw.itemStatus,
    url:`https://paypayfleamarket.yahoo.co.jp/item/${raw.id}`,image:raw.thumbnailImageUrl||'',listedAt:raw.openTime||null,soldAt:raw.itemStatus==='SOLD'?raw.endTime||null:null});
   if(cards.size>=Number(result.totalResultsAvailable??Infinity)||(result.items||[]).length===0){complete=true;break}
  }
 }else if(merchant.platform==='rakuma'){
  let url=merchant.url;
  while(url&&pages<maxPages&&Date.now()<deadline){
   const html=await fetchRakumaHtml(url,settings);pages++;
   const rows=extractRakumaSearchCards(html,'shop');
   if(!rows.length&&!/商品はありません|出品した商品はありません|0件中/.test(html))throw Error('商家列表不可读');
   for(const row of rows)cards.set(row.id,{...row,status:row.itemStatus});
   const nextTag=[...html.matchAll(/<link\b[^>]*>/gi)].map(m=>m[0]).find(tag=>/rel=["']next["']/i.test(tag));
   const href=nextTag?.match(/href=["']([^"']+)["']/i)?.[1]?.replaceAll('&amp;','&');
   if(!href){complete=true;break}
   const next=new URL(href,url);if(next.origin!=='https://fril.jp'||!next.pathname.startsWith(new URL(merchant.url).pathname+'/page/'))throw Error('商家分页链接不匹配');url=next.href;
  }
 }else{
  await page.goto(merchant.url,{waitUntil:'domcontentloaded',timeout:45000});
  const profileName=merchantNameFromTitle('mercari',await page.title());if(profileName)merchant.name=profileName;
  await page.waitForFunction(()=>document.querySelector('main a[href^="/item/"]')||/出品した商品はありません/.test(document.querySelector('main')?.innerText||''),{},{timeout:20000});
  let prior=-1,stable=0;
  for(let n=0;n<maxPages&&Date.now()<deadline;n++){
   // Overseas cards can omit JPY. Keep their links for target-detail lookup;
   // neither a converted USD amount nor a missing price can pass the JPY filter.
   const result=await page.evaluate('('+readMercariCards.toString()+')(document,{includeUnpriced:true})');pages++;
   for(const row of result.cards)cards.set(row.id,{...row,status:row.itemStatus});
   stable=cards.size===prior?stable+1:0;prior=cards.size;
   if(!result.hasMore){complete=true;break}if(stable>=2)break;
   const more=page.getByRole('button',{name:'もっと見る',exact:true});
   if(await more.count()&&await more.first().isVisible())await more.first().click();
   else await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
   await page.waitForTimeout(1200);
  }
 }
 if(!cards.size&&!complete)throw Error('商家列表存在商品但未能读取，不能当作空店铺');
 return {cards:[...cards.values()],complete,pages};
}

export async function merchantDetail(merchant,card,{settings={},page,deadline=Infinity,bundleChild=false,fetchBundle=fetchYahooItemBundle}={}){
 if(merchant.platform==='yahoo'){
  const bundle=await fetchBundle(card.id,settings),detail=bundle.detail;
  if(String(detail.seller?.id||'')!==merchant.id)throw Error('商品卖家与监控主页不一致');
  const result={...card,sellerName:detail.seller?.name||detail.seller?.nickname||detail.seller?.displayName||'',title:detail.title,description:detail.description||'',price:Number(detail.price),status:detail.status,
   condition:typeof detail.condition==='string'?detail.condition:detail.condition?.name||'',
   listedAt:detail.openDate||card.listedAt||null,images:(detail.images||[]).map(i=>typeof i==='string'?i:i.url).filter(Boolean)};
  if(isMixedBundle(result)){
   result.components=[];result.bundleComplete=false;
   if(bundleChild)return result;
   for(const child of bundle.components||[]){
    if(Date.now()>=deadline)break;
    try{const d=await merchantDetail(merchant,child,{settings,page,deadline,bundleChild:true,fetchBundle});
     if(!isMixedBundle(d))result.components.push({...d,price:child.price,detailVerified:true});
    }catch{/* Retain the incomplete parent for the next cloud retry. */}
   }
   result.bundleComplete=bundle.components?.length>1&&result.components.length===bundle.components.length;
  }
  return result;
 }
 if(merchant.platform==='rakuma')return {...card,...await fetchRakumaItem(card,settings)};
 const detail=await mercariDetail(page,card.url);
 if(detail.sellerId!==`/user/profile/${merchant.id}`)throw Error('商品卖家与监控主页不一致');
 return {...card,...detail,status:detail.status==='UNKNOWN'?card.status:detail.status};
}
