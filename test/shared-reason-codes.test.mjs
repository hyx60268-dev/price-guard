import test from 'node:test';
import assert from 'node:assert/strict';
import {sharedStrictReason} from '../scripts/lib/shared-yahoo-reason-codes.mjs';
test('shared strict diagnostic retains known enum only, including distinct bonus and availability failures',()=>{
 for(const code of ['bonus_terms_mismatch','bonus_terms_unconfirmed','bonus_terms_inconsistent','not_open','sale_unit_mismatch','physical_product_type_unconfirmed'])assert.equal(sharedStrictReason(code),code);
 for(const value of ['private title https://example.invalid/?key=secret','bonus_terms_mismatch secret',new Error('password'),{reason:'not_open'},undefined,null])assert.equal(sharedStrictReason(value),'strict_other');
});

import {pipeline,T} from './fixtures/shared-detail-pipeline.mjs';
import {createSharedYahooDetailRuntime} from '../scripts/lib/yahoo-shared-detail-runtime.mjs';
import {peekImageFingerprints,peekKnownImageObservation} from '../scripts/lib/image.mjs';
for(const accountId of ['melon','boss','momoka'])for(const [kind,change] of [
 ['bonus',candidate=>{candidate.description='新品 未使用 フィギュア1点 特典なし';}],
 ['quantity',candidate=>{candidate.description='新品 未使用 フィギュア2点セット 特典付き';}],
 ['not_open',candidate=>{candidate.status='SOLD';}],
])test(`real ${accountId} ${kind} strict rejection is a fixed subtype count without private evidence`,async t=>{
 const p=await pipeline(t,{accountId,candidateChange:change}),before=p.counts(),original=structuredClone(p.item);
 const direct=await p.run();assert.equal(direct.status,'rejected');
 const runtime=createSharedYahooDetailRuntime({startedAt:T,deadlineAt:T+720000,accounts:p.accounts,contexts:p.contexts,
  snapshot:p.observer.snapshot,observationVersion:p.observer.revision,peekBundle:p.loader.peekYahooBundle,
  peekOriginalReceipt:p.loader.yahooOriginalReceipt,peekFingerprint:peekImageFingerprints,peekFingerprintState:peekKnownImageObservation,
  now:p.input.now,clock:()=>0,minPassGapMs:0});
 await runtime.consume(p.settings);const stats=runtime.statistics();
 assert.equal(stats.rejectedPairs,1);assert.deepEqual(stats.strictRejectionReasons,{[sharedStrictReason(direct.reason)]:1});
 assert.notEqual(sharedStrictReason(direct.reason),'strict_other');
 const serialized=JSON.stringify(stats);
 for(const value of [p.item.id,p.candidate.id,p.item.title,p.candidate.description,'https://'])assert.equal(serialized.includes(value),false);
 assert.deepEqual(runtime.offersFor(p.item),[]);assert.deepEqual(p.counts(),before);assert.deepEqual(p.item,original);
});
