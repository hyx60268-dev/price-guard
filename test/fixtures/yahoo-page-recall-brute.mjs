// Frozen PR606 Cartesian recall oracle, copied before reverse-index optimization.
// Keep independent of the production mapper so equivalence tests detect semantic drift.
import {isOwnedOffer} from '../../public/owned-offers.js';
import {rejectedByMemory} from '../../public/match-memory.js';
import {yahooProfileCardProblem} from '../../scripts/lib/yahoo-profile-identity.mjs';
const clone = value => structuredClone(value);
const stamp = value => typeof value === 'number' ? value : Date.parse(value || '');
const normalized = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const assert = (value, reason) => { if (!value) throw Error(reason); };
const ownKey = target => `${target.accountId}:${target.id}`;
const grams = value => {
  const text=normalized(value).replace(/[\s\p{P}\p{S}]+/gu,'');
  return new Set(Array.from({length:Math.max(0,text.length-1)},(_,index)=>text.slice(index,index+2)));
};
function titleSimilarity(a,b) {
  if(!a.size||!b.size)return 0;
  return [...a].filter(token=>b.has(token)).length / Math.max(a.size,b.size);
}

/** Pure, deliberately permissive local recall. Scores select review work only.
 * Matching does not establish identity, current description, stock or shipping.
 * Every managed target remains in the denominator, even with no current card.
 */
export function mapYahooPoolToTargets({snapshot,targets,settings={},now=Date.now(),titleThreshold=.35,
  maximumCandidatesPerTarget=64,maximumSourceReferencesPerCandidate=8,continueMapping=null}={}) {
  assert(Array.isArray(targets) && new Set(targets.map(ownKey)).size === targets.length,'distinct_managed_targets_required');
  assert(Number.isFinite(titleThreshold)&&titleThreshold>=0&&titleThreshold<=1,'invalid_title_threshold');
  assert(Number.isSafeInteger(maximumCandidatesPerTarget)&&maximumCandidatesPerTarget>0&&maximumCandidatesPerTarget<=200&&
    Number.isSafeInteger(maximumSourceReferencesPerCandidate)&&maximumSourceReferencesPerCandidate>0&&maximumSourceReferencesPerCandidate<=20,'invalid_mapping_bounds');
  const index=settings.ownedOffers?.yahoo;
  const ownershipReady=settings.ownedOffersComplete===true && index?.items instanceof Set && index?.sellers instanceof Set;
  const currentPages=(snapshot?.pages||[]).filter(page=>page.source.observedAt<=now&&page.source.expiresAt>now);
  const observations=currentPages.flatMap(page=>page.cards.map(card=>({card,source:page.source,titleGrams:grams(card.title)})));
  const observedOwnedIds=new Set(ownershipReady?observations.filter(({card})=>isOwnedOffer(settings.ownedOffers,'yahoo',card)).map(({card})=>card.id):[]);
  let mappingStopped=false,actualTargetObservationVisits=0,eligibleTargetObservationVisits=0;
  const rows=targets.map(target=>{
    const key=ownKey(target),profile=target.profileCard;
    const problem=!ownershipReady?'complete_owned_index_required':
      !validId(target.id)||!validId(target.accountId)||!['yahoo','yahoo_fleamarket'].includes(target.platform)?'target_binding_required':
      profile?.id!==target.id||profile?.accountId!==target.accountId?'target_profile_binding_required':
      yahooProfileCardProblem(profile,{now}) ||
      (!index.items.has(profile.id)||!index.sellers.has(profile.sellerId)?'own_membership_unconfirmed':null);
    const base={targetKey:key,targetId:target.id,accountId:target.accountId,comparisonComplete:false,
      searchCheckedAt:null,detailVerified:false,canRecommend:false,candidates:[],excluded:[],excludedCardObservations:0,
      omittedCandidateMatches:0,unmappedCardObservations:0};
    if(problem)return {...base,status:'blocked',reason:problem};
    if(profile.itemStatus!=='OPEN')return {...base,status:'not_open',reason:'current_profile_not_open'};
    eligibleTargetObservationVisits+=observations.length;
    if(mappingStopped||continueMapping&&!continueMapping()){mappingStopped=true;return {...base,status:'blocked',reason:'local_mapping_budget'};}
    const unique=new Map(),profileGrams=grams(profile.title);
    const excluded=(id,reason)=>{base.excludedCardObservations++;if(base.excluded.length<maximumCandidatesPerTarget)base.excluded.push({id,reason});};
    for(const observation of observations){
      if(continueMapping&&actualTargetObservationVisits%64===0&&!continueMapping()){mappingStopped=true;break;}
      actualTargetObservationVisits++;
      const {card,source}=observation;
      if(card.id===target.id||observedOwnedIds.has(card.id)||isOwnedOffer(settings.ownedOffers,'yahoo',card)) {excluded(card.id,'own_offer');continue;}
      if(rejectedByMemory(settings.matchCorrections,{...target,title:profile.title,image:profile.imageUrl},'yahoo',card)) {
        excluded(card.id,'saved_user_correction');continue;
      }
      const historical=(target.historicalIdentities||[]).find(identity=>identity.accountId===target.accountId&&
        identity.own?.id===target.id&&identity.candidate?.id===card.id);
      const score=titleSimilarity(profileGrams,observation.titleGrams),sameImageUrl=profile.imageUrl===card.image;
      if(!historical&&!sameImageUrl&&score<titleThreshold){base.unmappedCardObservations++;continue;}
      const prior=unique.get(card.id);
      const candidate={id:card.id,card:clone(card),sources:[clone(source)],historicalIdentity:historical?clone(historical):null,
        titleSimilarity:score,sameImageUrl,lowerListedPrice:card.price!==null?card.price<profile.priceJPY:null,
        needs:['current_sale_terms','candidate_availability','delivered_price','pair_identity_verification'],
        identityVerified:false,currentDescriptionObserved:false,canRecommend:false};
      if(prior){
        candidate.sources=[...prior.sources,...candidate.sources].slice(0,maximumSourceReferencesPerCandidate);
        candidate.omittedSourceReferences=(prior.omittedSourceReferences||0)+
          Math.max(0,prior.sources.length+1-maximumSourceReferencesPerCandidate);
        candidate.conflictingCardObservations=prior.conflictingCardObservations===true ||
          JSON.stringify([prior.card.title,prior.card.price,prior.card.image,prior.card.sellerId])!==JSON.stringify([card.title,card.price,card.image,card.sellerId]);
        if(stamp(prior.card.observedAt)>stamp(card.observedAt)){
          candidate.card=prior.card;candidate.lowerListedPrice=prior.lowerListedPrice;
          candidate.titleSimilarity=prior.titleSimilarity;candidate.sameImageUrl=prior.sameImageUrl;
        }
      }
      unique.set(card.id,candidate);
    }
    const ranked=[...unique.values()].sort((a,b)=>Number(Boolean(b.historicalIdentity))-Number(Boolean(a.historicalIdentity))||
      Number(b.lowerListedPrice===true)-Number(a.lowerListedPrice===true)||b.titleSimilarity-a.titleSimilarity||a.id.localeCompare(b.id));
    base.candidates=ranked.slice(0,maximumCandidatesPerTarget);
    base.omittedCandidateMatches=Math.max(0,ranked.length-base.candidates.length);
    return {...base,currentProfilePrice:profile.priceJPY,profileObservedAt:profile.observedAt,
      status:base.candidates.length?'local_recall_only':'unresolved',reason:base.candidates.length?'requires_verification':'no_local_mapping'};
  });
  const mapped=rows.flatMap(row=>row.candidates),ids=new Set(mapped.map(row=>row.id));
  return {version:1,totalManagedTargets:targets.length,rows,
    currentProfileTargets:rows.filter(row=>['local_recall_only','unresolved','not_open'].includes(row.status)).length,
    mappedTargets:rows.filter(row=>row.candidates.length).length,unmappedTargets:rows.filter(row=>!row.candidates.length).length,
    targetCandidatePairs:mapped.length,uniqueMappedCandidateIds:ids.size,
    sharedTargetPairDuplicates:mapped.length-ids.size,
    omittedCandidateMatches:rows.reduce((sum,row)=>sum+row.omittedCandidateMatches,0),
    bounds:{maximumCandidatesPerTarget,maximumSourceReferencesPerCandidate,maximumRetainedPairs:targets.length*maximumCandidatesPerTarget},
    mappingStopped,actualTargetObservationVisits,omittedTargetObservationVisits:eligibleTargetObservationVisits-actualTargetObservationVisits,
    completeComparisons:0,searchCheckedAt:null,verifiedCosts:0,marketplaceRequests:0};
}
