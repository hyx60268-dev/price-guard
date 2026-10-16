import {createHash} from 'node:crypto';
import {MATCHING_RULES_VERSION} from './rules.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim();
const image=value=>typeof value==='string'?value:value?.url||'';
const time=value=>{const n=Date.parse(value||'');return Number.isFinite(n)?n:0};
const cardKey=card=>hash([card.id,text(card.title),card.image||'',card.sellerId||'',Number(card.price)||null]);
const RETRY_MIN_MS=20*60_000,RETRY_MAX_MS=60*60_000;
const schedulingReasons=new Set(['physical_product_type_unconfirmed','sale_description_unavailable']);

// This identity binds queue order only. It never supplies current price or
// grants acceptance; every selected card still needs the normal full detail gate.
export function yahooQueueOwnKey(item={},detail){
 if(!item.accountId||!item.id||!text(item.title)||detail?.id!==item.id||!detail?.description?.trim()||!text(detail.title)||!(detail.seller?.id||detail.sellerId)||!(detail.images||[]).some(image))return null;
 return hash([MATCHING_RULES_VERSION,item.accountId,item.id,item.platform||'yahoo',text(item.title),
  text(detail.title),text(detail.description),detail.condition||null,detail.seller?.id||detail.sellerId||'',
  (detail.images||[]).map(image),detail.category||null]);
}

export function planYahooDetailQueue({item,detail,candidates=[],knownIds=new Set(),knownLimit=2,limit=8,prior,now=Date.now()}={}){
 const ownKey=yahooQueueOwnKey(item,detail);
 const existing=ownKey&&prior?.ownKey===ownKey?new Map((prior.attempts||[]).map(row=>[row.id,row])):new Map();
 const scheduled=ownKey&&prior?.ownKey===ownKey?new Map((prior.schedulingAttempts||[]).map(row=>[row.id,row])):new Map();
 const rows=candidates.map((card,index)=>{
  const key=cardKey(card),old=existing.get(card.id),at=old?.key===key&&time(old.at)<=now+60_000?time(old.at):0;
  const retry=scheduled.get(card.id),retryAt=time(retry?.retryAt),attemptedAt=time(retry?.attemptedAt);
  const scheduling=retry?.key===key&&schedulingReasons.has(retry.reason)&&attemptedAt>0&&attemptedAt<=now+60_000&&
   retryAt>=attemptedAt&&retryAt<=attemptedAt+RETRY_MAX_MS?retry:null;
  return {card,index,key,at,scheduling,orderAt:Math.max(at,time(scheduling?.attemptedAt))};
 });
 const remembered=new Map(rows.filter(row=>row.at).map(row=>[row.card.id,{id:row.card.id,key:row.key,at:new Date(row.at).toISOString()}]));
 const schedulingMemory=new Map(rows.filter(row=>row.scheduling).map(row=>[row.card.id,row.scheduling]));
 // These are completed transport attempts with unresolved identity, not inspected
 // or accepted offers. Keep them in the caller's recall/coverage set while giving
 // unseen cards room. Retry time is finite, and changed identity revokes it.
 const ready=rows.filter(row=>!row.scheduling||time(row.scheduling.retryAt)<=now);
 const known=ready.filter(row=>knownIds.has(row.card.id)).slice(0,Math.min(knownLimit,limit));
 const reserved=new Set(known.map(row=>row.card.id));
 const unknown=ready.filter(row=>!knownIds.has(row.card.id));
 // Keep the lowest retry-eligible unknown candidate, even if it was wrong last
 // cycle. A newly cheaper or changed card has no scheduling penalty.
 const low=unknown.length&&known.length<limit?[unknown[0]]:[];
 low.forEach(row=>reserved.add(row.card.id));
 // One existing slot retries the oldest due unresolved response, even while new
 // cards keep arriving. It cannot monopolize the remaining discovery slots.
 const retry=reserved.size<limit?ready.filter(row=>row.scheduling&&!reserved.has(row.card.id))
  .sort((a,b)=>time(a.scheduling.retryAt)-time(b.scheduling.retryAt)||a.index-b.index).slice(0,1):[];
 retry.forEach(row=>reserved.add(row.card.id));
 const rest=ready.filter(row=>!reserved.has(row.card.id)).sort((a,b)=>
  Number(knownIds.has(a.card.id))-Number(knownIds.has(b.card.id))||a.orderAt-b.orderAt||a.index-b.index);
 const ordered=[...known,...low,...retry,...rest];
 const attempts=[],schedulingSelections=[];
 return {
  cards:ordered.map(row=>row.card),
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
   schedulingMemory.set(card.id,{id:card.id,key:row.key,reason,count,attemptedAt:new Date(stamp).toISOString(),retryAt:new Date(stamp+delay).toISOString()});
  },
  snapshot(){
   if(!ownKey)return undefined;
   // Retain only current recalled candidates. No stale global blacklist grows.
   return {ownKey,attempts:[...remembered.values()],lastSelection:attempts,
    schedulingAttempts:[...schedulingMemory.values()],lastSchedulingSelection:schedulingSelections,
    remaining:Math.max(0,rows.length-new Set([...attempts,...schedulingSelections]).size)};
  }
 };
}
