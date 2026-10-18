import test from 'node:test';
import assert from 'node:assert/strict';
import {pipeline,T} from './fixtures/shared-detail-pipeline.mjs';
import {verifySharedYahooDetailPair} from '../scripts/lib/yahoo-shared-detail-consumer.mjs';
import {currentSharedYahooOffers,sharedYahooOffersMarkup} from '../public/shared-yahoo-offers.js';
import {pricingDecision} from '../public/pricing-policy.js';

for(const accountId of ['melon','boss','momoka'])test(`actual collector/cache/recall/strict chain produces display-only offer for ${accountId} with zero additional GET`,async t=>{
 const p=await pipeline(t,{accountId}),before=p.counts(),old=structuredClone(p.item);
 const result=await p.run();assert.equal(result.status,'verified_single_offer',JSON.stringify(result));
 assert.deepEqual(p.counts(),before);assert.deepEqual(p.item,old);
 assert.equal(result.offer.checkedAt,new Date(T+7000).toISOString());assert.equal(result.offer.ownObservedAt,new Date(T+1000).toISOString());
 const row={...p.item,sharedYahooOffers:[result.offer]},options={ownershipIndex:p.settings.ownedOffers,corrections:{},now:T+13000};
 assert.equal(currentSharedYahooOffers(row,options).length,1);
 assert.deepEqual(pricingDecision(row,{now:T+13000}),pricingDecision(p.item,{now:T+13000}));
 assert.match(sharedYahooOffersMarkup(row,options),/8,000/);assert.equal(row.yahoo.checkedAt,old.yahoo.checkedAt);
});
for(const [label,candidateChange] of [
 ['sold',value=>value.status='SOLD'],['quantity',value=>value.description='新品 未使用 フィギュア2点セット 特典付き'],
 ['bonus',value=>value.description='新品 未使用 フィギュア1点 特典なし'],['missing description',value=>value.description=''],['condition',value=>value.description='中古 開封済 フィギュア1点 特典付き'],
 ['cross account owned',value=>value.seller.id='seller-boss'],
])test(`strict shared pair rejects ${label} without extra source reads`,async t=>{
 const p=await pipeline(t,{candidateChange}),before=p.counts(),value=await p.run();
 assert.notEqual(value.status,'verified_single_offer');assert.deepEqual(p.counts(),before);assert.equal(value.offer,undefined);
});
for(const field of ['skipCandidate','skipImages'])test(`shared ${field} leaves unresolved evidence and cannot start a missing read`,async t=>{
 const p=await pipeline(t,{[field]:true}),before=p.counts();const result=await p.run();
 assert.equal(result.status,'pending');assert.deepEqual(p.counts(),before);
});
test('raw recall/historical hint, wrong target, stale/future originals and malformed image clocks cannot produce a quote',async t=>{
 const p=await pipeline(t),before=p.counts();
 for(const change of [input=>input.peekBundle=()=>null,input=>input.item={...input.item,id:'different'},input=>input.settings={...input.settings,ownedOffersComplete:false},
  input=>input.recall={...input.recall,conflictingCardObservations:true},input=>input.peekFingerprint=async()=>({url:'x',imageObservedAt:new Date(T).toISOString()}),
  input=>input.startedAt=T+15000,input=>input.deadlineAt=T+12000]){
  const input={...p.input};change(input);assert.notEqual((await verifySharedYahooDetailPair(input)).status,'verified_single_offer');
 }
 assert.deepEqual(p.counts(),before);
});

test('thumbnail alone cannot replace the known-offer path required own detail images',async t=>{
 const p=await pipeline(t,{ownChange:own=>{own.thumbnailImageUrl=own.images[0];own.images=[]}}),before=p.counts();
 const result=await p.run();assert.equal(result.status,'pending');assert.equal(result.reason,'own_terms_changed_or_missing');assert.deepEqual(p.counts(),before);
});
