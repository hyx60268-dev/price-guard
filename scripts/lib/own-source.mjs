// Platform workers share public own-listing reads, not competitor decisions or costs.
export function createOwnSourceLoader({fetchYahooBundle,fetchYahooResult,fetchRakumaItem,fetchRakumaHtml,now=Date.now}){
 const bundles=new Map(),details=new Map(),results=new Map(),rakumaPages=new Map();
 const stats={yahooResultRequests:0,yahooResultReuses:0,rakumaPageRequests:0,rakumaPageReuses:0,rakumaReadWallMs:0};
 const yahooBundle=id=>{
  if(!bundles.has(id))bundles.set(id,fetchYahooBundle(id));
  return bundles.get(id);
 };
 // Share raw public query observations, never product matching decisions. Two
 // accounts or variants can issue the same recall query but validate separately.
 // Keep the original observation time and clone the payload for each consumer.
 async function yahooResult(url){
  let request=results.get(url);
  if(request)stats.yahooResultReuses++;
  else{
   stats.yahooResultRequests++;
   request=Promise.resolve().then(()=>fetchYahooResult(url)).then(result=>({...result,observedAt:new Date(now()).toISOString()}));
   results.set(url,request);
   request.catch(()=>{if(results.get(url)===request)results.delete(url)});
  }
  return structuredClone(await request);
 }
 // Immutable raw HTML is shared only within this run. Matching decisions are
 // still made separately against each account/item and its correction records.
 async function rakumaPage(url){
  let request=rakumaPages.get(url);
  if(request)stats.rakumaPageReuses++;
  else{
   stats.rakumaPageRequests++;const start=performance.now();
   request=Promise.resolve().then(()=>fetchRakumaHtml(url)).then(html=>({html,observedAt:new Date(now()).toISOString()})).finally(()=>{stats.rakumaReadWallMs+=performance.now()-start});
   rakumaPages.set(url,request);
   // Keep memory bounded; evictions can only cause a new permitted observation.
   while(rakumaPages.size>256)rakumaPages.delete(rakumaPages.keys().next().value);
   request.catch(()=>{if(rakumaPages.get(url)===request)rakumaPages.delete(url)});
  }
  return {...await request};
 }
 async function hydrate(item,prior={}){
  const key=item.platform+':'+item.id;
  if(!details.has(key))details.set(key,(async()=>{
   const source=prior.sourceDetail,stamp=Date.parse(source?.checkedAt||'');
   if(source?.description&&source.listingId===item.id&&prior.title===item.title&&prior.ownPrice===item.ownPrice&&prior.image===item.image&&stamp<=now()&&now()-stamp<6*3600000)return source;
   const detail=item.platform==='rakuma'?await fetchRakumaItem(item):(await yahooBundle(item.id)).detail;
   if(!detail?.description?.trim())throw Error('自有商品销售正文缺失');
   if(detail.status&&detail.status!=='OPEN')throw Error('自有商品不再在售，等待库存更新');
   return {...detail,listingId:item.id,checkedAt:detail.sourceObservedAt||new Date(now()).toISOString()};
  })());
  const sourceDetail=await details.get(key);item.sourceDetail=sourceDetail;
  const images=(sourceDetail.images||[]).map(image=>typeof image==='string'?image:image?.url).filter(Boolean);
  return {...item,sourceDetail,yahoo:{...(prior.yahoo||{}),ownDescription:sourceDetail.description,ownCategory:sourceDetail.category||prior.yahoo?.ownCategory||'',ownImages:images.length?images:prior.yahoo?.ownImages||[]}};
 }
 return {hydrate,yahooBundle,yahooResult,rakumaPage,stats};
}
