export function merchantRetryDelay(result={},now=Date.now()){
 if((result.merchants||[]).some(m=>m.status!=='ok'))return 20*60_000;
 const pending=(result.products||[]).filter(p=>!p.webImages?.length&&!p.xianyuImages?.length);
 if(!pending.length)return 24*3600_000;
 const due=Math.min(...pending.map(p=>Date.parse(p.webImageRetryAt)||now));
 return Math.max(20*60_000,Math.min(24*3600_000,due-(Date.parse(result.checkedAt)||now)));
}
export function merchantBudget({deadline,now=Date.now(),remainingMerchants,remainingDetails}){
 const count=Math.max(1,remainingMerchants);
 return {deadline:Math.min(deadline,now+Math.max(0,deadline-now)/count),detailLimit:Math.max(0,Math.ceil(remainingDetails/count))};
}
