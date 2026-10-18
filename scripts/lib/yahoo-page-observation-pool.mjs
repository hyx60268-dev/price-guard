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

// Version 2 retained evidence is a complete JSON representation, not a JS heap
// bound. Source-local clocks and derived/constant card fields are expanded only
// in snapshot(). Tuples include every variable field of the accepted card;
// identical IDs with differing evidence therefore remain distinct payloads.
const payloadFields=['id','title','image','sellerId','price','priceKind','currency',
  'currencySource','priceField','priceSource','recommendationSection'];
const encodedBytes=value=>value===null?0:Buffer.byteLength(JSON.stringify(value),'utf8');
const cardPayload=card=>payloadFields.map(field=>card[field]);
function expandedCard(payload,source) {
  const card=Object.fromEntries(payloadFields.map((field,index)=>[field,payload[index]]));
  return {...card,url:urlFor(card.id),observedAt:iso(source.observedAt),availability:null,description:null,
    identityVerified:false,canRecommend:false};
}
function expandedSource(source) {
  const url=urlFor(source.id);
  return {id:source.id,url,sha256:source.sha256,sha256Scope:source.sha256Scope,status:200,redirected:false,
    auditReservationId:source.auditReservationId,observedAt:source.observedAt,fromCache:false,
    role:source.role,expiresAt:source.expiresAt,key:JSON.stringify([url,source.sha256,source.observedAt])};
}
// Build a candidate without mutating the committed representation. ID buckets
// require exact equality of every tuple field; no content hash is trusted. Rebuilding refs
// collects payloads after source expiry, replacement, eviction and conflicts.
function compactEvidence(pages,cardPayloads,conflicts) {
  if(!pages.length&&!conflicts.length)return null;
  const payloads=[],byId=new Map(),byReference=new Map();
  const compactPages=pages.map(page=>({...page,cards:page.cards.map(reference=>{
    if(byReference.has(reference))return byReference.get(reference);
    const payload=cardPayloads[reference],bucket=byId.get(payload[0])||[];
    let next=bucket.find(index=>payloads[index].every((value,field)=>value===payload[field]));
    if(next===undefined){next=payloads.length;payloads.push(payload);bucket.push(next);byId.set(payload[0],bucket);}
    byReference.set(reference,next);return next;
  })}));
  return {version:2,pages:compactPages,cardPayloads:payloads,conflicts};
}

/** Retain one immutable latest original observation per source listing.
 * sha256 MUST be the body SHA supplied at the transport/parser boundary. It is
 * not synthesized from a URL or a partial saved summary. Cache misses carrying
 * fromCache:true cannot introduce new evidence. Source reads never renew TTL.
 * maxRetainedEvidenceBytes covers the complete encoded evidence representation,
 * including source/detail/shipping rows, all references and conflict tombstones.
 * No representation exists when empty (0 bytes); first admission pays all JSON
 * table/header overhead. Counters and temporary working/snapshot objects are not
 * evidence storage and this limit is not a total process/heap memory claim.
 */
export function createYahooPageObservationPool({now=Date.now, cycleStartedAt, deadlineAt,
  maxAgeMs=20*60_000, maxSources=300, maxCardsPerSource=200,maxRetainedEvidenceBytes=2*1024*1024}={}) {
  assert(typeof now === 'function' && Number.isFinite(cycleStartedAt) && Number.isFinite(deadlineAt) && deadlineAt > cycleStartedAt, 'invalid_cycle');
  assert(Number.isSafeInteger(maxSources) && maxSources > 0 && maxSources <= 1000 &&
    Number.isSafeInteger(maxCardsPerSource) && maxCardsPerSource > 0 && maxCardsPerSource <= 200 &&
    Number.isFinite(maxAgeMs) && maxAgeMs > 0 && maxAgeMs <= 20*60_000 &&
    Number.isSafeInteger(maxRetainedEvidenceBytes)&&maxRetainedEvidenceBytes>0&&maxRetainedEvidenceBytes<=8*1024*1024, 'invalid_bounds');
  let evidence=null,retainedEvidenceBytes=0,retentionUnavailable=false;
  const counters = {acceptedSourceReads:0, duplicateAdmissions:0, cacheReuses:0, unknownCacheReads:0,
    expiredSources:0, evictedSources:0, omittedCards:0, invalidCards:0, sameTimeConflicts:0,byteBudgetRefusals:0,newerUnretainedSources:0};
  function commit(candidate) {
    const size=encodedBytes(candidate);
    if(size>maxRetainedEvidenceBytes)return false;
    evidence=candidate;retainedEvidenceBytes=size;return true;
  }
  function commitInvalidation(candidate) {
    try{if(commit(candidate))return;}catch(error){
      evidence=null;retainedEvidenceBytes=0;retentionUnavailable=true;throw error;
    }
    // Defensive fail-closed path: tombstones replace larger source rows, so the
    // cap cannot normally fail. If that invariant ever breaks, a caught callback
    // error must not leave any contradicted source active or allow its revival.
    evidence=null;retainedEvidenceBytes=0;retentionUnavailable=true;
    throw Error('invalidation_evidence_exceeds_budget');
  }
  function prune() {
    const time=now();assert(Number.isFinite(time) && time >= cycleStartedAt, 'invalid_clock');
    if(!evidence)return;
    const pages=evidence.pages.filter(page=>page.source.expiresAt>time),conflicts=evidence.conflicts.filter(row=>row.expiresAt>time);
    if(pages.length===evidence.pages.length&&conflicts.length===evidence.conflicts.length)return;
    const expired=evidence.pages.length-pages.length;
    assert(commit(compactEvidence(pages,evidence.cardPayloads,conflicts)),'pruned_evidence_exceeds_budget');
    counters.expiredSources+=expired;
  }
  function ingest({source, detail, shipping, cards, totalCards=cards?.length,parserInvalidCards=0,sectionsTruncated=false}={}) {
    prune();
    if(retentionUnavailable)return {retained:false,reason:'pool_retention_unavailable'};
    assert(validId(source?.id) && source.url === urlFor(source.id) && detail?.id === source.id &&
      /^[a-f0-9]{64}$/.test(source.sha256 || '') && ['own','candidate'].includes(source.role) &&
      typeof source.fromCache === 'boolean' && source.status === 200 && source.redirected === false, 'source_binding_required');
    const observedAt=stamp(source.observedAt), expiresAt=Math.min(observedAt+maxAgeMs,deadlineAt);
    assert(Number.isFinite(observedAt) && observedAt >= cycleStartedAt && observedAt <= now() && expiresAt > now(), 'original_observation_not_current');
    assert(Array.isArray(cards) && Number.isSafeInteger(totalCards) && Number.isSafeInteger(parserInvalidCards) &&
      parserInvalidCards>=0 && totalCards >= cards.length+parserInvalidCards && typeof sectionsTruncated==='boolean', 'card_accounting_required');
    const pages=evidence?.pages||[],payloads=evidence?.cardPayloads||[],conflicts=evidence?.conflicts||[];
    const previous=pages.find(page=>page.source.id===source.id),key=JSON.stringify([source.url,source.sha256,observedAt]);
    if (previous&&expandedSource(previous.source).key === key) {
      counters.duplicateAdmissions++; if(source.fromCache)counters.cacheReuses++;
      return {retained:true,duplicate:true,source:expandedSource(previous.source)};
    }
    if (source.fromCache) {counters.unknownCacheReads++;return {retained:false,reason:'unrecognized_cached_original'};}
    const conflict=conflicts.find(row=>row.id===source.id);
    if (conflict && observedAt <= conflict.observedAt) return {retained:false,reason:conflict.reason||'source_same_time_conflict'};
    if (previous && observedAt < previous.source.observedAt) return {retained:false,reason:'older_observation'};
    if (previous && observedAt === previous.source.observedAt) {
      // Replacing this source row with its smaller tombstone cannot increase the
      // encoded size. Do not byte-reject and leave conflicted evidence usable.
      const candidate=compactEvidence(pages.filter(page=>page!==previous),payloads,
        [...conflicts,{id:source.id,observedAt,expiresAt,reason:'source_same_time_conflict'}]);
      commitInvalidation(candidate);
      counters.sameTimeConflicts++;
      return {retained:false,reason:'source_same_time_conflict'};
    }
    let eviction=null;
    // Both source rows and tombstones consume the source cap. Conflicts survive
    // until expiry or a strictly newer original observation of that same source.
    if (!previous && !conflict && pages.length+conflicts.length >= maxSources) {
      eviction=pages.reduce((oldest,page)=>!oldest||page.source.observedAt<oldest.source.observedAt?page:oldest,null);
      if (!eviction) return {retained:false,reason:'pool_conflict_capacity'};
    }
    const bound={id:source.id,sha256:source.sha256,
      sha256Scope:source.sha256Scope==='decoded_response_html_utf8'?source.sha256Scope:'caller_supplied_unspecified',
      auditReservationId:typeof source.auditReservationId==='string'?source.auditReservationId:null,
      observedAt,role:source.role,expiresAt};
    const retained=cards.slice(0,maxCardsPerSource).map(card=>copyCard(card,bound)).filter(Boolean);
    const invalid=parserInvalidCards+Math.min(cards.length,maxCardsPerSource)-retained.length;
    const omitted=totalCards-parserInvalidCards-Math.min(cards.length,maxCardsPerSource);
    const detailCopy=copyDetail(detail);
    const shippingCopy=shipping?.shippingKnown===true && shipping.currency==='JPY' &&
      Number.isFinite(shipping.shippingJPY) && shipping.shippingJPY>=0
      ? {shippingKnown:true,currency:'JPY',shippingJPY:shipping.shippingJPY}:null;
    const page={source:bound,detail:detailCopy,shipping:shippingCopy,cards:retained.map((_,index)=>payloads.length+index),
      rawCardCount:totalCards,retainedCardCount:retained.length,invalidCards:invalid,omittedCards:omitted,sectionsTruncated};
    const nextPages=previous?pages.map(row=>row===previous?page:row):[...pages.filter(row=>row!==eviction),page];
    const candidate=compactEvidence(nextPages,
      [...payloads,...retained.map(cardPayload)],conflicts.filter(row=>row!==conflict));
    if(!commit(candidate)){
      counters.byteBudgetRefusals++;
      if(previous&&source.sha256!==previous.source.sha256||conflict){
        // A known newer changed body makes its predecessor unavailable even when
        // replacement storage fails. Keep only the original new clock/reason,
        // not private historical content. A newer rejected replacement must
        // also advance an existing tombstone, or an out-of-order intermediate
        // observation could revive evidence older than the latest known read.
        // Other sources remain untouched.
        commitInvalidation(compactEvidence(pages.filter(row=>row!==previous),payloads,
          [...conflicts.filter(row=>row!==conflict),{id:source.id,observedAt,expiresAt,reason:'newer_observation_unretained'}]));
        counters.newerUnretainedSources++;
      }
      return {retained:false,reason:'retained_evidence_byte_budget'};
    }
    counters.invalidCards+=invalid;counters.omittedCards+=omitted;counters.acceptedSourceReads++;
    if(eviction)counters.evictedSources++;
    return {retained:true,duplicate:false,source:expandedSource(bound)};
  }
  function hasSourceCapacity(id) {
    prune();
    return !retentionUnavailable&&(!evidence||evidence.pages.length+evidence.conflicts.length<maxSources||
      evidence.pages.some(page=>page.source.id===id)||evidence.conflicts.some(row=>row.id===id));
  }
  function snapshot() {
    prune();
    // Compatibility expansion is transient and bounded by maxSources times
    // maxCardsPerSource (normal observer: 120 * 80), not by the encoded byte cap.
    const pages=(evidence?.pages||[]).map(page=>{
      const source=expandedSource(page.source);
      return {...clone(page),source,cards:page.cards.map(reference=>expandedCard(evidence.cardPayloads[reference],source))};
    });
    const conflicts=clone(evidence?.conflicts||[]),cards=pages.flatMap(page=>page.cards),unique=new Set(cards.map(card=>card.id));
    return {version:1,scope:'bounded_current_page_observations',pages,counters:clone(counters),retentionUnavailable,
      activeSources:pages.length,retainedCards:cards.length,uniqueCandidateIds:unique.size,
      duplicateCardObservations:cards.length-unique.size,conflicts,
      retention:{formatVersion:2,retainedEvidenceBytes,retainedCardPayloads:evidence?.cardPayloads.length||0,
        deduplicatedCardPayloadReferences:cards.length-(evidence?.cardPayloads.length||0),
        expandedSnapshotEvidenceBytes:encodedBytes({pages,conflicts})},
      bounds:{maxSources,maxCardsPerSource,maxRetainedCards:maxSources*maxCardsPerSource,maxRetainedEvidenceBytes},
      comparisonComplete:false,searchCheckedAt:null,verifiedCosts:0,marketplaceRequests:0};
  }
  return Object.freeze({ingest,snapshot,hasSourceCapacity});
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
  maximumCandidatesPerTarget=64,maximumSourceReferencesPerCandidate=8,maximumTargetObservationVisits=2_000_000,maximumIndexedWorkUnits=20_000_000,continueMapping=null}={}) {
  assert(Array.isArray(targets) && new Set(targets.map(ownKey)).size === targets.length,'distinct_managed_targets_required');
  assert(Number.isFinite(titleThreshold)&&titleThreshold>=0&&titleThreshold<=1,'invalid_title_threshold');
  assert(Number.isSafeInteger(maximumCandidatesPerTarget)&&maximumCandidatesPerTarget>0&&maximumCandidatesPerTarget<=200&&
    Number.isSafeInteger(maximumSourceReferencesPerCandidate)&&maximumSourceReferencesPerCandidate>0&&maximumSourceReferencesPerCandidate<=20,'invalid_mapping_bounds');
  assert(Number.isSafeInteger(maximumTargetObservationVisits)&&maximumTargetObservationVisits>0&&maximumTargetObservationVisits<=2_000_000,'invalid_mapping_visit_bound');
  assert(Number.isSafeInteger(maximumIndexedWorkUnits)&&maximumIndexedWorkUnits>0&&maximumIndexedWorkUnits<=20_000_000,'invalid_indexed_work_bound');
  const index=settings.ownedOffers?.yahoo;
  const ownershipReady=settings.ownedOffersComplete===true && index?.items instanceof Set && index?.sellers instanceof Set;
  const currentPages=(snapshot?.pages||[]).filter(page=>page.source.observedAt<=now&&page.source.expiresAt>now);
  // Index observation positions, not candidate IDs: duplicate observations must
  // retain source order, original clocks, newer-card selection and conflicts.
  const observations=currentPages.flatMap(page=>page.cards.map(card=>({card,source:page.source})));
  const byGram=new Map(),byImage=new Map(),byId=new Map(),unowned=[],owned=[];
  const observedOwnedIds=new Set(),correctionsByAccount=new Map();
  let mappingStopped=false,mappingStoppedReason=null,budgetPollUnits=0,indexBuildComplete=false,actualIndexedWorkUnits=0;
  let actualTargetObservationVisits=0,eligibleTargetObservationVisits=0,scoredTargetObservationPairs=0;
  let preexcludedOwnedTargetObservationPairs=0,indexEliminatedTargetObservationPairs=0,budgetUnresolvedTargets=0;
  let indexBuildObservationVisits=0,indexBuildPostingVisits=0,indexQueryPostingVisits=0;
  const checkBudget=(force=false)=>{
    if(mappingStopped)return false;
    if(continueMapping&&(force||budgetPollUnits++%64===0)&&!continueMapping()){
      mappingStopped=true;mappingStoppedReason='callback_budget';return false;
    }
    return true;
  };
  // Additional hard guard for three indexed operations only: posting insertion,
  // posting query and final pair visit. It does not replace/raise the independent
  // 2M final-pair limit, or claim to count every CPU/ownership/serialization step.
  // The wall-time callback continues to cover all phases, including index build.
  const takeIndexedWork=()=>{
    if(actualIndexedWorkUnits>=maximumIndexedWorkUnits){
      mappingStopped=true;mappingStoppedReason='indexed_work_limit';return false;
    }
    actualIndexedWorkUnits++;return true;
  };
  const append=(map,key,value)=>{const bucket=map.get(key);if(bucket)bucket.push(value);else map.set(key,[value]);};
  if(ownershipReady&&checkBudget(true)){
    // Finish the cross-page ownership pass before indexing any external card.
    // An owned seller on a later page excludes every observation of that ID.
    for(const {card} of observations){
      if(!checkBudget())break;
      if(isOwnedOffer(settings.ownedOffers,'yahoo',card))observedOwnedIds.add(card.id);
    }
    if(!mappingStopped)for(let position=0;position<observations.length;position++){
      if(!checkBudget())break;
      indexBuildObservationVisits++;
      const observation=observations[position],{card}=observation;
      if(observedOwnedIds.has(card.id)){owned.push(position);continue;}
      unowned.push(position);append(byImage,card.image,position);append(byId,card.id,position);
      observation.titleGrams=grams(card.title);
      for(const gram of observation.titleGrams){
        if(!checkBudget()||!takeIndexedWork())break;
        append(byGram,gram,position);indexBuildPostingVisits++;
      }
    }
    if(!mappingStopped)for(const record of Object.values(settings.matchCorrections||{})){
      if(!checkBudget())break;
      if(!record.deleted&&record.platform==='yahoo')append(correctionsByAccount,record.accountId,record);
    }
    indexBuildComplete=!mappingStopped;
  }
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
    if(!indexBuildComplete||!checkBudget(true)){
      budgetUnresolvedTargets++;return {...base,status:'blocked',reason:'local_mapping_budget',mappingIncomplete:true};
    }
    const unique=new Map(),profileGrams=grams(profile.title),historicalById=new Map();
    const selected=new Set(),overlap=new Map(),correctedIds=new Set();
    const correctionTarget={...target,title:profile.title,image:profile.imageUrl};
    const addPositions=positions=>{
      for(const position of positions||[]){if(!checkBudget())return false;selected.add(position);}
      return true;
    };
    for(const identity of target.historicalIdentities||[]){
      if(!checkBudget())break;
      if(identity.accountId===target.accountId&&identity.own?.id===target.id&&!historicalById.has(identity.candidate?.id))
        historicalById.set(identity.candidate?.id,identity);
    }
    // Calling the shared rejection predicate preserves exact account, relisting,
    // deletion and CURRENT profile title/image fingerprint semantics. Correction
    // observations join the union even if they cannot match the recall score.
    for(const record of correctionsByAccount.get(target.accountId)||[]){
      if(!checkBudget())break;
      const positions=byId.get(record.candidateId);
      if(!positions||correctedIds.has(record.candidateId))continue;
      if(rejectedByMemory([record],correctionTarget,'yahoo',observations[positions[0]].card)){
        correctedIds.add(record.candidateId);if(!addPositions(positions))break;
      }
    }
    if(titleThreshold===0){
      // Zero accepts score zero, including empty/punctuation-only card titles.
      // This intentional full fallback still obeys the same work/time budgets.
      addPositions(unowned);
    }else{
      for(const gram of profileGrams){
        if(!checkBudget())break;
        for(const position of byGram.get(gram)||[]){
          if(!checkBudget()||!takeIndexedWork())break;
          indexQueryPostingVisits++;
          const size=observations[position].titleGrams.size;
          // min/max is an upper bound on intersection/max. No rounding or
          // approximate top-k pruning can discard a threshold-boundary match.
          if(Math.min(profileGrams.size,size)/Math.max(profileGrams.size,size)<titleThreshold)continue;
          overlap.set(position,(overlap.get(position)||0)+1);selected.add(position);
        }
      }
    }
    if(!mappingStopped)addPositions(byImage.get(profile.imageUrl));
    if(!mappingStopped)for(const id of historicalById.keys())if(!addPositions(byId.get(id)))break;
    if(mappingStopped){budgetUnresolvedTargets++;return {...base,status:'blocked',reason:'local_mapping_budget',mappingIncomplete:true};}
    // These observations are conclusively resolved without target-card visits.
    // The remaining positions are processed in the exact original page order.
    preexcludedOwnedTargetObservationPairs+=owned.length;
    indexEliminatedTargetObservationPairs+=unowned.length-selected.size;
    base.excludedCardObservations=owned.length;
    base.unmappedCardObservations=unowned.length-selected.size;
    const exclusions=owned.slice(0,maximumCandidatesPerTarget).map(position=>({position,id:observations[position].card.id,reason:'own_offer'}));
    for(const position of [...selected].sort((a,b)=>a-b)){
      if(actualTargetObservationVisits>=maximumTargetObservationVisits){mappingStopped=true;mappingStoppedReason='actual_visit_limit';break;}
      if(!checkBudget()||!takeIndexedWork())break;
      actualTargetObservationVisits++;
      const observation=observations[position],{card,source}=observation;
      if(correctedIds.has(card.id)){
        base.excludedCardObservations++;
        // Keep only the earliest bounded exclusions, independent of recall order.
        if(exclusions.length<maximumCandidatesPerTarget||position<exclusions.at(-1).position){
          exclusions.push({position,id:card.id,reason:'saved_user_correction'});
          exclusions.sort((a,b)=>a.position-b.position);exclusions.length=Math.min(exclusions.length,maximumCandidatesPerTarget);
        }
        continue;
      }
      const historical=historicalById.get(card.id);
      const score=titleThreshold===0?titleSimilarity(profileGrams,observation.titleGrams):
        (overlap.has(position)?overlap.get(position)/Math.max(profileGrams.size,observation.titleGrams.size):titleSimilarity(profileGrams,observation.titleGrams));
      const sameImageUrl=profile.imageUrl===card.image;
      scoredTargetObservationPairs++;
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
    base.excluded=exclusions.map(({id,reason})=>({id,reason}));
    if(mappingStopped)budgetUnresolvedTargets++;
    const ranked=[...unique.values()].sort((a,b)=>Number(Boolean(b.historicalIdentity))-Number(Boolean(a.historicalIdentity))||
      Number(b.lowerListedPrice===true)-Number(a.lowerListedPrice===true)||b.titleSimilarity-a.titleSimilarity||a.id.localeCompare(b.id));
    base.candidates=ranked.slice(0,maximumCandidatesPerTarget);
    base.omittedCandidateMatches=Math.max(0,ranked.length-base.candidates.length);
    return {...base,currentProfilePrice:profile.priceJPY,profileObservedAt:profile.observedAt,
      ...(mappingStopped?{mappingIncomplete:true}:{}),
      status:base.candidates.length?'local_recall_only':mappingStopped?'blocked':'unresolved',
      reason:mappingStopped?'local_mapping_budget':base.candidates.length?'requires_verification':'no_local_mapping'};
  });
  const mapped=rows.flatMap(row=>row.candidates),ids=new Set(mapped.map(row=>row.id));
  return {version:1,totalManagedTargets:targets.length,rows,
    currentProfileTargets:rows.filter(row=>['local_recall_only','unresolved','not_open'].includes(row.status)).length,
    mappedTargets:rows.filter(row=>row.candidates.length).length,unmappedTargets:rows.filter(row=>!row.candidates.length).length,
    targetCandidatePairs:mapped.length,uniqueMappedCandidateIds:ids.size,
    sharedTargetPairDuplicates:mapped.length-ids.size,
    omittedCandidateMatches:rows.reduce((sum,row)=>sum+row.omittedCandidateMatches,0),
    bounds:{maximumCandidatesPerTarget,maximumSourceReferencesPerCandidate,maximumRetainedPairs:targets.length*maximumCandidatesPerTarget},
    // Counter v2: naive = all eligible targets x current card observations.
    // Actual visits include possible-title/image/history and correction pairs;
    // scored pairs exclude corrections and include below-threshold scores.
    // Preexcluded-owned pairs count only target rows that reached local recall;
    // the observation count describes the one complete global ownership pass.
    // Eliminated pairs are impossible by no shared gram/size upper bound (and
    // have no image/history/correction bucket). Omitted pairs remain unresolved,
    // never safely eliminated. Build/query posting work is reported separately.
    // Budget-unresolved targets include a partially processed target; no-recall
    // targets also include completed no-hit, invalid and non-open targets.
    mappingCounterVersion:2,mappingStopped,mappingStoppedReason,indexBuildComplete,
    naivePotentialTargetObservationVisits:eligibleTargetObservationVisits,actualTargetObservationVisits,scoredTargetObservationPairs,
    preexcludedOwnedCardObservations:indexBuildComplete?owned.length:0,preexcludedOwnedTargetObservationPairs,indexEliminatedTargetObservationPairs,
    omittedTargetObservationVisits:eligibleTargetObservationVisits-actualTargetObservationVisits-preexcludedOwnedTargetObservationPairs-indexEliminatedTargetObservationPairs,
    budgetUnresolvedTargets,noRecallTargets:rows.filter(row=>!row.candidates.length).length,
    indexBuildObservationVisits,indexBuildPostingVisits,indexQueryPostingVisits,maximumTargetObservationVisits,
    actualIndexedWorkUnits,maximumIndexedWorkUnits,
    completeComparisons:0,searchCheckedAt:null,verifiedCosts:0,marketplaceRequests:0};
}
