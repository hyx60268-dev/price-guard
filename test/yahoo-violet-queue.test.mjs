import test from 'node:test';
import assert from 'node:assert/strict';
import {yahooCompare} from '../scripts/lib/yahoo.mjs';
import {planYahooDetailQueue} from '../scripts/lib/yahoo-detail-queue.mjs';
import {pricingDecision} from '../public/pricing-policy.js';
import {buildOwnedOffers} from '../public/owned-offers.js';
import {RequestDeferredError} from '../scripts/lib/request-cooldown.mjs';
import {violetQueueEvidence as evidence} from './fixtures/yahoo-violet-queue.mjs';

const NOW=Date.parse(evidence.checkedAt),MINUTE=60_000;
const report=evidence.report,url=id=>`https://paypayfleamarket.yahoo.co.jp/item/${id}`;
const fp={dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[100,100,100],colorGrid:Array(768).fill(100)};
// Prices, IDs and rejection reasons above are real observations. All detail
// prose, card titles, OPEN flags and fingerprints below are CONTROLLED fixtures.
const own={id:evidence.ownId,accountId:'melon',platform:'yahoo',comparisonMode:'same_platform',sellerId:'fixture-managed',title:report.ownTitle,ownPrice:28499,image:'fixture-own',url:url(evidence.ownId)};
const ownDetail={id:own.id,title:own.title,price:own.ownPrice,status:'OPEN',seller:{id:own.sellerId},description:'新品 未使用 フィギュア1点 特典付き',images:[own.image]};
const card=(id,price)=>({id,price,title:report.candidateTitle,image:'fixture-candidate',sellerId:report.sellerId,url:url(id),source:'recommendation',sources:['recommendation']});
const observedCards=evidence.rejected.map(row=>card(row.id,row.price));
const rival=card(evidence.controlledRivalId,28000);
function dependencies(reads,{cards=[...observedCards,rival],error,changeDetail}={}){
 return {
  fetchYahooResult:async()=>({items:[]}),imageFingerprints:async()=>fp,
  fetchYahooItemBundle:async id=>{
   if(id===own.id)return {detail:ownDetail,recommendations:cards};
   reads.push(id);if(error)throw error;
   const observed=evidence.rejected.find(row=>row.id===id),value=cards.find(row=>row.id===id);
   const detail={id,title:value.title,price:value.price,status:'OPEN',seller:{id:value.sellerId},images:['fixture-candidate'],description:'新品 未使用 フィギュア1点 特典付き'};
   if(observed?.reason==='physical_product_type_unconfirmed'){detail.title='ヴァイオレット・エヴァーガーデン 缶バッジ';detail.description='新品 未使用 缶バッジ1点';}
   if(observed?.reason==='sale_description_unavailable')detail.description='';
   changeDetail?.(detail);return {detail};
  }
 };
}

for(const accountId of ['melon','local-1789214704376','account-p6579087'])test(`${accountId}: actual eight unresolved outcomes rotate without increasing the eight-detail budget`,async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW});
 const item={...own,accountId},reads1=[],first=await yahooCompare(null,item,{},dependencies(reads1));
 assert.equal(first.detailCheckedCount,8);assert.equal(first.candidates.length,0);
 assert.deepEqual(first.rejected.slice(-8).map(({id,price,reason})=>({id,price,reason})),evidence.rejected);
 assert.equal(first.detailQueue.attempts.length,0,'unconfirmed data is not marked inspected');
 assert.equal(first.detailQueue.schedulingAttempts.length,8);
 assert.ok(first.detailQueue.schedulingAttempts.every(row=>!('checkedAt' in row)&&!('searchCheckedAt' in row)));
 const frozen=structuredClone(first),reads2=[];
 t.mock.timers.tick(20*MINUTE);
 // Legacy caller persisted no attempt for these eight reasons. Removing only
 // the new scheduling ledger reproduces that state through actual yahooCompare.
 const legacyPrior={...first,detailQueue:{...first.detailQueue,schedulingAttempts:[]}},legacyReads=[];
 const legacySecond=await yahooCompare(null,{...item,yahoo:legacyPrior},{},dependencies(legacyReads));
 assert.equal(reads1.length+legacyReads.length,16);assert.equal(new Set([...reads1,...legacyReads]).size,8);
 assert.equal(legacySecond.candidates.length,0);
 const second=await yahooCompare(null,{...item,yahoo:first},{},dependencies(reads2));
 assert.deepEqual(first,frozen,'prior evidence and original clocks are immutable');
 assert.ok(second.detailCheckedCount<=8);assert.ok(reads2.includes(rival.id));
 assert.equal(reads2.length,2,'one due description retry plus the unseen same-model fixture');
 assert.equal(reads1.length+reads2.length,10);
 assert.equal(new Set([...reads1,...reads2]).size,9);
 assert.equal(second.candidates[0].id,rival.id);assert.equal(second.candidates[0].price,28000);
 assert.equal(second.status,'incomplete','backed-off unknowns remain unresolved');
 assert.ok(second.uncheckedLowerCandidateCount>=7);
 assert.equal(second.plausibleMinPrice,500,'backoff cannot erase the lower raise guard');
 const decision=pricingDecision({...item,yahoo:second});
 assert.equal(decision.complete,false);assert.equal(decision.recommendedPrice,27999);
});

test('before/after ordering replay: old callback repeats the same eight, scheduling memory reaches the ninth',()=>{
 const make=prior=>planYahooDetailQueue({item:own,detail:ownDetail,candidates:[...observedCards,rival],prior,now:NOW});
 const first=make(),oldNext=make(first.snapshot());
 assert.deepEqual(oldNext.cards.slice(0,8).map(c=>c.id),observedCards.map(c=>c.id));
 observedCards.forEach((value,index)=>first.recordSchedulingAttempt(value,evidence.rejected[index].reason,new Date(NOW).toISOString()));
 const fixedNext=make(first.snapshot());assert.deepEqual(fixedNext.cards.map(c=>c.id),[rival.id]);
 assert.equal(fixedNext.deferredCount,8);assert.equal(first.snapshot().attempts.length,0);
});

test('a new genuinely cheap matching offer still gets a slot and normal full verification',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW});
 const first=await yahooCompare(null,own,{},dependencies([]));
 const cheap=card('fixture-genuine-cheap',400),reads=[];
 const next=await yahooCompare(null,{...own,yahoo:first},{},dependencies(reads,{cards:[...observedCards,cheap,rival]}));
 assert.equal(reads[0],cheap.id);assert.ok(next.candidates.some(c=>c.id===cheap.id&&c.price===400));
 assert.ok(next.detailCheckedCount<=8);
});

test('unconfirmed details retry after finite backoff and can recover with the same card identity',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW});
 const first=await yahooCompare(null,own,{},dependencies([],{cards:observedCards}));
 const reads=[],early=await yahooCompare(null,{...own,yahoo:first},{},dependencies(reads,{cards:observedCards}));
 assert.equal(reads.length,0);assert.equal(early.candidates.length,0);assert.equal(early.status,'incomplete');
 assert.equal(early.preliminaryCount,8);assert.equal(early.uncheckedLowerCandidateCount,8);
 t.mock.timers.tick(61*MINUTE);
 const retryReads=[],recovered=await yahooCompare(null,{...own,yahoo:early},{},dependencies(retryReads,{cards:observedCards,changeDetail:detail=>{detail.title=report.candidateTitle;detail.description='新品 未使用 フィギュア1点 特典付き';}}));
 assert.equal(retryReads.length,8);assert.equal(recovered.competitorCount,8);
 assert.equal(recovered.detailQueue.schedulingAttempts.length,0,'resolved responses clear scheduling backoff');
});

test('source holds, 403, 429, network failures and wrong target responses never create scheduling evidence',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW});
 for(const error of [Object.assign(Error('403'),{httpStatus:403}),Object.assign(Error('429'),{httpStatus:429}),Error('network')]){
  const result=await yahooCompare(null,own,{},dependencies([],{cards:observedCards,error}));
  assert.equal(result.candidates.length,0);assert.equal(result.detailQueue.attempts.length,0);assert.equal(result.detailQueue.schedulingAttempts.length,0);
 }
 const prior={sentinel:'unchanged'},item={...own,yahoo:prior};
 await assert.rejects(yahooCompare(null,item,{},dependencies([],{error:new RequestDeferredError('request_cooldown_deadline')})),{code:'request_deferred'});
 assert.deepEqual(prior,{sentinel:'unchanged'});
 const wrong=await yahooCompare(null,own,{},dependencies([],{cards:observedCards,changeDetail:detail=>{detail.id='different-target';}}));
 assert.equal(wrong.detailQueue.attempts.length,0);assert.equal(wrong.detailQueue.schedulingAttempts.length,0);
});

test('rotating unknown cards cannot revive SOLD or any managed-account offer',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW});
 const first=await yahooCompare(null,own,{},dependencies([]));
 const sold=await yahooCompare(null,{...own,yahoo:first},{},dependencies([],{changeDetail:detail=>{if(detail.id===rival.id)detail.status='SOLD';}}));
 assert.equal(sold.candidates.length,0);assert.ok(sold.rejected.some(c=>c.id===rival.id&&c.reason==='not_open'));
 const ownedOffers=buildOwnedOffers([{id:'other-managed',platform:'yahoo',sellerId:report.sellerId}]);
 const managed=await yahooCompare(null,{...own,yahoo:first},{ownedOffers},dependencies([]));
 assert.equal(managed.candidates.length,0);assert.equal(managed.detailCheckedCount,0);
 const correction={accountId:own.accountId,itemId:own.id,platform:'yahoo',candidateId:rival.id,updatedAt:new Date(NOW).toISOString()};
 const corrected=await yahooCompare(null,{...own,yahoo:first},{matchCorrections:{fixture:correction}},dependencies([]));
 assert.equal(corrected.candidates.length,0);assert.ok(corrected.rejected.some(c=>c.id===rival.id&&c.reason==='saved_user_correction'));
});

test('scheduling memory is bound to exact own and candidate identity, with bounded retries',()=>{
 const base=planYahooDetailQueue({item:own,detail:ownDetail,candidates:observedCards,now:NOW});
 observedCards.forEach((c,index)=>base.recordSchedulingAttempt(c,evidence.rejected[index].reason,new Date(NOW).toISOString()));
 const saved=base.snapshot(),make=(changes={})=>planYahooDetailQueue({item:own,detail:ownDetail,candidates:observedCards,prior:saved,now:NOW,...changes});
 for(const changes of [
  {item:{...own,accountId:'other'}},{item:{...own,id:'relisted'},detail:{...ownDetail,id:'relisted'}},
  {item:{...own,title:own.title+' changed'}},{detail:{...ownDetail,description:'changed sale specification'}},
  {detail:{...ownDetail,condition:'傷あり'}},{detail:{...ownDetail,images:['changed']}},
  {detail:{...ownDetail,seller:{id:'different-owner'}}}
 ])assert.equal(make(changes).cards.length,8);
 for(const change of [{id:'new-card'},{price:450},{title:'new title'},{image:'new image'},{sellerId:'new seller'}]){
  const cards=observedCards.map((c,index)=>index===2?{...c,...change}:c),result=make({candidates:cards});
  assert.deepEqual(result.cards.map(c=>c.id),[cards[2].id]);
 }
 const removed=make({candidates:[]}).snapshot();assert.equal(removed.schedulingAttempts.length,0);
 let prior=saved,at=NOW;
 for(let n=0;n<6;n++){
  at+=61*MINUTE;const queue=make({prior,now:at});
  assert.equal(queue.cards.length,8,'expired unresolved data is retryable');
  queue.recordSchedulingAttempt(observedCards[1],'sale_description_unavailable',new Date(at).toISOString());
  prior=queue.snapshot();const row=prior.schedulingAttempts.find(r=>r.id===observedCards[1].id);
  assert.ok(Date.parse(row.retryAt)-Date.parse(row.attemptedAt)<=60*MINUTE);
  assert.ok(Date.parse(row.retryAt)-Date.parse(row.attemptedAt)>=20*MINUTE);
 }
 const forged={...saved,schedulingAttempts:saved.schedulingAttempts.map(row=>({...row,retryAt:'2099-01-01T00:00:00Z'}))};
 assert.equal(make({prior:forged}).cards.length,8,'invalid persisted times cannot create a permanent exclusion');
});

test('due retry and two known offers share the same eight slots without starving fresh discovery',()=>{
 const extras=Array.from({length:20},(_,n)=>card('fixture-unread-'+n,1200+n));
 const cards=[...observedCards,...extras,rival],knownIds=new Set([extras[0].id,extras[1].id]);
 const first=planYahooDetailQueue({item:own,detail:ownDetail,candidates:cards,now:NOW,knownIds});
 observedCards.forEach((c,index)=>first.recordSchedulingAttempt(c,evidence.rejected[index].reason,new Date(NOW).toISOString()));
 const next=planYahooDetailQueue({item:own,detail:ownDetail,candidates:cards,now:NOW+61*MINUTE,knownIds,prior:first.snapshot()});
 const selected=next.cards.slice(0,8).map(c=>c.id);
 assert.deepEqual(selected.slice(0,2),[extras[0].id,extras[1].id]);
 assert.equal(selected[2],observedCards[0].id,'lowest eligible unknown remains reserved');
 assert.equal(selected[3],observedCards[1].id,'oldest due retry gets one existing slot');
 assert.deepEqual(selected.slice(4),extras.slice(2,6).map(c=>c.id));
 assert.equal(new Set(selected).size,8);
});
