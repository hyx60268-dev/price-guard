import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeSharedQuotePublication,SHARED_QUOTE_PUBLICATION as P} from '../scripts/lib/shared-quote-publication-summary.mjs';
import {sharedYahooTargetBinding} from '../public/shared-yahoo-offers.js';
import {PRICING_RULES_VERSION} from '../public/pricing-policy.js';
import {sharedPublicationFixture} from './fixtures/shared-quote-publication.fixture.mjs';

const now=Date.parse(P.publishedAt)+1000;
test('counts actual persisted platform alias through production scope, compaction and renderer without revealing rows',()=>{
 const state=sharedPublicationFixture(),before=structuredClone(state),r=summarizeSharedQuotePublication(state,{now});
 assert.equal(r.valid,true);assert.equal(r.validSharedPairsAtSnapshot,9);assert.equal(r.samePairAlreadyInOrdinaryStorage,9);assert.equal(r.pairsAbsentFromOrdinaryStorage,0);assert.equal(r.samePairEligibleInOrdinaryPricingAtSnapshot,9);assert.equal(r.targetsWithoutAnyEligibleOrdinaryQuoteAtSnapshot,0);
 assert.equal(r.memberProjection.publicationDistinctPairs,9);assert.equal(r.memberProjection.publicationRenderedSections,9);assert.equal(r.rendererSectionsAtPublication,9);assert.equal(r.memberProjection.browserObserved,false);assert.equal(r.memberProjection.memberEndpointRead,false);
 assert.doesNotMatch(JSON.stringify(r),/PRIVATE|own-\d|external-\d|8000|example\.invalid/);assert.deepEqual(state,before);
});
test('tuple dedupe separates stored historical overlap, usable ordinary quote, and truly absent pair',()=>{
 const s=sharedPublicationFixture();s.items[0].yahoo.candidates=[];s.items[1].yahoo.cacheReason='request_error';s.items[2].yahoo.candidates.push({...s.items[2].yahoo.candidates[0]});
 const r=summarizeSharedQuotePublication(s,{now});assert.equal(r.valid,true);assert.equal(r.samePairAlreadyInOrdinaryStorage,8);assert.equal(r.pairsAbsentFromOrdinaryStorage,1);assert.equal(r.samePairEligibleInOrdinaryPricingAtSnapshot,7);assert.equal(r.pairsAdditionalToEligibleOrdinaryPricing,2);assert.equal(r.targetsWithoutAnyEligibleOrdinaryQuoteAtSnapshot,2);
});
test('diagnostic expiry never erases publication-time production and member counts',()=>{
 const r=summarizeSharedQuotePublication(sharedPublicationFixture(),{now:now+3600000});assert.equal(r.valid,true);assert.equal(r.validSharedPairsAtSnapshot,9);assert.equal(r.validSharedPairsAtPublication,9);assert.equal(r.validSharedPairsAtDiagnostic,0);assert.equal(r.publicationValidButNoLongerCurrent,9);assert.equal(r.memberProjection.publicationDistinctPairs,9);assert.equal(r.memberProjection.currentOfferInstances,0);
});
test('members stay scoped and multiple members do not multiply unique pair counts',()=>{
 const s=sharedPublicationFixture();s.portalUsers.push({...s.portalUsers[0],username:'SECOND_PRIVATE'},{username:'EMPTY_PRIVATE',accountIds:[],enabled:true});const r=summarizeSharedQuotePublication(s,{now});assert.equal(r.valid,true);assert.equal(r.memberProjection.publicationOfferInstances,18);assert.equal(r.memberProjection.publicationDistinctPairs,9);
});
test('member narrowing cannot restore a quote owned by a hidden account or listing history',()=>{
 for(const useHistory of [false,true]){
  const s=sharedPublicationFixture();s.items[0].sharedYahooOffers[0].sellerId='hidden-owner';
  if(useHistory)s.listingHistory={old:{id:'old-owned',platform:'yahoo',sellerId:'hidden-owner'}};
  else s.managedAccounts.push({id:'hidden',platform:'yahoo',sellerId:'hidden-owner',profileUrl:'https://paypayfleamarket.yahoo.co.jp/user/hidden-owner'});
  const r=summarizeSharedQuotePublication(s,{now});assert.equal(r.valid,true);assert.equal(r.validSharedPairsAtPublication,8);assert.equal(r.memberProjection.publicationDistinctPairs,8);assert.equal(r.memberProjection.publicationOfferInstances,8);
 }
});
test('state, times, ledger and output-count pins fail closed without data values',()=>{
 for(const mutate of [s=>s.scanMeta.codeSha='f'.repeat(40),s=>s.dataRevision='SECRET',s=>s.cycleCoverage.startedAt='SECRET',s=>s.comparisonAuditReceipt.revision=2,s=>s.comparisonAuditReceipt.consumed[0].expectedSha='f'.repeat(40),s=>s.items.push(s.items[0]),s=>s.scanMeta.sharedDetailSummary.outputOffers=8]){const s=sharedPublicationFixture();mutate(s);const r=summarizeSharedQuotePublication(s,{now});assert.equal(r.valid,false);assert.doesNotMatch(JSON.stringify(r),/SECRET|PRIVATE|ffff/);}
});
test('raw card, corrected offer, missing image, changed own and foreign platform never become valid shared UI evidence',()=>{
 for(const mutate of [s=>s.items[0].sharedYahooOffers[0]={id:'external-0',canRecommend:false},s=>s.items[0].sharedYahooOffers[0].imageEvidence=[],s=>s.items[0].title+=' changed',s=>s.items[0].platform='rakuma',s=>s.items[0].sharedYahooOffers[0].sellerId='owner',s=>s.matchCorrections={x:{accountId:'alpha',itemId:'own-0',platform:'yahoo',candidateId:'external-0',deleted:false}}]){
  const s=sharedPublicationFixture();mutate(s);const r=summarizeSharedQuotePublication(s,{now});assert.equal(r.valid,true);assert.equal(r.validSharedPairsAtSnapshot,8);assert.equal(r.memberProjection.publicationDistinctPairs,8);
 }
});
