export function merchantRetryDelay(result={}){
 return (result.merchants||[]).some(m=>m.status!=='ok')?20*60_000:24*3600_000;
}
export function merchantBudget({deadline,now=Date.now(),remainingMerchants,remainingDetails}){
 const count=Math.max(1,remainingMerchants);
 return {deadline:Math.min(deadline,now+Math.max(0,deadline-now)/count),detailLimit:Math.max(0,Math.ceil(remainingDetails/count))};
}
