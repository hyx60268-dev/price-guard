// Bounded observation storage and local recall only. No transport, persistence, scheduler or acceptance.
import {isOwnedOffer} from '../../public/owned-offers.js';
import {rejectedByMemory} from '../../public/match-memory.js';
import {yahooProfileCardProblem} from './yahoo-profile-identity.mjs';

const clone = value => structuredClone(value);
const stamp = value => typeof value === 'number' ? value : Date.parse(value || '');
const normalized = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const urlFor = id => `https://paypayfleamarket.yahoo.co.jp/item/${id}`;
const assert = (value, reason) => { if (!value) throw Error(reason); };
const finitePrice = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const iso = value => new Date(value).toISOString();
const ownKey = target => `${target.accountId}:${target.id}`;

function copyCard(card, source) {
  if (!validId(card?.id) || card.url !== urlFor(card.id) || typeof card.title !== 'string' || card.title.length > 1000) return null;
  // Optional original card clocks must agree with the parent page, never now().
  if (card.observedAt !== undefined && stamp(card.observedAt) !== source.observedAt) return null;
  const currency=card.currency===undefined||card.currency==='JPY'?'JPY':null;
  const ordinary=finitePrice(card.price)&&card.priceKind==='ordinary'&&currency==='JPY';
  return {id:card.id, url:card.url, title:card.title,
    image:typeof card.image === 'string' ? card.image.slice(0, 2048) : '',
    sellerId:validId(card.sellerId) ? card.sellerId : null,
    price:ordinary?card.price:null,priceKind:ordinary?'ordinary':'unknown',currency,
    currencySource:card.currency===undefined?'yahoo_platform_scope':'explicit_card_currency',
    priceField:card.priceField==='recommendItems.items.price'?card.priceField:null,
    priceSource:card.priceSource==='yahoo_recommendation_receipt_v1'?card.priceSource:null,
    recommendationSection:typeof card.recommendationSection === 'string' ? card.recommendationSection.slice(0,64) : null,
    observedAt:iso(source.observedAt), availability:null, description:null,
    identityVerified:false, canRecommend:false};
}

function copyDetail(detail) {
  if (!detail || !validId(detail.id) || typeof detail.title !== 'string' || detail.title.length > 1000 ||
      typeof detail.description !== 'string' || detail.description.length > 30000) return null;
  return {id:detail.id, title:detail.title, description:detail.description,
    sellerId:validId(detail.seller?.id || detail.sellerId) ? detail.seller?.id || detail.sellerId : null,
    price:finitePrice(detail.price) ? detail.price : null,
    status:typeof detail.status === 'string' ? detail.status : null,
    images:(Array.isArray(detail.images) ? detail.images : []).slice(0,20).map(image => typeof image === 'string' ? image : image?.url)
      .filter(value => typeof value === 'string' && value.length <= 2048)};
}

/** Retain one immutable latest original observation per source listing.
 * sha256 MUST be the body SHA supplied at the transport/parser boundary. It is
 * not synthesized from a URL or a partial saved summary. Cache misses carrying
 * fromCache:true cannot introduce new evidence. Source reads never renew TTL.
 */
export function createYahooPageObservationPool({now=Date.now, cycleStartedAt, deadlineAt,
  maxAgeMs=20*60_000, maxSources=300, maxCardsPerSource=200}={}) {
  assert(typeof now === 'function' && Number.isFinite(cycleStartedAt) && Number.isFinite(deadlineAt) && deadlineAt > cycleStartedAt, 'invalid_cycle');
  assert(Number.isSafeInteger(maxSources) && maxSources > 0 && maxSources <= 1000 &&
    Number.isSafeInteger(maxCardsPerSource) && maxCardsPerSource > 0 && maxCardsPerSource <= 200 &&
    Number.isFinite(maxAgeMs) && maxAgeMs > 0 && maxAgeMs <= 20*60_000, 'invalid_bounds');
  const pages = new Map(), conflicts = new Map();
  const counters = {acceptedSourceReads:0, duplicateAdmissions:0, cacheReuses:0, unknownCacheReads:0,
    expiredSources:0, evictedSources:0, omittedCards:0, invalidCards:0, sameTimeConflicts:0};
  function prune() {
    const time=now();assert(Number.isFinite(time) && time >= cycleStartedAt, 'invalid_clock');
    for (const [id,page] of pages) if (page.source.expiresAt <= time) { pages.delete(id); counters.expiredSources++; }
    for (const [id,conflict] of conflicts) if (conflict.expiresAt <= time) conflicts.delete(id);
  }
  function ingest({source, detail, shipping, cards, totalCards=cards?.length,parserInvalidCards=0,sectionsTruncated=false}={}) {
    prune();
    assert(validId(source?.id) && source.url === urlFor(source.id) && detail?.id === source.id &&
      /^[a-f0-9]{64}$/.test(source.sha256 || '') && ['own','candidate'].includes(source.role) &&
      typeof source.fromCache === 'boolean' && source.status === 200 && source.redirected === false, 'source_binding_required');
    const observedAt=stamp(source.observedAt), expiresAt=Math.min(observedAt+maxAgeMs,deadlineAt);
    assert(Number.isFinite(observedAt) && observedAt >= cycleStartedAt && observedAt <= now() && expiresAt > now(), 'original_observation_not_current');
    assert(Array.isArray(cards) && Number.isSafeInteger(totalCards) && Number.isSafeInteger(parserInvalidCards) &&
      parserInvalidCards>=0 && totalCards >= cards.length+parserInvalidCards && typeof sectionsTruncated==='boolean', 'card_accounting_required');
    const previous=pages.get(source.id), key=JSON.stringify([source.url,source.sha256,observedAt]);
    if (previous?.source.key === key) {
      counters.duplicateAdmissions++; if(source.fromCache)counters.cacheReuses++;
      return {retained:true,duplicate:true,source:clone(previous.source)};
    }
    if (source.fromCache) {counters.unknownCacheReads++;return {retained:false,reason:'unrecognized_cached_original'};}
    const conflict=conflicts.get(source.id);
    if (conflict && observedAt <= conflict.observedAt) return {retained:false,reason:'source_same_time_conflict'};
    if (previous && observedAt < previous.source.observedAt) return {retained:false,reason:'older_observation'};
    if (previous && observedAt === previous.source.observedAt) {
      pages.delete(source.id); conflicts.set(source.id,{observedAt,expiresAt}); counters.sameTimeConflicts++;
      return {retained:false,reason:'source_same_time_conflict'};
    }
    // Both maps are bounded. A conflict is never forgotten before expiry except
    // when replaced by a strictly newer real observation of the same source.
    if (!previous && !conflict && pages.size+conflicts.size >= maxSources) {
      const oldest=[...pages].sort((a,b)=>a[1].source.observedAt-b[1].source.observedAt)[0];
      if (!oldest) return {retained:false,reason:'pool_conflict_capacity'};
      pages.delete(oldest[0]);counters.evictedSources++;
    }
    conflicts.delete(source.id);
    const bound={id:source.id,url:source.url,sha256:source.sha256,
      sha256Scope:source.sha256Scope==='decoded_response_html_utf8'?source.sha256Scope:'caller_supplied_unspecified',
      status:200,redirected:false,auditReservationId:typeof source.auditReservationId==='string'?source.auditReservationId:null,
      observedAt,fromCache:false,
      role:source.role,expiresAt,key};
    const retained=cards.slice(0,maxCardsPerSource).map(card=>copyCard(card,bound)).filter(Boolean);
    const invalid=parserInvalidCards+Math.min(cards.length,maxCardsPerSource)-retained.length;
    const omitted=totalCards-parserInvalidCards-Math.min(cards.length,maxCardsPerSource);
    counters.invalidCards+=invalid;counters.omittedCards+=omitted;
    const detailCopy=copyDetail(detail);
    const shippingCopy=shipping?.shippingKnown===true && shipping.currency==='JPY' &&
      Number.isFinite(shipping.shippingJPY) && shipping.shippingJPY>=0
      ? {shippingKnown:true,currency:'JPY',shippingJPY:shipping.shippingJPY}:null;
    pages.set(source.id,{source:bound,detail:detailCopy,shipping:shippingCopy,cards:retained,
      rawCardCount:totalCards,retainedCardCount:retained.length,invalidCards:invalid,
      omittedCards:omitted,sectionsTruncated});
    counters.acceptedSourceReads++;
    return {retained:true,duplicate:false,source:clone(bound)};
  }
  function snapshot() {
    prune();const values=[...pages.values()];const cards=values.flatMap(page=>page.cards);
    return {version:1,scope:'bounded_current_page_observations',pages:clone(values),counters:clone(counters),
      activeSources:values.length,retainedCards:cards.length,uniqueCandidateIds:new Set(cards.map(card=>card.id)).size,
      duplicateCardObservations:cards.length-new Set(cards.map(card=>card.id)).size,
      conflicts:clone([...conflicts].map(([id,value])=>({id,...value}))),
      bounds:{maxSources,maxCardsPerSource,maxRetainedCards:maxSources*maxCardsPerSource},
      comparisonComplete:false,searchCheckedAt:null,verifiedCosts:0,marketplaceRequests:0};
  }
  return Object.freeze({ingest,snapshot});
}

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
