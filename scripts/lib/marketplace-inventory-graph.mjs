// Local integration boundary. No implicit reader, workflow, network, publication,
// inventory selection budget or rate defaults. All configured accounts are kept.
import {createHash} from 'node:crypto';
import {planFullCycle,runFullCycle,VALIDATION_GATES} from './full-cycle-graph.mjs';
import {yahooGraphSearchSpec} from './yahoo-graph-adapter.mjs';
import {rakumaGraphSearchSpec} from './rakuma-graph-adapter.mjs';
import {requiredPricingPlatforms} from '../../public/pricing-policy.js';
import {buildOwnedOffers,normalizeOfferPlatform} from '../../public/owned-offers.js';
const unknown=reason=>({reason,gates:Object.fromEntries(VALIDATION_GATES.map(gate=>[gate,'unknown']))});
const searches={yahoo:yahooGraphSearchSpec,rakuma:rakumaGraphSearchSpec};
const schedulingTime=(value,now)=>{
  const at=typeof value==='number'?value:typeof value==='string'&&value.trim()?Date.parse(value):NaN;
  return Number.isFinite(at)&&at<=now?at:-Infinity;
};
function admissionAge(target,now){
  const comparison=source=>{
    const value=target[source],audit=value?.audit;
    return (audit?.accountId&&audit.accountId!==target.accountId)||(audit?.ownItemId&&audit.ownItemId!==target.id)?null:value;
  };
  const comparisonTime=source=>Math.max(...['lastAttemptAt','lastFullAttemptAt','knownLastAttemptAt','checkedAt','searchCheckedAt']
    .map(field=>schedulingTime(comparison(source)?.[field],now)));
  const detail=target.sourceDetail,ownComparison=comparison(target.platform);
  const ownObserved=detail?.id&&detail.id!==target.id?-Infinity:schedulingTime(detail?.observedAt??detail?.checkedAt,now);
  // Shared search activity is not an own-listing turn. Only its original own
  // observation or a target-local own raw dispatch can advance this retry age.
  const ownTurn=Math.max(ownObserved,schedulingTime(ownComparison?.ownLastAttemptAt,now));
  return [ownTurn,...requiredPricingPlatforms(target).map(comparisonTime)].sort((a,b)=>a===b?0:a<b?-1:1);
}
function oldestWorkFirst(rows,now){
  const ages=new Map(rows.map(target=>[target,admissionAge(target,now)]));
  // Missing/oldest obligations first, then their other obligations. Stable ties
  // retain profile order. No timestamp here becomes current quote evidence.
  rows.sort((left,right)=>{
    const a=ages.get(left),b=ages.get(right);
    for(let index=0;index<a.length;index++)if(a[index]!==b[index])return a[index]<b[index]?-1:1;
    return 0;
  });
}
function supportedKnownOffer(row,source){
  if(!row||typeof row!=='object'||typeof row.url!=='string')return null;
  try{
    const url=new URL(row.url),pattern=source==='yahoo'?/^\/item\/([a-zA-Z0-9_-]+)$/:/^\/([a-f0-9]{32})$/i;
    const host=source==='yahoo'?'paypayfleamarket.yahoo.co.jp':'item.fril.jp',match=url.pathname.match(pattern);
    if(url.protocol!=='https:'||url.host!==host||url.username||url.password||url.search||url.hash||!match||row.id&&String(row.id)!==match[1])return null;
    return {url:url.href,card:{...structuredClone(row),id:match[1]}};
  }catch{return null;}
}

const itemUrl=(platform,item)=>item.url||item.ownUrl||(platform==='yahoo'?`https://paypayfleamarket.yahoo.co.jp/item/${item.id}`:
  platform==='rakuma'?`https://item.fril.jp/${item.id}`:null);

/** Inventories are receipts from the existing full seller-list collector, not
 * snapshots renamed as live. The original read timestamp must be supplied.
 * An absent account is a hard error; a failed account keeps its prior rows and
 * stale receipt, so the denominator and missing coverage remain visible. */
export function planMarketplaceInventory({cycleId,startedAt,deadlineAt,configuredAccounts,inventories,
  comparisonMode='same_platform',previousCompleteAt=null,historicalOwnedItems=[],supplierSpecs=()=>({}),maxNodes=100000}){
  if(!Array.isArray(configuredAccounts)||!configuredAccounts.length||!Array.isArray(inventories))throw new Error('Explicit complete account registry and inventory receipts required');
  if(!['same_platform','cross_platform'].includes(comparisonMode))throw new Error('Unsupported comparison mode');
  const registry=new Map(configuredAccounts.map(account=>[account.id,account]));
  const receipts=new Map(inventories.map(receipt=>[receipt.accountId,receipt]));
  if(registry.size!==configuredAccounts.length||receipts.size!==inventories.length||
    [...registry.keys()].some(id=>!receipts.has(id))||[...receipts.keys()].some(id=>!registry.has(id)))throw new Error('Inventory account universe mismatch');
  const accounts=[],targets=[],accountTargets=[];
  for(const [id,account] of registry){
    const receipt=receipts.get(id),platform=normalizeOfferPlatform(account.platform,account.profileUrl);
    if(!Array.isArray(receipt.items)||receipt.items.some(item=>!item?.id||!item.title)||new Set(receipt.items.map(item=>item.id)).size!==receipt.items.length)
      throw new Error('Full inventory rows must have unique IDs and current declared titles');
    if(!Number.isSafeInteger(receipt.expectedCount)||receipt.expectedCount<receipt.items.length)throw new Error('Inventory expected count cannot shrink supplied rows');
    accounts.push({id,expectedCount:receipt.expectedCount,status:receipt.fromCache===false?receipt.status:'cached',cycleId:receipt.cycleId,
      observedAt:receipt.observedAt,paginationComplete:receipt.complete===true,truncated:receipt.truncated===true});
    const rows=[];accountTargets.push(rows);
    for(const item of receipt.items){
      const target={...structuredClone(item),id:item.id,accountId:id,platform,comparisonMode,
        own:{accessScope:'public',url:itemUrl(platform,item)},pricing:{},procurement:supplierSpecs(item,account)};
      // Old automatic cost or canonical identity flags do not become bindings.
      delete target.identity;
      for(const source of requiredPricingPlatforms(target)){
        if(!searches[source])continue; // mandatory unsupported source remains missing in graph
        target.pricing[source]={...searches[source](target.title),knownOffers:(Array.isArray(item[source]?.candidates)?item[source].candidates:[])
          .map(row=>supportedKnownOffer(row,source)).filter(Boolean)};
      }
      rows.push(target);
    }
    oldestWorkFirst(rows,startedAt);
  }
  // Give each configured account one target turn before returning to its next
  // row. Keep the full denominator and stable age ties; this is admission
  // order only, never an inventory selection or a per-account scan budget.
  for(let index=0,remaining=true;remaining;index++){
    remaining=false;
    for(const rows of accountTargets)if(index<rows.length){targets.push(rows[index]);remaining=true;}
  }
  const graph=planFullCycle({cycleId,startedAt,deadlineAt,accounts,targets,previousCompleteAt,maxNodes});
  const inventoryProof=createHash('sha256').update(JSON.stringify(inventories.map(receipt=>({accountId:receipt.accountId,
    proofRef:receipt.proofRef,observedAt:receipt.observedAt,count:receipt.expectedCount,ids:receipt.items.map(item=>item.id)})))).digest('hex');
  const assessInventoryCoverage=(_,context)=>({complete:inventories.every(receipt=>receipt.status==='live'&&receipt.fromCache===false&&receipt.complete===true&&
    receipt.truncated!==true&&receipt.cycleId===cycleId&&Number.isFinite(receipt.observedAt)&&receipt.observedAt>=startedAt&&
    receipt.observedAt<=context.now&&typeof receipt.proofRef==='string'&&receipt.proofRef&&receipt.items.length===receipt.expectedCount),
    scope:'all_configured_accounts',cycleId,proofRef:`collector-receipts:${inventoryProof}`,
    accounts:accounts.map(({id,expectedCount})=>({id,expectedCount}))});
  return {graph,assessInventoryCoverage,ownedOffers:buildOwnedOffers(configuredAccounts,[...historicalOwnedItems,...targets])};
}

/** Dispatches every graph obligation through explicitly supplied adapters.
 * Callers retain source holds, rate policy and the actual inventory collector.
 * No production acceptance or mutable stored state is manufactured here. */
export function marketplaceGraphHandlers(adapters){
  const sourceAdapter=source=>adapters[normalizeOfferPlatform(source)];
  return {
    fetchRaw:(request,context)=>{
      const adapter=sourceAdapter(request.source);if(!adapter?.fetchRaw)throw new Error(`source_adapter_unavailable:${request.source}`);
      return adapter.fetchRaw(request,context);
    },
    validateOwn:(target,raw,context)=>sourceAdapter(target.platform)?.validateOwn(target,raw,context)||{complete:false,reason:'own_source_adapter_unavailable'},
    validateOffer:(target,own,raw,context)=>sourceAdapter(context.source)?.validateOffer(target,own,raw,context)||unknown('offer_source_adapter_unavailable'),
    screenCandidate:(target,own,candidate,context)=>sourceAdapter(context.source)?.screenCandidate?.(target,own,candidate,context)||{decision:'detail'},
    candidatesFromOwn:(target,own,context)=>sourceAdapter(context.source)?.candidatesFromOwn?.(target,own,context)||[],
    assessDiscoveryCoverage:(request,raw,context)=>sourceAdapter(request.source)?.assessDiscoveryCoverage?.(request,raw,context)||{accepted:false}
  };
}
export function runMarketplaceInventory(planned,{adapters,clock,maxConcurrency,sourceLimits}){
  return runFullCycle(planned.graph,{...marketplaceGraphHandlers(adapters),assessInventoryCoverage:planned.assessInventoryCoverage,clock,maxConcurrency,sourceLimits});
}
