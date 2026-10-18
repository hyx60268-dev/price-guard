// Platform workers share public own-listing reads, not competitor decisions or costs.
export function createOwnSourceLoader({fetchYahooBundle,fetchYahooResult,fetchRakumaItem,fetchRakumaHtml,fetchRakumaPage,now=Date.now}){
 const bundles=new Map(),details=new Map(),results=new Map(),rakumaPages=new Map();
 const stats={yahooBundleRequests:0,yahooBundleReuses:0,yahooResultRequests:0,yahooResultReuses:0,rakumaPageRequests:0,rakumaPageReuses:0,rakumaReadWallMs:0};
 const yahooBundle=(id,options={})=>{
  if(!bundles.has(id)){stats.yahooBundleRequests++;bundles.set(id,fetchYahooBundle(id,options))}
  else stats.yahooBundleReuses++;
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
   request=Promise.resolve().then(()=>fetchYahooResult(url)).then(result=>{const original=result?.observedAt,at=typeof original==='number'?original:Date.parse(original||'');if(original!==undefined&&original!==null&&(!Number.isFinite(at)||at<0||at>now()))throw Error('Yahoo search original observation unavailable');return {...result,observedAt:Number.isFinite(at)?new Date(at).toISOString():new Date(now()).toISOString()}});
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
   request=Promise.resolve().then(()=>fetchRakumaPage?fetchRakumaPage(url):
    Promise.resolve(fetchRakumaHtml(url)).then(html=>({html,observedAt:new Date(now()).toISOString()})))
    .finally(()=>{stats.rakumaReadWallMs+=performance.now()-start});
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
   const bundle=item.platform==='rakuma'?null:await yahooBundle(item.id,{purpose:'own'});
   const detail=item.platform==='rakuma'?await fetchRakumaItem(item):bundle.detail;
   if(!detail?.description?.trim())throw Error('自有商品销售正文缺失');
   if(detail.status&&detail.status!=='OPEN')throw Error('自有商品不再在售，等待库存更新');
   const original=detail.sourceObservedAt??bundle?.observedAt;
   const at=typeof original==='number'?original:Date.parse(original||'');
   if(original!==undefined&&original!==null&&(!Number.isFinite(at)||at<0||at>now()))throw Error('自有详情原始观测时间不可用');
   return {...detail,listingId:item.id,checkedAt:Number.isFinite(at)?new Date(at).toISOString():new Date(now()).toISOString()};
  })());
  const sourceDetail=await details.get(key);item.sourceDetail=sourceDetail;
  const images=(sourceDetail.images||[]).map(image=>typeof image==='string'?image:image?.url).filter(Boolean);
  return {...item,sourceDetail,yahoo:{...(prior.yahoo||{}),ownDescription:sourceDetail.description,ownCategory:sourceDetail.category||prior.yahoo?.ownCategory||'',ownImages:images.length?images:prior.yahoo?.ownImages||[]}};
 }
 return {hydrate,yahooBundle,yahooResult,rakumaPage,stats};
}
