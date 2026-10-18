import {createHash} from 'node:crypto';
import {MATCHING_RULES_VERSION} from './rules.mjs';
import {isRequestDeferred,RequestDeferredError} from './request-cooldown.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim();
const image=value=>typeof value==='string'?value:value?.url||'';
const time=value=>{const n=Date.parse(value||'');return Number.isFinite(n)?n:0};
const cardKey=card=>hash([card.id,text(card.title),card.image||'',card.sellerId||'',Number(card.price)||null]);
const RETRY_MIN_MS=20*60_000,RETRY_MAX_MS=60*60_000;
const schedulingReasons=new Set(['physical_product_type_unconfirmed','sale_description_unavailable']);
// Checkpoints live only on a compare-private error, never a shared source hold.
// They contain ordering memory, not a partial result or accepted-offer evidence.
const deferredCheckpoints=new WeakMap();
const itemKey=item=>item?.accountId&&item?.id&&text(item?.title)?hash([
 MATCHING_RULES_VERSION,item.accountId,item.id,item.platform||'yahoo',text(item.title),
 item.sellerId||'',image(item.image),Number(item.ownPrice)||null
]):null;

export function withYahooSchedulingCheckpoint(error,queue){
 if(!isRequestDeferred(error))return error;
 try{
  const checkpoint=queue?.deferredSnapshot();
  if(!checkpoint)return error;
  const wrapped=new RequestDeferredError(error.reason,error.retryAt);
  // Keep the original hold, including indefinite deadlines and HTTP metadata.
  for(const field of ['message','httpStatus','retryAfter'])if(error[field]!==undefined)wrapped[field]=error[field];
  wrapped.cause=error;
  deferredCheckpoints.set(wrapped,structuredClone(checkpoint));
  return wrapped;
 }catch{return error;} // Checkpoint failure cannot replace or relax the deferral.
}

export function deferredYahooDetailQueue(error,item){
 const checkpoint=deferredCheckpoints.get(error);
 if(!checkpoint||!itemKey(item)||checkpoint.itemKey!==itemKey(item)||
  (item.itemStatus&&item.itemStatus!=='OPEN')||(item.sourceDetail&&
   (item.sourceDetail.status!=='OPEN'||yahooQueueOwnKey(item,item.sourceDetail)!==checkpoint.queue.ownKey)))return undefined;
 return structuredClone(checkpoint.queue);
}

// This identity binds queue order only. It never supplies current price or
// grants acceptance; every selected card still needs the normal full detail gate.
function ownKeyForRules(item={},detail,rulesVersion){
 if(!item.accountId||!item.id||!text(item.title)||detail?.id!==item.id||!detail?.description?.trim()||!text(detail.title)||!(detail.seller?.id||detail.sellerId)||!(detail.images||[]).some(image))return null;
 return hash([rulesVersion,item.accountId,item.id,item.platform||'yahoo',text(item.title),
  text(detail.title),text(detail.description),detail.condition||null,detail.seller?.id||detail.sellerId||'',
  (detail.images||[]).map(image),detail.category||null]);
}
export function yahooQueueOwnKey(item={},detail){
 return ownKeyForRules(item,detail,MATCHING_RULES_VERSION);
}

// Known-only quotes can advance independently from broad queue work. Legacy
// checkpoints may already use the current key while their fallback quote is
// still historical, so prove provenance from the current detail before tagging.
export function carryYahooDetailQueueVersion({item,detail,prior,priorRulesVersion}={}){
 if(!prior||Object.hasOwn(prior,'rulesVersion'))return prior;
 const ownKey=yahooQueueOwnKey(item,detail);
 if(!ownKey||detail?.status!=='OPEN')return prior;
 if(prior.ownKey===ownKey)return {...prior,rulesVersion:MATCHING_RULES_VERSION};
 if(Number.isSafeInteger(priorRulesVersion)&&priorRulesVersion>0&&priorRulesVersion<MATCHING_RULES_VERSION&&
  prior.ownKey===ownKeyForRules(item,detail,priorRulesVersion))return {...prior,rulesVersion:priorRulesVersion};
 return prior;
}

export function planYahooDetailQueue({item,detail,candidates=[],knownIds=new Set(),knownLimit=2,limit=8,prior,priorRulesVersion,geometryPriorityIds=new Set(),geometryOnlyIds=new Set(),now=Date.now()}={}){
 const ownKey=yahooQueueOwnKey(item,detail);
 // A rules upgrade invalidates accepted/inspected outcomes. Only completed
 // unresolved scheduling work may cross the version boundary.
 // Reconstruct the old key from the current complete OPEN own detail instead
 // of trusting a version label. Card keys and bounded retry rows still pass
 // the same validation below. No candidate or quote evidence is migrated.
 const explicitVersion=Object.hasOwn(prior||{},'rulesVersion'),priorVersion=explicitVersion?prior.rulesVersion:priorRulesVersion;
 const historical=ownKey&&detail?.status==='OPEN'&&Number.isSafeInteger(priorVersion)&&priorVersion>0&&priorVersion<MATCHING_RULES_VERSION&&
  prior?.ownKey===ownKeyForRules(item,detail,priorVersion);
 const currentIdentity=ownKey&&prior?.ownKey===ownKey&&(!explicitVersion||priorVersion===MATCHING_RULES_VERSION);
 const identityValid=currentIdentity||historical;
 const existing=currentIdentity?new Map((prior.attempts||[]).map(row=>[row.id,row])):new Map();
 const scheduled=identityValid?new Map((prior.schedulingAttempts||[]).map(row=>[row.id,row])):new Map();
 const rows=candidates.map((card,index)=>{
  const key=cardKey(card),old=existing.get(card.id),at=old?.key===key&&time(old.at)<=now+60_000?time(old.at):0;
  const retry=scheduled.get(card.id),retryAt=time(retry?.retryAt),attemptedAt=time(retry?.attemptedAt);
  const scheduling=retry?.key===key&&schedulingReasons.has(retry.reason)&&attemptedAt>0&&attemptedAt<=now+60_000&&
   retryAt>=attemptedAt&&retryAt<=attemptedAt+RETRY_MAX_MS&&Number.isSafeInteger(retry.count)&&retry.count>=1&&retry.count<=3?
   {id:card.id,key,reason:retry.reason,count:retry.count,attemptedAt:new Date(attemptedAt).toISOString(),retryAt:new Date(retryAt).toISOString()}:null;
  return {card,index,key,at,scheduling,orderAt:Math.max(at,time(scheduling?.attemptedAt))};
 });
 const remembered=new Map(rows.filter(row=>row.at).map(row=>[row.card.id,{id:row.card.id,key:row.key,at:new Date(row.at).toISOString()}]));
 const schedulingMemory=new Map(rows.filter(row=>row.scheduling).map(row=>[row.card.id,row.scheduling]));
 // A deferred comparison may retain only completed unresolved attempts. In
 // particular, record() below must not checkpoint newly accepted/inspected data.
 const checkpointItemKey=itemKey(item),checkpointAttempts=[...remembered.values()];
 const checkpointScheduling=new Map(schedulingMemory),schedulingUpdates=new Map();
 // These are completed transport attempts with unresolved identity, not inspected
 // or accepted offers. Keep them in the caller's recall/coverage set while giving
 // unseen cards room. Retry time is finite, and changed identity revokes it.
 const ready=rows.filter(row=>!row.scheduling||time(row.scheduling.retryAt)<=now);
 const normalReady=ready.filter(row=>!geometryOnlyIds.has(row.card.id));
 const known=normalReady.filter(row=>knownIds.has(row.card.id)).slice(0,Math.min(knownLimit,limit));
 const reserved=new Set(known.map(row=>row.card.id));
 const unknown=normalReady.filter(row=>!knownIds.has(row.card.id));
 // Keep the lowest retry-eligible unknown candidate, even if it was wrong last
 // cycle. A newly cheaper or changed card has no scheduling penalty.
 const low=unknown.length&&known.length<limit?[unknown[0]]:[];
 low.forEach(row=>reserved.add(row.card.id));
 // One existing slot retries the oldest due unresolved response, even while new
 // cards keep arriving. It cannot monopolize the remaining discovery slots.
 const retry=reserved.size<limit?normalReady.filter(row=>row.scheduling&&!reserved.has(row.card.id))
  .sort((a,b)=>time(a.scheduling.retryAt)-time(b.scheduling.retryAt)||a.index-b.index).slice(0,1):[];
 retry.forEach(row=>reserved.add(row.card.id));
 // At most one existing slot may use geometry, after known/lowest/due retry.
 // Keep at least one slot for the original uninspected/unknown exploration.
 const geometry=reserved.size+1<limit?ready.filter(row=>!reserved.has(row.card.id)&&!knownIds.has(row.card.id)&&geometryPriorityIds.has(row.card.id)).slice(0,1):[];
 geometry.forEach(row=>reserved.add(row.card.id));
 const rest=normalReady.filter(row=>!reserved.has(row.card.id)).sort((a,b)=>
  Number(knownIds.has(a.card.id))-Number(knownIds.has(b.card.id))||a.orderAt-b.orderAt||a.index-b.index);
 const ordered=[...known,...low,...retry,...geometry,...rest];
 const attempts=[],schedulingSelections=[];
 return {
  cards:ordered.map(row=>row.card),
  geometryPriorityCount:geometry.length,
  deferredCount:rows.length-ready.length,
  record(card,attemptedAt=new Date().toISOString()){
   const row=rows.find(value=>value.card.id===card.id);if(!row)return;
   const stamp=time(attemptedAt);if(!stamp)return;
   attempts.push(card.id);remembered.set(card.id,{id:card.id,key:row.key,at:new Date(stamp).toISOString()});schedulingMemory.delete(card.id);
  },
  recordSchedulingAttempt(card,reason,attemptedAt=new Date().toISOString()){
   const row=rows.find(value=>value.card.id===card.id),stamp=time(attemptedAt);
   if(!row||!stamp||!schedulingReasons.has(reason))return;
   const previous=schedulingMemory.get(card.id),previousCount=Number.isSafeInteger(previous?.count)&&previous.count>0?previous.count:0;
   const count=previous?.reason===reason?Math.min(3,previousCount+1):1;
   const delay=reason==='physical_product_type_unconfirmed'?RETRY_MAX_MS:Math.min(RETRY_MAX_MS,RETRY_MIN_MS*2**(count-1));
   schedulingSelections.push(card.id);
   const value={id:card.id,key:row.key,reason,count,attemptedAt:new Date(stamp).toISOString(),retryAt:new Date(stamp+delay).toISOString()};
   schedulingMemory.set(card.id,value);schedulingUpdates.set(card.id,value);
  },
  deferredSnapshot(){
   if(!ownKey||!checkpointItemKey||detail?.status!=='OPEN'||!schedulingUpdates.size)return undefined;
   return {itemKey:checkpointItemKey,queue:{ownKey,rulesVersion:MATCHING_RULES_VERSION,attempts:checkpointAttempts,lastSelection:[],
    schedulingAttempts:[...new Map([...checkpointScheduling,...schedulingUpdates]).values()],
    lastSchedulingSelection:[...schedulingUpdates.keys()],remaining:rows.length}};
  },
  snapshot(){
   if(!ownKey)return undefined;
   // Retain only current recalled candidates. No stale global blacklist grows.
   return {ownKey,rulesVersion:MATCHING_RULES_VERSION,attempts:[...remembered.values()],lastSelection:attempts,
    schedulingAttempts:[...schedulingMemory.values()],lastSchedulingSelection:schedulingSelections,
    remaining:Math.max(0,rows.length-new Set([...attempts,...schedulingSelections]).size)};
  }
 };
}
