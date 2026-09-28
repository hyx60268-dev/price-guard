// Platform workers share public own-listing reads, not competitor decisions or costs.
export function createOwnSourceLoader({fetchYahooBundle,fetchRakumaItem,now=Date.now}){
 const bundles=new Map(),details=new Map();
 const yahooBundle=id=>{
  if(!bundles.has(id))bundles.set(id,fetchYahooBundle(id));
  return bundles.get(id);
 };
 async function hydrate(item,prior={}){
  const key=item.platform+':'+item.id;
  if(!details.has(key))details.set(key,(async()=>{
   const source=prior.sourceDetail,stamp=Date.parse(source?.checkedAt||'');
   if(source?.description&&source.listingId===item.id&&prior.title===item.title&&prior.ownPrice===item.ownPrice&&stamp<=now()&&now()-stamp<6*3600000)return source;
   const detail=item.platform==='rakuma'?await fetchRakumaItem(item):(await yahooBundle(item.id)).detail;
   if(!detail?.description?.trim())throw Error('自有商品销售正文缺失');
   if(detail.status&&detail.status!=='OPEN')throw Error('自有商品不再在售，等待库存更新');
   return {...detail,listingId:item.id,checkedAt:new Date(now()).toISOString()};
  })());
  const sourceDetail=await details.get(key);item.sourceDetail=sourceDetail;
  const images=(sourceDetail.images||[]).map(image=>typeof image==='string'?image:image?.url).filter(Boolean);
  return {...item,sourceDetail,yahoo:{...(prior.yahoo||{}),ownDescription:sourceDetail.description,ownCategory:sourceDetail.category||prior.yahoo?.ownCategory||'',ownImages:images.length?images:prior.yahoo?.ownImages||[]}};
 }
 return {hydrate,yahooBundle};
}
