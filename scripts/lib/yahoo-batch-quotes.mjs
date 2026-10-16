import { fetchYahooResult } from './yahoo.mjs';

// This is the same public HTML seller interface used by inventory discovery,
// not an undocumented API or an authenticated endpoint. The existing Yahoo
// request gate, cooldown and retry policy still govern every page request.
export async function readYahooSellerQuotes(sellerId,settings={},dependencies={}){
 if(!/^p\d+$/.test(sellerId||''))throw Error('Invalid Yahoo public seller ID');
 const read=dependencies.fetchYahooResult||fetchYahooResult,now=dependencies.now||Date.now;
 const started=now(),quotes=new Map(),pageObservations=[];
 let total=null,pages=1,complete=true,invalidCount=0;
 for(let page=1;page<=pages;page++){
  const url=`https://paypayfleamarket.yahoo.co.jp/user/${sellerId}?page=${page}`;
  const result=await read(url,settings),observedAt=new Date(now()).toISOString();
  const available=Number(result.totalResultsAvailable);
  if(!Array.isArray(result.items)||!Number.isSafeInteger(available)||available<0)throw Error('Incomplete Yahoo seller page schema');
  if(page===1){total=available;pages=Math.max(1,Math.ceil(total/100))}
  else if(available!==total)complete=false;
  if(Number(result.offset)!==(page-1)*100)complete=false;
  pageObservations.push({url,observedAt,returned:result.items.length});
  for(const raw of result.items){
   const sellerIds=[raw.sellerId,raw.seller?.id].filter(Boolean).map(String);
   const price=Number(raw.price);
   if(!raw.id||!sellerIds.length||sellerIds.some(id=>id!==sellerId)||!raw.title||!raw.thumbnailImageUrl||
     !Number.isFinite(price)||price<=0||!['OPEN','SOLD'].includes(raw.itemStatus)){
    invalidCount++;complete=false;continue;
   }
   if(quotes.has(raw.id)){complete=false;continue}
   quotes.set(raw.id,{id:raw.id,sellerId,url:`https://paypayfleamarket.yahoo.co.jp/item/${raw.id}`,
    title:raw.title,image:raw.thumbnailImageUrl,condition:typeof raw.condition==='string'?raw.condition:null,
    itemPriceJPY:price,currency:'JPY',availability:raw.itemStatus==='OPEN'?'available':'sold',
    quoteObservedAt:observedAt,sourceUrl:url,priceSource:'public_seller_listing',
    // A changed description, quantity or shipping cannot be detected by this
    // interface. Do not fabricate a new identity/cost verification timestamp.
    identityVerified:false,shippingKnown:false,canReprice:false});
  }
 }
 const finished=now();
 return {sellerId,source:'yahoo_public_seller_html',startedAt:new Date(started).toISOString(),finishedAt:new Date(finished).toISOString(),
  durationMs:finished-started,totalExpected:total,pageCount:pages,pageObservations,invalidCount,
  complete:complete&&quotes.size===total,quotes:[...quotes.values()]};
}

// Raw observations can be shared across accounts; identity and ownership
// decisions remain item-local. A missing quote is never assigned a zero price.
export async function readYahooSellerBatch(sellerIds,settings={},dependencies={}){
 const sellers=[];
 for(const sellerId of [...new Set(sellerIds)])sellers.push(await readYahooSellerQuotes(sellerId,settings,dependencies));
 return sellers;
}
