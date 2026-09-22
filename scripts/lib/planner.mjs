import { inferSize } from './rules.mjs';
import { normalizeProductIdentity } from './state.mjs';

export function reconcileLiveItems(catalogItems=[],previousItems=[],liveItems=[],accountId='default'){
  const previous=new Map(previousItems.map(item=>[item.id,item]));
  const catalog=new Map(catalogItems.map(item=>[item.id,item]));
  const historic=[...previousItems,...catalogItems];
  const byTitle=new Map();
  for(const item of historic){
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
      const candidates=(byTitle.get(key)||[]).filter(item=>item.id!==live.id&&!usedRelists.has(item.id));
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
      relistedFrom:relisted.id||undefined
    };
  });
}

export function inventoryDelta(previousItems=[],activeItems=[]){
  const before=new Set(previousItems.map(item=>item.id));
  const after=new Set(activeItems.map(item=>item.id));
  const relisted=activeItems.filter(item=>item.relistedFrom&&before.has(item.relistedFrom))
    .map(item=>({from:item.relistedFrom,to:item.id,title:item.title}));
  const relistedFrom=new Set(relisted.map(item=>item.from)),relistedTo=new Set(relisted.map(item=>item.to));
  return {
    added:[...after].filter(id=>!before.has(id)&&!relistedTo.has(id)),
    removed:[...before].filter(id=>!after.has(id)&&!relistedFrom.has(id)),
    relisted,
    unchanged:[...after].filter(id=>before.has(id)).length
  };
}

export function shouldScanXianyu(item,yahooResult){
  return yahooResult?.status==='ok' && Number.isFinite(yahooResult.lowestPrice) && yahooResult.lowestPrice<item.ownPrice;
}

export function verifiedXianyuCache(item={}){
  if(!['detail_and_price_cluster','detail_text_images_price_cluster_v2','detail_text_images_price_cluster_v3','detail_text_images_price_cluster_v4'].includes(item.xianyu?.verification)||!Number.isFinite(item.averageCNY))return null;
  return {averageCNY:item.averageCNY,samples:item.xianyu.samples||[],checkedAt:item.xianyu.checkedAt||item.checkedAt||null,verification:item.xianyu.verification};
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
