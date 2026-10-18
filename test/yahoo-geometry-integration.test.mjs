import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {yahooCompare} from '../scripts/lib/yahoo.mjs';
import {configureImageFingerprintCache} from '../scripts/lib/image.mjs';
import {createBoundedGeometryRanker} from '../scripts/lib/geometry-rank-batch.mjs';
const title='ヴァイオレット・エヴァーガーデン APEX 自動手記人形 フィギュア 1/7';
const ownImage='https://fixtures.invalid/own.png',weakImage='https://fixtures.invalid/weak.png';
const item={id:'fixture-own',accountId:'melon',platform:'yahoo',sellerId:'managed',title,ownPrice:28499,image:ownImage};
const ownDetail={id:item.id,title,price:28499,status:'OPEN',description:'新品 未開封 フィギュア1点',seller:{id:'managed'},images:[ownImage]};
const cards=[...Array.from({length:9},(_,i)=>({id:'weak-'+i,title,price:500+i,image:'https://fixtures.invalid/unused-'+i+'.png',sellerId:'external',source:'recommendation',sources:['recommendation']})),{id:'geometry-candidate',title:'ヴァイオレット 人形',price:28000,image:weakImage,sellerId:'external',source:'recommendation',sources:['recommendation']}];
const raw=Buffer.alloc(128*128*3);for(let y=0;y<128;y++)for(let x=0;x<128;x++){let p=(y*128+x)*3;raw[p]=x*2;raw[p+1]=y*2;raw[p+2]=(x+y)%2?220:30}
const bytes=await sharp(raw,{raw:{width:128,height:128,channels:3}}).png().toBuffer();
const weak=await sharp({create:{width:128,height:128,channels:3,background:'#ffffff'}}).png().toBuffer();
function dependencies({reads,fetches,ranker,mode='accepted'}){return {
 geometryRanker:ranker,fetchYahooResult:async()=>({items:[]}),fetchYahooItemBundle:async id=>{
  if(id===item.id)return {detail:ownDetail,recommendations:cards,observedAt:Date.now()};
  reads.push({id,imageReads:fetches.length});
  const candidate=cards.find(card=>card.id===id);
  const detail={...ownDetail,id,price:candidate.price,seller:{id:'external'}};
  if(id!=='geometry-candidate'||mode==='wrong')Object.assign(detail,{title:'アクリルスタンド',description:'新品 アクリルスタンド1点'});
  if(id==='geometry-candidate'&&mode==='sold')detail.status='SOLD';
  return {detail,observedAt:Date.now()};
 }};}
function ranker({bad=false}={}){return createBoundedGeometryRanker({execute:async input=>{
 if(bad)return {reason:'runtime_unavailable'};
 const hashes=new Map(input.images.map(image=>[image.id,createHash('sha256').update(Buffer.from(image.base64,'base64')).digest('hex')]));
 return {value:{scope:'candidate_ranking_only',version:'harris_affine_rank_v1_offline',pairs:input.pairs.map(([queryId,candidateId])=>({queryId,candidateId,status:'visual_metrics_only',rankHint:'same_artwork_candidate',identityVerified:false,canRecommend:false,queryContentSha256:hashes.get(queryId),candidateContentSha256:hashes.get(candidateId),metrics:{inliers:100,inlierFraction:.8,sourceCoverage:.5,targetCoverage:.5,alignedRgbMae:.1,alignedPixelFraction:.7}}))}};
 }});}
async function compare(t,{enabled=true,bad=false,mode='accepted',accountId='melon',cacheControl='no-store'}={}){
 configureImageFingerprintCache();const reads=[],fetches=[];
 t.mock.method(globalThis,'fetch',async url=>{fetches.push(url);return new Response(url===weakImage?weak:bytes,{headers:{'cache-control':cacheControl}})});
 const result=await yahooCompare(null,{...item,accountId},{yahooGeometryPriority:enabled,maxYahooDetailChecks:8},dependencies({reads,fetches,ranker:ranker({bad}),mode}));
 return {result,reads,fetches};
}
for(const accountId of ['melon','boss','momoka'])test(`${accountId}: real byte loader and comparison route one geometric hint through strict detail within eight slots`,async t=>{
 const {result,reads}=await compare(t,{accountId});
 assert.equal(reads.length,8);assert.deepEqual(reads.slice(0,2).map(row=>row.id),['weak-0','geometry-candidate']);
 assert.equal(reads[0].imageReads,2,'only existing own + existing recall thumbnail before details');
 assert.equal(result.geometryRouting.prioritySlots,1);assert.equal(result.geometryRouting.paired,1);
 assert.ok(result.candidates.some(row=>row.id==='geometry-candidate'&&row.price===28000));
 assert.equal(result.status,'incomplete');assert.ok(result.uncheckedLowerCandidateCount>0);
});
test('disabled or failed geometry leaves exact original detail queue and no extra pre-detail images',async t=>{
 for(const settings of [{enabled:false},{bad:true}]){
  const {result,reads}=await compare(t,settings);assert.deepEqual(reads.map(row=>row.id),cards.slice(0,8).map(row=>row.id));assert.equal(reads[0].imageReads,2);assert.equal(result.candidates.length,0);
 }
});
for(const mode of ['wrong','sold'])test(`same-background false geometry hint remains strictly rejected: ${mode}`,async t=>{
 const {result,reads}=await compare(t,{mode});assert.ok(reads.some(row=>row.id==='geometry-candidate'));assert.equal(result.candidates.length,0);
 assert.ok(result.rejected.some(row=>row.id==='geometry-candidate'&&row.reason===(mode==='sold'?'not_open':'physical_product_type_unconfirmed')));
});

test('many shared-background hints cannot occupy all eight real detail reads',async t=>{
 configureImageFingerprintCache();
 const hints=Array.from({length:10},(_,n)=>({...cards.at(-1),id:'geometry-'+n,price:10+n,image:weakImage+'?'+n}));
 const expanded=[...hints,...cards.slice(0,9)],reads=[],fetches=[];
 t.mock.method(globalThis,'fetch',async url=>{fetches.push(url);return new Response(url===ownImage?bytes:weak,{headers:{'cache-control':'no-store'}})});
 const deps=dependencies({reads,fetches,ranker:ranker(),mode:'wrong'}),original=deps.fetchYahooItemBundle;
 deps.fetchYahooItemBundle=async id=>id===item.id?{detail:ownDetail,recommendations:expanded,observedAt:Date.now()}:id.startsWith('geometry-')?(reads.push({id}),{detail:{...ownDetail,id,title:'アクリルスタンド',description:'新品 アクリルスタンド1点',price:10,seller:{id:'external'}}}):original(id);
 const result=await yahooCompare(null,item,{yahooGeometryPriority:true,maxYahooDetailChecks:8},deps);
 assert.equal(reads.length,8);assert.equal(reads.filter(row=>row.id.startsWith('geometry-')).length,1);assert.equal(reads[0].id,'weak-0');
 assert.equal(result.geometryRouting.hints,10);assert.equal(result.geometryRouting.prioritySlots,1);assert.equal(result.candidates.length,0);
 assert.ok(result.uncheckedLowerCandidateCount>=9,'unselected geometry hints do not disappear from unresolved coverage');
});

test('HTTP-fresh fingerprints restore already downloaded bytes in a new scope without refetch',async t=>{
 configureImageFingerprintCache();const reads=[],fetches=[];let rankCalls=0;
 t.mock.method(globalThis,'fetch',async url=>{fetches.push(url);return new Response(url===weakImage?weak:bytes,{headers:{'cache-control':'public,max-age=3600'}})});
 const geometry=createBoundedGeometryRanker({execute:async()=>{rankCalls++;return {reason:'runtime_unavailable'}}});
 const deps=dependencies({reads,fetches,ranker:geometry});
 await yahooCompare(null,item,{yahooGeometryPriority:true},deps);const afterFirst=fetches.length;
 await yahooCompare(null,item,{yahooGeometryPriority:true},deps);
 assert.equal(fetches.length,afterFirst);assert.equal(rankCalls,2,'the second scope reuses original cached bytes without image refetch');
});

test('an earlier own-image observation is reused by the real normal comparison without changing its source clock',async t=>{
 let time=1000;configureImageFingerprintCache({now:()=>time});const fetches=[],reads=[],observations=[];
 t.mock.method(globalThis,'fetch',async url=>{fetches.push(url);return new Response(url===weakImage?weak:bytes,{headers:{'cache-control':'public,max-age=3600'}})});
 const {imageFingerprints}=await import('../scripts/lib/image.mjs');
 const before=await imageFingerprints(ownImage);time=2000;
 const working=ranker(),geometry={canRun:options=>working.canRun(options),rank:async args=>{
  observations.push({time:args.own?.imageObservedAt,hash:args.own?.contentSha256});return working.rank(args);
 }};
 const result=await yahooCompare(null,item,{yahooGeometryPriority:true,maxYahooDetailChecks:8},dependencies({reads,fetches,ranker:geometry}));
 assert.equal(fetches.filter(url=>url===ownImage).length,1);
 assert.deepEqual(observations,[{time:before.imageObservedAt,hash:before.contentSha256}]);
 assert.equal(before.imageObservedAt,new Date(1000).toISOString());
 assert.equal(result.geometryRouting.imageEligibility.ownBytesAvailable,true);
 assert.equal(result.geometryRouting.status,'observed');assert.equal(result.geometryRouting.prioritySlots,1);
 assert.equal(reads.length,8);assert.equal(result.status,'incomplete');
});

for(const [ownTitle,conflictTitle] of [
 ['鬼滅の刃 不死川実弥 フィギュア','鬼滅の刃 冨岡義勇 フィギュア'],
 [title+' A版',title+' B版'],
 ['タロット 魔術師 フィギュア','タロット 女教皇 フィギュア']
])test(`existing explicit variant guard cannot be rescued by geometry: ${conflictTitle}`,async t=>{
 configureImageFingerprintCache();let geometryCalls=0;const reads=[],fetches=[];
 t.mock.method(globalThis,'fetch',async url=>{fetches.push(url);return new Response(url===ownImage?bytes:weak,{headers:{'cache-control':'no-store'}})});
 const changedOwn={...ownDetail,title:ownTitle},changedCards=[...cards.slice(0,9).map(c=>({...c,title:ownTitle})),{...cards.at(-1),title:conflictTitle}];
 const deps=dependencies({reads,fetches,ranker:createBoundedGeometryRanker({execute:async()=>{geometryCalls++;throw Error('must not reach')}})}),original=deps.fetchYahooItemBundle;
 deps.fetchYahooItemBundle=async id=>id===item.id?{detail:changedOwn,recommendations:changedCards,observedAt:Date.now()}:original(id);
 await yahooCompare(null,{...item,title:ownTitle},{yahooGeometryPriority:true,maxYahooDetailChecks:8},deps);
 assert.equal(geometryCalls,0);assert.equal(reads.some(row=>row.id==='geometry-candidate'),false);
});

for(const failure of [false,true])test(`normal reallocation records real cache misses and retains replaced unknown cards (runtime failure=${failure})`,async t=>{
 configureImageFingerprintCache();
 const original=Array.from({length:20},(_,n)=>({...cards.at(-1),id:'old-visual-'+n,price:500+n,image:weakImage+'?old='+n}));
 const near=Array.from({length:9},(_,n)=>({...cards[0],id:'near-'+n,price:25000+n,image:weakImage+'?near='+n}));
 const fetches=[],reads=[];t.mock.method(globalThis,'fetch',async url=>{fetches.push(url);return new Response(url===ownImage?bytes:weak,{headers:{'cache-control':'public,max-age=3600'}})});
 const {imageFingerprints}=await import('../scripts/lib/image.mjs');await Promise.all(original.map(card=>imageFingerprints(card.image)));
 const warmed=fetches.length;let rankCalls=0;
 const working=ranker(),geometry={canRun:()=>true,rank:async args=>{rankCalls++;return failure?{status:'unavailable',priorityIds:[]} : working.rank(args)}};
 const deps={geometryRanker:geometry,fetchYahooResult:async()=>({items:[]}),fetchYahooItemBundle:async id=>{
  if(id===item.id)return {detail:ownDetail,recommendations:[...original,...near],observedAt:Date.now()};
  reads.push(id);return {detail:{...ownDetail,id,status:'SOLD',seller:{id:'external'}},observedAt:Date.now()};
 }};
 const result=await yahooCompare(null,item,{yahooGeometryPriority:true,yahooGeometryReallocate:true,maxYahooDetailChecks:8},deps);
 assert.equal(rankCalls,1);assert.equal(result.geometryRouting.imageWork.baselineCalls,20);assert.equal(result.geometryRouting.imageWork.selectedCalls,20);
 assert.equal(result.geometryRouting.imageWork.nearPriceCalls,4);assert.equal(result.geometryRouting.imageWork.unprocessedOriginalCards,4);
 assert.equal(result.geometryRouting.imageWork.cardTransfers.fetches,4,'cache miss difference is real mocked transport, not fingerprint-call arithmetic');
 assert.equal(result.geometryRouting.imageWork.cardTransfers.completedDecodedBytes,weak.length*4);assert.ok(result.geometryRouting.imageWork.cardTransfers.durationMs>=0);
 assert.equal(fetches.length-warmed,5,'one existing own + four newly selected thumbnails, no fallback refill');
 assert.deepEqual(reads,failure?near.slice(0,8).map(card=>card.id):['near-0','old-visual-0',...near.slice(1,7).map(card=>card.id)]);assert.equal(result.detailCheckedCount,8);
 assert.equal(result.geometryRouting.prioritySlots,failure?0:1,'newly reusable old bodies may get only one geometric priority slot');
 assert.equal(result.status,'incomplete');assert.ok(result.uncheckedLowerCandidateCount>=4);assert.equal(result.plausibleMinPrice,failure?516:501);assert.equal(result.recommendedPrice,item.ownPrice);
});

test('known missing runtime or exhausted compute budget never reallocates images',async t=>{
 configureImageFingerprintCache();const original=Array.from({length:20},(_,n)=>({...cards.at(-1),id:'base-'+n,price:500+n,image:weakImage+'?base='+n}));
 const near=Array.from({length:9},(_,n)=>({...cards[0],id:'near-'+n,price:25000+n,image:weakImage+'?near='+n}));const fetches=[];
 t.mock.method(globalThis,'fetch',async url=>{fetches.push(url);return new Response(url===ownImage?bytes:weak,{headers:{'cache-control':'no-store'}})});
 const result=await yahooCompare(null,item,{yahooGeometryPriority:true,yahooGeometryReallocate:true},{geometryRanker:createBoundedGeometryRanker({runtimeReady:false,execute:async()=>{throw Error('must not run')}}),fetchYahooResult:async()=>({items:[]}),fetchYahooItemBundle:async id=>id===item.id?{detail:ownDetail,recommendations:[...original,...near]}:{detail:{...ownDetail,id,status:'SOLD',seller:{id:'external'}}}});
 assert.equal(result.geometryRouting.imageWork.nearPriceCalls,0);assert.equal(result.geometryRouting.imageWork.unprocessedOriginalCards,0);assert.ok(fetches.every(url=>!url.includes('?near=')));
});

test('bounded near-price image reallocation lets a newly observed near-price hint reach strict detail within the same eight reads',async t=>{
 const cheap=Array.from({length:20},(_,n)=>({...cards.at(-1),id:'cheap-image-'+n,price:700+n,image:weakImage+'?cheap='+n}));
 const near={...cards.at(-1),id:'near-geometry',price:28000,image:'https://fixtures.invalid/near-art.png'};
 const input=[...cards.slice(0,9),...cheap,near],accepted=[];
 for(const reallocate of [false,true]){
  configureImageFingerprintCache();const reads=[],fetches=[];
  t.mock.method(globalThis,'fetch',async url=>{fetches.push(url);return new Response(url===ownImage||url===near.image?bytes:weak,{headers:{'cache-control':'no-store'}})});
  const geometry=createBoundedGeometryRanker({execute:async input=>{
   const hashes=new Map(input.images.map(image=>[image.id,createHash('sha256').update(Buffer.from(image.base64,'base64')).digest('hex')]));
   return {value:{scope:'candidate_ranking_only',version:'harris_affine_rank_v1_offline',pairs:input.pairs.map(([queryId,candidateId])=>({queryId,candidateId,status:'visual_metrics_only',rankHint:hashes.get(queryId)===hashes.get(candidateId)?'same_artwork_candidate':'unresolved',identityVerified:false,canRecommend:false,queryContentSha256:hashes.get(queryId),candidateContentSha256:hashes.get(candidateId),metrics:{inliers:79,inlierFraction:.8,sourceCoverage:.5,targetCoverage:.5,alignedRgbMae:.1,alignedPixelFraction:.8}}))}};
  }});
  const result=await yahooCompare(null,item,{yahooGeometryPriority:true,yahooGeometryReallocate:reallocate,maxYahooDetailChecks:8},{geometryRanker:geometry,fetchYahooResult:async()=>({items:[]}),fetchYahooItemBundle:async id=>{
   if(id===item.id)return {detail:ownDetail,recommendations:input,observedAt:Date.now()};reads.push(id);
   return {detail:id===near.id?{...ownDetail,id,price:28000,seller:{id:'external'}}:{...ownDetail,id,price:500,seller:{id:'external'},title:'アクリルスタンド',description:'新品 アクリルスタンド1点'},observedAt:Date.now()};
  }});
  assert.equal(reads.length,8);assert.equal(result.geometryRouting.imageWork.selectedCalls,20);assert.equal(result.status,'incomplete');
  assert.equal(result.geometryRouting.prioritySlots,reallocate?1:0);
  assert.equal(reads.includes(near.id),reallocate);assert.equal(result.candidates.some(row=>row.id===near.id&&row.price===28000),reallocate);
  accepted.push(result.candidates.length);t.mock.restoreAll();
 }
 assert.deepEqual(accepted,[0,1]);
});
