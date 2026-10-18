import {createHash} from 'node:crypto';
const digest=value=>createHash('sha256').update(value).digest('hex');
// Optional completed originals are isolated from mutable comparison results.
// Peeking never resolves a pending request, downloads a missing body, or borrows
// prior.sourceDetail. The transport/parser supplies both original receipts.
function originalYahooStore(options,now){
 const rows=new Map();let bytes=0;
 const {startedAt,deadlineAt,maxBytes=2*1024*1024,maxEntries=120}=options||{};
 const enabled=Boolean(options)&&Number.isFinite(startedAt)&&Number.isFinite(deadlineAt)&&deadlineAt>startedAt&&
  Number.isSafeInteger(maxBytes)&&maxBytes>0&&maxBytes<=8*1024*1024&&Number.isSafeInteger(maxEntries)&&maxEntries>0&&maxEntries<=300;
 const stats={retained:0,refused:0,misses:0,hits:0};
 const remove=id=>{const old=rows.get(id);if(old){bytes-=old.bytes;rows.delete(id);}};
 function remember(id,bundle){
  if(!enabled)return;
  try{
   const r=bundle?.originalObservation,time=now(),url=`https://paypayfleamarket.yahoo.co.jp/item/${id}`;
   if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id)||bundle?.detail?.id!==id||bundle.sourceUrl!==url||bundle.fromCache!==false||
    r?.kind!=='original_yahoo_detail_body'||r.version!==1||r.url!==url||r.status!==200||r.redirected!==false||
    !/^[a-f0-9]{64}$/.test(r.bodySha256||'')||r.bodySha256Scope!=='decoded_response_html_utf8'||
    !Number.isFinite(bundle.observedAt)||r.observedAt!==bundle.observedAt||r.observedAt<startedAt||r.observedAt>time||r.observedAt>=deadlineAt)return;
   const payload=JSON.stringify({detail:bundle.detail,shipping:bundle.shipping});
   if(digest(payload)!==r.parsedSha256)return;
   const value=JSON.stringify({detail:bundle.detail,shipping:bundle.shipping,sourceUrl:url,fromCache:false,
    observedAt:r.observedAt,originalObservation:r});
   const size=Buffer.byteLength(value);remove(id);
   if(size>256*1024||size>maxBytes){stats.refused++;return;}
   while(rows.size>=maxEntries||bytes+size>maxBytes)remove(rows.keys().next().value);
   rows.set(id,{value,bytes:size,observedAt:r.observedAt});bytes+=size;stats.retained++;
  }catch{remove(id);stats.refused++;}
 }
 function peek(id){
  const row=rows.get(id),time=now();
  if(!enabled||!row||time>=deadlineAt||time<row.observedAt||time-row.observedAt>=20*60_000){
   if(row)remove(id);stats.misses++;return null;
  }
  stats.hits++;return JSON.parse(row.value);
 }
 const receipt=id=>{const row=rows.get(id),time=now();if(!enabled||!row||time<row.observedAt||time-row.observedAt>=20*60_000)return null;return JSON.parse(row.value).originalObservation;};
 return {remember,peek,receipt,stats:()=>({...stats,active:rows.size,retainedBytes:bytes,maxBytes:enabled?maxBytes:0})};
}

// Platform workers share public own-listing reads, not competitor decisions or costs.
export function createOwnSourceLoader({fetchYahooBundle,fetchYahooResult,fetchRakumaItem,fetchRakumaHtml,fetchRakumaPage,now=Date.now,retainYahooOriginals=null}){
 const bundles=new Map(),details=new Map(),results=new Map(),rakumaPages=new Map();
 const originals=originalYahooStore(retainYahooOriginals,now);
 const stats={yahooBundleRequests:0,yahooBundleReuses:0,yahooResultRequests:0,yahooResultReuses:0,rakumaPageRequests:0,rakumaPageReuses:0,rakumaReadWallMs:0};
 const yahooBundle=(id,options={})=>{
  if(!bundles.has(id)){
   stats.yahooBundleRequests++;const request=fetchYahooBundle(id,options);bundles.set(id,request);
   if(retainYahooOriginals)Promise.resolve(request).then(value=>originals.remember(id,value),()=>{});
  }
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
 return {hydrate,yahooBundle,yahooResult,rakumaPage,stats,peekYahooBundle:originals.peek,yahooOriginalReceipt:originals.receipt,yahooOriginalStats:originals.stats};
}
