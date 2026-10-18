import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {PRICING_RULES_VERSION} from '../public/pricing-policy.js';
import {buildOwnedOffers} from '../public/owned-offers.js';
import {observeYahooProfileRegistry} from './lib/yahoo-profile-identity.mjs';
const at=Date.parse('2026-10-16T23:00:00Z'),old=new Date(at-25*3600_000).toISOString();
const accountCounts=[['melon','p1',100],['account-p6579087','p2',487],['local-1789214704376','p3',48]];
const card=(id,sellerId,accountId,title,priceJPY)=>({id,sellerId,accountId,title,priceJPY,imageUrl:`https://images.example.invalid/${id}.jpg`,
 itemStatus:'OPEN',profileUrl:`https://paypayfleamarket.yahoo.co.jp/user/${sellerId}`,pageUrl:`https://paypayfleamarket.yahoo.co.jp/user/${sellerId}?page=1`,pageNumber:1,observedAt:at-1000,source:'current_profile_card'});
export function auditYahooProfileRoots(){
 let n=0;const ownProfiles=accountCounts.map(([accountId,sellerId,count])=>({complete:true,cards:Array.from({length:count},()=>{
  const number=n++;return card('controlled-own-'+number,sellerId,accountId,`APEX control figure ${number} フィギュア1点`,10000+number);
 })}));
 const ownCards=ownProfiles.flatMap(profile=>profile.cards),candidateProfiles=Array.from({length:35},()=>({complete:true,cards:[]})),identities=[];
 for(let i=0;i<140;i++){
  const own=ownCards[i%123],sellerId='p'+(100+Math.floor(i/4)),candidate=card('controlled-competitor-'+i,sellerId,'seller-'+sellerId,own.title,own.priceJPY-500);
  candidateProfiles[Math.floor(i/4)].cards.push(candidate);
  const snapshot=row=>({id:row.id,sellerId:row.sellerId,title:row.title,imageUrl:row.imageUrl,detailObservedAt:old,descriptionObservedAt:old});
  identities.push({version:1,source:'accepted_detail_pair',rulesVersion:PRICING_RULES_VERSION,accountId:own.accountId,
   own:snapshot(own),candidate:snapshot(candidate),identityVerifiedAt:old,matchMethod:'controlled_prior_detail_identity'});
 }
 const settings={ownedOffersComplete:true,ownedOffers:buildOwnedOffers([],ownCards.map(row=>({...row,platform:'yahoo'})))};
 const registry=observeYahooProfileRegistry({ownProfiles,candidateProfiles,identities,settings,now:at});
 // Counts below model source requests, not local function invocations. All
 // records are frozen/synthetic; actual persisted binding availability is unknown.
 const roots={ownProfilePages:17,ownDetails:635,knownCandidateDetails:140,candidateSellers:35};
 const baseline=roots.ownProfilePages+roots.ownDetails+roots.knownCandidateDetails;
 const plan=pages=>({candidateProfilePages:pages,totalPageRequests:roots.ownProfilePages+pages,
  requestsSaved:baseline-roots.ownProfilePages-pages,savingFraction:(baseline-roots.ownProfilePages-pages)/baseline,
  fiveSecondGateStartSpanSeconds:(roots.ownProfilePages+pages-1)*5});
 return {version:1,kind:'offline_controlled_root_plan_not_live_performance',frozenAt:new Date(at).toISOString(),
  measuredProductionCounts:{yahooOwnItems:635,ownProfilePages:17,ownProfileElapsedSeconds:81,knownLinkedOwnItems:123,uniqueKnownCandidateIds:140,knownSellers:35,
   source:'Production run telemetry supplied by scan owner; no decrypted row-level state or raw seller profile retained'},
  fixtureDisclosure:'635 own cards and 140 candidate cards are synthetic records matching aggregate counts. Every one of the 140 historical bindings is manufactured for this controlled replay, not evidence that 140 production links are eligible.',
  assuranceDifference:'Baseline counts repeated own/known-offer detail reads; optimized output is current profile price/status plus OLD identity, not equivalent fresh descriptions, image bytes, new candidate discovery, complete pricing or procurement.',
  baselineRootPlan:{...roots,totalPageRequests:baseline},
  conditionalBestCasePlan:plan(35),
  discoveryPreservingOptimisticPlan:{ownProfilePages:17,ownRecommendationDetailPagesForUnlinkedTargets:512,candidateProfilePages:35,
   totalPageRequests:564,requestsSaved:228,savingFraction:228/792,fiveSecondGateStartSpanSeconds:563*5,
   caveat:'Still omits candidate validation/new discovery for known targets, images, procurement and holds. 140 usable current-rule bindings and all first-page hits are assumed, not measured.'},
  bootstrap:{productionEligibleHistoricalBindingCount:null,legacyClocklessBindingsUpgradeable:false,
   firstCycleSavingsGuaranteed:false,mechanism:'Retain exact bound receipts beside normal successful detail reads; do not retrospectively mint them from cached accepted quotes.'},
  boundedFirstPageProbeSensitivity:[0,35,49,70,105,140].map(hits=>({knownOfferHits:hits,profileProbes:35,missingDetailReads:140-hits,totalWithOwnProfiles:17+35+140-hits,candidateRequestsSavedVs140Details:hits-35})),
  sellerPaginationSensitivity:[35,70,140,280].map(plan),
  runtimeResult:{enumeratedOwnMembershipCount:registry.enumeratedOwnMembershipCount,unverifiedOwnItemCount:registry.unverifiedOwnItems.length,currentOwnProfileObserved:registry.currentOwnProfileObserved,knownPairLinks:registry.knownPairLinks,
   currentProfilePriceObservations:registry.currentProfilePriceObservations,lowerPriceHints:registry.outcomes.filter(row=>row.observation?.lowerPriceAlert).length,
   ownItemsWithKnownHints:new Set(registry.outcomes.filter(row=>row.observation).map(row=>row.ownId)).size,
   ownItemsWithoutKnownPair:registry.ownItemsWithoutKnownPair.length,completeComparisons:registry.completeComparisons,verifiedCosts:registry.verifiedCosts},
  evidenceClocks:{currentProfilePriceObservedAt:new Date(at-1000).toISOString(),historicalIdentityAndDescriptionObservedAt:old,newDetailVerifiedAt:null},
  additionalMarketRequestsPerformed:0,productionActivation:false,
  limits:['35 candidate pages is an optimistic lower bound, not a measured seller-page count. Seller inventories/pages can remove the benefit.',
   'A changed/absent/unbound current card or old-rule/missing historical binding requires unresolved/detail work and reduces the savings.',
   '512 controlled own items have no known pair; current own price observations do not discover lower competitors for them.',
   'Hidden description-only quantity/bonus changes can yield false provisional hints despite unchanged profile fields.',
   'Same image URL does not prove fresh image bytes. Original identity/description clocks stay old.',
   'Images, requests for changed terms, search/discovery, access holds, procurement, setup and publishing are excluded from these root counts.']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const result=JSON.stringify(auditYahooProfileRoots(),null,2)+'\n';if(process.argv[2])await fs.writeFile(process.argv[2],result);else process.stdout.write(result)}
