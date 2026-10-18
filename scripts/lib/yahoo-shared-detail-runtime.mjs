import {performance} from 'node:perf_hooks';
import {mapYahooPoolToTargets} from './yahoo-page-observation-pool.mjs';
import {verifySharedYahooDetailPair,boundedSharedPeek} from './yahoo-shared-detail-consumer.mjs';
import {sharedYahooTargetBinding,currentSharedYahooOffers} from '../../public/shared-yahoo-offers.js';
import {buildOwnedOffers,normalizeOfferPlatform,isOwnedOffer} from '../../public/owned-offers.js';
import {sharedStrictReason} from './shared-yahoo-reason-codes.mjs';

const yahoo=value=>normalizeOfferPlatform(value.platform,value.profileUrl)==='yahoo';
const key=value=>`${value.accountId}:${value.id}`;
const consistentImageClock=(latest,original,current)=>Number.isFinite(Date.parse(latest))&&
 Date.parse(latest)>=Date.parse(original)&&Date.parse(latest)<=current;
// A bounded local consumer of completed reads. It cannot request a body/image,
// extend source deadlines, change normal scheduling, or insert pricing candidates.
export function createSharedYahooDetailRuntime({startedAt,deadlineAt,accounts,contexts,snapshot,peekBundle,peekFingerprint,
 peekOriginalReceipt=id=>peekBundle(id)?.originalObservation,peekFingerprintState=null,observationVersion=null,onMapping=null,now=Date.now,clock=performance.now.bind(performance),maxPasses=3,maxPairs=32,maxDurationMs=1000,minPassGapMs=120000,
 maxDirectedPairs=6,maxDirectedDurationMs=1000}={}){
 for(const [value,max] of [[maxPasses,3],[maxPairs,32],[maxDurationMs,1000],[minPassGapMs,120000],[maxDirectedPairs,6],[maxDirectedDurationMs,1000]])
  if(!Number.isSafeInteger(value)||value<0||value>max)throw Error('invalid_shared_detail_bound');
 const offers=new Map(),completed=new Set(),recallBindings=new Map(),withdrawnRevisions=new Set();let recallVersion,recallIndex=null;let busy=false,lastPass=-Infinity,spent=0,lastSettings=null,directedBusy=false,directedSpent=0;
 const stats={version:1,scope:'current_shared_detail_pairs_only',passes:0,mappedPairs:0,bodyReadyPairs:0,attemptedPairs:0,verifiedPairs:0,verifiedTargets:0,
  missingOriginalPairs:0,pendingPairs:0,rejectedPairs:0,failures:0,deadlineStops:0,mappingStops:0,localDurationMs:0,negativeSnapshotBuilds:0,negativeValidationDurationMs:0,htmlRequests:0,imageRequests:0,
  directedAttempts:0,directedVerified:0,directedDurationMs:0,directedWaitMs:0,mappingObserverFailures:0,
  completeComparisons:0,canRecommend:false,reasons:{},strictRejectionReasons:{},directedStrictRejectionReasons:{},withdrawalReasons:{},retentionReasons:{},
  withdrawalCountScope:'first_reason_per_accepted_evidence_revision',retentionCountScope:'guarded_retention_decisions'};
 const reason=value=>{stats.reasons[value]=(stats.reasons[value]||0)+1;};
 const count=(group,value)=>{stats[group][value]=(stats[group][value]||0)+1;};
 const evidenceRevision=row=>JSON.stringify([row.target,row.id,row.ownSource?.bodySha256,row.ownSource?.parsedSha256,
  row.candidateSource?.bodySha256,row.candidateSource?.parsedSha256,row.identityVerifiedAt,row.verification?.digest,
  row.imageEvidence?.map(image=>[image.url,image.contentSha256,image.imageObservedAt])]);
 const withdraw=(rows,value)=>{for(const row of rows||[]){
  const revision=evidenceRevision(row);
  if(!withdrawnRevisions.has(revision)){withdrawnRevisions.add(revision);count('withdrawalReasons',value);}
 }};
 const complete=(context,current)=>context&&yahoo(context.account)&&context.profileStatus==='live'&&
    context.profileDiscovery?.profileObservation?.complete===true&&context.profileDiscovery.profileObservation.enumerationComplete===true&&
    context.profileDiscovery.profileObservation.ownershipConflictCount===0&&context.profileDiscovery.profileObservation.fromCache===false&&
    Number.isFinite(context.profileDiscovery.profileObservation.observedAt)&&context.profileDiscovery.profileObservation.observedAt>=startedAt&&
    context.profileDiscovery.profileObservation.observedAt<=current;
 // Negative evidence is indexed once per actual producer callback, then reused
 // at output. It cannot authorize a quote or fetch missing evidence.
 function negativeRecallIndex(){
  const revision=typeof observationVersion==='function'?observationVersion():undefined;
  if(recallIndex&&revision!==undefined&&revision===recallVersion)return recallIndex;
  stats.negativeSnapshotBuilds++;const value=snapshot();if(value?.retentionUnavailable||!Array.isArray(value?.pages))throw Error('recall_evidence_unavailable');
  const index=new Map();for(const page of value.pages)for(const card of page.cards||[]){
   const rows=index.get(card.id)||[];rows.push({card,observedAt:page.source.observedAt,expiresAt:page.source.expiresAt});index.set(card.id,rows);
  }
  recallVersion=revision;return recallIndex=index;
 }
 const cardTuple=card=>JSON.stringify([card.title,card.price,card.image,card.sellerId]);
 function recallProblem(row,index,targetKey){
  const rows=(index.get(row.id)||[]).filter(value=>value.observedAt<=now()&&value.expiresAt>now());
  if(!rows.length)return null; // Absence/expiry of recall is not contrary detail evidence.
  if(rows.some(value=>isOwnedOffer(lastSettings.ownedOffers,'yahoo',value.card)))return 'recall_owned';
  if(new Set(rows.map(({card})=>cardTuple(card))).size>1)return 'recall_conflicting_tuple';
  const original=recallBindings.get(`${targetKey}:${row.id}`);if(!original)return 'recall_binding_missing';
  return rows.some(({card,observedAt})=>observedAt>Date.parse(row.checkedAt)&&cardTuple(card)!==original)?'recall_newer_tuple_changed':null;
 }
 function currentOffers(item){
  const begin=performance.now();try{return checkedCurrentOffers(item)}finally{stats.negativeValidationDurationMs+=Math.max(0,performance.now()-begin);}
 }
 function checkedCurrentOffers(item){
  if(!item||!lastSettings)return [];
  if(accounts.some(account=>yahoo(account)&&!contexts.some(context=>context.account.id===account.id&&complete(context,now())))){withdraw([...offers.values()].flat(),'complete_owned_index_unavailable');offers.clear();stats.verifiedTargets=0;return [];}
  const targetKey=key(item),own=peekOriginalReceipt(item.id),rows=offers.get(targetKey)||[];
  if(!rows.length)return [];const negative=negativeRecallIndex();
  const schema=currentSharedYahooOffers({...item,sharedYahooOffers:rows},{ownershipIndex:lastSettings.ownedOffers,corrections:lastSettings.matchCorrections||{},now:now()});
  withdraw(rows.filter(row=>!schema.some(value=>value.id===row.id)),'stored_quote_invalid_or_expired');
  const keep=schema.filter(row=>{
    const candidate=peekOriginalReceipt(row.id);let problem=recallProblem(row,negative,targetKey);
    if(!problem&&!own)problem='own_original_unavailable';
    if(!problem&&!candidate)problem='candidate_original_unavailable';
    if(!problem&&(own.bodySha256!==row.ownSource.bodySha256||own.parsedSha256!==row.ownSource.parsedSha256))problem='own_original_changed';
    if(!problem&&(candidate.bodySha256!==row.candidateSource.bodySha256||candidate.parsedSha256!==row.candidateSource.parsedSha256))problem='candidate_original_changed';
    if(!problem&&typeof peekFingerprintState!=='function')problem='image_metadata_unavailable';
    if(!problem)for(const image of row.imageEvidence){const latest=peekFingerprintState(image.url);
     if(latest?.status!=='available')problem='image_metadata_unavailable';
     else if(latest.contentSha256!==image.contentSha256)problem='image_bytes_changed';
     else if(!consistentImageClock(latest.imageObservedAt,image.imageObservedAt,now()))problem='image_observation_inconsistent';
     else if(!Number.isFinite(latest.imageCacheExpiresAt)||!(latest.imageCacheExpiresAt>now()))problem='image_metadata_expired';
     if(problem)break;
    }
    if(problem){withdraw([row],problem);return false;}return true;
   })
   .map(row=>({...row,imageEvidence:row.imageEvidence.map(image=>({...image,imageCacheExpiresAt:Math.min(image.imageCacheExpiresAt,peekFingerprintState(image.url).imageCacheExpiresAt)}))}));
  if(keep.length)offers.set(targetKey,keep);else offers.delete(targetKey);
  for(const row of rows)if(!keep.some(value=>value.id===row.id))for(const pair of completed)if(pair.startsWith(`${targetKey}:${row.id}:`))completed.delete(pair);
  stats.verifiedTargets=offers.size;
  return structuredClone(keep);
 }
 function revokeKnownChanges(){
  for(const targetKey of [...offers.keys()]){
   const item=contexts.flatMap(context=>context.activeItems).find(item=>key(item)===targetKey);
   if(item)currentOffers(item);else {withdraw(offers.get(targetKey),'current_target_unavailable');offers.delete(targetKey);}
  }
  stats.verifiedTargets=offers.size;
 }

 // An interrupted optional duplicate peek is not new source evidence. Keep
 // only a currently accepted row with the same complete original body bindings;
 // currentOffers still applies ownership, correction, recall, TTL and image
 // metadata guards and can only shorten the retained original image expiry.
 function retainAfterInterruption(item,row){
  // The 12-minute source admission window is not the accepted evidence TTL.
  // This path reads only already-held metadata and never starts a new task.
  if(!item)return null;
  const own=peekOriginalReceipt(item.id),candidate=peekOriginalReceipt(row.id);
  if(!own||!candidate||own.bodySha256!==row.ownSource.bodySha256||candidate.bodySha256!==row.candidateSource.bodySha256||
   own.parsedSha256!==row.ownSource.parsedSha256||candidate.parsedSha256!==row.candidateSource.parsedSha256)return null;
  const retained=currentOffers(item).find(value=>value.id===row.id)||null;
  if(retained)count('retentionReasons',now()>=deadlineAt?'source_window_closed_original_retained':'local_budget_original_retained');
  return retained;
 }

 const pairKey=(item,id,own,candidate)=>`${key(item)}:${id}:${own?.parsedSha256}:${candidate?.parsedSha256}:${JSON.stringify(sharedYahooTargetBinding(item))}`;
 function forgetPair(item,id){
  const targetKey=key(item),prior=offers.get(targetKey);
  if(prior){withdraw(prior.filter(row=>row.id===id),'directed_revalidation_started');const keep=prior.filter(row=>row.id!==id);if(keep.length)offers.set(targetKey,keep);else offers.delete(targetKey);}
  for(const pair of completed)if(pair.startsWith(`${targetKey}:${id}:`))completed.delete(pair);
  stats.verifiedTargets=offers.size;
 }
 function commitVerified(item,recall,result){
  completed.add(pairKey(item,result.offer.id,result.offer.ownSource,result.offer.candidateSource));
  recallBindings.set(`${key(item)}:${result.offer.id}`,cardTuple(recall.card));const rows=offers.get(key(item))||[];
  offers.set(key(item),[...rows.filter(row=>row.id!==result.offer.id),result.offer].sort((a,b)=>a.price-b.price).slice(0,5));
  stats.verifiedPairs++;stats.verifiedTargets=offers.size;
 }
 const directedAvailable=()=>typeof peekFingerprintState==='function'&&!directedBusy&&lastSettings!==null&&
  stats.directedAttempts<maxDirectedPairs&&directedSpent<maxDirectedDurationMs&&now()<deadlineAt;
 function isRecallCurrent({item,recall}={}){
  try{
   if(!lastSettings||now()>=deadlineAt||!recall?.card||accounts.some(account=>yahoo(account)&&!contexts.some(context=>context.account.id===account.id&&complete(context,now()))))return false;
   const context=contexts.find(context=>context.account.id===item?.accountId),current=context?.activeItems.find(value=>value.id===item?.id);
   if(!current||JSON.stringify(sharedYahooTargetBinding(current))!==JSON.stringify(sharedYahooTargetBinding(item)))return false;
   const currentProfile=context.profileDiscovery.profileObservation.cards.find(value=>value.id===item.id);
   if(!currentProfile||JSON.stringify(currentProfile)!==JSON.stringify(item.profileCard))return false;
   const rows=(negativeRecallIndex().get(recall.id)||[]).filter(value=>value.observedAt<=now()&&value.expiresAt>now());
   return rows.length>0&&rows.every(value=>!isOwnedOffer(lastSettings.ownedOffers,'yahoo',value.card)&&cardTuple(value.card)===cardTuple(recall.card));
  }catch{return false;}
 }
 // The scheduler may prepare a missing own body/image outside this function.
 // This admission remains cache-only and has its own cumulative local/wait
 // ledger, so spending the observation pass's 1s cannot silently disable it.
 async function verifyPlannedPair({item:planned,recall}={}){
  if(!directedAvailable())return {status:'pending',reason:'directed_budget'};
  directedBusy=true;const begin=performance.now();
  const stop=()=>now()>=deadlineAt||directedSpent+performance.now()-begin>=maxDirectedDurationMs;
  try{
   const waitStart=performance.now();
   while(busy&&!stop())await new Promise(resolve=>setTimeout(resolve,1));
   stats.directedWaitMs+=performance.now()-waitStart;
   if(stop())return {status:'pending',reason:'directed_budget'};
   if(accounts.some(account=>yahoo(account)&&!contexts.some(context=>context.account.id===account.id&&complete(context,now()))))return {status:'pending',reason:'complete_owned_index_required'};
   const context=contexts.find(context=>context.account.id===planned?.accountId),item=context?.activeItems.find(value=>value.id===planned?.id);
   const profileCard=context?.profileDiscovery?.profileObservation?.cards.find(value=>value.id===item?.id);
   if(!item||!profileCard||!recall?.id||!isRecallCurrent({item:planned,recall}))return {status:'pending',reason:'current_target_binding_required'};
   const current={...item,accountId:context.account.id,platform:item.platform||context.account.platform};
   // A fresh attempted verification cannot fall back to an earlier accepted
   // row after a current refusal, missing image, or local timeout.
   forgetPair(current,recall.id);
   stats.directedAttempts++;
   const result=await verifySharedYahooDetailPair({item:current,profileCard,recall,settings:lastSettings,
    peekBundle,peekFingerprint,startedAt,deadlineAt,now,remainingMs:()=>maxDirectedDurationMs-directedSpent-(performance.now()-begin),stopLocal:stop});
   if(stop())return {status:'pending',reason:'directed_budget'};
   if(result.status==='verified_single_offer'){
    commitVerified(current,recall,result);
    // Apply current negative evidence before exposing even a newly accepted row.
    if(!currentOffers(current).some(row=>row.id===result.offer.id))return {status:'pending',reason:'changed_source_evidence'};
    stats.directedVerified++;
   }
   if(result.status==='rejected')count('directedStrictRejectionReasons',sharedStrictReason(result.reason));
   return result;
  }catch{reason('directed_verification_unavailable');return {status:'pending',reason:'directed_verification_unavailable'};}
  finally{directedSpent+=Math.max(0,performance.now()-begin);stats.directedDurationMs=directedSpent;directedBusy=false;}
 }

 async function consume(settings={}){
  if(typeof peekFingerprintState!=='function'){reason('cache_metadata_required');return;}
  if(lastSettings)lastSettings={...lastSettings,matchCorrections:settings.matchCorrections||{},ownedOffers:settings.ownedOffers||lastSettings.ownedOffers};
  // Revocation is a cache metadata check, not new verification. It must run even
  // when pass/pair/time quotas prohibit more local comparison work.
  try{revokeKnownChanges();}catch{withdraw([...offers.values()].flat(),'negative_guard_unavailable');offers.clear();stats.verifiedTargets=0;stats.failures++;}
  if(busy||directedBusy||stats.passes>=maxPasses||spent>=maxDurationMs||stats.attemptedPairs>=maxPairs||now()-lastPass<minPassGapMs)return;
  if(now()>=deadlineAt){stats.deadlineStops++;return;}
  busy=true;const begin=clock(),stop=()=>now()>=deadlineAt||clock()-begin+spent>=maxDurationMs;
  try{
   const current=now(),all=accounts.map(account=>contexts.find(context=>context.account.id===account.id));

   if(all.some(context=>!context)||!all.filter(context=>yahoo(context.account)).every(context=>complete(context,current))){reason('complete_owned_index_required');return;}
   const observed=snapshot();if(!observed?.pages?.length)return;
   stats.passes++;lastPass=current;
   const owned=buildOwnedOffers(accounts,all.flatMap(context=>[...(context.previousItems||[]),...context.activeItems,
    ...(context.profileDiscovery?.profileObservation?.membershipIds||[]).map(id=>({id,platform:context.account.platform,sellerId:context.account.sellerId}))]));
   for(const [platform,group] of Object.entries(settings.ownedOffers||{}))for(const field of ['items','sellers'])
    if(group?.[field] instanceof Set)for(const value of group[field])owned[platform]?.[field].add(value);
   const strictSettings={...settings,ownedOffers:owned,ownedOffersComplete:true};lastSettings=strictSettings;
   const targets=all.filter(context=>yahoo(context.account)).flatMap(context=>{
    const cards=new Map(context.profileDiscovery.profileObservation.cards.map(card=>[card.id,card]));
    return context.activeItems.map(item=>({...item,accountId:context.account.id,platform:item.platform||context.account.platform,profileCard:cards.get(item.id)}));
   });
   if(stop()){stats.deadlineStops++;return;}
   const mapping=mapYahooPoolToTargets({snapshot:observed,targets,settings:strictSettings,now:current,
    maximumTargetObservationVisits:2_000_000,maximumIndexedWorkUnits:20_000_000,continueMapping:()=>!stop()});
   try{onMapping?.(mapping,{targets,strictSettings});}catch{stats.mappingObserverFailures++;}
   if(mapping.mappingStopped)stats.mappingStops++;
   stats.mappedPairs+=mapping.targetCandidatePairs;
   const byKey=new Map(targets.map(item=>[key(item),item]));
   // New source evidence or missing current prerequisites revoke earlier local
   // offers. An older successful pair is never a fallback after a later refusal.
   for(const [targetKey,rows] of offers){
    const item=byKey.get(targetKey),own=item&&peekBundle(item.id),keep=[];
    for(const row of rows){
     const candidate=peekBundle(row.id);
     let valid=item&&own&&candidate&&currentSharedYahooOffers({...item,sharedYahooOffers:[row]},
      {ownershipIndex:owned,corrections:settings.matchCorrections||{},now:current}).length===1&&
      row.ownSource.parsedSha256===own.originalObservation?.parsedSha256&&row.candidateSource.parsedSha256===candidate.originalObservation?.parsedSha256;
     let retained=null,withdrawalReason='duplicate_validation_unavailable';
     if(valid)for(const image of row.imageEvidence){
      if(stop()){retained=retainAfterInterruption(item,row);valid=Boolean(retained);withdrawalReason='interruption_guard_unavailable';break;}
      // A settled null/error is missing evidence and still revokes. Only the
      // outer null means this optional wait was interrupted or timed out.
      const settled=await boundedSharedPeek(async()=>{try{return {value:await peekFingerprint(image.url,{deadlineAt,now})}}catch{return {value:null}}},
       {remainingMs:()=>maxDurationMs-spent-(clock()-begin),stopped:stop});
      if(!settled){retained=retainAfterInterruption(item,row);valid=Boolean(retained);withdrawalReason='interruption_guard_unavailable';break;}
      const original=settled.value;
      if(!original){withdrawalReason='duplicate_image_missing';valid=false;break;}
      if(original.url!==image.url){withdrawalReason='duplicate_image_binding_changed';valid=false;break;}
      if(original.contentSha256!==image.contentSha256){withdrawalReason='duplicate_image_bytes_changed';valid=false;break;}
      // A newer observation of identical bytes supports the original image; it
      // does not renew the accepted product, image, or identity clocks.
      if(!consistentImageClock(original.imageObservedAt,image.imageObservedAt,now())){withdrawalReason='duplicate_image_observation_changed';valid=false;break;}
      if(!Number.isFinite(original.imageCacheExpiresAt)||original.imageCacheExpiresAt<=now()){withdrawalReason='duplicate_image_expired';valid=false;break;}
     }
     if(valid)keep.push(retained||row);
     else {
      withdraw([row],withdrawalReason);
      // A settled missing/changed peek is already known evidence. Remove it
      // before awaiting another row so concurrent output cannot expose it.
      const remaining=(offers.get(targetKey)||[]).filter(value=>evidenceRevision(value)!==evidenceRevision(row));
      if(remaining.length)offers.set(targetKey,remaining);else offers.delete(targetKey);
      for(const pair of completed)if(pair.startsWith(`${targetKey}:${row.id}:`))completed.delete(pair);
     }
    }
    // Every await above lets another output guard revoke a row. Commit only
    // revisions that are still accepted after all row peeks have settled; never
    // resurrect a loop-local row even if its old metadata later becomes visible.
    const currentRows=new Map(currentOffers(item).map(row=>[evidenceRevision(row),row]));
    const committing=keep.flatMap(row=>{const currentRow=currentRows.get(evidenceRevision(row));
     if(currentRow)return [currentRow];withdraw([row],'accepted_revision_no_longer_current');return [];});
    if(committing.length)offers.set(targetKey,committing);else offers.delete(targetKey);
   }
   stats.verifiedTargets=offers.size;
   // Lower listed price is only a read-value preference; unknowns are retained.
   const pairs=mapping.rows.flatMap(row=>row.candidates.map(recall=>({item:byKey.get(row.targetKey),recall})))
    .sort((a,b)=>(a.recall.lowerListedPrice===true?0:a.recall.lowerListedPrice===null?1:2)-(b.recall.lowerListedPrice===true?0:b.recall.lowerListedPrice===null?1:2));
   for(const {item,recall} of pairs){
    if(stop()||stats.attemptedPairs>=maxPairs){stats.deadlineStops++;break;}
    const own=peekBundle(item.id),candidate=peekBundle(recall.id);
    if(!own||!candidate){stats.missingOriginalPairs++;continue;}
    stats.bodyReadyPairs++;
    const pair=pairKey(item,recall.id,own.originalObservation,candidate.originalObservation);
    if(completed.has(pair))continue;
    const prior=offers.get(key(item));if(prior){withdraw(prior.filter(row=>row.id===recall.id),'strict_revalidation_started');const keep=prior.filter(row=>row.id!==recall.id);if(keep.length)offers.set(key(item),keep);else offers.delete(key(item));}
    stats.attemptedPairs++;
    const result=await verifySharedYahooDetailPair({item,profileCard:item.profileCard,recall,settings:strictSettings,
     peekBundle,peekFingerprint,startedAt,deadlineAt,now,remainingMs:()=>maxDurationMs-spent-(clock()-begin),stopLocal:stop});
    if(stop()){stats.deadlineStops++;break;}
    if(result.status==='verified_single_offer'){
     completed.add(pair);commitVerified(item,recall,result);
    }else if(result.status==='rejected'){completed.add(pair);stats.rejectedPairs++;reason('strict_rejected');count('strictRejectionReasons',sharedStrictReason(result.reason));}
    else{stats.pendingPairs++;reason(['image_evidence_unavailable','source_deadline','current_target_binding_required','own_terms_changed_or_missing','excluded_offer'].includes(result.reason)?result.reason:'source_evidence_unavailable');}
   }
  }catch{stats.failures++;reason('shared_detail_consumer_unavailable');}
  finally{stats.verifiedTargets=offers.size;spent+=Math.max(0,clock()-begin);stats.localDurationMs=spent;busy=false;}
 }
 return Object.freeze({consume,directedAvailable,isRecallCurrent,verifyPlannedPair,offersFor:item=>{try{return currentOffers(item)}catch{withdraw(offers.get(key(item)),'negative_guard_unavailable');offers.delete(key(item));stats.failures++;return []}},statistics:()=>{try{revokeKnownChanges()}catch{withdraw([...offers.values()].flat(),'negative_guard_unavailable');offers.clear();stats.verifiedTargets=0;stats.failures++}return structuredClone({...stats,activeVerifiedOffers:[...offers.values()].reduce((sum,rows)=>sum+rows.length,0)})}});
}
