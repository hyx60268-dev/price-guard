import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {carryYahooDetailQueueVersion,planYahooDetailQueue,yahooQueueOwnKey} from '../scripts/lib/yahoo-detail-queue.mjs';
import {yahooCompare} from '../scripts/lib/yahoo.mjs';
import {knownYahooRefreshTasks,runKnownYahooRefresh} from '../scripts/lib/yahoo-known-refresh.mjs';
import {MATCHING_RULES_VERSION} from '../scripts/lib/rules.mjs';
import {deferredYahooComparison,cachedComparison} from '../scripts/lib/pricing-coverage.mjs';
import {RequestDeferredError} from '../scripts/lib/request-cooldown.mjs';
import {compactDashboardResult} from '../scripts/lib/publish.mjs';
import {reconcileDurableState} from '../scripts/lib/state.mjs';
import {encrypt,decrypt} from '../scripts/lib/crypto.mjs';
import {pricingDecision} from '../public/pricing-policy.js';
import {buildOwnedOffers} from '../public/owned-offers.js';
import {violetQueueEvidence as evidence} from './fixtures/yahoo-violet-queue.mjs';

const NOW=Date.parse(evidence.checkedAt),MINUTE=60_000,OLD_RULES=MATCHING_RULES_VERSION-1;
const own={id:evidence.ownId,accountId:'melon',platform:'yahoo',comparisonMode:'same_platform',sellerId:'fixture-managed',title:evidence.report.ownTitle,ownPrice:28499,image:'fixture-own'};
const ownDetail={id:own.id,title:own.title,price:own.ownPrice,status:'OPEN',seller:{id:own.sellerId},description:'新品 未使用 フィギュア1点 特典付き',images:[own.image]};
const card=(id,price)=>({id,price,title:evidence.report.candidateTitle,image:'fixture-candidate',sellerId:evidence.report.sellerId,source:'recommendation',sources:['recommendation']});
const observed=evidence.rejected.map(row=>card(row.id,row.price)),rival=card(evidence.controlledRivalId,28000),cards=[...observed,rival];
const fp={dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[100,100,100],colorGrid:Array(768).fill(100)};
const text=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim();
// The historical persisted key schema is independently reconstructed here.
// Only observed rejection IDs/prices/reasons are real; all detail prose,
// availability, image fingerprints and the rival ID are controlled fixtures.
const historicalKey=(item=own,detail=ownDetail,version=OLD_RULES)=>createHash('sha256').update(JSON.stringify([
 version,item.accountId,item.id,item.platform||'yahoo',text(item.title),text(detail.title),text(detail.description),detail.condition||null,
 detail.seller?.id||detail.sellerId||'',(detail.images||[]).map(value=>typeof value==='string'?value:value?.url||''),detail.category||null
])).digest('hex');
function legacyQueue(item=own,{inspected=false,explicitVersion=false}={}){
 const detail={...ownDetail,id:item.id},queue=planYahooDetailQueue({item,detail,candidates:cards,now:NOW});
 observed.forEach((value,index)=>inspected?queue.record(value,new Date(NOW).toISOString()):queue.recordSchedulingAttempt(value,evidence.rejected[index].reason,new Date(NOW).toISOString()));
 const saved={...queue.snapshot(),ownKey:historicalKey(item,detail)};delete saved.rulesVersion;
 if(explicitVersion)saved.rulesVersion=OLD_RULES;
 return saved;
}
function legacyComparison(item=own){return {rulesVersion:OLD_RULES,status:'incomplete',checkedAt:new Date(NOW).toISOString(),searchCheckedAt:new Date(NOW).toISOString(),
 lowestPrice:item.ownPrice,recommendedPrice:item.ownPrice,candidates:[],audit:{accountId:item.accountId,ownItemId:item.id},detailQueue:legacyQueue(item)};}
function dependencies(reads,{deferAfter=Infinity,detailChange,ownValue=ownDetail}={}){
 return {imageFingerprints:async()=>fp,fetchYahooResult:async()=>({items:[]}),fetchYahooItemBundle:async id=>{
  if(id===own.id)return {detail:ownValue,recommendations:cards,shipping:{shippingKnown:true,shippingJPY:0,currency:'JPY',shippingSource:'target_price_area'}};
  reads.push(id);if(reads.length>deferAfter)throw new RequestDeferredError('request_cooldown_deadline',NOW+120*MINUTE);
  const value=cards.find(row=>row.id===id),reason=evidence.rejected.find(row=>row.id===id)?.reason;
  const detail={id,title:value.title,price:value.price,status:'OPEN',seller:{id:value.sellerId},images:[value.image],description:'新品 未使用 フィギュア1点 特典付き'};
  if(reason==='physical_product_type_unconfirmed'){detail.title='ヴァイオレット・エヴァーガーデン 缶バッジ';detail.description='新品 未使用 缶バッジ1点';}
  if(reason==='sale_description_unavailable')detail.description='';
  detailChange?.(detail);return {detail,shipping:{shippingKnown:true,shippingJPY:0,currency:'JPY',shippingSource:'target_price_area'}};
 }};
}
const plan=(prior,changes={})=>planYahooDetailQueue({item:own,detail:ownDetail,candidates:cards,prior,priorRulesVersion:OLD_RULES,now:NOW+20*MINUTE,...changes});

test('matching historical identity migrates only ordering and retains eight-detail discovery capacity',()=>{
 const saved=legacyQueue(),before=structuredClone(saved),queue=plan(saved);
 assert.equal(historicalKey(own,ownDetail,MATCHING_RULES_VERSION),yahooQueueOwnKey(own,ownDetail));
 assert.deepEqual(queue.cards.map(row=>row.id),[observed[1].id,rival.id]);assert.equal(queue.deferredCount,7);
 const migrated=queue.snapshot();assert.equal(migrated.ownKey,yahooQueueOwnKey(own,ownDetail));assert.equal(migrated.rulesVersion,MATCHING_RULES_VERSION);
 assert.deepEqual(migrated.schedulingAttempts,saved.schedulingAttempts);assert.deepEqual(migrated.attempts,[]);
 for(const key of ['checkedAt','searchCheckedAt','candidates','lowestPrice','recommendedPrice'])assert.equal(migrated[key],undefined);
 assert.deepEqual(saved,before);
 const inspected=plan(legacyQueue(own,{inspected:true}));assert.deepEqual(inspected.cards.slice(0,8).map(row=>row.id),observed.map(row=>row.id));
 assert.equal(inspected.snapshot().attempts.length,0,'historical accepted/rejected inspections never cross rules');
 const mixed={...saved,attempts:legacyQueue(own,{inspected:true}).attempts},mixedMigration=plan(mixed).snapshot();
 assert.deepEqual(mixedMigration.attempts,[]);assert.equal(mixedMigration.schedulingAttempts.length,8);
 const currentInspected={...legacyQueue(own,{inspected:true}),ownKey:yahooQueueOwnKey(own,ownDetail),rulesVersion:MATCHING_RULES_VERSION};
 assert.equal(plan(currentInspected).snapshot().attempts.length,8,'same-rule inspected ordering remains unchanged');
 // A queue carries independent provenance after a newer known-only quote.
 assert.equal(plan(legacyQueue(own,{explicitVersion:true}),{priorRulesVersion:MATCHING_RULES_VERSION}).deferredCount,7);
});

test('missing, malformed, future, conflicting version or key cannot migrate ordering',()=>{
 const saved=legacyQueue();
 for(const version of [undefined,null,0,-1,1.5,String(OLD_RULES),NaN,Infinity,MATCHING_RULES_VERSION,MATCHING_RULES_VERSION+1]){
  for(const explicit of [false,true]){
   const prior=explicit?{...saved,rulesVersion:version}:saved,queue=plan(prior,{priorRulesVersion:version});
   assert.equal(queue.deferredCount,0);assert.equal(queue.snapshot().schedulingAttempts.length,0);
  }
 }
 for(const key of [null,'bad','a'.repeat(64),historicalKey(own,ownDetail,OLD_RULES-1)])assert.equal(plan({...saved,ownKey:key}).deferredCount,0);
 const current={...saved,ownKey:yahooQueueOwnKey(own,ownDetail),rulesVersion:OLD_RULES};
 assert.equal(plan(current).deferredCount,0,'a label contradicting a current key is not guessed');
 for(const version of [0,1.5,MATCHING_RULES_VERSION+1])assert.equal(plan({...current,rulesVersion:version}).deferredCount,0);
});

test('changed or incomplete own identity never inherits historical ordering',()=>{
 const saved=legacyQueue();
 for(const changes of [
  {item:{...own,accountId:'other'}},{item:{...own,id:'relisted'},detail:{...ownDetail,id:'relisted'}},{item:{...own,platform:'rakuma'}},
  {item:{...own,title:own.title+' 別仕様'}},{detail:{...ownDetail,id:'wrong'}},{detail:{...ownDetail,title:ownDetail.title+' 別仕様'}},
  {detail:{...ownDetail,description:ownDetail.description+' 2点セット'}},{detail:{...ownDetail,condition:'中古'}},
  {detail:{...ownDetail,images:['different-primary']}},{detail:{...ownDetail,seller:{id:'different-seller'}}},
  {detail:{...ownDetail,category:{name:'different-category'}}},{detail:{...ownDetail,status:'SOLD'}},
  {detail:{...ownDetail,status:undefined}},{detail:{...ownDetail,description:''}},{detail:{...ownDetail,seller:null}},{detail:{...ownDetail,images:[]}}
 ]){
  const queue=plan(saved,changes);assert.equal(queue.deferredCount,0);assert.equal(queue.snapshot()?.schedulingAttempts.length||0,0);
 }
});

test('every historical card revalidates its key and bounded scheduling row before migration',()=>{
 const saved=legacyQueue();
 for(const changed of [{id:'relisted-card'},{title:'new title'},{image:'new image'},{sellerId:'new seller'},{price:400}]){
  const current=cards.map((row,index)=>index===0?{...row,...changed}:row),queue=plan(saved,{candidates:current});
  assert.equal(queue.snapshot().schedulingAttempts.length,7);assert.ok(queue.cards.some(row=>row.id===(changed.id||observed[0].id)));
 }
 for(const changes of [{key:'wrong'},{count:0},{count:99},{reason:'verified'},{retryAt:'2099-01-01T00:00:00Z'}]){
  const prior={...saved,schedulingAttempts:saved.schedulingAttempts.map((row,index)=>index===0?{...row,...changes}:row)};
  assert.equal(plan(prior).snapshot().schedulingAttempts.length,7);
 }
 const dirty={...saved,schedulingAttempts:saved.schedulingAttempts.map(row=>({...row,price:1,checkedAt:'2099-01-01',candidates:[rival]}))};
 assert.deepEqual(plan(dirty).snapshot().schedulingAttempts,saved.schedulingAttempts);
 assert.equal(plan(saved,{candidates:[]}).snapshot().schedulingAttempts.length,0);
 assert.equal(plan(saved,{now:NOW+61*MINUTE}).deferredCount,0,'historical retry expiry remains finite');
});

for(const accountId of ['melon','local-1789214704376','account-p6579087'])test(`${accountId}: actual comparison resumes historical unresolved queue and fully verifies the unseen offer`,async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW+20*MINUTE});
 const item={...own,accountId},prior=legacyComparison(item),before=structuredClone(prior),reads=[];
 assert.equal(cachedComparison(prior),null);assert.equal(pricingDecision({...item,yahoo:prior}).canRecommend,false);
 const result=await yahooCompare(null,{...item,yahoo:prior},{forceYahooBroadSearch:true},dependencies(reads));
 assert.deepEqual(reads,[observed[1].id,rival.id]);assert.equal(result.detailCheckedCount,2);assert.equal(result.candidates[0].id,rival.id);
 assert.equal(result.candidates[0].price,28000);assert.equal(result.rulesVersion,MATCHING_RULES_VERSION);assert.equal(result.detailQueue.rulesVersion,MATCHING_RULES_VERSION);
 assert.equal(result.status,'incomplete');assert.ok(result.uncheckedLowerCandidateCount>=7);assert.equal(result.plausibleMinPrice,500);
 assert.deepEqual(prior,before);
});

test('historical inspected accept/reject ordering cannot skip current full verification',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW+20*MINUTE});
 const prior={...legacyComparison(),detailQueue:legacyQueue(own,{inspected:true})},reads=[];
 const result=await yahooCompare(null,{...own,yahoo:prior},{forceYahooBroadSearch:true},dependencies(reads,{detailChange:detail=>{
  detail.title=evidence.report.candidateTitle;detail.description='新品 未使用 フィギュア1点 特典付き';
 }}));
 assert.deepEqual(reads,observed.map(row=>row.id),'all eight old inspections must be checked under current rules again');
 assert.equal(result.detailCheckedCount,8);assert.equal(result.competitorCount,8);assert.equal(result.rulesVersion,MATCHING_RULES_VERSION);
 assert.ok(result.detailQueue.attempts.every(row=>Date.parse(row.at)===Date.now()),'only new full inspections create current inspected ordering');
});

test('historical known-offer refresh advances quote rules but preserves old queue provenance for later broad migration',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW+20*MINUTE});
 const prior={...legacyComparison(),candidates:[{...rival,price:27000,matchMethod:'exact_bidirectional_title_identity'}]},item={...own,yahoo:prior};
 const context={account:{id:own.accountId},activeItems:[own],previousById:new Map([[own.id,item]])};
 const tasks=knownYahooRefreshTasks([context],{},Date.now());assert.equal(tasks.length,1);
 const knownReads=[],results=await runKnownYahooRefresh(tasks,{deadline:Date.now()+120000,lookup:({item,prior})=>yahooCompare(null,{...item,yahoo:prior.yahoo},{yahooKnownOnly:true},dependencies(knownReads))});
 const value=[...results.values()][0].value;assert.deepEqual(knownReads,[rival.id]);assert.equal(value.rulesVersion,MATCHING_RULES_VERSION);
 assert.equal(value.candidates[0].price,28000);assert.equal(value.detailQueue.rulesVersion,OLD_RULES);assert.equal(value.detailQueue.ownKey,prior.detailQueue.ownKey);
 assert.deepEqual(value.detailQueue.schedulingAttempts,prior.detailQueue.schedulingAttempts);assert.equal(prior.detailQueue.rulesVersion,undefined);
 const broadReads=[],broad=await yahooCompare(null,{...own,yahoo:value},{forceYahooBroadSearch:true},dependencies(broadReads));
 assert.ok(broadReads.includes(rival.id));assert.ok(broadReads.length<=2);assert.equal(broad.detailQueue.rulesVersion,MATCHING_RULES_VERSION);
 assert.equal(broad.detailQueue.ownKey,yahooQueueOwnKey(own,ownDetail));assert.equal(broad.detailQueue.schedulingAttempts.length,8);
});

test('legacy current-key checkpoint with an old quote keeps progress through known-only refresh and broad continuation',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW+20*MINUTE});
 const prior={...legacyComparison(),detailQueue:undefined,candidates:[{...rival,price:27000,matchMethod:'exact_bidirectional_title_identity'}]},item={...own,yahoo:prior};
 let failure;try{await yahooCompare(null,item,{forceYahooBroadSearch:true},dependencies([],{deferAfter:1}));}catch(error){failure=error;}
 assert.equal(failure?.code,'request_deferred');
 const checkpointed=deferredYahooComparison(prior,failure,item);assert.equal(checkpointed.rulesVersion,OLD_RULES);
 assert.equal(checkpointed.detailQueue.ownKey,yahooQueueOwnKey(own,ownDetail));
 delete checkpointed.detailQueue.rulesVersion; // Exact legacy deferred-checkpoint shape.
 const before=structuredClone(checkpointed),knownReads=[];
 const refreshed=await yahooCompare(null,{...own,yahoo:checkpointed},{yahooKnownOnly:true},dependencies(knownReads));
 assert.deepEqual(knownReads,[rival.id]);assert.equal(refreshed.rulesVersion,MATCHING_RULES_VERSION);
 assert.equal(refreshed.detailQueue.rulesVersion,MATCHING_RULES_VERSION,'prove the current key rather than copy the old quote version');
 assert.deepEqual(refreshed.detailQueue.schedulingAttempts,checkpointed.detailQueue.schedulingAttempts);
 assert.deepEqual(checkpointed,before);
 const reads=[],broad=await yahooCompare(null,{...own,yahoo:refreshed},{forceYahooBroadSearch:true},dependencies(reads));
 assert.equal(reads.includes(observed[0].id),false,'the completed unresolved checkpoint is not forgotten');
 assert.ok(reads.includes(rival.id));assert.ok(reads.length<=8);
 assert.ok(broad.detailQueue.schedulingAttempts.some(row=>row.id===observed[0].id));
});

test('known-only queue provenance helper leaves unknown or conflicting identities unguessed',()=>{
 const saved=legacyQueue(),before=structuredClone(saved);
 const carry=(prior=saved,changes={})=>carryYahooDetailQueueVersion({item:own,detail:ownDetail,prior,priorRulesVersion:OLD_RULES,...changes});
 assert.equal(carry().rulesVersion,OLD_RULES);assert.deepEqual(saved,before);
 for(const prior of [{...saved,ownKey:'unknown'},{...saved,ownKey:historicalKey(own,ownDetail,OLD_RULES-1)}])assert.equal(carry(prior).rulesVersion,undefined);
 for(const priorRulesVersion of [undefined,null,0,-1,1.5,String(OLD_RULES),MATCHING_RULES_VERSION+1])assert.equal(carry(saved,{priorRulesVersion}).rulesVersion,undefined);
 for(const detail of [{...ownDetail,status:'SOLD'},{...ownDetail,description:''},{...ownDetail,images:['changed']},{...ownDetail,seller:{id:'other'}}])assert.equal(carry(saved,{detail}).rulesVersion,undefined);
 const currentKey=yahooQueueOwnKey(own,ownDetail),conflicting={...saved,ownKey:currentKey,rulesVersion:OLD_RULES};
 assert.deepEqual(carry(conflicting),conflicting,'do not overwrite explicit contradictory provenance');
 assert.equal(plan(carry(conflicting)).deferredCount,0);
});

test('migrated ordering survives deferred checkpoint, encryption, compaction and reconciliation without upgrading old quotes',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW+20*MINUTE});
 const prior=legacyComparison(),item={...own,yahoo:prior},reads=[];let failure;
 try{await yahooCompare(null,item,{forceYahooBroadSearch:true},dependencies(reads,{deferAfter:1}));}catch(error){failure=error;}
 assert.equal(failure?.code,'request_deferred');assert.deepEqual(reads,[observed[1].id,rival.id]);
 const saved=deferredYahooComparison(prior,failure,item);assert.equal(saved.detailQueue.rulesVersion,MATCHING_RULES_VERSION);
 assert.equal(saved.detailQueue.ownKey,yahooQueueOwnKey(own,ownDetail));assert.equal(saved.detailQueue.schedulingAttempts.length,8);
 for(const key of ['rulesVersion','checkedAt','searchCheckedAt','candidates','lowestPrice','recommendedPrice'])assert.deepEqual(saved[key],prior[key],key);
 const state={checkedAt:new Date().toISOString(),accounts:[{id:own.accountId,profileStatus:'live'}],items:[{...own,yahoo:saved}]};
 const restored=JSON.parse(decrypt(encrypt(Buffer.from(JSON.stringify(state)),'fixture-password'),'fixture-password'));
 const compact=compactDashboardResult(restored,{now:Date.now()}),reconciled=reconcileDurableState({},compact),resumedItem=reconciled.items[0];
 assert.deepEqual(resumedItem.yahoo.detailQueue,saved.detailQueue);assert.equal(pricingDecision(resumedItem).canRecommend,false);
 const retryReads=[],result=await yahooCompare(null,resumedItem,{forceYahooBroadSearch:true},dependencies(retryReads));
 assert.deepEqual(retryReads,[rival.id]);assert.equal(result.candidates[0].price,28000);assert.equal(result.detailCheckedCount,1);
});

test('migrated queue cannot bypass current ownership, correction, availability or quantity checks',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW+20*MINUTE});const item={...own,yahoo:legacyComparison()};
 const ownership=buildOwnedOffers([{id:'other-managed',platform:'yahoo',sellerId:rival.sellerId}]);
 const managed=await yahooCompare(null,item,{ownedOffers:ownership},dependencies([]));assert.equal(managed.candidates.length,0);
 const correction={accountId:own.accountId,itemId:own.id,platform:'yahoo',candidateId:rival.id,updatedAt:new Date().toISOString()};
 const corrected=await yahooCompare(null,item,{matchCorrections:{fixture:correction}},dependencies([]));assert.equal(corrected.candidates.length,0);
 for(const change of [detail=>{detail.status='SOLD';},detail=>{detail.description+=' フィギュア12体セットです。';}]){
  const reads=[],result=await yahooCompare(null,item,{},dependencies(reads,{detailChange:detail=>{if(detail.id===rival.id)change(detail);}}));
  assert.ok(reads.includes(rival.id));assert.equal(result.candidates.length,0);assert.ok(result.rejected.some(row=>row.id===rival.id));
 }
});
