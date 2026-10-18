import {performance} from 'node:perf_hooks';
import {mapYahooPoolToTargets} from './yahoo-page-observation-pool.mjs';
import {verifySharedYahooDetailPair,boundedSharedPeek} from './yahoo-shared-detail-consumer.mjs';
import {sharedYahooTargetBinding,currentSharedYahooOffers} from '../../public/shared-yahoo-offers.js';
import {buildOwnedOffers,normalizeOfferPlatform,isOwnedOffer} from '../../public/owned-offers.js';

const yahoo=value=>normalizeOfferPlatform(value.platform,value.profileUrl)==='yahoo';
const key=value=>`${value.accountId}:${value.id}`;
// A bounded local consumer of completed reads. It cannot request a body/image,
// extend source deadlines, change normal scheduling, or insert pricing candidates.
export function createSharedYahooDetailRuntime({startedAt,deadlineAt,accounts,contexts,snapshot,peekBundle,peekFingerprint,
 peekOriginalReceipt=id=>peekBundle(id)?.originalObservation,peekFingerprintState=null,observationVersion=null,onMapping=null,now=Date.now,clock=performance.now.bind(performance),maxPasses=3,maxPairs=32,maxDurationMs=1000,minPassGapMs=120000,
 maxDirectedPairs=6,maxDirectedDurationMs=1000}={}){
 for(const [value,max] of [[maxPasses,3],[maxPairs,32],[maxDurationMs,1000],[minPassGapMs,120000],[maxDirectedPairs,6],[maxDirectedDurationMs,1000]])
  if(!Number.isSafeInteger(value)||value<0||value>max)throw Error('invalid_shared_detail_bound');
 const offers=new Map(),completed=new Set(),recallBindings=new Map();let recallVersion,recallIndex=null;let busy=false,lastPass=-Infinity,spent=0,lastSettings=null,directedBusy=false,directedSpent=0;
 const stats={version:1,scope:'current_shared_detail_pairs_only',passes:0,mappedPairs:0,bodyReadyPairs:0,attemptedPairs:0,verifiedPairs:0,verifiedTargets:0,
  missingOriginalPairs:0,pendingPairs:0,rejectedPairs:0,failures:0,deadlineStops:0,mappingStops:0,localDurationMs:0,negativeSnapshotBuilds:0,negativeValidationDurationMs:0,htmlRequests:0,imageRequests:0,
  directedAttempts:0,directedVerified:0,directedDurationMs:0,directedWaitMs:0,mappingObserverFailures:0,
  completeComparisons:0,canRecommend:false,reasons:{}};
 const reason=value=>{stats.reasons[value]=(stats.reasons[value]||0)+1;};
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
 function contradicted(row,index,targetKey){
  const rows=(index.get(row.id)||[]).filter(value=>value.observedAt<=now()&&value.expiresAt>now());
  if(!rows.length)return false; // Absence/expiry of recall is not contrary detail evidence.
  if(rows.some(value=>isOwnedOffer(lastSettings.ownedOffers,'yahoo',value.card)))return true;
  if(new Set(rows.map(({card})=>cardTuple(card))).size>1)return true;
  const original=recallBindings.get(`${targetKey}:${row.id}`);if(!original)return true;
  return rows.some(({card,observedAt})=>observedAt>Date.parse(row.checkedAt)&&cardTuple(card)!==original);
 }
 function currentOffers(item){
  const begin=performance.now();try{return checkedCurrentOffers(item)}finally{stats.negativeValidationDurationMs+=Math.max(0,performance.now()-begin);}
 }
 function checkedCurrentOffers(item){
  if(!item||!lastSettings)return [];
  if(accounts.some(account=>yahoo(account)&&!contexts.some(context=>context.account.id===account.id&&complete(context,now())))){offers.clear();stats.verifiedTargets=0;return [];}
  const targetKey=key(item),own=peekOriginalReceipt(item.id),rows=offers.get(targetKey)||[];
  if(!rows.length)return [];const negative=negativeRecallIndex();
  const keep=currentSharedYahooOffers({...item,sharedYahooOffers:rows},{ownershipIndex:lastSettings.ownedOffers,corrections:lastSettings.matchCorrections||{},now:now()})
   .filter(row=>{const candidate=peekOriginalReceipt(row.id);return !contradicted(row,negative,targetKey)&&own&&candidate&&own.parsedSha256===row.ownSource.parsedSha256&&candidate.parsedSha256===row.candidateSource.parsedSha256&&
    (typeof peekFingerprintState==='function'&&row.imageEvidence.every(image=>{const latest=peekFingerprintState(image.url);return latest?.status==='available'&&latest.contentSha256===image.contentSha256&&Date.parse(latest.imageObservedAt)>=Date.parse(image.imageObservedAt)&&latest.imageCacheExpiresAt>now();}));})
   .map(row=>({...row,imageEvidence:row.imageEvidence.map(image=>({...image,imageCacheExpiresAt:Math.min(image.imageCacheExpiresAt,peekFingerprintState(image.url).imageCacheExpiresAt)}))}));
  if(keep.length)offers.set(targetKey,keep);else offers.delete(targetKey);
  for(const row of rows)if(!keep.some(value=>value.id===row.id))for(const pair of completed)if(pair.startsWith(`${targetKey}:${row.id}:`))completed.delete(pair);
  stats.verifiedTargets=offers.size;
  return structuredClone(keep);
 }
 function revokeKnownChanges(){
  for(const targetKey of [...offers.keys()]){
   const item=contexts.flatMap(context=>context.activeItems).find(item=>key(item)===targetKey);
   if(item)currentOffers(item);else offers.delete(targetKey);
  }
  stats.verifiedTargets=offers.size;
 }

 const pairKey=(item,id,own,candidate)=>`${key(item)}:${id}:${own?.parsedSha256}:${candidate?.parsedSha256}:${JSON.stringify(sharedYahooTargetBinding(item))}`;
 function forgetPair(item,id){
  const targetKey=key(item),prior=offers.get(targetKey);
  if(prior){const keep=prior.filter(row=>row.id!==id);if(keep.length)offers.set(targetKey,keep);else offers.delete(targetKey);}
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
   return result;
  }catch{reason('directed_verification_unavailable');return {status:'pending',reason:'directed_verification_unavailable'};}
  finally{directedSpent+=Math.max(0,performance.now()-begin);stats.directedDurationMs=directedSpent;directedBusy=false;}
 }

 async function consume(settings={}){
  if(typeof peekFingerprintState!=='function'){reason('cache_metadata_required');return;}
  if(lastSettings)lastSettings={...lastSettings,matchCorrections:settings.matchCorrections||{},ownedOffers:settings.ownedOffers||lastSettings.ownedOffers};
  // Revocation is a cache metadata check, not new verification. It must run even
  // when pass/pair/time quotas prohibit more local comparison work.
  try{revokeKnownChanges();}catch{offers.clear();stats.verifiedTargets=0;stats.failures++;}
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
     if(valid)for(const image of row.imageEvidence){
      if(stop()){valid=false;break;}
      const original=await boundedSharedPeek(()=>peekFingerprint(image.url,{deadlineAt,now}),{remainingMs:()=>maxDurationMs-spent-(clock()-begin),stopped:stop});
      if(!original||original.contentSha256!==image.contentSha256||original.imageObservedAt!==image.imageObservedAt||original.imageCacheExpiresAt<=now()){valid=false;break;}
     }
     if(valid)keep.push(row);
     else for(const pair of completed)if(pair.startsWith(`${targetKey}:${row.id}:`))completed.delete(pair);
    }
    if(keep.length)offers.set(targetKey,keep);else offers.delete(targetKey);
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
    const prior=offers.get(key(item));if(prior){const keep=prior.filter(row=>row.id!==recall.id);if(keep.length)offers.set(key(item),keep);else offers.delete(key(item));}
    stats.attemptedPairs++;
    const result=await verifySharedYahooDetailPair({item,profileCard:item.profileCard,recall,settings:strictSettings,
     peekBundle,peekFingerprint,startedAt,deadlineAt,now,remainingMs:()=>maxDurationMs-spent-(clock()-begin),stopLocal:stop});
    if(stop()){stats.deadlineStops++;break;}
    if(result.status==='verified_single_offer'){
     completed.add(pair);commitVerified(item,recall,result);
    }else if(result.status==='rejected'){completed.add(pair);stats.rejectedPairs++;reason('strict_rejected');}
    else{stats.pendingPairs++;reason(['image_evidence_unavailable','source_deadline','current_target_binding_required','own_terms_changed_or_missing','excluded_offer'].includes(result.reason)?result.reason:'source_evidence_unavailable');}
   }
  }catch{stats.failures++;reason('shared_detail_consumer_unavailable');}
  finally{stats.verifiedTargets=offers.size;spent+=Math.max(0,clock()-begin);stats.localDurationMs=spent;busy=false;}
 }
 return Object.freeze({consume,directedAvailable,isRecallCurrent,verifyPlannedPair,offersFor:item=>{try{return currentOffers(item)}catch{offers.delete(key(item));stats.failures++;return []}},statistics:()=>{try{revokeKnownChanges()}catch{offers.clear();stats.verifiedTargets=0;stats.failures++}return structuredClone({...stats,activeVerifiedOffers:[...offers.values()].reduce((sum,rows)=>sum+rows.length,0)})}});
}
