import {currentSharedYahooOffers,sharedYahooOffersMarkup} from '../../public/shared-yahoo-offers.js';
import {buildOwnedOffers,isOwnedOffer,normalizeOfferPlatform} from '../../public/owned-offers.js';
import {rejectedByMemory} from '../../public/match-memory.js';
import {pricingDecision} from '../../public/pricing-policy.js';
import {compactDashboardResult,scopeResultForPortalUser} from './publish.mjs';

// Counts only. These public revision pins identify one completed normal run.
// Never return listing IDs, titles, prices, URLs, users, passwords or raw errors.
export const SHARED_QUOTE_PUBLICATION=Object.freeze({
 codeSha:'97488762317715e5c16a405de19250b9c6544aed',
 snapshotAt:'2026-10-18T07:47:53.418Z',startedAt:'2026-10-18T07:35:50.639Z',
 publishedAt:'2026-10-18T07:49:15.089Z',expectedOutputOffers:9,expectedOutputTargets:9,
 ledgerRequestId:'lp-card-20261018-once-v1',ledgerSha:'1208088efe7c84dc1aa584f331aa0ee662b92b49',ledgerRunId:'39090203784',
});
const P=SHARED_QUOTE_PUBLICATION,plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const stamp=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x?Date.parse(x):NaN;
const key=item=>JSON.stringify([item.accountId,item.id]);
const pair=(item,id)=>JSON.stringify([item.accountId,item.id,id]);
const fail=reason=>{throw Object.assign(Error(reason),{summaryReason:reason});};
const need=(ok,reason)=>{if(!ok)fail(reason);};
const SAFE=new Set(['invalid_options','state_metadata_invalid','receipt_invalid','items_invalid','shared_count_mismatch','member_projection_invalid']);
export function summarizeSharedQuotePublication(state,{now=Date.now()}={}){
 try{
  need(Number.isFinite(now)&&now>=Date.parse(P.publishedAt),'invalid_options');
  need(plain(state)&&state.scanMeta?.codeSha===P.codeSha&&state.checkedAt===P.snapshotAt&&state.dataRevision===P.snapshotAt&&
   state.cycleCoverage?.startedAt===P.startedAt&&state.cycleCoverage?.finishedAt===P.snapshotAt&&state.scanMeta?.startedAt===P.startedAt,'state_metadata_invalid');
  const ledger=state.comparisonAuditReceipt,row=ledger?.consumed?.[0];
  need(ledger?.version===1&&ledger.revision===1&&Array.isArray(ledger.consumed)&&ledger.consumed.length===1&&
   row?.requestId===P.ledgerRequestId&&row.expectedSha===P.ledgerSha&&row.runId===P.ledgerRunId&&
   Number.isFinite(stamp(row.startedAt))&&Number.isFinite(stamp(row.consumedAt))&&Number.isFinite(stamp(row.deadlineAt))&&
   stamp(row.startedAt)<=stamp(row.consumedAt)&&stamp(row.consumedAt)<stamp(row.deadlineAt)&&stamp(row.deadlineAt)<=stamp(row.startedAt)+720000&&
   stamp(row.deadlineAt)<Date.parse(P.startedAt)&&state.comparisonAudit?.startedAt===row.startedAt&&state.comparisonAudit?.deadlineAt===row.deadlineAt,'receipt_invalid');
  need(Array.isArray(state.items)&&state.items.length<=20000&&Array.isArray(state.accounts)&&state.accounts.length<=100&&
   new Set(state.items.map(key)).size===state.items.length&&state.items.every(item=>plain(item)&&typeof item.accountId==='string'&&typeof item.id==='string'&&
    state.accounts.some(account=>account.id===item.accountId)&&(!item.sharedYahooOffers||Array.isArray(item.sharedYahooOffers)&&item.sharedYahooOffers.length<=32)&&
    (!item.yahoo?.candidates||Array.isArray(item.yahoo.candidates)&&item.yahoo.candidates.length<=256)),'items_invalid');
  const ownership=buildOwnedOffers([...(state.accounts||[]),...(state.managedAccounts||[])],[...state.items,...Object.values(state.listingHistory||{})]);
  const options=at=>({ownershipIndex:ownership,corrections:state.matchCorrections||{},now:at});
  const snapshot=Date.parse(P.snapshotAt),published=Date.parse(P.publishedAt),stored=new Set(),storedTargets=new Set(),usable=new Set(),ordinaryTargets=new Set();
  for(const item of state.items){
   if(normalizeOfferPlatform(item.platform)!=='yahoo')continue;
   for(const candidate of item.yahoo?.candidates||[]){
    if(typeof candidate?.id!=='string'||!candidate.id)continue;
    const id=pair(item,candidate.id);stored.add(id);storedTargets.add(key(item));
    if(!isOwnedOffer(ownership,'yahoo',candidate)&&!rejectedByMemory(state.matchCorrections||{},item,'yahoo',candidate)&&
      pricingDecision({...item,comparisonMode:'same_platform',yahoo:{...item.yahoo,candidates:[candidate]}},{now:snapshot}).lowest?.id===candidate.id){usable.add(id);ordinaryTargets.add(key(item));}
   }
  }
  const shared=new Set(),targets=new Set(),rawTargets=new Set(),nowPairs=new Set(),publishedPairs=new Set();let raw=0,lower=0,overlapStored=0,overlapUsable=0,newTarget=0,renderedAtPublication=0,renderedNow=0;
  for(const item of state.items){
   const list=item.sharedYahooOffers||[];raw+=list.length;if(list.length)rawTargets.add(key(item));
   for(const offer of currentSharedYahooOffers(item,options(snapshot))){const id=pair(item,offer.id);shared.add(id);targets.add(key(item));if(offer.price<item.ownPrice)lower++;if(stored.has(id))overlapStored++;if(usable.has(id))overlapUsable++;}
   for(const offer of currentSharedYahooOffers(item,options(published)))publishedPairs.add(pair(item,offer.id));
   for(const offer of currentSharedYahooOffers(item,options(now)))nowPairs.add(pair(item,offer.id));
   if(sharedYahooOffersMarkup(item,options(published)))renderedAtPublication++;
   if(sharedYahooOffersMarkup(item,options(now)))renderedNow++;
  }
  need(raw===P.expectedOutputOffers&&rawTargets.size===P.expectedOutputTargets&&state.scanMeta.sharedDetailSummary?.outputOffers===raw&&
   state.scanMeta.sharedDetailSummary?.outputOfferTargets===rawTargets.size,'shared_count_mismatch');
  for(const id of targets)if(!ordinaryTargets.has(id))newTarget++;
  const members=(state.portalUsers||[]).filter(user=>user?.enabled!==false);
  need(Array.isArray(state.portalUsers)&&members.length<=1000&&members.every(user=>plain(user)&&Array.isArray(user.accountIds)),'member_projection_invalid');
  const membersUnion=new Set();let memberInstances=0,memberCurrentInstances=0,memberRenderedSections=0;
  for(const user of members){
   const allowed=new Set(user.accountIds);
   for(const [at,current] of [[published,false],[now,true]]){
    // Mirror writeOutputs' global exclusion before narrowing member access.
    // A hidden managed account/history may own a seller the member cannot see.
    const globallyFiltered={...state,items:state.items.map(item=>({...item,sharedYahooOffers:currentSharedYahooOffers(item,options(at))}))};
    const scoped=scopeResultForPortalUser(globallyFiltered,user);
    need(scoped.items.every(item=>allowed.has(item.accountId)),'member_projection_invalid');
    const compact=compactDashboardResult(scoped,{now:at}),own=buildOwnedOffers([...(compact.accounts||[]),...(compact.managedAccounts||[])],compact.items||[]);
    for(const item of compact.items){const opts={ownershipIndex:own,corrections:compact.matchCorrections||{},now:at},rows=currentSharedYahooOffers(item,opts);
     if(current){memberCurrentInstances+=rows.length;continue;}
     memberInstances+=rows.length;for(const offer of rows)membersUnion.add(pair(item,offer.id));
     if(sharedYahooOffersMarkup(item,opts))memberRenderedSections++;
    }
   }
  }
  return {version:1,valid:true,countsOnly:true,readOnly:true,codeSha:P.codeSha,snapshotAt:P.snapshotAt,publishedAt:P.publishedAt,diagnosticAt:new Date(now).toISOString(),
   storedSharedOffers:raw,storedSharedTargets:rawTargets.size,validSharedPairsAtSnapshot:shared.size,validSharedTargetsAtSnapshot:targets.size,
   samePairAlreadyInOrdinaryStorage:overlapStored,pairsAbsentFromOrdinaryStorage:shared.size-overlapStored,
   samePairEligibleInOrdinaryPricingAtSnapshot:overlapUsable,pairsAdditionalToEligibleOrdinaryPricing:shared.size-overlapUsable,
   targetsWithoutAnyStoredOrdinaryCandidate:[...targets].filter(id=>!storedTargets.has(id)).length,
   targetsWithoutAnyEligibleOrdinaryQuoteAtSnapshot:newTarget,lowerListedSharedPairsAtSnapshot:lower,
   validSharedPairsAtPublication:publishedPairs.size,validSharedPairsAtDiagnostic:nowPairs.size,
   publicationValidButNoLongerCurrent:[...publishedPairs].filter(id=>!nowPairs.has(id)).length,
   rendererSectionsAtPublication:renderedAtPublication,rendererSectionsAtDiagnostic:renderedNow,
   memberProjection:{enabledMembers:members.length,publicationOfferInstances:memberInstances,publicationDistinctPairs:membersUnion.size,publicationRenderedSections:memberRenderedSections,currentOfferInstances:memberCurrentInstances,
    basis:'production_scope_compaction_and_renderer_replayed_from_pinned_full_state',memberEndpointRead:false,browserObserved:false},
   marketplaceRequests:0,stateWrites:0,completeComparisonIncrement:0,automaticPriceChanged:false};
 }catch(error){return {version:1,valid:false,reason:SAFE.has(error?.summaryReason)?error.summaryReason:'items_invalid'};}
}
