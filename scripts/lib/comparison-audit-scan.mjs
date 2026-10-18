import {normalizeOfferPlatform} from '../../public/owned-offers.js';
import {claimComparisonAudit,createComparisonAuditController,comparisonAuditMarker} from './comparison-audit-control.mjs';
import {openComparisonAuditState,prepareComparisonAuditState} from './comparison-audit-state.mjs';
import {RequestDeferredError} from './request-cooldown.mjs';
import {runYahooComparisonAudit} from './yahoo-comparison-audit-runner.mjs';

const origin='https://paypayfleamarket.yahoo.co.jp',unique=rows=>[...new Set(rows.filter(value=>typeof value==='string'&&value))];
const assert=(condition,reason)=>{if(!condition)throw Error(reason)};
export function comparisonAuditRequested(activation,event={}){
 const message=event.head_commit?.message||'';
 return activation?.enabled===true&&typeof activation.requestId==='string'&&message.includes(comparisonAuditMarker(activation.requestId));
}
// Configured profile ownership and retained private inventory are exclusion
// evidence. Their provenance is the restored state, never a fresh market quote.
export function configuredAuditOwnership({accounts,previous,sourceStateId}){
 const observedAt=previous?.checkedAt;
 assert(Number.isFinite(Date.parse(observedAt)),'Restored ownership provenance time required');
 const rows=accounts.filter(account=>normalizeOfferPlatform(account.platform,account.profileUrl)==='yahoo').map(account=>{
  const url=new URL(account.profileUrl);
  assert(url.origin===origin&&/^\/user\/p\d+$/.test(url.pathname)&&!url.search&&!url.hash&&!url.username&&!url.password,'Invalid configured Yahoo seller binding');
  const saved=[...(previous.items||[]),...Object.values(previous.listingHistory||{})].filter(item=>item.accountId===account.id);
  return {accountId:account.id,platform:'yahoo',sellerBindingVerified:true,
   sellerIds:unique([url.pathname.split('/').at(-1),account.sellerId,...saved.flatMap(item=>[item.sellerId,item.sourceDetail?.sellerId,item.sourceDetail?.seller?.id])]),
   listingIds:unique(saved.map(item=>item.id)),provenance:[{source:'restored_configured_profile_and_owned_history',sourceStateId,observedAt}]};
 });
 assert(rows.length>0,'All configured Yahoo ownership accounts required');
 return {version:1,sourceStateId,accounts:rows};
}
export function comparisonAuditTransportHooks(controller){
 let sequence=0;
 return {
  beforeYahooTransport({url,purpose,accountId,targetId}){
   const source=new URL(url);assert(source.origin===origin,'Unexpected audit source');
   let request;
   if(/^\/user\/p\d+$/.test(source.pathname))request={kind:'profile',accountId};
   else if(/^\/item\/[^/]+$/.test(source.pathname)&&purpose==='own')request={kind:'own'};
   else if(/^\/item\/[^/]+$/.test(source.pathname)&&['known','candidate'].includes(purpose))request={kind:purpose==='known'?'known':'detail',targetId,candidateId:source.pathname.split('/').at(-1)};
   else throw new RequestDeferredError('comparison_audit_unplanned_source');
   const reservation=controller.reservePageFetch({...request,transportId:`transport-${++sequence}`});
   if(!reservation.admitted)throw new RequestDeferredError(reservation.reason,Infinity);
   return reservation;
  },
  afterYahooTransport({reservation,httpStatus,completed,transportStarted,decodedBodyBytes,observedAt}){
   assert(reservation?.admitted===true,'Audit transport has no reservation');
   const outcome=!transportStarted?'cancelled':[401,403,429].includes(httpStatus)?'denied':completed?'ok':'failed';
   return controller.finishPageFetch({reservationId:reservation.reservationId,outcome,transportStarted,bytes:decodedBodyBytes,
    ...(completed&&outcome==='ok'?{observedAt}:{})});
  }
 };
}
export async function openScanComparisonAudit({root,password,activation,legacyStateCodeShas,previous,accounts,startedAt,context,now=Date.now}){
 const stateOptions={root,password,writerLockHeld:context.writerLockHeld===true,runKey:`${context.runId}:${context.runAttempt}`,codeSha:context.codeSha,startedAt,now};
 if(activation.enabled===false){
  const prepared=await prepareComparisonAuditState({...stateOptions,activation,legacyStateCodeShas});
  return {active:false,prepared:true,receipt:prepared.receipt};
 }
 const state=await openComparisonAuditState(stateOptions);
 const claim=await claimComparisonAudit({activation,context:{...context,startedAt},receipt:state.receipt,consumeReceipt:state.consumeReceipt,now});
 assert(claim.active,`Comparison audit blocked: ${claim.reason}`);
 const configuredOwnership=configuredAuditOwnership({accounts,previous,sourceStateId:state.sourceStateId});
 const targetIds=activation.targets.map(row=>row.itemId);
 const controller=createComparisonAuditController({claim,configuredOwnership,expectedAccountIds:configuredOwnership.accounts.map(row=>row.accountId),sourceStateId:state.sourceStateId,targetIds,now});
 return {active:true,state,controller,configuredOwnership,settings:{...comparisonAuditTransportHooks(controller),attempts:1,yahooComparisonAudit:true,signal:controller.signal,yahooRequestDeadline:Date.parse(claim.audit.deadlineAt)}};
}
// Uses current raw profile receipts, not seller fallback or old descriptions.
export function currentAuditOwnership(session,contexts,now=Date.now()){
 const snapshot=session.controller.snapshot();
 const accounts=session.configuredOwnership.accounts.map(saved=>{
  const context=contexts.find(row=>row.account.id===saved.accountId),observed=context?.profileDiscovery?.profileObservation;
  assert(context?.profileStatus==='live'&&observed?.complete===true&&observed.enumerationComplete===true&&observed.ownershipConflictCount===0,'Complete current Yahoo profile membership required');
  const requests=snapshot.requests.filter(row=>row.kind==='profile'&&row.accountId===saved.accountId);
  assert(requests.length===observed.pageObservations.length&&requests.every(row=>row.outcome==='ok'&&row.transportStarted),'Every current profile page must be counted');
  return {...saved,complete:true,listingIds:unique([...saved.listingIds,...observed.membershipIds]),
   profile:{complete:true,observedAt:observed.observedAt,reservationIds:requests.map(row=>row.reservationId)}};
 });
 const index={version:1,complete:true,sourceStateId:session.configuredOwnership.sourceStateId,verifiedAt:new Date(now).toISOString(),accounts};
 session.controller.setOwnershipIndex(index);return index;
}
export async function executeScanComparisonAudit({session,activation,contexts,settings,readBundle,imageFingerprints,now=Date.now}){
 const targets=[],ownershipIndex=currentAuditOwnership(session,contexts,now());
 for(const target of activation.targets){
  const context=contexts.find(row=>row.account.id===target.accountId),item=context?.activeItems.find(row=>row.id===target.itemId);
  assert(item&&item.itemStatus==='OPEN','Audit target must be currently OPEN in its exact account');
  const bundle=await readBundle(item.id,{...settings,yahooRequestPurpose:'own',yahooRequestAccountId:context.account.id});
  targets.push({item:{...item,platform:'yahoo',accountId:context.account.id},ownBundle:bundle,knownCandidateIds:target.knownCandidateIds||[]});
 }
 return runYahooComparisonAudit({controller:session.controller,ownershipIndex,targets,settings,now,readDetail:readBundle,
  imageFingerprints:(url,options)=>imageFingerprints(url,{...options,stopOnAccessDenial:true,auditTransport:true})});
}
