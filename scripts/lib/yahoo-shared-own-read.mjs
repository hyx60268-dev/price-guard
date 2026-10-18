import {performance} from 'node:perf_hooks';
import {sharedOwnTermsProblem} from './yahoo-shared-detail-consumer.mjs';

// One targeted own-body read, then bounded normal own-image processing. No
// search or competitor transport is available to this executor.
export function createSharedOwnReadExecutor({readOwn,peekBundle,fingerprint,candidateReadProblem,runtime,deadlineAt,now=Date.now,
 canRequest=()=>true,maxOwnImages=8}={}){
 if(![readOwn,peekBundle,fingerprint,candidateReadProblem,now,canRequest].every(value=>typeof value==='function')||!runtime||
  !Number.isFinite(deadlineAt)||!Number.isSafeInteger(maxOwnImages)||maxOwnImages<1||maxOwnImages>10)throw Error('invalid_shared_own_read');
 let stoppedByImageAccess=false;
 const stats={version:1,actions:0,rootReadCalls:0,rootReadWallMs:0,htmlRequests:0,originalsObtained:0,imageProcessingCalls:0,imageFetches:0,imageBytes:0,
  imageTransferDurationMs:0,imageUnknownBodyTransfers:0,actionWallMs:0,imageProcessingWallMs:0,verified:0,pending:0,rejected:0,failures:0,reasons:{}};
 const reason=value=>{stats.reasons[value]=(stats.reasons[value]||0)+1;};
 const available=()=>!stoppedByImageAccess&&now()<deadlineAt&&canRequest()&&runtime.directedAvailable();
 async function run(root){
  if(!available()||!runtime.isRecallCurrent(root)){reason('not_admitted');return {status:'pending',reason:'not_admitted'};}
  const begin=performance.now();stats.actions++;
  try{
   if(candidateReadProblem(root)){stats.pending++;reason('candidate_evidence_changed');return {status:'pending',reason:'candidate_evidence_changed'};}
   let own=peekBundle(root.item.id);
   if(!own){
    stats.rootReadCalls++;
    const readStart=performance.now();
    try{await readOwn(root.item.id,{purpose:'own',targetId:root.item.id,attempts:1,beforeYahooTransport:()=>{stats.htmlRequests++;}});}
    finally{stats.rootReadWallMs+=Math.max(0,performance.now()-readStart);}
    own=peekBundle(root.item.id);
   }
   if(!own||now()>=deadlineAt||!runtime.isRecallCurrent(root)){stats.pending++;reason('own_original_unavailable');return {status:'pending',reason:'own_original_unavailable'};}
   if(!canRequest()){stats.pending++;reason('source_no_longer_admissible');return {status:'pending',reason:'source_no_longer_admissible'};}
   stats.originalsObtained++;
   const ownProblem=sharedOwnTermsProblem(own,root.item);
   if(ownProblem){stats.pending++;reason(ownProblem);return {status:'pending',reason:ownProblem};}
   if(candidateReadProblem(root)){stats.pending++;reason('candidate_evidence_changed');return {status:'pending',reason:'candidate_evidence_changed'};}
   const images=[...new Set([...(own.detail?.images||[]).map(value=>typeof value==='string'?value:value?.url),own.detail?.thumbnailImageUrl].filter(Boolean))].slice(0,maxOwnImages);
   if(!images.length){stats.pending++;reason('own_images_unavailable');return {status:'pending',reason:'own_images_unavailable'};}
   // Sequential processing cannot increase the old per-comparison image
   // concurrency. The cache may legitimately turn these calls into zero GETs.
   const imageBegin=performance.now();
   try{for(const url of images){
    if(now()>=deadlineAt||stoppedByImageAccess||!canRequest()||candidateReadProblem(root))break;
    stats.imageProcessingCalls++;
    await fingerprint(url,{deadlineAt,now,stopOnAccessDenial:true,
     observeImageTransferStart:()=>{stats.imageFetches++;},
     observeImageTransfer:value=>{
      stats.imageBytes+=value.bytes;stats.imageTransferDurationMs+=value.durationMs;
      if(value.httpStatus>=200&&value.httpStatus<300&&value.bytes===0)stats.imageUnknownBodyTransfers++;
      if([401,403,429].includes(value.httpStatus)){stoppedByImageAccess=true;reason('image_access_denied');}
     }});
   }}finally{stats.imageProcessingWallMs+=performance.now()-imageBegin;}
   if(now()>=deadlineAt||stoppedByImageAccess){stats.pending++;reason('image_or_source_deadline');return {status:'pending',reason:'image_or_source_deadline'};}
   if(!canRequest()){stats.pending++;reason('source_no_longer_admissible');return {status:'pending',reason:'source_no_longer_admissible'};}
   if(candidateReadProblem(root)){stats.pending++;reason('candidate_evidence_changed');return {status:'pending',reason:'candidate_evidence_changed'};}
   const result=await runtime.verifyPlannedPair(root);
   if(result.status==='verified_single_offer')stats.verified++;
   else if(result.status==='rejected'){stats.rejected++;reason('strict_rejected');}
   else{stats.pending++;reason(['image_evidence_unavailable','own_terms_changed_or_missing','current_target_binding_required','source_deadline','directed_budget','changed_source_evidence'].includes(result.reason)?result.reason:'evidence_unavailable');}
   return result;
  }catch{stats.failures++;reason('shared_own_read_failed');return {status:'pending',reason:'shared_own_read_failed'};}
  finally{stats.actionWallMs+=performance.now()-begin;}
 }
 return Object.freeze({run,available,statistics:()=>structuredClone({...stats,imageAccessStopped:stoppedByImageAccess,
  completeComparisons:0,automaticPriceChanged:false,scope:'bounded_missing_own_body_actions'})});
}
