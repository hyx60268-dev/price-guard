import {PRICING_RULES_VERSION} from '../../public/pricing-policy.js';
import {isOwnedOffer} from '../../public/owned-offers.js';
import {rejectedByMemory} from '../../public/match-memory.js';
import {offerIdentityGuard} from './offer-identity.mjs';
import {yahooDetailVerificationDigest} from './yahoo-verification-context.mjs';

const stamp=value=>typeof value==='number'?value:Date.parse(value||'');
const iso=value=>Number.isFinite(stamp(value))?new Date(stamp(value)).toISOString():null;
const text=value=>typeof value==='string'?value.normalize('NFKC').replace(/\s+/g,' ').trim():'';
const id=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(value)?value:'';
const current=(value,now)=>Number.isFinite(stamp(value))&&stamp(value)<=now&&now-stamp(value)<=20*60_000;
const imageUrl=detail=>typeof detail?.images?.[0]==='string'?detail.images[0]:detail?.images?.[0]?.url;
const seller=detail=>detail?.seller?.id||detail?.sellerId;
const validImage=value=>{try{const url=new URL(value);return typeof value==='string'&&url.protocol==='https:'&&!url.username&&!url.password}catch{return false}};

// Create this receipt only beside an actual accepted detail verification. It
// stores the OLD field clocks, not the time a later profile card is observed.
// No raw description is exposed by the price-observation result below.
export function retainYahooProfileIdentity({item,ownDetail,candidateDetail,evaluation,ownObservedAt,candidateObservedAt,identityVerifiedAt,rulesVersion,now=Date.now()}={}){
 const candidate=evaluation?.candidate,context=evaluation?.verificationContext;
 const digest=yahooDetailVerificationDigest({item,ownDetail,candidateDetail,ownObservedAt,candidateObservedAt,rulesVersion});
 if(!digest||context?.version!==1||context.source!=='evaluate_yahoo_detail'||context.rulesVersion!==rulesVersion||
  context.digest!==digest||context.ownObservedAt!==ownObservedAt||context.candidateObservedAt!==candidateObservedAt||
  context.verifiedAt!==stamp(identityVerifiedAt))return null;
 if(!item||!['yahoo','yahoo_fleamarket'].includes(item.platform)||!id(item.accountId)||!candidate||evaluation.currentDetailRead!==true||!candidate.matchMethod||rulesVersion!==PRICING_RULES_VERSION)return null;
 if(!id(item.id)||ownDetail?.id!==item.id||!id(candidate.id)||candidateDetail?.id!==candidate.id||seller(ownDetail)!==item.sellerId||seller(candidateDetail)!==candidate.sellerId)return null;
 if(ownDetail.status!=='OPEN'||candidateDetail.status!=='OPEN'||!validImage(imageUrl(ownDetail))||!validImage(imageUrl(candidateDetail)))return null;
 for(const value of [ownObservedAt,candidateObservedAt,identityVerifiedAt])if(!Number.isFinite(stamp(value))||stamp(value)>now)return null;
 if(stamp(identityVerifiedAt)<Math.max(stamp(ownObservedAt),stamp(candidateObservedAt)))return null;
 const identity=offerIdentityGuard({ownTitle:ownDetail.title,ownDescription:ownDetail.description,candidateTitle:candidateDetail.title,
  candidateDescription:candidateDetail.description,primaryImageScore:candidate.primaryImageScore});
 if(!identity.accepted)return null;
 const snapshot=(detail,observedAt)=>({id:detail.id,sellerId:seller(detail),title:detail.title,imageUrl:imageUrl(detail),
  detailObservedAt:iso(observedAt),descriptionObservedAt:iso(observedAt)});
 return {version:1,source:'accepted_detail_pair',rulesVersion,accountId:item.accountId,
  relistingParentId:id(item.relistedFrom)||null,
  own:snapshot(ownDetail,ownObservedAt),candidate:snapshot(candidateDetail,candidateObservedAt),
  identityVerifiedAt:iso(identityVerifiedAt),matchMethod:candidate.matchMethod,
  // Same URL later is only an unchanged indicator; never current image bytes.
  imageEvidenceCurrent:false};
}

export function yahooProfileCardProblem(card,{now=Date.now()}={}){
 if(card?.source!=='current_profile_card'||!id(card.id)||!id(card.sellerId)||!text(card.title)||
  !Number.isFinite(card.priceJPY)||card.priceJPY<=0||!validImage(card.imageUrl))return 'profile_fields_unconfirmed';
 if(!current(card.observedAt,now))return 'profile_observation_stale';
 let profile,page;try{profile=new URL(card.profileUrl);page=new URL(card.pageUrl)}catch{return 'profile_source_unbound'}
 if(profile.origin!=='https://paypayfleamarket.yahoo.co.jp'||profile.pathname!==`/user/${card.sellerId}`||profile.search||profile.hash||
  page.origin!==profile.origin||page.pathname!==profile.pathname||page.hash||!Number.isInteger(card.pageNumber)||card.pageNumber<1||
  page.search!==`?page=${card.pageNumber}`)return 'profile_source_unbound';
 if(!['OPEN','SOLD','CLOSED','DELETED','ENDED','STOPPED'].includes(card.itemStatus))return 'profile_status_unknown';
 return null;
}

// Pure provisional layer: current PROFILE prices/status + previously verified
// pair identity. It does not construct a fake current own detail for the legacy
// verifier, and it never returns an actionable candidate or current detail time.
export function observeYahooProfilePair({ownCard,candidateCard,identity,settings={},now=Date.now()}={}){
 const result=(mode,reason,extra={})=>({mode,reason,ownId:ownCard?.id||identity?.own?.id||null,candidateId:candidateCard?.id||identity?.candidate?.id||null,...extra});
 const ownProblem=yahooProfileCardProblem(ownCard,{now});if(ownProblem)return result('blocked',ownProblem,{needs:'current_own_profile'});
 const index=settings.ownedOffers?.yahoo;
 if(settings.ownedOffersComplete!==true||!(index?.items instanceof Set)||!(index?.sellers instanceof Set)||
  !index.items.has(ownCard.id)||!index.sellers.has(ownCard.sellerId))return result('blocked','complete_owned_index_required');
 if(ownCard.itemStatus!=='OPEN')return result('excluded','own_not_open');
 if(!candidateCard)return result('unresolved','candidate_not_observed',{needs:'current_candidate_profile_or_detail'});
 const candidateProblem=yahooProfileCardProblem(candidateCard,{now});if(candidateProblem)return result('unresolved',candidateProblem,{needs:'current_candidate_profile_or_detail'});
 if(candidateCard.itemStatus!=='OPEN')return result('excluded','candidate_not_open');
 if(isOwnedOffer(settings.ownedOffers,'yahoo',candidateCard)||candidateCard.id===ownCard.id)return result('excluded','own_offer');
 const target={id:ownCard.id,accountId:ownCard.accountId,title:ownCard.title,image:ownCard.imageUrl,
  relistedFrom:identity?.own?.id===ownCard.id&&identity?.accountId===ownCard.accountId?identity.relistingParentId:null};
 // Formatting-only title changes are allowed below, so apply inherited
 // correction fingerprints to the retained title too, not only the current one.
 const retainedTarget=identity?.own?.id===ownCard.id&&identity?.accountId===ownCard.accountId&&
  text(ownCard.title)===text(identity.own.title)&&ownCard.imageUrl===identity.own.imageUrl
  ?{...target,title:identity.own.title,image:identity.own.imageUrl}:target;
 if(rejectedByMemory(settings.matchCorrections,target,'yahoo',candidateCard)||
  rejectedByMemory(settings.matchCorrections,retainedTarget,'yahoo',candidateCard)||
  rejectedByMemory(Object.fromEntries(Object.entries(settings.matchCorrections||{}).map(([key,record])=>[key,{...record,ownTitle:text(record?.ownTitle)}])),
   {...retainedTarget,title:text(retainedTarget.title)},'yahoo',candidateCard))return result('excluded','saved_user_correction');
 if(!identity||identity.version!==1||identity.source!=='accepted_detail_pair'||identity.rulesVersion!==PRICING_RULES_VERSION||!identity.matchMethod)
  return result('detail_required','historical_identity_unavailable_or_old_rules',{needs:'both_details'});
 if(identity.accountId!==ownCard.accountId||identity.own?.id!==ownCard.id||identity.candidate?.id!==candidateCard.id||
  identity.own.sellerId!==ownCard.sellerId||identity.candidate.sellerId!==candidateCard.sellerId)
  return result('detail_required','historical_identity_target_mismatch',{needs:'both_details'});
 const clocks=[identity.identityVerifiedAt,identity.own.detailObservedAt,identity.own.descriptionObservedAt,identity.candidate.detailObservedAt,identity.candidate.descriptionObservedAt];
 if(clocks.some(value=>!Number.isFinite(stamp(value))||stamp(value)>now)||
  identity.own.descriptionObservedAt!==identity.own.detailObservedAt||identity.candidate.descriptionObservedAt!==identity.candidate.detailObservedAt||
  stamp(identity.identityVerifiedAt)<Math.max(stamp(identity.own.detailObservedAt),stamp(identity.candidate.detailObservedAt)))
  return result('detail_required','historical_identity_clock_unbound',{needs:'both_details'});
 const same=(card,prior)=>text(card.title)===text(prior.title)&&card.imageUrl===prior.imageUrl;
 if(!same(ownCard,identity.own))return result('detail_required','own_identity_indicators_changed',{needs:'own_detail_then_recompare'});
 if(!same(candidateCard,identity.candidate))return result('detail_required','candidate_identity_indicators_changed',{needs:'candidate_detail_then_recompare'});
 const minimumRatio=Math.max(.5,Math.min(1,Number(settings.profileMinimumPriceRatio)||.75));
 const maximumRatio=Math.max(1,Math.min(2,Number(settings.profileMaximumPriceRatio)||1.25));
 if(candidateCard.priceJPY/ownCard.priceJPY<minimumRatio||candidateCard.priceJPY/ownCard.priceJPY>maximumRatio)
  return result('detail_required','price_outlier',{needs:'candidate_detail_then_recompare'});
 const lower=candidateCard.priceJPY<ownCard.priceJPY;
 return result('profile_observation','historical_pair_current_profile_prices',{
  observation:{ownId:ownCard.id,id:candidateCard.id,url:`https://paypayfleamarket.yahoo.co.jp/item/${candidateCard.id}`,
   ownPriceJPY:ownCard.priceJPY,priceJPY:candidateCard.priceJPY,currency:'JPY',priceSource:'current_seller_profile_card',
   ownPriceObservedAt:iso(ownCard.observedAt),candidatePriceObservedAt:iso(candidateCard.observedAt),
   ownAvailability:'OPEN',candidateAvailability:'OPEN',ownProfileUrl:ownCard.pageUrl,candidateProfileUrl:candidateCard.pageUrl,
   historicalIdentityVerifiedAt:identity.identityVerifiedAt,ownDescriptionObservedAt:identity.own.descriptionObservedAt,
   candidateDescriptionObservedAt:identity.candidate.descriptionObservedAt,identityRulesVersion:identity.rulesVersion,
   confidence:'historical_match_unchanged_profile_indicators',lowerPriceAlert:lower,lowerByJPY:Math.max(0,ownCard.priceJPY-candidateCard.priceJPY),
   unknownTerms:['current_descriptions_not_observed','current_image_bytes_not_observed','quantity_bonus_condition_may_have_changed','new_candidate_discovery_not_refreshed'],
   shipping:{currency:'JPY',shippingJPY:0,source:'platform_rule',sourceUrl:'https://support.yahoo-net.jp/SccPaypayfleamarket/s/article/H000008409'},
   detailVerified:false,detailCheckedAt:null,identityVerifiedAt:null,canRecommend:false,comparisonComplete:false,procurementCostEligible:false,
   requiresDetailBefore:['actionable_reprice','confirm_sale_terms','confirmed_lowest_price'],
   displayLabel:'历史同款关联的当前店铺标价，正文与图片内容未重新核实'}});
}

// Preserve every positive row, including rows whose quote fields were unusable.
// A later ineligible row blocks an older OPEN card; same-time conflicts never
// depend on input order. Legacy receipts without per-row clocks cannot revive
// a missing card by borrowing an aggregate min/max page time.
function mergedProfileRows(profiles,{own=false,now}){
 const merged=new Map(),membership=new Set(),completeTraversals=[];
 const signature=row=>JSON.stringify(row.card?[row.card.accountId,row.card.sellerId,row.card.title,row.card.priceJPY,row.card.imageUrl,
  row.card.itemStatus,row.card.profileUrl,row.card.pageUrl,row.card.pageNumber,row.card.source]:[row.reason]);
 const put=next=>{
  const previous=merged.get(next.id);
  if(!previous){merged.set(next.id,next);return}
  if(previous.clockUnbound||next.clockUnbound){merged.set(next.id,{id:next.id,clockUnbound:true,reason:'profile_row_clock_unbound'});return}
  if(next.observedAt>previous.observedAt){merged.set(next.id,next);return}
  if(next.observedAt<previous.observedAt)return;
  if(previous.reason==='profile_same_time_conflict'||signature(previous)!==signature(next))
   merged.set(next.id,{id:next.id,observedAt:next.observedAt,reason:'profile_same_time_conflict'});
 };
 for(const profile of profiles){
  if(!(own?profile.complete===true:profile.complete===true||profile.pageObservationValid===true))continue;
  if(profile.enumerationComplete===true&&id(profile.sellerId)&&Array.isArray(profile.membershipIds)&&
   typeof profile.observedAt==='number'&&Number.isFinite(profile.observedAt)&&profile.observedAt<=now)
   completeTraversals.push({sellerId:profile.sellerId,observedAt:profile.observedAt,ids:new Set(profile.membershipIds)});
  const cards=new Map((profile.cards||[]).map(card=>[card.id,card]));
  const rows=Array.isArray(profile.rowObservations)?profile.rowObservations:(profile.cards||[]).map(card=>({id:card.id,observedAt:card.observedAt,cardEligible:true}));
  const seen=new Set();
  for(const row of rows){
   if(!id(row.id))continue;membership.add(row.id);seen.add(row.id);
   if(typeof row.observedAt!=='number'||!Number.isFinite(row.observedAt)||row.observedAt>now){put({id:row.id,clockUnbound:true,reason:'profile_row_clock_unbound'});continue}
   const card=cards.get(row.id),bound=row.cardEligible===true&&card&&card.observedAt===row.observedAt;
   put({id:row.id,observedAt:row.observedAt,sourceSellerId:profile.sellerId||card?.sellerId,card:bound?card:null,
    reason:bound?null:'latest_profile_row_ineligible'});
  }
  for(const memberId of profile.membershipIds||[]){
   if(!id(memberId))continue;membership.add(memberId);
   if(!seen.has(memberId))put({id:memberId,clockUnbound:true,reason:'profile_row_clock_unbound'});
  }
 }
 // A newer *complete* traversal can invalidate an older positive price,
 // without claiming a sale. Its earliest original page time must be at least
 // the positive row time; partial-page absence has no negative meaning.
 for(const traversal of completeTraversals.sort((a,b)=>a.observedAt-b.observedAt))for(const [memberId,row] of merged){
  if(row.clockUnbound||row.sourceSellerId!==traversal.sellerId||traversal.ids.has(memberId)||traversal.observedAt<row.observedAt)continue;
  merged.set(memberId,{id:memberId,sourceSellerId:row.sourceSellerId,observedAt:traversal.observedAt,
   reason:traversal.observedAt===row.observedAt?'profile_same_time_conflict':'absent_from_newer_complete_profile'});
 }
 return {rows:merged,membership};
}

// Missing a card is not proof it is sold. No old candidate price is promoted.
// The registry fans a current card out to existing pair links without new I/O.
export function observeYahooProfileRegistry({ownProfiles=[],candidateProfiles=[],identities=[],settings={},now=Date.now()}={}){
 const own=mergedProfileRows(ownProfiles,{own:true,now}),candidates=mergedProfileRows(candidateProfiles,{now});
 const outcomes=identities.map(identity=>{
  const ownRow=own.rows.get(identity.own?.id),candidateRow=candidates.rows.get(identity.candidate?.id);
  const target={ownId:identity.own?.id||null,candidateId:identity.candidate?.id||null};
  if(ownRow?.reason)return {...target,mode:'blocked',reason:ownRow.reason,needs:'current_own_profile_or_detail'};
  const result=observeYahooProfilePair({ownCard:ownRow?.card,candidateCard:candidateRow?.card,identity,settings,now});
  if(result.mode==='unresolved'&&candidateRow?.reason)return {...target,mode:'unresolved',reason:candidateRow.reason,needs:'current_candidate_profile_or_detail'};
  return result;
 });
 const typedOwn=[...own.rows.values()].filter(row=>!row.reason&&!yahooProfileCardProblem(row.card,{now}));
 const currentOwnCards=typedOwn.filter(row=>row.card.itemStatus==='OPEN').map(row=>row.card);
 const knownClosedOwnIds=typedOwn.filter(row=>row.card.itemStatus!=='OPEN').map(row=>row.id);
 const closed=new Set(knownClosedOwnIds),usable=new Set(typedOwn.map(row=>row.id));
 const linkedOwnIds=new Set(identities.map(identity=>identity.own?.id));
 const unverifiedOwnItems=[...own.membership].filter(memberId=>!usable.has(memberId)).map(memberId=>({ownId:memberId,candidateId:null,
  reason:own.rows.get(memberId)?.reason||yahooProfileCardProblem(own.rows.get(memberId)?.card,{now}),needs:'current_own_profile_or_detail'}));
 return {version:1,enumeratedOwnMembershipCount:own.membership.size,currentOwnProfileObserved:currentOwnCards.length,
  knownClosedOwnIds,unverifiedOwnItems,knownPairLinks:identities.length,
  ownItemsWithoutKnownPair:[...own.membership].filter(memberId=>!closed.has(memberId)&&!linkedOwnIds.has(memberId)),outcomes,
  currentProfilePriceObservations:outcomes.filter(row=>row.mode==='profile_observation').length,
  detailRequired:outcomes.filter(row=>row.mode==='detail_required').length,unresolved:outcomes.filter(row=>['blocked','unresolved'].includes(row.mode)).length,
  completeComparisons:0,verifiedCosts:0,canRecommend:false};
}

export function yahooProfilePricePresentation(registry={}){
 const outcomes=Array.isArray(registry.outcomes)?registry.outcomes:[];
 const hints=outcomes.filter(row=>row.mode==='profile_observation'&&row.observation?.lowerPriceAlert).map(row=>row.observation);
 const pending=outcomes.filter(row=>['blocked','unresolved','detail_required'].includes(row.mode)).map(row=>({ownId:row.ownId,candidateId:row.candidateId,reason:row.reason,needs:row.needs||null}));
 pending.push(...(registry.unverifiedOwnItems||[]));
 return {version:1,source:'historical_pair_current_profile_prices',knownLinkedLowerPriceHints:hints,
  enumeratedOwnMembershipCount:registry.enumeratedOwnMembershipCount||0,currentOwnProfileObserved:registry.currentOwnProfileObserved||0,
  unverifiedOwnItemCount:registry.unverifiedOwnItems?.length||0,knownClosedOwnCount:registry.knownClosedOwnIds?.length||0,
  ownItemsWithoutKnownPairCount:registry.ownItemsWithoutKnownPair?.length||0,pending,
  displayLabel:'当前店铺标价提示；身份沿用历史核验，正文与图片内容未重读',
  canRecommend:false,complete:false,verifiedCostCount:0};
}

// Request planner only: a one-page positive probe avoids crawling an entire
// large seller inventory. The caller owns budgets/gates; this never fetches.
export function planYahooKnownSellerProbes(identities=[]){
 const sellers=new Map();
 for(const identity of identities){const sellerId=id(identity?.candidate?.sellerId),candidateId=id(identity?.candidate?.id);if(!sellerId||!candidateId)continue;
  if(!sellers.has(sellerId))sellers.set(sellerId,new Set());sellers.get(sellerId).add(candidateId);
 }
 const groups=[...sellers].map(([sellerId,ids])=>({sellerId,knownCandidateIds:[...ids].sort(),mode:ids.size>1?'profile_first_page_then_missing_details':'direct_detail',maximumProbePages:ids.size>1?1:0}));
 const histogram={};for(const group of groups){const n=group.knownCandidateIds.length;histogram[n]=(histogram[n]||0)+1}
 return {groups,diagnostics:{sellerCount:groups.length,uniqueKnownOffers:groups.reduce((n,g)=>n+g.knownCandidateIds.length,0),
  knownOffersPerSellerHistogram:histogram,maximumProbePages:groups.reduce((n,g)=>n+g.maximumProbePages,0)},
  absenceMeansSold:false,needsCurrentCardForEveryPrice:true,sourceRequestsPerformed:0};
}
