import { inferSize } from './rules.mjs';
import { normalizeProductIdentity } from './state.mjs';
import { verifiedCostEvidence,XIANYU_VERIFICATION } from './xianyu-evidence.mjs';

export function reconcileLiveItems(catalogItems=[],previousItems=[],liveItems=[],accountId='default',history=[]){
  const previous=new Map(previousItems.map(item=>[item.id,item]));
  const catalog=new Map(catalogItems.map(item=>[item.id,item]));
  const historic=[...previousItems,...catalogItems,...history.filter(item=>item.accountId===accountId)];
  const liveIds=new Set(liveItems.map(item=>item.id));
  const superseded=new Set(historic.map(item=>item.relistedFrom).filter(Boolean));
  const byTitle=new Map();
  for(const item of historic){
    if(superseded.has(item.id))continue;
    const key=normalizeProductIdentity(item.title||'');
    if(!key)continue;
    const values=byTitle.get(key)||[];
    if(!values.some(value=>value.id===item.id))values.push(item);
    byTitle.set(key,values);
  }
  const usedRelists=new Set();
  return liveItems.map((live,index)=>{
    const exactOld=previous.get(live.id)||{};
    const exactSaved=catalog.get(live.id)||{};
    let relisted={};
    if(!exactOld.id&&!exactSaved.id){
      const key=normalizeProductIdentity(live.title||'');
      const candidates=(byTitle.get(key)||[]).filter(item=>!liveIds.has(item.id)&&!usedRelists.has(item.id));
      // 同名商品が複数ある場合は誤った原価継承を避け、人工確認に回す。
      relisted=candidates.length===1?candidates[0]:{};
      if(relisted.id)usedRelists.add(relisted.id);
    }
    const old=exactOld.id?exactOld:relisted;
    const saved=exactSaved.id?exactSaved:relisted;
    return {
      ...old,
      ...saved,
      ...live,
      accountId,
      seq:index+1,
      xianyuQuery:saved.xianyuQuery??old.xianyuQuery??'',
      size:saved.size??old.size??inferSize(live.title),
      relistedFrom:relisted.id||old.relistedFrom||undefined
    };
  });
}

export function inventoryDelta(previousItems=[],activeItems=[]){
  const before=new Set(previousItems.map(item=>item.id));
  const after=new Set(activeItems.map(item=>item.id));
  const relisted=activeItems.filter(item=>!before.has(item.id)&&item.relistedFrom&&before.has(item.relistedFrom))
    .map(item=>({from:item.relistedFrom,to:item.id,title:item.title}));
  const relistedFrom=new Set(relisted.map(item=>item.from)),relistedTo=new Set(relisted.map(item=>item.to));
  return {
    added:[...after].filter(id=>!before.has(id)&&!relistedTo.has(id)),
    removed:[...before].filter(id=>!after.has(id)&&!relistedFrom.has(id)),
    relisted,
    unchanged:[...after].filter(id=>before.has(id)).length
  };
}

export function currentInventoryAdditions(delta={}){
  // relistedFrom survives for cost inheritance; only this refresh's delta earns priority.
  return new Set([...(delta.added||[]),...(delta.relisted||[]).map(item=>item.to)]);
}

export function parsePriceAuditItemIds(value=''){
  return new Set([...new Set(String(value).split(',').map(id=>id.trim()).filter(id=>/^[a-zA-Z0-9_-]{1,80}$/.test(id)))].slice(0,20));
}

export function prioritizePriceAuditItems(tasks=[],itemIds=new Set()){
  if(!itemIds.size)return tasks;
  const requested=[],remaining=[];
  for(const task of tasks)(itemIds.has(task.item?.id)?requested:remaining).push(task);
  return [...requested,...remaining];
}

export function comparisonAttemptTime(value={}){
  const times=[value?.lastAttemptAt,value?.checkedAt].map(value=>Date.parse(value||'')).filter(Number.isFinite);
  return times.length?Math.max(...times):NaN;
}

export function retainComparisonAttempt(value={},prior={},attemptedAt){
  // Retry scheduling must not refresh the timestamp of the price evidence.
  const times=[attemptedAt,value.lastAttemptAt,prior?.lastAttemptAt,prior?.checkedAt].map(value=>Date.parse(value||'')).filter(Number.isFinite);
  return times.length?{...value,lastAttemptAt:new Date(Math.max(...times)).toISOString()}:value;
}

export function shouldScanXianyu(item,yahooResult){
  return yahooResult?.status==='ok' && Number.isFinite(yahooResult.lowestPrice) && yahooResult.lowestPrice<item.ownPrice;
}

export function verifiedXianyuCache(item={}){
  const reference=Object.hasOwn(item.xianyu||{},'averageCNY')?item.xianyu.averageCNY:
    !item.referenceProvider||item.referenceProvider==='xianyu'?item.averageCNY:null;
  const evidence=verifiedCostEvidence(item.xianyu?.samples);
  if(item.xianyu?.verification!==XIANYU_VERIFICATION||!evidence.ready||!Number.isFinite(reference)||reference<=0||Math.abs(reference-evidence.median)>=.01)return null;
  return {averageCNY:evidence.median,samples:evidence.samples,checkedAt:item.xianyu.checkedAt||item.checkedAt||null,verification:item.xianyu.verification};
}

export function isFresh(value,hours,now=Date.now()){
  const timestamp=Date.parse(value||'');
  return Number.isFinite(timestamp)&&now-timestamp<Math.max(0,hours)*60*60*1000;
}

export function isFreshMinutes(value,minutes,now=Date.now()){
  const timestamp=Date.parse(value||'');
  return Number.isFinite(timestamp)&&now-timestamp<Math.max(0,minutes)*60*1000;
}

export function fairRoundRobin(buckets=[]){
  const output=[],cursors=buckets.map(()=>0);
  while(cursors.some((cursor,index)=>cursor<(buckets[index]?.length||0)))for(let index=0;index<buckets.length;index++){
    const bucket=buckets[index]||[],cursor=cursors[index];if(cursor<bucket.length){output.push(bucket[cursor]);cursors[index]++}
  }
  return output;
}

// Finish a new rule-version sweep before revisiting already-checked shop rows.
// Simple per-shop alternation otherwise spends most slots rechecking small shops.
export function fairPriorityRoundRobin(buckets=[]){
  const priorities=[...new Set(buckets.flat().map(task=>task.priority??3))].sort((a,b)=>a-b);
  return priorities.flatMap(priority=>fairRoundRobin(buckets.map(bucket=>bucket.filter(task=>(task.priority??3)===priority))));
}
