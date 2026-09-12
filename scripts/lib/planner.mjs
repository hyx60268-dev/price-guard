import { inferSize } from './rules.mjs';

export function reconcileLiveItems(catalogItems=[],previousItems=[],liveItems=[]){
  const previous=new Map(previousItems.map(item=>[item.id,item]));
  const catalog=new Map(catalogItems.map(item=>[item.id,item]));
  return liveItems.map((live,index)=>{
    const old=previous.get(live.id)||{};
    const saved=catalog.get(live.id)||{};
    return {
      ...old,
      ...saved,
      ...live,
      seq:index+1,
      xianyuQuery:saved.xianyuQuery??old.xianyuQuery??'',
      size:saved.size??old.size??inferSize(live.title)
    };
  });
}

export function inventoryDelta(previousItems=[],activeItems=[]){
  const before=new Set(previousItems.map(item=>item.id));
  const after=new Set(activeItems.map(item=>item.id));
  return {
    added:[...after].filter(id=>!before.has(id)),
    removed:[...before].filter(id=>!after.has(id)),
    unchanged:[...after].filter(id=>before.has(id)).length
  };
}

export function shouldScanXianyu(item,yahooResult){
  return yahooResult?.status==='ok' && Number.isFinite(yahooResult.lowestPrice) && yahooResult.lowestPrice<item.ownPrice;
}

export function verifiedXianyuCache(item={}){
  if(item.xianyu?.verification!=='detail_and_price_cluster'||!Number.isFinite(item.averageCNY))return null;
  return {averageCNY:item.averageCNY,samples:item.xianyu.samples||[]};
}
