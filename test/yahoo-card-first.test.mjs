import test from 'node:test';
import assert from 'node:assert/strict';
import {auditYahooCardFirst} from '../scripts/benchmark-yahoo-card-first.mjs';
import {classifyYahooCardFirst,runYahooCardFirst,yahooCardFirstPresentation,YAHOO_BUYER_SHIPPING_POLICY} from '../scripts/lib/yahoo-card-first.mjs';
import {frozenYahooCardFirstCases,frozenAt,frozenSettings} from './fixtures/yahoo-card-first-audit.mjs';
const now=Date.parse(frozenAt);
const classify=row=>classifyYahooCardFirst({...row,settings:frozenSettings(frozenYahooCardFirstCases()),now});

test('paired frozen audit saves requests and reports both hidden false alerts, not a zero-error claim',async()=>{
 const report=await auditYahooCardFirst();
 assert.equal(report.totalCases,22);assert.equal(report.baseline.detailRequests,22);assert.equal(report.cardFirst.detailRequests,13);
 assert.equal(report.comparison.baselineVerifiedLower,report.groundTruth.lowerOffers+report.groundTruth.baselineFalseLower.length);assert.equal(report.comparison.missedLowerFlags.length,0);
 assert.deepEqual(report.comparison.falseLowerFlags.map(row=>row.key),['hidden-sale-unit-conflict','hidden-sold-conflict']);
 assert.equal(report.comparison.lowerFlaggedButNotDetailVerified.length,4);assert.equal(report.comparison.baselineUnavailable.length,1);
 assert.deepEqual(report.comparison.baselineFalseAcceptancesAgainstFixtureTruth,[]);
 assert.deepEqual(report.comparison.fastFalseAcceptancesAgainstFixtureTruth.map(row=>row.key),report.comparison.baselineFalseAcceptancesAgainstFixtureTruth.map(row=>row.key));
 assert.equal(report.groundTruth.lowerOffers,15);assert.equal(report.groundTruth.missedLowerAlerts.length,0);
 assert.equal(report.cardFirst.canRecommendFromCard,false);
});

test('sparse recommendation status becomes an explicit provisional alert without a detail request',()=>{
 const row=frozenYahooCardFirstCases().find(row=>row.key==='sparse-recommendation-stock');
 const value=classify(row);assert.equal(value.mode,'card_observation');assert.equal(value.observation.availability,'unconfirmed');
 assert.ok(value.observation.unknownTerms.includes('availability_not_confirmed'));
 assert.equal(value.observation.cardObservedAt,frozenAt);assert.equal(value.observation.identityVerifiedAt,null);
 assert.equal(value.observation.detailCheckedAt,null);assert.equal(value.observation.canRecommend,false);
 assert.equal(value.observation.procurementCostEligible,false);
 assert.deepEqual(value.observation.shipping,YAHOO_BUYER_SHIPPING_POLICY);
});

test('both reported Violet titles keep missing card quantity as detail work on all three accounts',()=>{
 for(const row of frozenYahooCardFirstCases().filter(row=>/^(suitcase|umbrella)-/.test(row.key))){
  const value=classify(row);assert.equal(value.mode,'detail_required',row.key);
  assert.equal(value.reason,'sale_quantity_unconfirmed');assert.equal(value.observation,undefined);
 }
});

test('official versus photo, low primary similarity, abnormal price, unknown bonus or coupon invokes detail',()=>{
 for(const key of ['official-vs-real','image-score-low','very-low-genuine','missing-bonus','visible-box-conflict','coupon-only','secondary-logo-only']){
  const row=frozenYahooCardFirstCases().find(row=>row.key===key),value=classify(row);
  assert.equal(value.mode,'detail_required',key);assert.equal(value.observation,undefined);
 }
});

test('cards cannot invent a source clock or inherit Yahoo shipping policy on another platform',()=>{
 const row=frozenYahooCardFirstCases()[0];
 for(const changes of [{observedAt:null},{observedAt:new Date(now+1).toISOString()},
  {observedAt:new Date(now-20*60_000-1).toISOString()},{url:'https://auctions.yahoo.co.jp/item/'+row.card.id},
  {url:'https://paypayfleamarket.yahoo.co.jp/item/different-id'}]){
  const value=classify({...row,card:{...row.card,...changes}});assert.equal(value.mode,'detail_required');assert.equal(value.observation,undefined);
 }
});

test('old pricing decisions and procurement cannot consume the presentation as a quote collection',()=>{
 const rows=frozenYahooCardFirstCases().map(classify),view=yahooCardFirstPresentation(rows);
 assert.equal(view.lowerPriceAlerts.length,7);assert.equal(view.lowestObservedCardPriceJPY,28000);
 assert.equal(view.candidates,undefined);assert.equal(view.lowestPrice,undefined);assert.equal(view.checkedAt,undefined);
 assert.equal(view.canRecommend,false);assert.equal(view.verifiedCostCount,0);assert.equal(view.complete,false);
});

test('card observations require complete managed-account index and bound current own and primary evidence',()=>{
 const row=frozenYahooCardFirstCases()[0];
 for(const changed of [
  {...row,ownDetail:{...row.ownDetail,id:'wrong'}},
  {...row,ownDetail:{...row.ownDetail,description:''}},
  {...row,ownDetail:{...row.ownDetail,status:'SOLD'}},
  {...row,ownDetail:{...row.ownDetail,price:25000}},
  {...row,ownDetailObservation:{...row.ownDetailObservation,observedAt:'2026-01-01T00:00:00Z'}},
  {...row,card:{...row.card,image:''}},
  {...row,card:{...row.card,image:'different-image'}},
  {...row,cardPrimary:{...row.cardPrimary,imageObservedAt:'2026-01-01T00:00:00Z'}},
  {...row,ownPrimary:{...row.ownPrimary,url:'wrong-image'}},
  {...row,cardPrimary:{...row.cardPrimary,contentSha256:''}}
 ])assert.notEqual(classify(changed).mode,'card_observation');
 for(const settings of [{},{ownedOffers:frozenSettings([row]).ownedOffers},{ownedOffersComplete:true}])
  assert.equal(classifyYahooCardFirst({...row,settings,now}).reason,'complete_owned_index_required');
 const settings=frozenSettings([row]);settings.ownedOffers.yahoo.sellers.add('other-owned-account');
 assert.equal(classifyYahooCardFirst({...row,card:{...row.card,sellerId:'other-owned-account'},settings,now}).reason,'own_offer');
});

test('valid original HTTP-fresh primary receipt retains its original time instead of resetting freshness',()=>{
 const row=frozenYahooCardFirstCases()[0],original='2026-10-16T20:00:00.000Z';
 row.cardPrimary={...row.cardPrimary,imageObservedAt:original,imageCacheSource:'http_fresh',imageCacheExpiresAt:now+1000};
 const result=classify(row);assert.equal(result.mode,'card_observation');
 assert.equal(result.observation.imageEvidence.candidate.observedAt,original);
 row.cardPrimary.imageCacheExpiresAt=now-1;assert.equal(classify(row).mode,'detail_required');
});

test('detail fallback binds the actual response to the frozen candidate before any verifier can accept it',async()=>{
 const row=frozenYahooCardFirstCases().find(row=>row.key==='official-vs-real');let verified=0;
 const result=await runYahooCardFirst([row],{settings:frozenSettings([row]),now,
  readDetail:async()=>({...row.bundle,detail:{...row.bundle.detail,id:'wrong-response-id'}}),
  verifyDetail:async()=>{verified++;return {candidate:row.card}}});
 assert.equal(result.detailRequests,1);assert.equal(verified,0);
 assert.equal(result.outcomes[0].detailResult.rejection.reason,'detail_id_mismatch');
});

test('invalid own context or incomplete owned index is blocked before candidate details or legacy verification',async()=>{
 const row=frozenYahooCardFirstCases()[0],settings=frozenSettings([row]);let reads=0,verifies=0;
 const variants=[{...row,ownDetail:{...row.ownDetail,id:'wrong'}},{...row,ownDetail:{...row.ownDetail,status:'SOLD'}},
  {...row,ownDetail:{...row.ownDetail,price:25000}},{...row,ownDetailObservation:{...row.ownDetailObservation,observedAt:'2026-01-01T00:00:00Z'}},
  {...row,ownPrimary:{...row.ownPrimary,url:'wrong-image'}}];
 for(const [rows,options] of [[variants,settings],[[row],{}]]){
  const result=await runYahooCardFirst(rows,{settings:options,now,readDetail:async()=>{reads++;return row.bundle},verifyDetail:async()=>{verifies++;return {candidate:row.card}}});
  assert.ok(result.outcomes.every(outcome=>outcome.mode==='blocked'));assert.equal(result.detailRequests,0);
  const view=yahooCardFirstPresentation(result.outcomes);assert.equal(view.lowerPriceAlerts.length,0);assert.equal(view.blockedTargets.length,rows.length);
 }
 assert.equal(reads,0);assert.equal(verifies,0);
});
