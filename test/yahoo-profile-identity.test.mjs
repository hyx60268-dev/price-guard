import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOwnedOffers} from '../public/owned-offers.js';
import {PRICING_RULES_VERSION} from '../public/pricing-policy.js';
import {evaluateYahooDetail} from '../scripts/lib/yahoo.mjs';
import {retainYahooProfileIdentity,observeYahooProfilePair,observeYahooProfileRegistry} from '../scripts/lib/yahoo-profile-identity.mjs';
const now=Date.parse('2026-10-16T23:00:00Z'),old=now-25*3600_000;
const title='APEX ヴァイオレット・エヴァーガーデン 自動手記人形Ver. 1/7 フィギュア 特典付き';
const fp={dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[100,100,100],colorGrid:Array(768).fill(100)};
function profileCard(id,sellerId,accountId,priceJPY,imageUrl){return {id,sellerId,accountId,title,priceJPY,imageUrl,itemStatus:'OPEN',
 profileUrl:`https://paypayfleamarket.yahoo.co.jp/user/${sellerId}`,pageUrl:`https://paypayfleamarket.yahoo.co.jp/user/${sellerId}?page=1`,pageNumber:1,observedAt:now-1000,source:'current_profile_card'}}
async function fixture(accountId='melon',ownId='own'){
 const item={id:ownId,accountId,platform:'yahoo',title,sellerId:'p1',ownPrice:28499};
 const ownDetail={...item,price:item.ownPrice,status:'OPEN',description:'新品 未使用 フィギュア1点 特典付き',images:['https://images.example.invalid/own.jpg'],seller:{id:'p1'}};
 const card={id:'competitor',title,price:28000,image:'https://images.example.invalid/competitor.jpg',sellerId:'p2'};
 const candidateDetail={...card,status:'OPEN',description:ownDetail.description,images:[card.image],seller:{id:'p2'}};
 const evaluation=await evaluateYahooDetail({item,card,bundle:{detail:candidateDetail,observedAt:old+10},ownDetail,ownObservedAt:old,ownSellerId:'p1',ownConditionText:ownDetail.description,ownFingerprints:[fp],ownImageEvidence:[fp]},{imageFingerprints:async()=>fp,now:()=>old+20});
 assert.ok(evaluation.candidate);
 const identity=retainYahooProfileIdentity({item,ownDetail,candidateDetail,evaluation,ownObservedAt:old,candidateObservedAt:old+10,identityVerifiedAt:old+20,rulesVersion:PRICING_RULES_VERSION,now});
 assert.ok(identity);
 return {item,ownDetail,candidateDetail,evaluation,identity,
  ownCard:profileCard(ownId,'p1',accountId,28499,ownDetail.images[0]),candidateCard:profileCard('competitor','p2','seller-p2',28000,card.image),
  settings:{ownedOffers:buildOwnedOffers([], [item]),ownedOffersComplete:true},now};
}

test('current profile prices work with older identity, keeping every original description/identity clock separate on all accounts',async()=>{
 for(const account of ['melon','local-1789214704376','account-p6579087']){
  const row=await fixture(account),before=structuredClone(row.identity),result=observeYahooProfilePair(row);
  assert.equal(result.mode,'profile_observation');assert.equal(result.observation.lowerPriceAlert,true);assert.equal(result.observation.lowerByJPY,499);
  assert.equal(result.observation.ownPriceObservedAt,new Date(now-1000).toISOString());
  assert.equal(result.observation.historicalIdentityVerifiedAt,new Date(old+20).toISOString());
  assert.equal(result.observation.ownDescriptionObservedAt,new Date(old).toISOString());
  assert.equal(result.observation.identityVerifiedAt,null);assert.equal(result.observation.detailCheckedAt,null);
  assert.equal(result.observation.detailVerified,false);assert.equal(result.observation.canRecommend,false);assert.equal(result.observation.procurementCostEligible,false);
  assert.ok(result.observation.unknownTerms.includes('current_image_bytes_not_observed'));
  assert.deepEqual(row.identity,before);assert.equal(result.observation.description,undefined);
 }
});

test('current own profile price overrides old inventory price; missing current competitor never revives its old price',async()=>{
 const row=await fixture();row.ownCard.priceJPY=25000;
 const result=observeYahooProfilePair(row);assert.equal(result.mode,'profile_observation');assert.equal(result.observation.lowerPriceAlert,false);
 assert.equal(result.observation.ownPriceJPY,25000);assert.equal(result.observation.lowerByJPY,0);
 assert.equal(observeYahooProfilePair({...row,candidateCard:null}).mode,'unresolved');
 assert.equal(observeYahooProfilePair({...row,candidateCard:{...row.candidateCard,source:'prior_verified'}}).mode,'unresolved');
 assert.equal(observeYahooProfilePair({...row,candidateCard:{...row.candidateCard,observedAt:old}}).mode,'unresolved');
});

test('changed own identity indicators request own detail; changed competitor indicators request its detail',async()=>{
 const row=await fixture();
 for(const change of [{title:title+' 2点セット'},{imageUrl:'https://images.example.invalid/changed.jpg'}]){
  assert.equal(observeYahooProfilePair({...row,ownCard:{...row.ownCard,...change}}).needs,'own_detail_then_recompare');
  assert.equal(observeYahooProfilePair({...row,candidateCard:{...row.candidateCard,...change}}).needs,'candidate_detail_then_recompare');
 }
 assert.equal(observeYahooProfilePair({...row,candidateCard:{...row.candidateCard,priceJPY:500}}).reason,'price_outlier');
});

test('sold, self, incomplete owned index, wrong seller/page, outdated rules and absent history never produce a price hint',async()=>{
 const row=await fixture();
 const variants=[{...row,ownCard:{...row.ownCard,itemStatus:'SOLD'}},{...row,candidateCard:{...row.candidateCard,itemStatus:'SOLD'}},
  {...row,settings:{}},{...row,ownCard:{...row.ownCard,pageUrl:'https://untrusted.invalid/user/p1?page=1'}},
  {...row,ownCard:{...row.ownCard,observedAt:old}},{...row,identity:{...row.identity,rulesVersion:PRICING_RULES_VERSION-1}},
  {...row,identity:null},{...row,identity:{...row.identity,own:{...row.identity.own,sellerId:'p999'}}}];
 const owned=structuredClone(row.settings);owned.ownedOffers.yahoo.sellers.add('p2');variants.push({...row,settings:owned});
 for(const changed of variants){const outcome=observeYahooProfilePair(changed);assert.notEqual(outcome.mode,'profile_observation');assert.equal(outcome.observation,undefined)}
});

test('history is minted only from accepted target-bound old details, never from a profile or invented current clock',async()=>{
 const row=await fixture(),args={...row,ownObservedAt:old,candidateObservedAt:old+10,identityVerifiedAt:old+20,rulesVersion:PRICING_RULES_VERSION};
 for(const changes of [{evaluation:{currentDetailRead:false,candidate:row.evaluation.candidate}},{candidateDetail:{...row.candidateDetail,id:'other'}},
  {ownObservedAt:null},{identityVerifiedAt:old-1},{candidateObservedAt:now+1},{ownDetail:{...row.ownDetail,description:''}}])
  assert.equal(retainYahooProfileIdentity({...args,...changes}),null);
});

test('unchanged profile fields cannot expose description-only changes; these remain honest false hints, never verified offers',async()=>{
 const row=await fixture();
 for(const description of ['新品 未使用 フィギュア2点セット 特典付き','新品 未使用 フィギュア1点 特典なし']){
  const detail={...row.candidateDetail,description};
  const baseline=await evaluateYahooDetail({item:row.item,card:{...row.candidateDetail,image:row.candidateDetail.images[0]},bundle:{detail},ownDetail:row.ownDetail,
   ownSellerId:'p1',ownConditionText:row.ownDetail.description,ownFingerprints:[fp],ownImageEvidence:[fp]},{imageFingerprints:async()=>fp});
  assert.equal(baseline.candidate,undefined);
  const fast=observeYahooProfilePair(row);assert.equal(fast.observation.lowerPriceAlert,true);assert.equal(fast.observation.detailVerified,false);
  assert.ok(fast.observation.unknownTerms.includes('quantity_bonus_condition_may_have_changed'));
 }
});

test('one current competitor card fans out across bound own accounts without refreshing discovery or completing unlinked inventory',async()=>{
 const rows=await Promise.all(['melon','boss','momoka'].map((account,i)=>fixture(account,'own'+i)));
 const extra={...rows[0].ownCard,id:'unlinked'};
 const settings={ownedOffers:buildOwnedOffers([],rows.map(row=>row.item).concat([{...rows[0].item,id:'unlinked'}])),ownedOffersComplete:true};
 const result=observeYahooProfileRegistry({ownProfiles:[{complete:true,cards:[...rows.map(row=>row.ownCard),extra]}],candidateProfiles:[{complete:true,cards:[rows[0].candidateCard]}],identities:rows.map(row=>row.identity),settings,now});
 assert.equal(result.currentOwnProfileObserved,4);assert.equal(result.currentProfilePriceObservations,3);assert.deepEqual(result.ownItemsWithoutKnownPair,['unlinked']);
 assert.equal(result.completeComparisons,0);assert.equal(result.verifiedCosts,0);assert.equal(result.canRecommend,false);
});

test('aggregate-count root replay separates 635 current own observations from only 123 linked targets and zero complete comparisons',async()=>{
 const {auditYahooProfileRoots}=await import('../scripts/benchmark-yahoo-profile-roots.mjs');
 const result=auditYahooProfileRoots();assert.equal(result.baselineRootPlan.totalPageRequests,792);
 assert.equal(result.conditionalBestCasePlan.totalPageRequests,52);assert.equal(result.conditionalBestCasePlan.requestsSaved,740);
 assert.equal(result.runtimeResult.currentOwnProfileObserved,635);assert.equal(result.runtimeResult.ownItemsWithKnownHints,123);
 assert.equal(result.runtimeResult.currentProfilePriceObservations,140);assert.equal(result.runtimeResult.ownItemsWithoutKnownPair,512);
 assert.equal(result.runtimeResult.completeComparisons,0);assert.equal(result.runtimeResult.verifiedCosts,0);assert.equal(result.additionalMarketRequestsPerformed,0);
});

test('single-page positive receipt can refresh an observed known offer without pretending the seller inventory is complete',async()=>{
 const row=await fixture();
 const result=observeYahooProfileRegistry({ownProfiles:[{complete:true,cards:[row.ownCard]}],
  candidateProfiles:[{complete:false,pageObservationValid:true,cards:[row.candidateCard]}],identities:[row.identity],settings:row.settings,now});
 assert.equal(result.currentProfilePriceObservations,1);assert.equal(result.completeComparisons,0);
 const missing=observeYahooProfileRegistry({ownProfiles:[{complete:true,cards:[row.ownCard]}],
  candidateProfiles:[{complete:false,pageObservationValid:true,cards:[]}],identities:[row.identity],settings:row.settings,now});
 assert.equal(missing.outcomes[0].mode,'unresolved');assert.equal(missing.outcomes[0].reason,'candidate_not_observed');
});

test('seller probe plan uses at most one page per multi-offer seller, not an unbounded inventory crawl',async()=>{
 const {planYahooKnownSellerProbes}=await import('../scripts/lib/yahoo-profile-identity.mjs');
 const result=planYahooKnownSellerProbes([{candidate:{id:'a',sellerId:'p1'}},{candidate:{id:'b',sellerId:'p1'}},{candidate:{id:'b',sellerId:'p1'}},{candidate:{id:'c',sellerId:'p2'}}]);
 assert.equal(result.groups[0].maximumProbePages,1);assert.deepEqual(result.groups[0].knownCandidateIds,['a','b']);
 assert.equal(result.groups[1].mode,'direct_detail');assert.equal(result.groups[1].maximumProbePages,0);
 assert.equal(result.diagnostics.uniqueKnownOffers,3);assert.equal(result.sourceRequestsPerformed,0);assert.equal(result.absenceMeansSold,false);
});

test('saved corrections and their relisting lineage remain effective; a deletion tombstone restores only provisional eligibility',async()=>{
 const row=await fixture();row.identity.relistingParentId='previous-own';
 const record={accountId:row.ownCard.accountId,itemId:'previous-own',platform:'yahoo',candidateId:row.candidateCard.id,
  ownTitle:row.ownCard.title,ownImage:row.ownCard.imageUrl};
 row.settings.matchCorrections={example:record};
 assert.equal(observeYahooProfilePair(row).reason,'saved_user_correction');
 record.deleted=true;assert.equal(observeYahooProfilePair(row).mode,'profile_observation');
});

test('real profile receipt feeds the historical-pair layer with original current card clocks and no additional reads',async()=>{
 const {yahooProfileObservation,yahooProfilePageObservation}=await import('../scripts/lib/yahoo-profile-observation.mjs');
 const row=await fixture();
 const entry=card=>({pageNumber:1,requestedUrl:card.pageUrl,response:{url:card.pageUrl,status:200,redirected:false,fromCache:false,observedAt:card.observedAt},
  result:{items:[{id:card.id,title:card.title,price:card.priceJPY,thumbnailImageUrl:card.imageUrl,itemStatus:card.itemStatus,sellerId:card.sellerId}],totalResultsAvailable:1,totalResultsReturned:1,offset:0}});
 const account=card=>({id:card.accountId,platform:'yahoo',sellerId:card.sellerId,profileUrl:card.profileUrl});
 const own=yahooProfileObservation({account:account(row.ownCard),pages:[entry(row.ownCard)],now});
 const candidate=yahooProfilePageObservation({account:account(row.candidateCard),page:entry(row.candidateCard),now});
 assert.equal(own.complete,true);assert.equal(candidate.complete,false);assert.equal(candidate.pageObservationValid,true);
 const result=observeYahooProfileRegistry({ownProfiles:[own],candidateProfiles:[candidate],identities:[row.identity],settings:row.settings,now});
 assert.equal(result.currentProfilePriceObservations,1);assert.equal(result.outcomes[0].observation.lowerPriceAlert,true);
 assert.equal(result.outcomes[0].observation.candidatePriceObservedAt,new Date(row.candidateCard.observedAt).toISOString());
 assert.equal(result.outcomes[0].observation.historicalIdentityVerifiedAt,row.identity.identityVerifiedAt);
 const bad=entry(row.candidateCard);delete bad.result.items[0].sellerId;
 const missing=yahooProfilePageObservation({account:account(row.candidateCard),page:bad,now});
 assert.equal(missing.pageObservationValid,true);assert.equal(missing.cards.length,0);assert.equal(missing.membershipIds.length,1);
 const uncertain=observeYahooProfileRegistry({ownProfiles:[own],candidateProfiles:[missing],identities:[row.identity],settings:row.settings,now});
 assert.equal(uncertain.currentProfilePriceObservations,0);assert.equal(uncertain.outcomes[0].mode,'unresolved');
});

test('accepted evaluator receipts cannot be borrowed for another target/account, changed body/image, or re-timed after verification',async()=>{
 const row=await fixture(),args={...row,ownObservedAt:old,candidateObservedAt:old+10,identityVerifiedAt:old+20,rulesVersion:PRICING_RULES_VERSION};
 for(const changes of [
  {item:{...row.item,accountId:'another-account'}},
  {item:{...row.item,id:'another-own'},ownDetail:{...row.ownDetail,id:'another-own'}},
  {ownDetail:{...row.ownDetail,images:['https://images.example.invalid/new-own.jpg']},candidateDetail:{...row.candidateDetail,images:['https://images.example.invalid/new-candidate.jpg']}},
  {candidateDetail:{...row.candidateDetail,description:'新品 未使用 フィギュア1点 特典付き changed'}},
  {ownObservedAt:old+1},{candidateObservedAt:old+11},{identityVerifiedAt:old+21},
  {evaluation:{...row.evaluation,verificationContext:null}},
 ])assert.equal(retainYahooProfileIdentity({...args,...changes}),null);
 assert.ok(retainYahooProfileIdentity(args));
});

test('input mutation during image verification cannot mint a historical binding; old no-clock evaluations still return ordinary quotes',async()=>{
 const row=await fixture();
 const args={item:row.item,card:row.evaluation.candidate,bundle:{detail:row.candidateDetail,observedAt:old+10},ownDetail:row.ownDetail,ownObservedAt:old,
  ownSellerId:'p1',ownConditionText:row.ownDetail.description,ownFingerprints:[fp],ownImageEvidence:[fp]};
 const normal=await evaluateYahooDetail({...args,ownObservedAt:null},{imageFingerprints:async()=>fp,now:()=>old+20});
 assert.ok(normal.candidate);assert.equal(normal.verificationContext,null);
 const mutated=await evaluateYahooDetail(args,{imageFingerprints:async()=>{row.item.accountId='changed-during-await';return fp},now:()=>old+20});
 assert.ok(mutated.candidate);assert.equal(mutated.verificationContext,null);
});

test('registry chooses newest original card clock, never input order, and fails closed for equal-time field conflicts',async()=>{
 const row=await fixture(),own={complete:true,cards:[row.ownCard]},oldCard={...row.candidateCard,observedAt:now-19*60_000};
 const newCard={...row.candidateCard,itemStatus:'SOLD'};
 const run=cards=>observeYahooProfileRegistry({ownProfiles:[own],candidateProfiles:cards.map(card=>({pageObservationValid:true,cards:[card]})),identities:[row.identity],settings:row.settings,now});
 for(const cards of [[oldCard,newCard],[newCard,oldCard]])assert.equal(run(cards).outcomes[0].reason,'candidate_not_open');
 const newPrice={...row.candidateCard,priceJPY:30000};
 for(const cards of [[oldCard,newPrice],[newPrice,oldCard]]){const result=run(cards);assert.equal(result.outcomes[0].observation.priceJPY,30000);assert.equal(result.outcomes[0].observation.lowerPriceAlert,false)}
 for(const cards of [[row.candidateCard,newCard],[newCard,row.candidateCard]]){
  const result=run(cards);assert.equal(result.currentProfilePriceObservations,0);assert.equal(result.outcomes[0].reason,'profile_same_time_conflict');
 }
});

test('a newer observed ineligible row blocks an older valid card; missing per-row clock cannot borrow aggregate max time',async()=>{
 const row=await fixture(),own={complete:true,cards:[row.ownCard]},older={pageObservationValid:true,cards:[{...row.candidateCard,observedAt:now-19*60_000}]};
 const newer={pageObservationValid:true,cards:[],membershipIds:[row.candidateCard.id],rowObservations:[{id:row.candidateCard.id,observedAt:now-500,cardEligible:false,reason:'image_invalid'}]};
 const run=profiles=>observeYahooProfileRegistry({ownProfiles:[own],candidateProfiles:profiles,identities:[row.identity],settings:row.settings,now});
 for(const profiles of [[older,newer],[newer,older]]){
  const result=run(profiles);assert.equal(result.currentProfilePriceObservations,0);assert.equal(result.outcomes[0].reason,'latest_profile_row_ineligible');
 }
 const legacy={...newer,rowObservations:undefined,observedAt:now-500,maxObservedAt:now-100};
 for(const profiles of [[older,legacy],[legacy,older]])assert.equal(run(profiles).outcomes[0].reason,'profile_row_clock_unbound');
});

test('all enumerated membership remains visible when own quote fields are unusable',async()=>{
 const row=await fixture(),profile={complete:true,membershipIds:['own','unpriced'],cards:[row.ownCard],rowObservations:[
  {id:'own',observedAt:row.ownCard.observedAt,cardEligible:true},{id:'unpriced',observedAt:now-500,cardEligible:false,reason:'seller_missing'}]};
 const result=observeYahooProfileRegistry({ownProfiles:[profile],candidateProfiles:[{complete:true,cards:[row.candidateCard]}],identities:[row.identity],settings:row.settings,now});
 assert.equal(result.enumeratedOwnMembershipCount,2);assert.equal(result.currentOwnProfileObserved,1);assert.equal(result.unverifiedOwnItems.length,1);
 assert.deepEqual(result.ownItemsWithoutKnownPair,['unpriced']);assert.equal(result.unverifiedOwnItems[0].ownId,'unpriced');
 const {yahooProfilePricePresentation}=await import('../scripts/lib/yahoo-profile-identity.mjs');
 const view=yahooProfilePricePresentation(result);assert.equal(view.enumeratedOwnMembershipCount,2);assert.equal(view.unverifiedOwnItemCount,1);
 assert.equal(view.pending.at(-1).ownId,'unpriced');assert.equal(view.complete,false);
});

test('format-only title changes cannot restore a rejected competitor through relisting ancestry',async()=>{
 const row=await fixture();row.identity.relistingParentId='previous-own';
 row.identity.own.title=title.replace(' 1/7','  1/7');
 row.settings.matchCorrections={example:{accountId:row.ownCard.accountId,itemId:'previous-own',platform:'yahoo',candidateId:row.candidateCard.id,
  ownTitle:title.replace(' 1/7','   1/7'),ownImage:row.ownCard.imageUrl}};
 assert.equal(observeYahooProfilePair(row).reason,'saved_user_correction');
 row.settings.matchCorrections.example.deleted=true;assert.equal(observeYahooProfilePair(row).mode,'profile_observation');
});

test('absence in a newer complete seller traversal invalidates an old positive price without claiming sold',async()=>{
 const row=await fixture(),own={complete:true,cards:[row.ownCard]};
 const oldProfile={pageObservationValid:true,cards:[{...row.candidateCard,observedAt:now-10_000}],sellerId:'p2'};
 const completeEmpty={complete:true,enumerationComplete:true,observedAt:now-500,sellerId:'p2',membershipIds:[],cards:[]};
 const run=profiles=>observeYahooProfileRegistry({ownProfiles:[own],candidateProfiles:profiles,identities:[row.identity],settings:row.settings,now});
 for(const profiles of [[oldProfile,completeEmpty],[completeEmpty,oldProfile]]){
  const result=run(profiles);assert.equal(result.currentProfilePriceObservations,0);assert.equal(result.outcomes[0].mode,'unresolved');
  assert.equal(result.outcomes[0].reason,'absent_from_newer_complete_profile');
 }
 const partialEmpty={...completeEmpty,complete:false,enumerationComplete:false,pageObservationValid:true};
 assert.equal(run([oldProfile,partialEmpty]).currentProfilePriceObservations,1);
 const olderEmpty={...completeEmpty,observedAt:now-20_000};assert.equal(run([oldProfile,olderEmpty]).currentProfilePriceObservations,1);
});

test('real page receipts retain newest ineligible barriers and complete membership denominator end to end',async()=>{
 const {yahooProfileObservation,yahooProfilePageObservation}=await import('../scripts/lib/yahoo-profile-observation.mjs');
 const row=await fixture();
 const entry=(card,changes={})=>({pageNumber:1,requestedUrl:card.pageUrl,response:{url:card.pageUrl,status:200,redirected:false,fromCache:false,observedAt:card.observedAt},
  result:{items:[{id:card.id,title:card.title,price:card.priceJPY,thumbnailImageUrl:card.imageUrl,itemStatus:card.itemStatus,sellerId:card.sellerId,...changes}],totalResultsAvailable:1,totalResultsReturned:1,offset:0}});
 const account=card=>({id:card.accountId,platform:'yahoo',sellerId:card.sellerId,profileUrl:card.profileUrl});
 const old=yahooProfilePageObservation({account:account(row.candidateCard),page:entry({...row.candidateCard,observedAt:now-19*60_000}),now});
 const ownPage=entry(row.ownCard);ownPage.result.items.push({...ownPage.result.items[0],id:'unpriced',thumbnailImageUrl:null});ownPage.result.totalResultsAvailable=2;ownPage.result.totalResultsReturned=2;
 const own=yahooProfileObservation({account:account(row.ownCard),pages:[ownPage],now});
 for(const changes of [{sellerId:undefined},{thumbnailImageUrl:null},{price:null},{itemStatus:'SOLD',thumbnailImageUrl:null}]){
  const latest=yahooProfilePageObservation({account:account(row.candidateCard),page:entry({...row.candidateCard,observedAt:now-500},changes),now});
  assert.equal(latest.cards.length,0);assert.equal(latest.rowObservations[0].observedAt,now-500);
  for(const candidateProfiles of [[old,latest],[latest,old]]){
   const result=observeYahooProfileRegistry({ownProfiles:[own],candidateProfiles,identities:[row.identity],settings:row.settings,now});
   assert.equal(result.currentProfilePriceObservations,0);assert.equal(result.outcomes[0].reason,'latest_profile_row_ineligible');
   assert.equal(result.enumeratedOwnMembershipCount,2);assert.equal(result.unverifiedOwnItems.length,1);
   assert.deepEqual(result.ownItemsWithoutKnownPair,['unpriced']);
  }
 }
});
