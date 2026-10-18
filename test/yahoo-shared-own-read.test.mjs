import test from 'node:test';
import assert from 'node:assert/strict';
import {pipeline,T} from './fixtures/shared-detail-pipeline.mjs';
import {createSharedYahooDetailRuntime} from '../scripts/lib/yahoo-shared-detail-runtime.mjs';
import {createSharedOwnReadPlan} from '../scripts/lib/yahoo-shared-own-read-plan.mjs';
import {createSharedOwnReadExecutor} from '../scripts/lib/yahoo-shared-own-read.mjs';
import {imageFingerprints,peekImageFingerprints,peekKnownImageObservation} from '../scripts/lib/image.mjs';
import {pricingDecision} from '../public/pricing-policy.js';
import {compactDashboardResult} from '../scripts/lib/publish.mjs';

async function setup(t,options={}){
 const p=await pipeline(t,{secondTarget:true,deferSecondTargetRead:true,...options});let plan,clock=0;
 const runtime=createSharedYahooDetailRuntime({startedAt:T,deadlineAt:T+720000,accounts:p.accounts,contexts:p.contexts,
  snapshot:p.observer.snapshot,observationVersion:p.observer.revision,peekBundle:p.loader.peekYahooBundle,
  peekOriginalReceipt:p.loader.yahooOriginalReceipt,peekFingerprint:peekImageFingerprints,peekFingerprintState:peekKnownImageObservation,
  now:p.input.now,clock:()=>clock,onMapping:(mapping,input)=>{plan.observeMapping(mapping,input);clock=1000;}});
 plan=createSharedOwnReadPlan({accounts:p.accounts,peekBundle:p.loader.peekYahooBundle,peekFingerprintState:peekKnownImageObservation,
  startedAt:T,deadlineAt:T+720000,now:p.input.now,isRecallCurrent:runtime.isRecallCurrent});
 const executor=createSharedOwnReadExecutor({readOwn:p.loader.yahooBundle,peekBundle:p.loader.peekYahooBundle,fingerprint:imageFingerprints,
  candidateReadProblem:plan.candidateReadProblem,runtime,deadlineAt:T+720000,now:p.input.now});
 await runtime.consume(p.settings);
 return {...p,plan,runtime,executor};
}
test('real missing-own path adds exactly one root and its image, even after observation local budget is exhausted',async t=>{
 const p=await setup(t),prior=structuredClone(p.second),before=p.counts();
 assert.equal(p.runtime.statistics().localDurationMs,1000);assert.equal(p.runtime.statistics().verifiedPairs,0);
 const root=p.plan.claim('boss');assert.ok(root);p.setTime(T+19000);
 const result=await p.executor.run(root);assert.equal(result.status,'verified_single_offer');
 assert.deepEqual(p.counts(),{htmlReads:before.htmlReads+1,imageReads:before.imageReads+1});
 const rows=p.runtime.offersFor(p.second);assert.equal(rows.length,1);assert.equal(rows[0].price,8000);
 assert.equal(rows[0].checkedAt,new Date(T+7000).toISOString());assert.equal(rows[0].ownObservedAt,new Date(T+19000).toISOString());
 assert.deepEqual(p.second,prior);assert.equal(p.executor.statistics().htmlRequests,1);assert.equal(p.executor.statistics().imageFetches,1);
 assert.equal(p.runtime.statistics().directedAttempts,1);assert.equal(p.runtime.statistics().directedVerified,1);
 const compact=compactDashboardResult({items:[{...p.second,sharedYahooOffers:rows}],accounts:p.accounts,matchCorrections:{}},{now:T+19000});
 const beforeCompact=compactDashboardResult({items:[prior],accounts:p.accounts,matchCorrections:{}},{now:T+19000});
 assert.equal(compact.items[0].sharedYahooOffers.length,1);assert.deepEqual(compact.items[0].yahoo,beforeCompact.items[0].yahoo);
 assert.deepEqual(pricingDecision(compact.items[0],{now:T+19000}),pricingDecision(prior,{now:T+19000}));
});
test('hold or deadline after planning causes zero root or image requests and preserves old clocks',async t=>{
 const p=await setup(t),root=p.plan.claim('boss'),before=p.counts(),old=structuredClone(p.second);
 const held=createSharedOwnReadExecutor({readOwn:p.loader.yahooBundle,peekBundle:p.loader.peekYahooBundle,fingerprint:imageFingerprints,
  candidateReadProblem:p.plan.candidateReadProblem,runtime:p.runtime,deadlineAt:T+720000,now:p.input.now,canRequest:()=>false});
 assert.equal((await held.run(root)).status,'pending');p.setTime(T+720000);
 assert.equal((await p.executor.run(root)).status,'pending');assert.deepEqual(p.counts(),before);assert.deepEqual(p.second,old);
});
test('current profile/rail contradiction after planning cannot initiate a new own read',async t=>{
 const p=await setup(t),root=p.plan.claim('boss'),before=p.counts();
 p.contexts.find(c=>c.account.id==='boss').profileDiscovery.profileObservation.complete=false;
 assert.equal((await p.executor.run(root)).status,'pending');assert.deepEqual(p.counts(),before);
});
test('missing candidate image evidence gives no scheduled root',async t=>{
 const p=await setup(t,{skipImages:true}),before=p.counts();assert.equal(p.plan.claim('boss'),null);assert.deepEqual(p.counts(),before);
});
test('saved target sale-unit change is rejected through the original strict verifier after one root',async t=>{
 const p=await setup(t,{ownChange:own=>{own.description='新品 未使用 フィギュア2点セット 特典付き';}});
 const root=p.plan.claim('boss');assert.ok(root);p.setTime(T+19000);
 assert.equal((await p.executor.run(root)).status,'rejected');assert.deepEqual(p.runtime.offersFor(p.second),[]);
 assert.equal(p.second.yahoo.checkedAt,new Date(T-3600000).toISOString());
});

for(const change of ['candidate_evicted','fingerprint_invalidated','candidate_changed','source_hold'])test(`an own read followed by ${change} cannot start new image work`,async t=>{
 const p=await setup(t),root=p.plan.claim('boss'),before=p.counts(),old=structuredClone(p.second);let invalidated=false;
 const executor=createSharedOwnReadExecutor({readOwn:async(...args)=>{const value=await p.loader.yahooBundle(...args);invalidated=true;return value;},
  peekBundle:p.loader.peekYahooBundle,fingerprint:async()=>assert.fail('image must not start after evidence/hold changed'),
  candidateReadProblem:value=>invalidated&&change!=='source_hold'?change:p.plan.candidateReadProblem(value),
  runtime:p.runtime,deadlineAt:T+720000,now:p.input.now,canRequest:()=>!(invalidated&&change==='source_hold')});
 const result=await executor.run(root);assert.equal(result.status,'pending');assert.equal(executor.statistics().htmlRequests,1);
 assert.equal(executor.statistics().imageProcessingCalls,0);assert.deepEqual(p.counts(),{...before,htmlReads:before.htmlReads+1});
 assert.deepEqual(p.second,old);assert.deepEqual(p.runtime.offersFor(p.second),[]);
});
for(const status of [401,403,429])test(`image HTTP ${status} stops the lane without retries or verification`,async t=>{
 const p=await setup(t),root=p.plan.claim('boss');let calls=0;
 const executor=createSharedOwnReadExecutor({readOwn:p.loader.yahooBundle,peekBundle:p.loader.peekYahooBundle,
  fingerprint:async(_url,options)=>{calls++;options.observeImageTransferStart();options.observeImageTransfer({bytes:0,durationMs:3,httpStatus:status});return null;},
  candidateReadProblem:p.plan.candidateReadProblem,runtime:p.runtime,deadlineAt:T+720000,now:p.input.now});
 assert.equal((await executor.run(root)).status,'pending');assert.equal(calls,1);assert.equal(executor.available(),false);
 assert.equal(executor.statistics().imageAccessStopped,true);assert.equal(executor.statistics().imageFetches,1);assert.equal(executor.statistics().verified,0);
 assert.equal((await executor.run(root)).reason,'not_admitted');assert.equal(calls,1);assert.deepEqual(p.runtime.offersFor(p.second),[]);
});
test('cancelled own read cannot trigger images, a retry, or comparison clocks',async t=>{
 const p=await setup(t),root=p.plan.claim('boss'),old=structuredClone(p.second);let reads=0;
 const executor=createSharedOwnReadExecutor({readOwn:async()=>{reads++;throw Object.assign(new Error('abort'),{name:'AbortError'});},
  peekBundle:p.loader.peekYahooBundle,fingerprint:async()=>assert.fail('cancelled'),candidateReadProblem:p.plan.candidateReadProblem,
  runtime:p.runtime,deadlineAt:T+720000,now:p.input.now});
 assert.equal((await executor.run(root)).status,'pending');assert.equal(reads,1);assert.equal(executor.statistics().failures,1);
 assert.equal(executor.statistics().imageProcessingCalls,0);assert.deepEqual(p.second,old);assert.deepEqual(p.runtime.offersFor(p.second),[]);
});
