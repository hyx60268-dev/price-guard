import test from 'node:test';
import assert from 'node:assert/strict';
import {knownYahooCandidates,knownYahooRevalidationCandidates,knownYahooRefreshTasks,runKnownYahooRefresh} from '../scripts/lib/yahoo-known-refresh.mjs';
import {yahooCompare} from '../scripts/lib/yahoo.mjs';
import {MATCHING_RULES_VERSION} from '../scripts/lib/rules.mjs';
import {RequestDeferredError} from '../scripts/lib/request-cooldown.mjs';
import {pricingDecision} from '../public/pricing-policy.js';
import {buildOwnedOffers} from '../public/owned-offers.js';
import {violetReports} from './fixtures/yahoo-violet-reports.mjs';

// The current own ID, old clocks, rules version and external ID/price are from
// run 39018346601. All descriptions, images, current prices and OPEN responses
// below are controlled fixtures, not a claim that the live offer was re-read.
const report=violetReports[0],old='2026-10-16T22:35:10.363Z';
const full='2026-10-16T21:59:58.342Z',search='2026-10-16T18:29:30.199Z';
const NOW=Date.parse('2026-10-17T08:45:00.000Z');
const fp={dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[100,100,100],colorGrid:Array(768).fill(100)};
const shipping={shippingKnown:true,shippingJPY:0,currency:'JPY',shippingSource:'target_price_area'};
function product(accountId='melon'){
 const item={id:'z705438862',accountId,platform:'yahoo',comparisonMode:'same_platform',sellerId:'fixture-managed',
  title:report.ownTitle,image:'fixture-own-image',ownPrice:28499,manualCost:{purchaseCNY:123}};
 item.yahoo={rulesVersion:22,status:'cached',evidenceStatus:'incomplete',cacheReason:'request_error',
  checkedAt:old,searchCheckedAt:search,lastFullAttemptAt:full,lastAttemptAt:old,knownLastAttemptAt:old,
  audit:{accountId,ownItemId:item.id,rulesVersion:22},
  candidates:[{id:report.candidateId,sellerId:report.sellerId,title:report.candidateTitle,image:'fixture-candidate-image',
   url:`https://paypayfleamarket.yahoo.co.jp/item/${report.candidateId}`,price:28000,
   matchMethod:'exact_bidirectional_title_identity',checkedAt:old,itemStatus:'OPEN',priceSource:'current_target_detail',
   shippingJPY:0,shippingSource:'target_price_area',identityEvidence:{old:true},bonusComparison:{old:true},profileIdentity:{old:true}}]};
 return item;
}
function context(item){return {account:{id:item.accountId},activeItems:[item],previousById:new Map([[item.id,structuredClone(item)]])};}
async function replay({accountId='melon',mutate,own={},candidate={},ownShipping=shipping,candidateShipping=shipping,settings={},error}={}){
 const item=product(accountId);mutate?.(item);const before=structuredClone(item),reads=[];
 const tasks=knownYahooRefreshTasks([context(item)],settings,NOW);
 const results=await runKnownYahooRefresh(tasks,{deadline:NOW+120000,now:()=>NOW,lookup:async({item,prior,candidates})=>yahooCompare(null,{...item,yahoo:prior.yahoo},
  {...settings,yahooKnownOnly:true,yahooKnownCandidateIds:candidates.slice(0,1).map(row=>row.id)},
  {fetchYahooResult:async()=>{throw Error('Historical hint must not request broad search');},imageFingerprints:async()=>fp,
   fetchYahooItemBundle:async id=>{
    reads.push(id);if(error&&id!==item.id)throw error;
    if(id===item.id)return {detail:{id,title:item.title,price:28499,seller:{id:item.sellerId},description:'新品 未使用 フィギュア1点 特典付き',images:[item.image],status:'OPEN',...own},shipping:ownShipping,recommendations:[]};
    return {detail:{id,title:report.candidateTitle,price:27950,couponPrice:26950,seller:{id:report.sellerId},description:'新品 未使用 フィギュア1点 特典付き',images:['fixture-candidate-image'],status:'OPEN',...candidate},shipping:candidateShipping};
   }} )});
 assert.deepEqual(item,before,'scheduler and verifier must not rewrite saved evidence or manual costs');
 return {item,tasks,reads,value:results.get(item.accountId+':'+item.id)?.value};
}

test('v22 evidence stays non-actionable but its bound link enters only the revalidation queue',()=>{
 const item=product(),before=structuredClone(item);
 assert.equal(knownYahooCandidates(item).length,0);
 assert.equal(pricingDecision(item,{now:NOW}).canRecommend,false);
 const hints=knownYahooRevalidationCandidates(item);
 assert.equal(hints.length,1);assert.deepEqual(Object.keys(hints[0]).sort(),['id','image','price','sellerId','title','url']);
 assert.equal(hints[0].id,report.candidateId);
 assert.equal(knownYahooRefreshTasks([context(item)],{},NOW).length,1);
 assert.deepEqual(item,before);
});

for(const accountId of ['melon','account-p6579087','local-1789214704376'])test(`${accountId}: old known link requires two current detail reads before adopting a new price`,async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW});
 const {item,reads,value}=await replay({accountId});
 assert.deepEqual(reads,[item.id,report.candidateId]);
 assert.equal(value.rulesVersion,MATCHING_RULES_VERSION);assert.equal(value.candidates.length,1);
 const offer=value.candidates[0];assert.equal(offer.price,27950);assert.notEqual(offer.price,28000);assert.notEqual(offer.price,26950);
 assert.equal(offer.checkedAt,new Date(NOW).toISOString());assert.equal(value.checkedAt,offer.checkedAt);
 assert.equal(value.searchCheckedAt,search);assert.equal(value.lastFullAttemptAt,full);assert.equal(value.lastAttemptAt,old);
 assert.equal(offer.identityEvidence,undefined);assert.equal(offer.profileIdentity,undefined);assert.notDeepEqual(offer.bonusComparison,{old:true});
 assert.equal(offer.priceSource,'current_target_detail');assert.equal(offer.shippingSource,'target_price_area');
 const decision=pricingDecision({...item,yahoo:value},{now:NOW});
 assert.equal(decision.canRecommend,true);assert.equal(decision.recommendedPrice,27949);assert.equal(decision.complete,false);
 assert.equal(value.searchComplete,false);
});

test('historical hint admission rejects wrong bindings, invalid/future rules, ownership and saved corrections before reads',async()=>{
 const changes=[item=>item.yahoo.audit.accountId='other',item=>item.yahoo.audit.ownItemId='relisted',item=>item.id='relisted',
  item=>item.platform='rakuma',item=>item.yahoo.rulesVersion=0,item=>item.yahoo.rulesVersion=-1,
  item=>item.yahoo.rulesVersion=MATCHING_RULES_VERSION+1,item=>item.yahoo.rulesVersion='22',item=>item.yahoo.rulesVersion=22.5,
  item=>item.yahoo.checkedAt=null,item=>item.yahoo.evidenceStatus='error',item=>item.yahoo.candidates[0].matchMethod='title_only',
  item=>item.yahoo.candidates[0].sellerId=item.sellerId];
 for(const mutate of changes){const result=await replay({mutate});assert.equal(result.tasks.length,0);assert.deepEqual(result.reads,[]);}
 for(const accountId of ['melon','account-p6579087','local-1789214704376']){
  const ownedOffers=buildOwnedOffers([{id:'another-managed',platform:'yahoo',sellerId:report.sellerId}]);
  assert.deepEqual((await replay({accountId,settings:{ownedOffers}})).reads,[]);
  const matchCorrections={entry:{accountId,itemId:'z705438862',platform:'yahoo',candidateId:report.candidateId}};
  assert.deepEqual((await replay({accountId,settings:{matchCorrections}})).reads,[]);
 }
});

test('old match proof cannot bypass current own, ID, seller, OPEN, shipping, quantity, condition or bonus gates',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW});
 const cases=[{own:{id:'wrong'}},{own:{status:'SOLD'}},{own:{seller:{id:'changed'}}},{own:{description:''}},
  {own:{title:report.ownTitle+' changed'}},{ownShipping:{shippingKnown:false}},
  {candidate:{id:'wrong'}},{candidate:{id:undefined}},{candidate:{status:'SOLD'}},{candidate:{seller:{id:'changed'}}},
  {candidate:{seller:{id:'fixture-managed'}}},{candidate:{description:''}},{candidate:{images:[]}},{candidate:{price:0}},
  {candidateShipping:{shippingKnown:false}},{candidateShipping:{...shipping,shippingJPY:500}},
  {candidate:{description:'新品 未使用 フィギュア2点セット 特典付き'}},
  {candidate:{title:report.candidateTitle.replace('1/7','1/8')}},
  {candidate:{title:report.candidateTitle.replace('自動手記人形Ver.','水着Ver.')}},
  {candidate:{description:'傷あり 破損 ジャンク フィギュア1点 特典付き'}},
  {candidate:{title:report.candidateTitle.replace('特典付き','特典なし'),description:'新品 未使用 フィギュア1点 特典なし'}},
  {candidate:{title:report.candidateTitle.replace('特典付き',''),description:'新品 未使用 フィギュア1点'}}];
 for(const options of cases){
  const {item,value}=await replay(options);assert.equal(value.rulesVersion,22,JSON.stringify(options));
  assert.equal(value.checkedAt,old);assert.equal(value.searchCheckedAt,search);assert.equal(value.lastFullAttemptAt,full);
  assert.equal(value.cacheReason,'request_error');assert.equal(pricingDecision({...item,yahoo:value},{now:NOW}).canRecommend,false);
 }
});

test('a recently observed historical quote cannot lengthen the ordinary broad-search interval',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW});
 const item=product();item.yahoo.checkedAt=new Date(NOW-60000).toISOString();item.yahoo.cacheReason=null;
 item.yahoo.searchCheckedAt=new Date(NOW-21*60000).toISOString();
 let searches=0;
 await yahooCompare(null,item,{yahooFreshMinutes:20,yahooBroadSearchHours:6},{
  fetchYahooResult:async()=>{searches++;return {items:[]};},imageFingerprints:async()=>fp,
  fetchYahooItemBundle:async id=>({detail:{id,title:id===item.id?item.title:report.candidateTitle,price:id===item.id?item.ownPrice:27950,
   seller:{id:id===item.id?item.sellerId:report.sellerId},description:'新品 未使用 フィギュア1点 特典付き',images:['fixture-image'],status:'OPEN'},recommendations:[]})
 });
 assert.equal(searches,1,'only current-rule evidence may extend the broad-search interval');
 assert.equal(item.yahoo.rulesVersion,22);
});

test('source deferral and transport failure preserve old price/version/clocks and never complete an obligation',async t=>{
 t.mock.timers.enable({apis:['Date'],now:NOW});
 for(const error of [new RequestDeferredError('request_cooldown_deadline',NOW+300000),Error('fixture transport failure')]){
  const {item,value}=await replay({error});assert.equal(value.rulesVersion,22);assert.equal(value.checkedAt,old);
  assert.equal(value.searchCheckedAt,search);assert.equal(value.lastFullAttemptAt,full);assert.equal(value.candidates[0].price,28000);
  assert.equal(value.cacheReason,'request_error');assert.equal(pricingDecision({...item,yahoo:value},{now:NOW}).canRecommend,false);
  assert.equal(pricingDecision({...item,yahoo:value},{now:NOW}).complete,false);
 }
});
