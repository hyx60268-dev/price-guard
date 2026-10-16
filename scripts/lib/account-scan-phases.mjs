import {normalizeOfferPlatform} from '../../public/owned-offers.js';

// Scheduling only: keep every context and its inventory/evidence untouched.
export function orderedAccountPhases(contexts,{priorityAccountIds=[]}={}){
  const ranks=new Map();
  for(const id of priorityAccountIds)if(!ranks.has(id))ranks.set(id,ranks.size);
  const groups={yahoo:[],other:[],rakuma:[]};
  for(const context of contexts){
    const account=context.account||{},platform=normalizeOfferPlatform(account.platform,account.profileUrl);
    groups[platform==='yahoo'?'yahoo':platform==='rakuma'?'rakuma':'other'].push(context);
  }
  return Object.entries(groups).filter(([,values])=>values.length).map(([key,values])=>({key,
    contexts:values.sort((a,b)=>(ranks.get(a.account?.id)??Infinity)-(ranks.get(b.account?.id)??Infinity))}));
}

// Callbacks own their worker pools and must settle all their in-flight work
// before resolving/rejecting. Do not race cancellation against that settlement:
// a rejected phase must never overlap a later phase or premature cleanup.
export async function runAccountScanPhases(contexts,{priorityAccountIds=[],deadline,now=Date.now,signal,
  discover,scan,defer,onPhase=()=>{}}={}){
  if(typeof deadline!=='number'||Number.isNaN(deadline))throw new TypeError('A shared scan deadline is required');
  for(const callback of [discover,scan,defer,onPhase])if(typeof callback!=='function')throw new TypeError('Phase callbacks must be functions');
  const phases=orderedAccountPhases(contexts,{priorityAccountIds}),results=[];
  const checkAbort=()=>{if(signal?.aborted){const error=new Error('Account scan aborted',{cause:signal.reason});error.name='AbortError';throw error;}};
  const time=()=>{const value=now();if(!Number.isFinite(value))throw new TypeError('Invalid scan clock');return value;};
  const emit=(phase,event,at,start)=>onPhase({key:phase.key,event,count:phase.contexts.length,at,
    ...(start===undefined?{}:{durationMs:Math.max(0,at-start)})});
  let budgetExpired=false;
  for(const phase of phases){
    checkAbort();
    const start=time();
    let discovery;
    if(!budgetExpired&&start<deadline){
      await emit(phase,'start',start);
      checkAbort();
      if(time()<deadline){
        discovery=await discover(phase,{deadline,signal});
        checkAbort();
        const discoveredAt=time();
        if(discoveredAt>=deadline)budgetExpired=true;
        await emit(phase,'discovered',discoveredAt,start);
      }else budgetExpired=true;
    }else budgetExpired=true;
    checkAbort();
    if(budgetExpired||time()>=deadline){
      budgetExpired=true;
      const reason='deferred_due_to_priority',deferred=await defer(phase,reason);
      checkAbort();
      await emit(phase,'deferred',time(),start);
      results.push({key:phase.key,status:'deferred',reason,discovery,deferred});
      continue;
    }
    const scanned=await scan(phase,{deadline,signal});
    checkAbort();
    const completedAt=time();
    if(completedAt>=deadline)budgetExpired=true;
    await emit(phase,'completed',completedAt,start);
    results.push({key:phase.key,status:'completed',discovery,scan:scanned});
  }
  checkAbort();
  return results;
}
