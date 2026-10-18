// Observation only. No transport, images, strict verification or scheduling.
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createYahooPageObservationPool,mapYahooPoolToTargets} from './yahoo-page-observation-pool.mjs';
import {yahooProfileCardProblem} from './yahoo-profile-identity.mjs';
import {buildOwnedOffers,normalizeOfferPlatform} from '../../public/owned-offers.js';
import {PRICING_RULES_VERSION} from '../../public/pricing-policy.js';

const stamp=value=>typeof value==='number'?value:Date.parse(value||'');
const yahoo=value=>normalizeOfferPlatform(value.platform,value.profileUrl||value.url)==='yahoo';
const key=value=>`${value.accountId}:${value.id}`;
const fallbackItem=({id,accountId,platform,title,ownPrice,sellerId,image})=>({id,accountId,platform,title,ownPrice,sellerId,image});
// Availability of these copied fields is not proof of strict identity, stock or sale terms.
const detailFieldsPresent=page=>Boolean(page?.detail?.title?.trim()&&page.detail.description?.trim()&&page.detail.sellerId&&
  page.detail.status&&Number.isFinite(page.detail.price)&&page.detail.price>0&&page.detail.images?.length&&
  page.shipping?.shippingKnown&&page.shipping.currency==='JPY');
const noAuthority={completeComparisons:0,searchObservedTargets:0,marketplaceRequests:0,imageRequests:0,checkedAt:null,searchCheckedAt:null,canRecommend:false};

export function createYahooScanPageObservation({startedAt,deadlineAt,accounts=[],contexts=[],now=Date.now,
  maxSources=120,maxCardsPerSource=80,maxRetainedEvidenceBytes=2*1024*1024,maxTargetObservationVisits=2_000_000,
  maxPostScanMs=5000,maxMappingDurationMs=1000,mappingClock=performance.now.bind(performance)}={}){
  for(const [value,maximum] of [[maxRetainedEvidenceBytes,8*1024*1024],[maxTargetObservationVisits,2_000_000],[maxPostScanMs,5000],[maxMappingDurationMs,1000]])
    if(!Number.isSafeInteger(value)||value<1||value>maximum)throw Error('invalid_observation_bound');
  // Source admission ends at the original deadline. The short tail only permits local mapping.
  const finalizationDeadlineAt=deadlineAt+maxPostScanMs;
  const options={now,cycleStartedAt:startedAt,deadlineAt:finalizationDeadlineAt,maxSources,maxCardsPerSource,maxRetainedEvidenceBytes};
  const pool=createYahooPageObservationPool(options);
  const initial=new Map(contexts.map(context=>[context.account.id,{account:{...context.account},activeItems:context.activeItems.map(fallbackItem),
    previousItems:(context.previousItems||[]).map(fallbackItem),profileStatus:'missing'}]));
  const counters={observerCalls:0,rejectedSources:0,sourceCapacityRefusals:0,byteBudgetRefusals:0,observerFailures:0};
  let observerDurationMs=0,originalObservedAtMin=null,originalObservedAtMax=null,finished=null;
  const snapshot=()=>pool.snapshot();
  function observe({page,requestedItemId,role,detail,shipping,recommendationReceipt:receipt}={}){
    if(finished)return;
    const start=performance.now();counters.observerCalls++;
    try{
      const at=stamp(page?.observedAt),url=`https://paypayfleamarket.yahoo.co.jp/item/${requestedItemId}`;
      if(!/^[a-zA-Z0-9_-]{1,80}$/.test(requestedItemId||'')||!['own','candidate','known'].includes(role)||
        page?.fromCache!==false||page.status!==200||page.url!==url||page.redirected!==false||
        (page.finalUrl!==undefined&&page.finalUrl!==url)||typeof page.html!=='string'||!page.html||Buffer.byteLength(page.html,'utf8')>32*1024*1024||
        !Number.isFinite(at)||at<startedAt||at>=deadlineAt||at>now()||now()>=deadlineAt||detail?.id!==requestedItemId||receipt?.version!==1||receipt.requestedItemId!==requestedItemId||
        receipt.sourceUrl!==url||stamp(receipt.observedAt)!==at||!Array.isArray(receipt.cards)){
        counters.rejectedSources++;return;
      }
      if(!pool.hasSourceCapacity(requestedItemId)){counters.sourceCapacityRefusals++;return;}
      const input={source:{id:requestedItemId,url,sha256:createHash('sha256').update(page.html,'utf8').digest('hex'),sha256Scope:'decoded_response_html_utf8',
        observedAt:at,fromCache:false,role:role==='known'?'candidate':role,status:200,redirected:false,auditReservationId:page.auditReservationId||null},
        detail,shipping,cards:receipt.cards.map(card=>({...card,priceSource:'yahoo_recommendation_receipt_v1'})),
        totalCards:receipt.totalCards,parserInvalidCards:receipt.invalidCards,sectionsTruncated:receipt.sectionsTruncated};
      const admission=pool.ingest(input);
      if(admission.reason==='retained_evidence_byte_budget'){counters.byteBudgetRefusals++;return;}
      if(admission.retained&&!admission.duplicate){
        originalObservedAtMin=Math.min(originalObservedAtMin??at,at);originalObservedAtMax=Math.max(originalObservedAtMax??at,at);
      }
    }catch{counters.observerFailures++;}
    finally{observerDurationMs+=performance.now()-start;}
  }
  function finish({contexts:latest=contexts,settings={},scanPhaseFailed=false}={}){
    if(finished)return finished;
    const start=performance.now(),time=now();
    const all=accounts.map(account=>latest.find(context=>context.account.id===account.id)||initial.get(account.id)||{account,activeItems:[],profileStatus:'missing'});
    const totalManagedTargets=all.reduce((n,context)=>n+context.activeItems.length,0);
    const base={version:1,scope:'normal_read_rails_observation_only',totalManagedTargets,yahooTargets:0,currentProfileTargets:0,
      authorizedAccounts:accounts.length,missingAccountContexts:accounts.filter(account=>!latest.some(context=>context.account.id===account.id)).length,
      completeOwnedIndex:false,blockedTargets:totalManagedTargets,mappedTargets:0,unmappedTargets:totalManagedTargets,targetCandidatePairs:0,uniqueCandidateIds:0,
      ownPageObservedTargets:0,pendingOwnPageTargets:totalManagedTargets,unresolvedTargets:totalManagedTargets,
      mappingPasses:0,scanPhaseFailed:Boolean(scanPhaseFailed),mappingTargetObservationVisits:0,mappingTargetObservationVisitUpperBound:0,
      mappingEligibleTargets:0,omittedMappingCardObservations:0,
      maxPostScanMs,maxMappingDurationMs,mappingStopped:false,mappingActualTargetObservationVisits:0,omittedTargetObservationVisits:0,
      recalledPendingOwnRoots:0,lowerLinkedPendingOwnRoots:0,unknownPriceLinkedPendingOwnRoots:0,notLowerOnlyPendingOwnRoots:0,pendingOwnRootsByCandidateCount:{one:0,twoToFour:0,fivePlus:0},
      detailInputAssessment:'retained_fields_only',currentOwnDetailFieldTargets:0,missingOwnDetailFieldTargets:totalManagedTargets,
      mappedTargetsWithBothObservedDetailFields:0,mappedPairsWithBothObservedDetailFields:0,
      mappedPairsMissingOwnObservedDetailFields:0,mappedPairsMissingCandidateObservedDetailFields:0,
      lowerListedPricePairs:0,notLowerListedPricePairs:0,unknownListedPricePairs:0,conflictingCardPairs:0,
      bodyFieldPresenceByCardPrice:Object.fromEntries(['both','own_only','candidate_only','neither'].map(kind=>[kind,{lower:0,not_lower:0,unknown:0,conflicting:0}])),
      saleTermsVerificationPendingPairs:0,saleTermsVerifiedPairs:0,
      observerDurationMs,originalObservedAtMin,originalObservedAtMax,...counters,...noAuthority};
    try{
      const complete=context=>yahoo(context.account)&&context.profileStatus==='live'&&context.profileDiscovery?.profileObservation?.complete===true&&
        context.profileDiscovery.profileObservation.enumerationComplete===true&&context.profileDiscovery.profileObservation.ownershipConflictCount===0&&
        context.profileDiscovery.profileObservation.fromCache===false&&Number.isFinite(context.profileDiscovery.profileObservation.observedAt)&&
        context.profileDiscovery.profileObservation.observedAt>=startedAt&&context.profileDiscovery.profileObservation.observedAt<=time&&
        time-context.profileDiscovery.profileObservation.observedAt<=20*60_000;
      const targets=all.flatMap(context=>{
        const cards=new Map((complete(context)?context.profileDiscovery.profileObservation.cards:[]).map(card=>[card.id,card]));
        return context.activeItems.map(item=>{
          const profile=cards.get(item.id),prior=context.previousById?.get(item.id);
          return {...item,accountId:context.account.id,platform:item.platform||context.account.platform,
            profileCard:profile?.accountId===context.account.id?profile:null,
            historicalIdentities:(prior?.yahoo?.candidates||[]).flatMap(candidate=>{
              const value=candidate.profileIdentity;
              return value?.version===1&&value.source==='accepted_detail_pair'&&value.rulesVersion===PRICING_RULES_VERSION&&value.accountId===context.account.id&&
                value.own?.id===item.id&&value.candidate?.id===candidate.id?[value]:[];
            })};
        });
      });
      base.yahooTargets=targets.filter(yahoo).length;
      base.currentProfileTargets=targets.filter(target=>target.profileCard&&!yahooProfileCardProblem(target.profileCard,{now:time})).length;
      const ownership=buildOwnedOffers(accounts,all.flatMap(context=>[...(context.previousItems||[]),...context.activeItems,
        ...(context.profileDiscovery?.profileObservation?.membershipIds||[]).map(id=>({id,platform:context.account.platform,sellerId:context.account.sellerId}))]));
      // Never narrow caller-provided all-account or historical self exclusions.
      for(const [platform,group] of Object.entries(settings.ownedOffers||{}))for(const field of ['items','sellers'])
        if(group?.[field] instanceof Set)for(const value of group[field])ownership[platform]?.[field].add(value);
      base.completeOwnedIndex=base.missingAccountContexts===0&&all.filter(context=>yahoo(context.account)).every(complete);
      const observed=snapshot();Object.assign(base,{acceptedSourceReads:observed.counters.acceptedSourceReads,duplicateAdmissions:observed.counters.duplicateAdmissions,
        retainedSources:observed.activeSources,retainedCardObservations:observed.retainedCards,uniqueRailCandidateIds:observed.uniqueCandidateIds,
        duplicateCardObservations:observed.duplicateCardObservations,omittedRailCards:observed.counters.omittedCards,
        expiredSources:observed.counters.expiredSources,newerUnretainedSources:observed.counters.newerUnretainedSources,
        retentionUnavailable:observed.retentionUnavailable,retainedEvidenceBytes:observed.retention.retainedEvidenceBytes,
        retainedEvidenceFormatVersion:observed.retention.formatVersion,retainedCardPayloads:observed.retention.retainedCardPayloads,
        deduplicatedCardPayloadReferences:observed.retention.deduplicatedCardPayloadReferences,
        expandedSnapshotEvidenceBytes:observed.retention.expandedSnapshotEvidenceBytes,
        maxRetainedEvidenceBytes,maxTargetObservationVisits});
      const ownObserved=new Set(targets.filter(target=>yahoo(target)&&observed.pages.some(page=>page.source.id===target.id&&page.detail?.description?.trim()&&
        page.detail.sellerId===(target.profileCard?.sellerId||target.sellerId))).map(key));
      base.ownPageObservedTargets=ownObserved.size;base.pendingOwnPageTargets=totalManagedTargets-ownObserved.size;
      const detailPages=new Map(observed.pages.filter(detailFieldsPresent).map(page=>[page.source.id,page]));
      const ownDetailFields=new Set(targets.filter(target=>ownObserved.has(key(target))&&detailPages.has(target.id)).map(key));
      base.currentOwnDetailFieldTargets=ownDetailFields.size;base.missingOwnDetailFieldTargets=totalManagedTargets-ownDetailFields.size;
      if(scanPhaseFailed||time>=finalizationDeadlineAt){base.reason=scanPhaseFailed?'scan_phase_failed':'finalization_deadline';return finished=Object.freeze({...base,finishDurationMs:performance.now()-start});}
      base.mappingEligibleTargets=base.completeOwnedIndex?targets.filter(target=>yahoo(target)&&target.profileCard?.itemStatus==='OPEN'&&
        !yahooProfileCardProblem(target.profileCard,{now:time})&&ownership.yahoo.items.has(target.id)&&ownership.yahoo.sellers.has(target.profileCard.sellerId)).length:0;
      // The old Cartesian estimate clipped later observed pages before local
      // recall. Index all retained cards and keep the same actual pair/time
      // bounds. Mathematical eliminations are not unfinished mapping work.
      base.omittedMappingCardObservations=0;
      base.mappingTargetObservationVisitUpperBound=base.mappingEligibleTargets*observed.retainedCards;
      base.mappingPasses=1;
      const mappingEndsAt=mappingClock()+maxMappingDurationMs;
      const mapping=mapYahooPoolToTargets({snapshot:observed,targets,settings:{...settings,ownedOffers:ownership,ownedOffersComplete:base.completeOwnedIndex},now:time,
        maximumTargetObservationVisits:maxTargetObservationVisits,
        continueMapping:()=>mappingClock()<mappingEndsAt&&now()<finalizationDeadlineAt});
      Object.assign(base,{blockedTargets:mapping.rows.filter(row=>row.status==='blocked').length,mappedTargets:mapping.mappedTargets,unmappedTargets:mapping.unmappedTargets,
        targetCandidatePairs:mapping.targetCandidatePairs,uniqueCandidateIds:mapping.uniqueMappedCandidateIds,
        omittedCandidateMatches:mapping.omittedCandidateMatches,sharedTargetPairDuplicates:mapping.sharedTargetPairDuplicates,
        mappingStopped:mapping.mappingStopped,mappingTargetObservationVisits:mapping.actualTargetObservationVisits,mappingActualTargetObservationVisits:mapping.actualTargetObservationVisits,omittedTargetObservationVisits:mapping.omittedTargetObservationVisits});
      for(const field of ['mappingCounterVersion','mappingStoppedReason','indexBuildComplete','naivePotentialTargetObservationVisits',
        'scoredTargetObservationPairs','preexcludedOwnedCardObservations','preexcludedOwnedTargetObservationPairs',
        'indexEliminatedTargetObservationPairs','budgetUnresolvedTargets','noRecallTargets',
        'indexBuildObservationVisits','indexBuildPostingVisits','indexQueryPostingVisits','actualIndexedWorkUnits','maximumIndexedWorkUnits'])
        if(mapping[field]!==undefined)base[field]=mapping[field];
      for(const row of mapping.rows){
        const ownPresent=ownDetailFields.has(row.targetKey);let bothPresent=false;
        for(const candidate of row.candidates){
          const candidatePage=detailPages.get(candidate.id);
          const candidatePresent=Boolean(candidatePage&&(!candidate.card.sellerId||candidatePage.detail.sellerId===candidate.card.sellerId));
          // Field presence and a rail's listed price describe expected evidence
          // needs only. They do not prove current strict identity or zero image
          // requests, and repeated references are not independent confirmations.
          const bodyKind=ownPresent?(candidatePresent?'both':'own_only'):(candidatePresent?'candidate_only':'neither');
          const priceKind=candidate.conflictingCardObservations?'conflicting':candidate.lowerListedPrice===null?'unknown':candidate.lowerListedPrice?'lower':'not_lower';
          base.bodyFieldPresenceByCardPrice[bodyKind][priceKind]++;
          if(!ownPresent)base.mappedPairsMissingOwnObservedDetailFields++;
          if(!candidatePresent)base.mappedPairsMissingCandidateObservedDetailFields++;
          if(ownPresent&&candidatePresent){base.mappedPairsWithBothObservedDetailFields++;bothPresent=true;}
          if(candidate.conflictingCardObservations)base.conflictingCardPairs++;
          if(candidate.conflictingCardObservations||candidate.lowerListedPrice===null)base.unknownListedPricePairs++;
          else if(candidate.lowerListedPrice===true)base.lowerListedPricePairs++;
          else base.notLowerListedPricePairs++;
        }
        if(bothPresent)base.mappedTargetsWithBothObservedDetailFields++;
        if(!ownObserved.has(row.targetKey)&&row.candidates.length){
          base.recalledPendingOwnRoots++;
          const hasLower=row.candidates.some(candidate=>!candidate.conflictingCardObservations&&candidate.lowerListedPrice===true);
          const hasUnknown=row.candidates.some(candidate=>candidate.conflictingCardObservations||candidate.lowerListedPrice===null);
          if(hasLower)base.lowerLinkedPendingOwnRoots++;
          if(hasUnknown)base.unknownPriceLinkedPendingOwnRoots++;
          if(!hasLower&&!hasUnknown)base.notLowerOnlyPendingOwnRoots++;
          base.pendingOwnRootsByCandidateCount[row.candidates.length===1?'one':row.candidates.length<=4?'twoToFour':'fivePlus']++;
        }
      }
      // Even observed detail fields are not evaluated here. All recalled terms remain unverified.
      base.saleTermsVerificationPendingPairs=base.targetCandidatePairs;
      base.reason=mapping.mappingStopped?'local_mapping_budget':base.completeOwnedIndex?'observed_only':'complete_owned_index_required';
    }catch{base.reason='observation_unavailable';}
    return finished=Object.freeze({...base,finishDurationMs:performance.now()-start});
  }
  return Object.freeze({observe,finish,snapshot,revision:()=>counters.observerCalls});
}
