import {createHash} from 'node:crypto';
import {MATCHING_RULES_VERSION} from './rules.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim();
const image=value=>typeof value==='string'?value:value?.url||'';
const time=value=>{const n=Date.parse(value||'');return Number.isFinite(n)?n:0};
const cardKey=card=>hash([card.id,text(card.title),card.image||'',card.sellerId||'',Number(card.price)||null]);

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
 const rows=candidates.map((card,index)=>{
  const key=cardKey(card),old=existing.get(card.id),at=old?.key===key&&time(old.at)<=now+60_000?time(old.at):0;
  return {card,index,key,at};
 });
 const remembered=new Map(rows.filter(row=>row.at).map(row=>[row.card.id,{id:row.card.id,key:row.key,at:new Date(row.at).toISOString()}]));
 const known=rows.filter(row=>knownIds.has(row.card.id)).slice(0,Math.min(knownLimit,limit));
 const reserved=new Set(known.map(row=>row.card.id));
 const unknown=rows.filter(row=>!knownIds.has(row.card.id));
 // Always reread the current lowest new candidate, even if it was wrong last
 // cycle. Remaining slots advance unseen candidates, then oldest actual attempts.
 const low=unknown.length&&known.length<limit?[unknown[0]]:[];
 low.forEach(row=>reserved.add(row.card.id));
 const rest=rows.filter(row=>!reserved.has(row.card.id)).sort((a,b)=>
  Number(knownIds.has(a.card.id))-Number(knownIds.has(b.card.id))||a.at-b.at||a.index-b.index);
 const ordered=[...known,...low,...rest];
 const attempts=[];
 return {
  cards:ordered.map(row=>row.card),
  record(card,attemptedAt=new Date().toISOString()){
   const row=rows.find(value=>value.card.id===card.id);if(!row)return;
   const stamp=time(attemptedAt);if(!stamp)return;
   attempts.push(card.id);remembered.set(card.id,{id:card.id,key:row.key,at:new Date(stamp).toISOString()});
  },
  snapshot(){
   if(!ownKey)return undefined;
   // Retain only current recalled candidates. No stale global blacklist grows.
   return {ownKey,attempts:[...remembered.values()],lastSelection:attempts,
    remaining:Math.max(0,rows.length-attempts.length)};
  }
 };
}
