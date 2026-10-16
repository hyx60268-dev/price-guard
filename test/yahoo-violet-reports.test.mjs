import test from 'node:test';
import assert from 'node:assert/strict';
import {yahooCompare,screenYahooCard,extractRecommendationCards} from '../scripts/lib/yahoo.mjs';
import {MATCHING_RULES_VERSION} from '../scripts/lib/rules.mjs';
import {deferredYahooComparison} from '../scripts/lib/pricing-coverage.mjs';
import {RequestDeferredError} from '../scripts/lib/request-cooldown.mjs';
import {buildOwnedOffers} from '../public/owned-offers.js';
import {violetReports} from './fixtures/yahoo-violet-reports.mjs';

// Only titles, screenshot prices and the suitcase competitor ID are observed.
// Descriptions, OPEN status and fingerprints below are CONTROLLED test evidence,
// not fabricated live reads, and do not establish the live miss's rejection reason.
const fp={dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[100,100,100],colorGrid:Array(768).fill(100)};
const url=id=>`https://paypayfleamarket.yahoo.co.jp/item/${id}`;
async function replay(report,{accountId='melon',candidate={},own={},settings={},known=false}={}){
 const ownId=report.historicalOwnId,candidateId=report.candidateId||'fixtureUmbrellaCandidate';
 const card={id:candidateId,title:report.candidateTitle,price:report.candidatePrice,sellerId:report.sellerId,image:'controlled-candidate-image',source:'recommendation',sources:['recommendation'],url:url(candidateId),matchMethod:'exact_bidirectional_title_identity'};
 const item={id:ownId,accountId,platform:'yahoo',sellerId:'fixtureManaged',title:report.ownTitle,ownPrice:report.ownPrice,image:'controlled-own-image',url:url(ownId)};
 if(known)item.yahoo={rulesVersion:MATCHING_RULES_VERSION,status:'ok',checkedAt:report.priorObservation?.checkedAt||'2026-10-16T06:00:00Z',audit:{ownItemId:ownId,accountId},candidates:[{...card,price:28500}]};
 const detail={id:candidateId,title:report.candidateTitle,price:report.candidatePrice,couponPrice:report.couponPrice,seller:{id:report.sellerId},description:'新品 未使用 フィギュア1点 特典付き',images:['controlled-candidate-image'],status:'OPEN',...candidate};
 const ownDetail={id:ownId,title:report.ownTitle,price:report.ownPrice,seller:{id:'fixtureManaged'},description:'新品 未使用 フィギュア1点 特典付き',images:['controlled-own-image'],status:'OPEN',...own};
 const reads=[],shipping={shippingKnown:true,shippingJPY:0,currency:'JPY',shippingSource:'target_price_area'};
 const result=await yahooCompare(null,item,{...(known?{yahooKnownOnly:true,yahooKnownCandidateIds:[candidateId]}:{}),...settings},{
  fetchYahooResult:async()=>{reads.push('search');if(known)throw Error('known refresh must not search');return {items:[]}},
  fetchYahooItemBundle:async id=>{reads.push(id);return id===ownId?{detail:ownDetail,shipping,recommendations:[card]}:{detail,shipping}},
  imageFingerprints:async()=>fp
 });
 return {result,reads,item};
}
for(const report of violetReports){
 test(`${report.key}: actual screenshot title is recalled even without vector metadata`,()=>{
  const screening=screenYahooCard({id:report.historicalOwnId,title:report.ownTitle},{id:report.candidateId||'fixture',title:report.candidateTitle,price:28000,source:'recommendation',sources:['recommendation']});
  assert.ok(screening.card);assert.equal(screening.card.titleScore,1);
 });
 for(const accountId of ['melon','local-1789214704376','account-p6579087'])test(`${accountId} ${report.key}: full controlled same-offer proof accepts ordinary 28000, never coupon 27000`,async()=>{
  const {result}=await replay(report,{accountId});assert.equal(result.competitorCount,1);assert.equal(result.candidates[0].price,28000);assert.equal(result.recommendedPrice,27999);
 });
 test(`${report.key}: SOLD recommendation cannot become an active competitor`,async()=>{
  const {result}=await replay(report,{candidate:{status:'SOLD'}});assert.equal(result.competitorCount,0);assert.ok(result.rejected.some(row=>row.reason==='not_open'));
 });
 test(`${report.key}: any managed account is excluded`,async()=>{
  const ownedOffers=buildOwnedOffers([{id:'other-managed',platform:'yahoo',sellerId:report.sellerId}]);
  const {result}=await replay(report,{settings:{ownedOffers}});assert.equal(result.competitorCount,0);assert.ok(result.rejected.some(row=>row.reason==='own_seller'));
 });
 test(`${report.key}: unavailable description cannot be replaced by matching screenshot title and photo`,async()=>{
  const {result}=await replay(report,{candidate:{description:''}});assert.equal(result.competitorCount,0);assert.equal(result.status,'incomplete');assert.ok(result.rejected.some(row=>row.reason==='sale_description_unavailable'));
 });
}
test('historically recognized suitcase link refreshes its changed base price with complete controlled current detail',async()=>{
 const {result,reads}=await replay(violetReports[0],{known:true});
 assert.deepEqual(reads,['z704304540','z704300094']);assert.equal(result.candidates[0].price,28000);assert.equal(result.candidates[0].shippingJPY,0);
});
test('both Yahoo recommendation rails are consumed; market-price SOLD cards are not current proof',()=>{
 const raw=(itemId,price)=>({itemId,price,title:violetReports[0].candidateTitle});
 const groups={similar:{recommendItems:{items:[raw('z704300094',28000)]}},viewed:{recommendItems:{items:[raw('fixtureUmbrella',28000)]}}};
 const cards=extractRecommendationCards({props:{initialState:{recommendsState:{recommends:{recommends:groups}}}}});
 assert.deepEqual(cards.map(row=>row.recommendationSection),['similar','viewed']);assert.ok(cards.every(row=>row.itemStatus===null));
});
test('reported umbrella deadline failure cannot acquire a newer quote clock',()=>{
 const old={checkedAt:'2026-10-16T10:17:18.597Z',searchCheckedAt:'2026-10-16T10:15:00Z',status:'incomplete',candidates:[],lowestPrice:28499};
 const value=deferredYahooComparison(old,new RequestDeferredError('request_cooldown_deadline'));
 assert.equal(value.checkedAt,old.checkedAt);assert.equal(value.searchCheckedAt,old.searchCheckedAt);assert.equal(value.cacheReason,'request_error');assert.equal(value.deferredReason,'request_cooldown_deadline');
});
