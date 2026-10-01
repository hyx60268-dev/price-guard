import { mapLimit } from './worker-pool.mjs';
import { bindProcurementTarget,verifiedPublicProcurementCache,sameProcurementTarget } from './procurement-reference.mjs';

// Each account supplies an already ordered bucket. Sources run independently of
// Xianyu access state, with their own bounded admission and shared scan deadline.
export async function runPublicProcurement(buckets,{lookup,hydrate=async item=>item,deadline,limit=8,concurrency=2,now=Date.now,log=()=>{}}={}){
 const results=new Map(),tasks=[];
 for(let n=0;n<Math.max(0,...buckets.map(b=>b.length));n++)for(const bucket of buckets)if(bucket[n])tasks.push(bucket[n]);
 let admitted=0;
 await mapLimit(tasks,Math.max(1,Math.min(2,concurrency)),async task=>{
  const {item,prior={}}=task,key=item.accountId+':'+item.id;
  const cached=verifiedPublicProcurementCache({...item,procurementSource:prior.procurementSource},{now:now()});
  if(cached){results.set(key,{...prior.procurementSource,attempted:false,cacheStatus:'fresh_verified'});return;}
  const checked=Date.parse(prior.procurementSource?.checkedAt||''),age=now()-checked;
  const retry=['no_verified_cost','no_results'].includes(prior.procurementSource?.status)?6*3600000:20*60000;
  if(sameProcurementTarget(prior.procurementSource?.target,item)&&age>=0&&age<retry){results.set(key,{...prior.procurementSource,attempted:false,cacheStatus:'awaiting_retry'});return;}
  if(admitted>=limit||now()>=deadline){results.set(key,{...prior.procurementSource,attempted:false,cacheStatus:'deferred_budget'});return;}
  admitted++;
  let reference;
  try{reference=await lookup(await hydrate(item,prior),{deadline:Math.min(deadline,now()+60000)});}
  catch(error){reference={status:'error',averageCNY:null,samples:[],diagnostics:[{reason:'lookup_exception',message:String(error?.message||error).slice(0,160)}]};}
  reference=bindProcurementTarget({...reference,attempted:true,checkedAt:reference.checkedAt||new Date(now()).toISOString()},item);
  results.set(key,reference);
  log({key,status:reference.status,sellers:reference.sellerCount||0,averageCNY:reference.averageCNY??null,diagnostics:reference.diagnostics||[]});
 });
 return results;
}
