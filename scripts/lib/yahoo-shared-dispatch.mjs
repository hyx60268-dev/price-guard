// A bounded additional read action may borrow a worker slot, never a normal
// discovery obligation. Only the normal callback owns comparison attempt clocks.
export async function runSharedYahooDispatch(tasks,{accountOrder=[],concurrency=1,plan,ordinary,shared,
 canStartShared=()=>true}={}){
 if(!Array.isArray(tasks)||typeof ordinary!=='function'||typeof shared!=='function'||!plan)throw Error('invalid_shared_dispatch');
 const key=task=>`${task.context.account.id}:${task.item.id}`;
 const order=[...new Set([...accountOrder,...tasks.map(task=>task.context.account.id)])];
 const buckets=new Map(order.map(id=>[id,tasks.map((task,index)=>({task,index})).filter(row=>row.task.context.account.id===id)]));
 const sinceShared=new Map(),inFlight=new Set(),outputs=new Array(tasks.length);let cursor=0,sharedInFlight=false;
 const stats={version:1,ordinaryClaims:0,ordinaryObserved:0,noHitDiscoveryClaims:0,noHitDiscoveryObserved:0,sharedClaims:0,sharedFailures:0,
  accountTurns:Object.fromEntries(order.map(id=>[id,{ordinaryClaims:0,ordinaryObserved:0,noHitDiscoveryClaims:0,noHitDiscoveryObserved:0,sharedClaims:0}]))};
 function claim(){
  for(let n=0;n<order.length;n++){
   const id=order[cursor++%order.length],bucket=buckets.get(id),turns=sinceShared.get(id)||0;
   if(!sharedInFlight&&turns>=2&&canStartShared()){
    const root=plan.claim(id,{blockedTargetKeys:inFlight});
    if(root){const rootKey=`${root.item.accountId}:${root.item.id}`;
     if(inFlight.has(rootKey))throw Error('shared_dispatch_duplicate_claim');
     sharedInFlight=true;inFlight.add(rootKey);sinceShared.set(id,0);stats.sharedClaims++;stats.accountTurns[id].sharedClaims++;
     return {kind:'shared',id,key:rootKey,root};
    }
   }
   const ready=bucket.filter(row=>!inFlight.has(key(row.task)));
   if(!ready.length)continue;
   // Reserve every second ordinary claim, including in-flight work, for an
   // established no-hit obligation. Completion parity is unsafe under parallel
   // workers. Cached claims still cannot earn shared-action source credit.
   const row=stats.accountTurns[id].ordinaryClaims%2===1?ready.find(row=>plan.hasRecall(key(row.task))===false)||ready[0]:ready[0];
   bucket.splice(bucket.indexOf(row),1);const targetKey=key(row.task);inFlight.add(targetKey);
   stats.ordinaryClaims++;stats.accountTurns[id].ordinaryClaims++;
   const noHit=plan.hasRecall(targetKey)===false;
   if(noHit){stats.noHitDiscoveryClaims++;stats.accountTurns[id].noHitDiscoveryClaims++;}
   return {kind:'ordinary',id,key:targetKey,row,noHit};
  }
  return null;
 }
 const settled=await Promise.allSettled(Array.from({length:Math.max(1,Math.min(tasks.length||1,Math.floor(Number(concurrency)||1)))},async(_,slot)=>{
  while(true){const task=claim();if(!task)return;
   try{
    if(task.kind==='shared'){
     try{await shared(task.root,slot);}catch{stats.sharedFailures++;}
    }else{
     const value=await ordinary(task.row.task,task.row.index,slot);outputs[task.row.index]=value;
     if(value?.sourceInputObserved===true){sinceShared.set(task.id,(sinceShared.get(task.id)||0)+1);stats.ordinaryObserved++;stats.accountTurns[task.id].ordinaryObserved++;
      if(task.noHit){stats.noHitDiscoveryObserved++;stats.accountTurns[task.id].noHitDiscoveryObserved++;}}
    }
   }finally{inFlight.delete(task.key);if(task.kind==='shared')sharedInFlight=false;}
  }
 }));
 const failed=settled.find(value=>value.status==='rejected');if(failed)throw failed.reason;
 // scanMeta is retained in member projections, so operational aggregates must
 // not expose the identifiers of accounts outside the viewer's scope.
 return {outputs,statistics:structuredClone({...stats,accountTurns:order.map((id,ordinal)=>({ordinal,...stats.accountTurns[id]}))})};
}
