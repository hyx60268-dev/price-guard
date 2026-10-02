import { mapLimit } from './worker-pool.mjs';
import { bindProcurementTarget,verifiedPublicProcurementCache,sameProcurementTarget } from './procurement-reference.mjs';

const logText=value=>String(value??'').replace(/<[^>]*>/g,' ').replace(/https?:\/\/[^\s"'<>]+/gi,'[url omitted]').replace(/\b(?:set-cookie|cookie|authorization|token|password|session)\s*[:=][^,;\n]*/gi,'[sensitive omitted]').replace(/\s+/g,' ').trim().slice(0,160);

// Each account supplies an already ordered bucket. Sources run independently of
// Xianyu access state, with their own bounded admission and shared scan deadline.
export async function runPublicProcurement(buckets,{lookup,hydrate=async item=>item,deadline,limit=8,concurrency=2,priorityItemIds=[],now=Date.now,log=()=>{}}={}){
 const results=new Map(),tasks=[];
 for(let n=0;n<Math.max(0,...buckets.map(b=>b.length));n++)for(const bucket of buckets)if(bucket[n])tasks.push(bucket[n]);
 // Priorities reorder only existing, account-bound tasks. The cache, retry and
 // admission checks below apply unchanged to every prioritized task.
 const priorities=new Set(priorityItemIds);
 tasks.sort((a,b)=>Number(priorities.has(b.item.id))-Number(priorities.has(a.item.id)));
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
  let reference,observedItem=item;
  try{observedItem=await hydrate(item,prior);reference=await lookup(observedItem,{deadline:Math.min(deadline,now()+60000)});}
  catch(error){reference={status:'error',reason:'lookup_exception',averageCNY:null,samples:[],diagnostics:[{reason:'lookup_exception',message:logText(error?.message||error)}]};}
  reference=bindProcurementTarget({...reference,attempted:true,checkedAt:reference.checkedAt||new Date(now()).toISOString()},observedItem);
  results.set(key,reference);
  log({key,status:reference.status,reason:logText(reference.reason),sellers:reference.sellerCount||0,averageCNY:reference.averageCNY??null,searched:reference.searched||0,detailCheckedCount:reference.detailCheckedCount||0,unsupportedTargets:reference.unsupportedTargets||0,duplicateUrls:reference.duplicateUrls||0,searchResults:(reference.searchResults||[]).slice(0,4),diagnostics:(reference.diagnostics||[]).slice(0,16)});
 });
 return results;
}
