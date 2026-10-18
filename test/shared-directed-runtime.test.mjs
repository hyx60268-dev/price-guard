import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pipeline,T} from './fixtures/shared-detail-pipeline.mjs';
import {createSharedYahooDetailRuntime} from '../scripts/lib/yahoo-shared-detail-runtime.mjs';
import {peekImageFingerprints,peekKnownImageObservation} from '../scripts/lib/image.mjs';

const setup=(p,extra={})=>createSharedYahooDetailRuntime({startedAt:T,deadlineAt:T+720000,
 accounts:p.accounts,contexts:p.contexts,snapshot:p.observer.snapshot,observationVersion:p.observer.revision,
 peekBundle:p.loader.peekYahooBundle,peekOriginalReceipt:p.loader.yahooOriginalReceipt,
 peekFingerprint:peekImageFingerprints,peekFingerprintState:peekKnownImageObservation,
 now:p.input.now,minPassGapMs:0,...extra});
const root=p=>({item:{...p.item,profileCard:p.input.profileCard},recall:p.input.recall});
function deferred(){let resolve;const promise=new Promise(value=>resolve=value);return {promise,resolve};}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('directed missing fingerprint withdraws an older accepted pair even while cache metadata remains available',async t=>{
 const p=await pipeline(t),before=p.counts(),old=structuredClone(p.item);let missing=false;
 const runtime=setup(p,{peekFingerprint:(...args)=>missing?null:peekImageFingerprints(...args)});
 await runtime.consume(p.settings);const previous=runtime.offersFor(p.item);assert.equal(previous.length,1);
 missing=true;
 assert.equal(peekKnownImageObservation(previous[0].imageEvidence[0].url).status,'available');
 const result=await runtime.verifyPlannedPair(root(p));
 assert.equal(result.status,'pending');assert.equal(result.reason,'image_evidence_unavailable');
 assert.deepEqual(runtime.offersFor(p.item),[]);assert.equal(runtime.statistics().activeVerifiedOffers,0);
 assert.equal(runtime.statistics().directedAttempts,1);assert.equal(runtime.statistics().directedVerified,0);
 assert.deepEqual(p.counts(),before);assert.deepEqual(p.item,old);
});

test('directed strict sale-unit rejection withdraws an older pair without changing ordinary clocks',async t=>{
 const p=await pipeline(t),before=p.counts(),old=structuredClone(p.item);let changed=false;
 const runtime=setup(p,{peekBundle:id=>{
  const bundle=p.loader.peekYahooBundle(id);if(!changed||id!==p.candidate.id)return bundle;
  bundle.detail.description='新品 未使用 フィギュア2点セット 特典付き';
  bundle.originalObservation.parsedSha256=createHash('sha256').update(JSON.stringify({detail:bundle.detail,shipping:bundle.shipping})).digest('hex');
  return bundle;
 }});
 await runtime.consume(p.settings);assert.equal(runtime.offersFor(p.item).length,1);changed=true;
 const result=await runtime.verifyPlannedPair(root(p));
 assert.equal(result.status,'rejected');assert.equal(result.offer,undefined);
 assert.deepEqual(runtime.offersFor(p.item),[]);assert.equal(runtime.statistics().directedVerified,0);
 assert.deepEqual(p.counts(),before);assert.deepEqual(p.item,old);
});

test('directed local timeout withdraws the old offer and a late cache completion cannot restore it',{timeout:5000},async t=>{
 const p=await pipeline(t),before=p.counts(),old=structuredClone(p.item),blocked=deferred();let stall=false,reads=0;
 const runtime=setup(p,{maxDirectedDurationMs:40,peekFingerprint:(...args)=>{
  if(!stall)return peekImageFingerprints(...args);reads++;return blocked.promise.then(()=>peekImageFingerprints(...args));
 }});
 await runtime.consume(p.settings);assert.equal(runtime.offersFor(p.item).length,1);stall=true;
 // The promise is deliberately unresolved until the runtime has returned. This
 // establishes bounded waiting without a brittle runner-speed upper bound.
 const result=await runtime.verifyPlannedPair(root(p));
 assert.equal(result.status,'pending');assert.equal(reads,1);assert.deepEqual(runtime.offersFor(p.item),[]);
 assert.equal(runtime.statistics().directedAttempts,1);assert.equal(runtime.statistics().directedVerified,0);
 assert.ok(runtime.statistics().directedDurationMs>0);
 blocked.resolve();await settle();await settle();
 assert.deepEqual(runtime.offersFor(p.item),[]);assert.equal(runtime.statistics().directedVerified,0);
 assert.deepEqual(p.counts(),before);assert.deepEqual(p.item,old);
});

test('an in-flight directed strict check excludes an ordinary strict pass and a second directed invocation',{timeout:5000},async t=>{
 const p=await pipeline(t),before=p.counts(),entered=deferred(),blocked=deferred();let mode='missing',reads=0;
 const runtime=setup(p,{peekFingerprint:(...args)=>{
  if(mode==='missing')return null;
  reads++;if(reads===1){entered.resolve();return blocked.promise.then(()=>peekImageFingerprints(...args));}
  return peekImageFingerprints(...args);
 }});
 await runtime.consume(p.settings);assert.equal(runtime.statistics().attemptedPairs,1);mode='directed';
 const pending=runtime.verifyPlannedPair(root(p));await entered.promise;
 const during=runtime.statistics();assert.equal(during.directedAttempts,1);assert.equal(runtime.directedAvailable(),false);
 await runtime.consume(p.settings);
 assert.equal(runtime.statistics().passes,during.passes);assert.equal(runtime.statistics().attemptedPairs,during.attemptedPairs);
 assert.equal((await runtime.verifyPlannedPair(root(p))).reason,'directed_budget');assert.equal(reads,1);
 blocked.resolve();assert.equal((await pending).status,'verified_single_offer');
 assert.equal(runtime.statistics().directedAttempts,1);assert.equal(runtime.statistics().directedVerified,1);
 assert.equal(runtime.offersFor(p.item).length,1);assert.deepEqual(p.counts(),before);
});

test('a directed success marks the exact body pair complete for the next ordinary pass',async t=>{
 const p=await pipeline(t),before=p.counts();let missing=true;
 const runtime=setup(p,{peekFingerprint:(...args)=>missing?null:peekImageFingerprints(...args)});
 await runtime.consume(p.settings);assert.equal(runtime.statistics().attemptedPairs,1);missing=false;
 assert.equal((await runtime.verifyPlannedPair(root(p))).status,'verified_single_offer');
 const accepted=runtime.offersFor(p.item),counts=runtime.statistics();assert.equal(accepted.length,1);
 await runtime.consume(p.settings);
 const after=runtime.statistics();assert.equal(after.passes,counts.passes+1);
 assert.equal(after.attemptedPairs,counts.attemptedPairs);assert.equal(after.verifiedPairs,counts.verifiedPairs);
 assert.equal(after.directedAttempts,1);assert.equal(after.directedVerified,1);
 assert.deepEqual(runtime.offersFor(p.item),accepted);assert.deepEqual(p.counts(),before);
});

test('waiting for an ordinary strict pass spends the cumulative directed budget and cannot start or commit late',{timeout:5000},async t=>{
 const p=await pipeline(t),before=p.counts(),entered=deferred(),blocked=deferred();let mode='missing',reads=0;
 // A fixed ordinary clock isolates the waiting ledger under test. The source
 // clock still cancels the ordinary check when its held peek is released.
 const runtime=setup(p,{clock:()=>0,maxDirectedDurationMs:40,peekFingerprint:(...args)=>{
  if(mode==='missing')return null;reads++;entered.resolve();return blocked.promise.then(()=>peekImageFingerprints(...args));
 }});
 await runtime.consume(p.settings);mode='ordinary';
 const ordinary=runtime.consume(p.settings);await entered.promise;
 const result=await runtime.verifyPlannedPair(root(p)),timedOut=runtime.statistics();
 assert.equal(result.status,'pending');assert.equal(result.reason,'directed_budget');
 assert.equal(timedOut.directedAttempts,0);assert.equal(timedOut.directedVerified,0);assert.equal(reads,1);
 assert.ok(timedOut.directedWaitMs>0);assert.ok(timedOut.directedDurationMs>=timedOut.directedWaitMs);
 assert.equal(runtime.directedAvailable(),false);
 assert.equal((await runtime.verifyPlannedPair(root(p))).reason,'directed_budget');
 assert.equal(runtime.statistics().directedDurationMs,timedOut.directedDurationMs,'a refused admission cannot reset or replenish the ledger');
 p.setTime(T+720000);blocked.resolve();await ordinary;await settle();
 assert.deepEqual(runtime.offersFor(p.item),[]);assert.equal(runtime.statistics().directedAttempts,0);
 assert.equal(runtime.statistics().directedVerified,0);assert.deepEqual(p.counts(),before);
});
