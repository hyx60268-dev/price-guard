import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {yahooCompare} from '../scripts/lib/yahoo.mjs';
import {planYahooDetailQueue,withYahooSchedulingCheckpoint,deferredYahooDetailQueue} from '../scripts/lib/yahoo-detail-queue.mjs';
import {deferredYahooComparison,pricingCoverage} from '../scripts/lib/pricing-coverage.mjs';
import {RequestDeferredError} from '../scripts/lib/request-cooldown.mjs';
import {MATCHING_RULES_VERSION} from '../scripts/lib/rules.mjs';
import {compactDashboardResult} from '../scripts/lib/publish.mjs';
import {reconcileDurableState} from '../scripts/lib/state.mjs';
import {encrypt,decrypt} from '../scripts/lib/crypto.mjs';
import {pricingDecision} from '../public/pricing-policy.js';
import {buildOwnedOffers} from '../public/owned-offers.js';
import {violetQueueEvidence as evidence} from './fixtures/yahoo-violet-queue.mjs';

const NOW=Date.parse(evidence.checkedAt),MINUTE=60_000,OLD=new Date(NOW-10*MINUTE).toISOString();
const own={id:evidence.ownId,accountId:'melon',platform:'yahoo',comparisonMode:'same_platform',sellerId:'fixture-managed',title:evidence.report.ownTitle,ownPrice:28499,image:'fixture-own'};
const ownDetail={id:own.id,title:own.title,price:own.ownPrice,status:'OPEN',seller:{id:own.sellerId},description:'新品 未使用 フィギュア1点 特典付き',images:[own.image]};
const card=(id,price)=>({id,price,title:evidence.report.candidateTitle,image:'fixture-candidate',sellerId:evidence.report.sellerId,source:'recommendation',sources:['recommendation']});
const observed=evidence.rejected.map(row=>card(row.id,row.price)),rival=card(evidence.controlledRivalId,28000);
const fp={dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[100,100,100],colorGrid:Array(768).fill(100)};
const baseline=()=>({rulesVersion:MATCHING_RULES_VERSION,status:'incomplete',checkedAt:OLD,searchCheckedAt:OLD,
 lowestPrice:28499,recommendedPrice:28499,candidates:[],cardCount:185,preliminaryCount:86,detailCheckedCount:8,competitorCount:0,
 uncheckedLowerCandidateCount:64,unconfirmedLowerCandidateCount:1,rejected:[{id:'old-rejection',reason:'detail_error'}]});
const hold=()=>Object.assign(new RequestDeferredError('request_cooldown_deadline',NOW+60*MINUTE),{httpStatus:429,retryAfter:'3600'});
// Only IDs/prices/reasons come from production. Prose, images and the umbrella
// rival ID remain controlled fixtures; this cannot establish a live match.
function deps(reads,{cards=[...observed,rival],deferAfter=Infinity,error=hold(),ownValue=ownDetail,detailChange,stage}={}){
 return {imageFingerprints:async()=>fp,fetchYahooResult:async()=>{if(stage==='search')throw error;return {items:[]};},
  fetchYahooItemBundle:async id=>{
   if(id===own.id){if(stage==='own')throw error;return {detail:ownValue,recommendations:cards};}
   reads.push(id);if(reads.length>deferAfter)throw error;
   const value=cards.find(row=>row.id===id),reason=evidence.rejected.find(row=>row.id===id)?.reason;
   const detail={id,title:value.title,price:value.price,status:'OPEN',seller:{id:value.sellerId},images:['fixture-candidate'],description:'新品 未使用 フィギュア1点 特典付き'};
   if(reason==='physical_product_type_unconfirmed'){detail.title='ヴァイオレット・エヴァーガーデン 缶バッジ';detail.description='新品 未使用 缶バッジ1点';}
   if(reason==='sale_description_unavailable')detail.description='';
   detailChange?.(detail,reads.length);return {detail};
  }};
}
async function interrupted(item,dependencies,settings={}){
 try{await yahooCompare(null,item,{forceYahooBroadSearch:true,...settings},dependencies);}catch(error){assert.equal(error.code,'request_deferred');return error;}
 assert.fail('expected an interrupted comparison');
}
function assertOldEvidence(value,prior){
 for(const field of ['checkedAt','searchCheckedAt','lowestPrice','recommendedPrice','candidates','rejected','cardCount','preliminaryCount','detailCheckedCount','competitorCount','uncheckedLowerCandidateCount','unconfirmedLowerCandidateCount'])assert.deepEqual(value[field],prior[field],field);
 assert.equal(value.cacheReason,'request_error');assert.equal(value.deferredReason,'request_cooldown_deadline');
}

for(const accountId of ['melon','local-1789214704376','account-p6579087'])test(`${accountId}: actual partial compare checkpoints only completed unknown attempts and resumes after persistence`,async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW});
 const prior=baseline(),frozen=structuredClone(prior),item={...own,accountId,yahoo:prior},reads=[],sourceError=hold();
 const error=await interrupted(item,deps(reads,{deferAfter:2,error:sourceError}));
 assert.notEqual(error,sourceError);assert.equal(error.cause,sourceError);assert.equal(error.reason,sourceError.reason);
 assert.equal(error.retryAt,sourceError.retryAt);assert.equal(error.httpStatus,429);assert.equal(error.retryAfter,'3600');
 assert.equal(deferredYahooDetailQueue(sourceError,item),undefined,'shared source errors never acquire item memory');
 const saved=deferredYahooComparison(prior,error,item);assertOldEvidence(saved,prior);assert.deepEqual(prior,frozen);
 assert.deepEqual(saved.detailQueue.lastSchedulingSelection,observed.slice(0,2).map(c=>c.id));
 assert.equal(saved.detailQueue.schedulingAttempts.length,2);assert.equal(saved.detailQueue.attempts.length,0);
 assert.deepEqual(saved.detailQueue.lastSelection,[]);
 assert.ok(saved.detailQueue.schedulingAttempts.every(row=>!('checkedAt' in row)&&!('price' in row)));
 assert.equal(saved.detailQueue.schedulingAttempts.some(row=>row.id===reads[2]),false,'deferred third request has no completed record');
 const state={checkedAt:new Date(NOW).toISOString(),items:[{...item,yahoo:saved}],accounts:[{id:accountId,profileStatus:'live'}],yahooRequestAccess:{reason:'http_429',retryAt:'indefinite'}};
 const restored=JSON.parse(decrypt(encrypt(Buffer.from(JSON.stringify(state)),'fixture-password'),'fixture-password'));
 const compact=compactDashboardResult(restored,{now:NOW});
 const reconciled=reconcileDurableState({},compact),restoredItem=reconciled.items[0];
 assert.deepEqual(restoredItem.yahoo.detailQueue,saved.detailQueue);assert.deepEqual(reconciled.yahooRequestAccess,state.yahooRequestAccess);
 assert.equal(pricingDecision(restoredItem,{now:NOW}).canRecommend,false);assert.equal(pricingCoverage([restoredItem],state.accounts).complete,false);
 t.mock.timers.tick(MINUTE);const retryReads=[];
 const retry=await yahooCompare(null,restoredItem,{forceYahooBroadSearch:true},deps(retryReads));
 assert.equal(retryReads[0],observed[2].id);assert.equal(retryReads.length,7);assert.ok(retryReads.includes(rival.id));
 assert.ok(retry.detailCheckedCount<=8);assert.equal(retry.candidates[0].id,rival.id);
 assert.equal(retry.status,'incomplete');assert.ok(retry.uncheckedLowerCandidateCount>=2);assert.equal(retry.plausibleMinPrice,500);
 assert.equal(saved.checkedAt,OLD);assert.equal(saved.searchCheckedAt,OLD);
});

test('no completed attempt, no prior, early own/search deferral and accepted-only reads do not invent progress',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW});
 for(const stage of [undefined,'own','search']){
  const sourceError=hold(),error=await interrupted(own,deps([],{stage,deferAfter:0,error:sourceError}));
  assert.equal(error,sourceError);const saved=deferredYahooComparison(undefined,error,own);
  assert.equal(saved.checkedAt,null);assert.equal(saved.searchCheckedAt,undefined);assert.equal(saved.detailQueue,undefined);assert.equal(saved.status,'deferred_budget');
 }
 const cheap=card('fixture-genuine-cheap',400),sourceError=hold();
 const error=await interrupted(own,deps([],{cards:[cheap,...observed],deferAfter:1,error:sourceError}));
 assert.equal(error,sourceError,'an accepted partial quote alone is not a scheduling checkpoint');
 const saved=deferredYahooComparison(undefined,error,own);assert.equal(saved.candidates,undefined);assert.equal(saved.detailQueue,undefined);
 const partial=await interrupted(own,deps([],{deferAfter:1}));
 const fresh=deferredYahooComparison(undefined,partial,own);assert.equal(fresh.checkedAt,null);assert.equal(fresh.searchCheckedAt,undefined);
 assert.equal(fresh.status,'deferred_budget');assert.equal(fresh.detailQueue.schedulingAttempts.length,1);assert.equal(fresh.candidates,undefined);
});

test('accepted and definitively inspected partial results never enter the checkpoint or overwrite old evidence',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW});
 const cheap=card('fixture-genuine-cheap',400),prior=baseline(),item={...own,yahoo:prior};
 const queue=planYahooDetailQueue({item,detail:ownDetail,candidates:[cheap,...observed],now:NOW});
 queue.record(observed[7],OLD);prior.detailQueue=queue.snapshot();const before=structuredClone(prior);
 const error=await interrupted(item,deps([],{cards:[cheap,...observed],deferAfter:2}));
 const value=deferredYahooComparison(prior,error,item);assertOldEvidence(value,prior);assert.deepEqual(prior,before);
 assert.deepEqual(value.detailQueue.attempts,prior.detailQueue.attempts,'only preexisting inspected ordering survives');
 assert.equal(value.detailQueue.attempts.some(row=>row.id===cheap.id),false);
 assert.equal(value.detailQueue.schedulingAttempts.length,1);assert.equal(value.candidates.length,0);
});

test('shared hold errors are isolated across concurrent accounts and current item binding rejects mismatches',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW});
 const shared=Object.freeze(Object.assign(new RequestDeferredError('yahoo_cooldown_state_unavailable',Infinity),{httpStatus:429,retryAfter:null}));
 const items=[own,{...own,accountId:'different-account'}];
 const errors=await Promise.all(items.map((item,n)=>interrupted(item,deps([],{deferAfter:n+1,error:shared}))));
 assert.notEqual(errors[0],errors[1]);assert.equal(errors[0].retryAt,'indefinite');assert.equal(errors[0].cause,shared);
 assert.equal(deferredYahooDetailQueue(shared,own),undefined);
 for(let n=0;n<2;n++)assert.equal(deferredYahooComparison({},errors[n],items[n]).detailQueue.schedulingAttempts.length,n+1);
 assert.equal(deferredYahooComparison({},errors[0],items[1]).detailQueue,undefined);
 for(const changes of [{id:'relisted'},{title:own.title+' changed'},{platform:'rakuma'},{sellerId:'different'},{image:'different'},{ownPrice:29000},{itemStatus:'SOLD'},{sourceDetail:{status:'CLOSED'}}]){
  assert.equal(deferredYahooComparison({},errors[0],{...own,...changes}).detailQueue,undefined);
 }
 assert.equal(deferredYahooComparison({},errors[0],{...own,sourceDetail:{...ownDetail,description:'changed offer'}}).detailQueue,undefined);
 assert.equal(deferredYahooComparison({},errors[0],{...own,sourceDetail:ownDetail}).detailQueue.schedulingAttempts.length,1);
 assert.equal(deferredYahooComparison({},errors[0]).detailQueue,undefined);
 assert.equal(deferredYahooComparison({},Object.assign(hold(),{detailQueue:{schedulingAttempts:['forged']}}),own).detailQueue,undefined);
});

test('a changed own detail drops old queue memory instead of rebinding it; changed cards retry immediately',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW});
 const initial=await yahooCompare(null,own,{},deps([]));
 const changedOwn={...ownDetail,description:ownDetail.description+' 別仕様'};
 const error=await interrupted({...own,yahoo:initial},deps([],{deferAfter:1,ownValue:changedOwn}));
 const saved=deferredYahooComparison(initial,error,own);
 assert.notEqual(saved.detailQueue.ownKey,initial.detailQueue.ownKey);assert.equal(saved.detailQueue.schedulingAttempts.length,1);
 assert.deepEqual(saved.detailQueue.lastSchedulingSelection,[observed[0].id]);
 const changedCard={...observed[0],price:450},queue=planYahooDetailQueue({item:own,detail:changedOwn,candidates:[changedCard,...observed.slice(1)],prior:saved.detailQueue,now:NOW});
 assert.equal(queue.cards[0].id,changedCard.id);assert.equal(queue.deferredCount,0);
 const originalOwn=planYahooDetailQueue({item:own,detail:ownDetail,candidates:observed,prior:saved.detailQueue,now:NOW});
 assert.equal(originalOwn.cards.length,8,'own-detail identity changes revoke old scheduling memory');
});

test('failed transport, wrong target, incomplete evaluation and deferred requests never acquire completed-attempt memory',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW});
 for(const failure of [Object.assign(Error('403'),{httpStatus:403}),Object.assign(Error('429'),{httpStatus:429}),Error('network')]){
  const sourceError=hold(),dependencies=deps([],{deferAfter:1,error:sourceError,detailChange:()=>{throw failure;}});
  const error=await interrupted(own,dependencies);assert.equal(error,sourceError);
 }
 const sourceError=hold(),wrong=await interrupted(own,deps([],{deferAfter:1,error:sourceError,detailChange:detail=>{detail.id='wrong-target';}}));
 assert.equal(wrong,sourceError);
 // A response can arrive, then its image/evaluation can defer. It is not a
 // completed rejection and cannot borrow another card's earlier reason.
 let fingerprintReads=0;const dependencies=deps([],{cards:[rival],error:sourceError});
 dependencies.imageFingerprints=async()=>{if(++fingerprintReads>1)throw sourceError;return fp;};
 const evaluation=await interrupted(own,dependencies);assert.equal(evaluation,sourceError);
});

test('checkpoint construction or consumption failure preserves the original deferral and old clocks',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW});
 const sourceError=hold();assert.equal(withYahooSchedulingCheckpoint(sourceError,{deferredSnapshot(){throw Error('checkpoint failed');}}),sourceError);
 const prior=baseline(),queue=planYahooDetailQueue({item:own,detail:ownDetail,candidates:observed,now:NOW});
 queue.recordSchedulingAttempt(observed[7],'physical_product_type_unconfirmed',OLD);prior.detailQueue=queue.snapshot();
 const error=await interrupted({...own,yahoo:prior},deps([],{deferAfter:1}));
 t.mock.method(globalThis,'structuredClone',()=>{throw Error('copy failed');});
 const saved=deferredYahooComparison(prior,error,own);assertOldEvidence(saved,prior);assert.deepEqual(saved.detailQueue,prior.detailQueue);
 const construction=await interrupted(own,deps([],{deferAfter:1,error:sourceError}));assert.equal(construction,sourceError);
});

test('a rejected disk checkpoint write cannot claim durability; a successful restored write rotates on retry',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW});
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'yahoo-checkpoint-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const prior=baseline(),file=path.join(root,'latest.enc'),password='fixture-password';
 await fs.writeFile(file,encrypt(Buffer.from(JSON.stringify(prior)),password));
 const error=await interrupted({...own,yahoo:prior},deps([],{deferAfter:2})),saved=deferredYahooComparison(prior,error,own);
 const bytes=encrypt(Buffer.from(JSON.stringify(saved)),password);
 await assert.rejects(fs.writeFile(path.join(file,'not-a-directory'),bytes),{code:'ENOTDIR'});
 const unchanged=JSON.parse(decrypt(await fs.readFile(file),password));assert.deepEqual(unchanged,prior);
 const repeated=[],again=await interrupted({...own,yahoo:unchanged},deps(repeated,{deferAfter:2}));
 assert.deepEqual(repeated.slice(0,2),observed.slice(0,2).map(c=>c.id),'failed writes cannot pretend memory was durable');
 assertOldEvidence(deferredYahooComparison(unchanged,again,own),prior);
 await fs.writeFile(file,bytes);const restored=JSON.parse(decrypt(await fs.readFile(file),password)),reads=[];
 const resumed=await yahooCompare(null,{...own,yahoo:restored},{forceYahooBroadSearch:true},deps(reads));
 assert.equal(reads[0],observed[2].id);assert.equal(resumed.detailCheckedCount,7);
});

test('checkpoint recovery preserves finite retries, all-managed ownership, SOLD and permanent corrections',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW});
 const prior=baseline(),error=await interrupted({...own,yahoo:prior},deps([],{deferAfter:2})),saved=deferredYahooComparison(prior,error,own);
 const correction={accountId:own.accountId,itemId:own.id,platform:'yahoo',candidateId:rival.id,updatedAt:new Date(NOW).toISOString()};
 const corrected=await yahooCompare(null,{...own,yahoo:saved},{matchCorrections:{fixture:correction}},deps([]));
 assert.equal(corrected.candidates.length,0);assert.ok(corrected.rejected.some(row=>row.id===rival.id&&row.reason==='saved_user_correction'));
 const ownedOffers=buildOwnedOffers([{id:'another-managed',platform:'yahoo',sellerId:evidence.report.sellerId}]);
 const ownReads=[],managed=await yahooCompare(null,{...own,yahoo:saved},{ownedOffers},deps(ownReads));assert.equal(ownReads.length,0);assert.equal(managed.candidates.length,0);
 const sold=await yahooCompare(null,{...own,yahoo:saved},{},deps([],{detailChange:detail=>{if(detail.id===rival.id)detail.status='SOLD';}}));
 assert.equal(sold.candidates.length,0);assert.ok(sold.rejected.some(row=>row.id===rival.id&&row.reason==='not_open'));
 t.mock.timers.tick(61*MINUTE);const reads=[];
 await yahooCompare(null,{...own,yahoo:saved},{forceYahooBroadSearch:true},deps(reads));
 assert.ok(reads.includes(observed[0].id));assert.ok(reads.includes(observed[1].id));assert.ok(reads.length<=8);
});


test('restored scheduling rows are a whitelist and malformed retry state cannot become a checkpoint',()=>{
 const queue=planYahooDetailQueue({item:own,detail:ownDetail,candidates:observed,now:NOW});
 queue.recordSchedulingAttempt(observed[0],'physical_product_type_unconfirmed',new Date(NOW).toISOString());
 const saved=queue.snapshot(),row=saved.schedulingAttempts[0];
 const dirty={...saved,schedulingAttempts:[{...row,price:1,checkedAt:new Date(NOW).toISOString(),candidates:[rival]}]};
 const resumed=planYahooDetailQueue({item:own,detail:ownDetail,candidates:observed,now:NOW,prior:dirty});
 resumed.recordSchedulingAttempt(observed[1],'sale_description_unavailable',new Date(NOW).toISOString());
 const checkpoint=resumed.deferredSnapshot();
 assert.deepEqual(checkpoint.queue.schedulingAttempts[0],row,'unknown fields cannot hitchhike in checkpoint rows');
 for(const changes of [{count:0},{count:99},{reason:'verified'}, {retryAt:'2099-01-01T00:00:00Z'},{key:'wrong-card'}]){
  const malformed={...saved,schedulingAttempts:[{...row,...changes}]};
  const retry=planYahooDetailQueue({item:own,detail:ownDetail,candidates:observed,now:NOW,prior:malformed});
  assert.equal(retry.deferredCount,0);assert.equal(retry.snapshot().schedulingAttempts.length,0);
 }
});
