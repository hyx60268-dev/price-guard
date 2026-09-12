import { imageSimilarity,imageHash } from './image.mjs';
import { hasVariantMismatch,isRejected,titleScore } from './rules.mjs';

const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36';

function queryFor(title=''){
  return title.replace(/新品|未使用|未開封|正規品|中国限定|海外限定|匿名配送|送料無料/gi,' ').replace(/\s+/g,' ').trim();
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

async function fetchHtml(url,attempts=5){
  let last;
  for(let attempt=1;attempt<=attempts;attempt++){
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),45000);
    try{
      const response=await fetch(url,{headers:{'user-agent':UA,'accept-language':'ja-JP,ja;q=0.9'},signal:controller.signal,redirect:'follow'});
      if(response.status===429){
        const retryAfter=Number(response.headers.get('retry-after'));
        const waitMs=Number.isFinite(retryAfter)&&retryAfter>0?retryAfter*1000:Math.min(60000,10000*attempt);
        if(attempt<attempts){console.warn(`[Yahoo 限流] ${Math.ceil(waitMs/1000)} 秒后重试 (${attempt}/${attempts})`);await new Promise(resolve=>setTimeout(resolve,waitMs));continue}
      }
      if(!response.ok) throw new Error(`HTTP ${response.status}`);
      const html=await response.text();
      if(html.length<10000) throw new Error(`页面内容异常短 (${html.length} bytes)`);
      return html;
    }catch(error){
      last=error;
      if(attempt<attempts) await new Promise(resolve=>setTimeout(resolve,Math.min(15000,1000*attempt*attempt)));
    }finally{clearTimeout(timeout)}
  }
  throw new Error(`Yahoo 请求失败：${String(last)}`);
}

async function fetchResult(url){
  return searchResult(extractNextData(await fetchHtml(url)));
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

export async function discoverYahooProfile(_unusedPage,profileUrl){
  const first=await fetchResult(`${profileUrl}?page=1`);
  const pages=Math.max(1,Math.ceil(Number(first.totalResultsAvailable||first.items.length)/100));
  const all=[...first.items];
  for(let page=2;page<=pages;page++){
    const result=await fetchResult(`${profileUrl}?page=${page}`);
    all.push(...result.items);
  }
  const items=[...new Map(all.filter(x=>x.itemStatus==='OPEN').map(x=>[x.id,liveItem(x)])).values()];
  return {items,totalResults:Number(first.totalResultsAvailable||all.length),pages};
}

export async function yahooCompare(_unusedPage,item){
  const query=queryFor(item.title);
  const url=`https://paypayfleamarket.yahoo.co.jp/search/${encodeURIComponent(query)}?open=1`;
  const result=await fetchResult(url);
  const cards=result.items.filter(x=>x.itemStatus==='OPEN').map(raw=>({
    id:raw.id,url:`https://paypayfleamarket.yahoo.co.jp/item/${raw.id}`,title:raw.title||'',text:raw.title||'',
    image:raw.thumbnailImageUrl||'',price:Number(raw.price),sellerId:raw.sellerId||''
  }));
  const ownHash=await imageHash(item.image);
  const competitors=[];
  for(const card of cards.slice(0,60)){
    if(card.id===item.id||isRejected(card.text)||hasVariantMismatch(query,card.title)||!Number.isFinite(card.price))continue;
    const tScore=titleScore(query,card.title);
    let iScore=null;
    if(tScore>=0.52&&tScore<0.88&&ownHash&&card.image)iScore=imageSimilarity(ownHash,await imageHash(card.image));
    // 标题必须基本覆盖完整商品名；图片兜底也要求很高相似度，避免把同系列不同角色当成同款。
    const accepted=tScore>=0.88 || (tScore>=0.72 && iScore!==null && iScore>=0.86);
    if(accepted)competitors.push({...card,titleScore:tScore,imageScore:iScore});
  }
  competitors.sort((a,b)=>a.price-b.price);
  const own={id:item.id,url:item.url||item.ownUrl,title:item.title,image:item.image,price:Number(item.ownPrice),titleScore:1,imageScore:1,isOwn:true};
  const comparable=[own,...competitors].filter(x=>Number.isFinite(x.price)).sort((a,b)=>a.price-b.price);
  const lowest=comparable[0]||null;
  const recommended=lowest&&lowest.price<item.ownPrice?Math.max(1,Math.floor(lowest.price)-1):item.ownPrice;
  return {
    query,searchUrl:url,lowestPrice:lowest?.price??item.ownPrice,lowestUrl:lowest?.url??item.url,
    recommendedPrice:recommended,candidates:competitors.slice(0,5),cardCount:cards.length,
    competitorCount:competitors.length,status:'ok',comparisonStatus:lowest?.isOwn?'own_lowest':'competitor_lower'
  };
}
