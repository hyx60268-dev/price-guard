// Pure compatibility boundary: graph evidence becomes the existing comparison
// format. It never reads a source, validates identity, or promotes stored offers.
import {VALIDATION_GATES,fullCycleReport,graphCounts} from './full-cycle-graph.mjs';
import {PRICING_RULES_VERSION,requiredPricingPlatforms} from '../../public/pricing-policy.js';

const copy=value=>structuredClone(value);
const text=value=>typeof value==='string'&&value.trim().length>0;
const iso=value=>Number.isFinite(value)?new Date(value).toISOString():null;
const earliest=values=>values.length?Math.min(...values):null;
const latest=values=>values.length?Math.max(...values):null;
const timestamp=value=>typeof value==='number'?value:Date.parse(value||'');
const key=item=>`${item.accountId}:${item.id}`;
const currentTime=(graph,value)=>Number.isFinite(value)&&value>=graph.startedAt&&value<=graph.deadlineAt&&
  (!Number.isFinite(graph.finishedAt)||value<=graph.finishedAt);
const currentRaw=(graph,node)=>node?.kind==='raw'&&node.status==='succeeded'&&node.result?.cycleId===graph.cycleId&&
  node.result.fromCache===false&&currentTime(graph,node.result.observedAt);
const safeUrl=value=>{
  try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password)return null;url.hash='';return url.href;}
  catch{return null;}
};

function candidateFromDecision(graph,record,scope,node){
  const own=graph.nodes.get(record.ownId),raw=graph.nodes.get(node.rawId),value=node.result,quote=value?.quote;
  if(node.kind!=='decision'||node.scopeId!==scope.id||node.targetKey!==record.key||node.source!==scope.source||
    node.purpose!=='pricing'||node.status!=='succeeded'||value?.complete!==true||value.accepted!==true||
    VALIDATION_GATES.some(gate=>value.gates?.[gate]!=='pass')||
    own?.status!=='succeeded'||own.result?.complete!==true||!currentRaw(graph,graph.nodes.get(own.rawId))||
    !currentRaw(graph,raw)||raw.source!==scope.source||value.observedAt!==raw.result.observedAt||
    !quote||quote.targetKey!==record.key||quote.skuId!==own.result.identity?.skuId||quote.quantity!==own.result.identity?.quantity||
    quote.available!==true||quote.isOwn===true||quote.currency!=='JPY'||quote.shippingCurrency!=='JPY'||
    !Number.isFinite(quote.price)||quote.price<=0||!Number.isFinite(quote.shipping)||quote.shipping<0||
    !text(quote.sellerId)||!text(quote.matchMethod)||!safeUrl(quote.url)||safeUrl(quote.url)!==safeUrl(raw.request.url))return null;
  const price=quote.price+quote.shipping;
  if(!Number.isFinite(price)||price<=0)return null;
  // The adapter already passed every gate. Optional display fields come only
  // from that accepted quote, never from a search card or a previous snapshot.
  const display=['id','title','image','detailTitle','identityEvidence','titleScore','imageScore','primaryImageScore','sellerKey','shippingSource','priceSource'];
  return {...Object.fromEntries(display.filter(field=>quote[field]!==undefined).map(field=>[field,copy(quote[field])])),
    url:safeUrl(quote.url),platform:scope.source,price,itemPrice:quote.price,shippingJPY:quote.shipping,
    sellerId:quote.sellerId,matchMethod:quote.matchMethod,isOwn:false,checkedAt:iso(value.observedAt)};
}

function comparisonFor(graph,record,scope,prior={},starts){
  const decisions=[...(scope?.decisions||[])].map(id=>graph.nodes.get(id)).filter(Boolean);
  const searches=[...(scope?.searchIds||[])].map(id=>graph.nodes.get(id)).filter(Boolean);
  const currentSearches=searches.filter(node=>currentRaw(graph,node));
  const candidates=scope?decisions.map(node=>candidateFromDecision(graph,record,scope,node)).filter(Boolean)
    .sort((a,b)=>a.price-b.price||a.url.localeCompare(b.url)):[];
  const unpublishable=decisions.filter(node=>node.result?.accepted===true&&!candidateFromDecision(graph,record,scope,node)).length;
  // A successful page is not a completed search. Expansion records the trusted
  // adapter's coverage proof; problems and missing continuations stay visible.
  const searchComplete=Boolean(scope&&scope.discoveryRequired&&scope.discoveryFinished&&!scope.problem&&searches.length&&
    currentSearches.length===searches.length&&searches.every(node=>scope.expanded?.has(node.id)));
  const complete=scope?.status==='succeeded'&&scope.result?.complete===true&&searchComplete&&unpublishable===0;
  const searchTimes=currentSearches.map(node=>node.result.observedAt);
  const detailNodes=decisions.map(node=>graph.nodes.get(node.rawId)).filter(node=>currentRaw(graph,node));
  const own=graph.nodes.get(record.ownId),ownRaw=graph.nodes.get(own?.rawId);
  const sourceIds=new Set([...searches,...detailNodes].map(node=>node.id));
  if(ownRaw?.source===scope?.source)sourceIds.add(ownRaw.id);
  // Include failed/not-admitted detail nodes in attempt accounting, without
  // converting a graph scheduling time into an evidence observation.
  for(const node of decisions)if(node.rawId)sourceIds.add(node.rawId);
  const attempted=latest([...sourceIds].map(id=>starts.get(id)).filter(Number.isFinite));
  const searchAttempted=latest(searches.map(node=>starts.get(node.id)).filter(Number.isFinite));
  const priorAttempt=timestamp(prior.lastAttemptAt);
  const attemptTimes=[attempted,priorAttempt].filter(Number.isFinite);
  // A coalesced search can touch many scopes without reading their own listing.
  // Keep this target-local dispatch age separate from all observation clocks.
  const ownAttemptTimes=[starts.get(ownRaw?.id),timestamp(prior.ownLastAttemptAt)].filter(Number.isFinite);
  const readFailure=[...sourceIds].map(id=>graph.nodes.get(id)?.error?.code).find(Boolean);
  const reason=complete?null:scope?.error?.code||scope?.problem?.code||readFailure||scope?.result?.reason||'graph_scope_incomplete';
  const fields={rulesVersion:PRICING_RULES_VERSION,status:complete?'ok':'incomplete',evidenceStatus:complete?'ok':'incomplete',
    searchComplete,searchCheckedAt:iso(earliest(searchTimes))||prior.searchCheckedAt||null,
    searchUrl:scope?.spec?.query?.url||prior.searchUrl||null,
    lastAttemptAt:iso(latest(attemptTimes)),lastFullAttemptAt:iso(searchAttempted)||prior.lastFullAttemptAt||null,
    ownLastAttemptAt:iso(latest(ownAttemptTimes)),
    deferredReason:reason,cacheReason:null,candidates,rejected:[],
    cardCount:decisions.length,detailCheckedCount:new Set(detailNodes.map(node=>node.id)).size,
    unresolvedCandidateCount:decisions.filter(node=>node.status!=='succeeded'||node.result?.complete!==true).length+unpublishable,
    audit:{accountId:record.target.accountId,ownItemId:record.target.id,rulesVersion:PRICING_RULES_VERSION}};
  if(complete||candidates.length){
    // The comparison clock is the oldest evidence supporting this result.
    // Per-candidate clocks retain the precise original detail observations.
    const evidenceTimes=candidates.map(candidate=>timestamp(candidate.checkedAt));
    if(complete){
      evidenceTimes.push(...searchTimes,...detailNodes.map(node=>node.result.observedAt));
      if(currentTime(graph,own?.result?.observedAt))evidenceTimes.push(own.result.observedAt);
    }
    return {...fields,checkedAt:iso(earliest(evidenceTimes)),lowestPrice:candidates[0]?.price??null,lowestUrl:candidates[0]?.url??null,
      matchConfidence:candidates.length?'高':'覆盖检查'};
  }
  // No new actionable quote and no completed scope: retaining historical
  // candidates is useful for review but cannot give them a fresh source clock.
  if(prior.checkedAt||prior.candidates?.length){
    return {...copy(prior),...fields,status:'stale',evidenceStatus:'stale',cacheReason:'request_error',
      rulesVersion:prior.rulesVersion??null,checkedAt:prior.checkedAt||null,candidates:copy(prior.candidates||[]),
      rejected:copy(prior.rejected||[]),lowestPrice:prior.lowestPrice??null,lowestUrl:prior.lowestUrl??null};
  }
  // Even an incomplete observed page is a real observation; attempts alone are
  // not. It carries no accepted candidate and cannot authorize raising.
  return {...fields,checkedAt:iso(earliest(searchTimes)),lowestPrice:null,lowestUrl:null};
}

/** One result for every planned account/item, including untouched obligations.
 * Previous rows must be account-qualified. Stored graph target fields provide
 * the same-target fallback; no item-ID-only cache is ever consulted. */
export function graphComparisonResults(graph,{previousItems=[]}={}){
  const previous=new Map(previousItems.filter(item=>text(item?.accountId)&&text(item?.id)).map(item=>[key(item),item]));
  const scopes=new Map(graph.scopes.filter(scope=>scope.purpose==='pricing').map(scope=>[`${scope.targetKey}\0${scope.source}`,scope]));
  const starts=new Map();
  for(const event of graph.execution?.events||[])if(event.event==='start'&&event.kind==='raw'&&Number.isFinite(event.at))
    starts.set(event.nodeId,Math.max(starts.get(event.nodeId)??-Infinity,event.at));
  const results=new Map();
  for(const record of graph.targets.values()){
    const prior=previous.get(record.key)||record.target,row={accountId:record.target.accountId,id:record.target.id};
    for(const source of requiredPricingPlatforms(record.target)){
      const stored=prior[source],audit=stored?.audit;
      const safePrior=stored&&(!audit?.accountId||audit.accountId===record.target.accountId)&&
        (!audit?.ownItemId||audit.ownItemId===record.target.id)?stored:{};
      row[source]=comparisonFor(graph,record,scopes.get(`${record.key}\0${source}`),safePrior,starts);
    }
    results.set(record.key,row);
  }
  return results;
}

/** Safe operational metadata for publication/logging: counts and fixed flags,
 * never raw requests, target IDs, account IDs, URLs, titles or event payloads. */
export function graphComparisonSummary(graph){
  const report=fullCycleReport(graph),rawCounts=graphCounts(graph).rawBySource,count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
  const countKeys=['total','declaredInventoryTotal','registeredInventoryTotal','plannedTargets','completed','ownIdentityVerified','priceComplete','costVerified'];
  const kinds=['raw','own','ownRecall','scope','screen','decision','cost','price'];
  const statuses=['pending','running','succeeded','failed','blocked','skipped'];
  return {version:1,...Object.fromEntries(countKeys.map(name=>[name,report[name]===null?null:count(report[name])])),
    complete:report.complete===true,coverageComplete:report.coverageComplete===true,withinTarget:report.withinTarget===true,
    cadenceProven:report.cadenceProven===true,productionAccepted:false,
    inventoryIssueCount:report.inventoryIssues.length,missingTargetCount:report.missingTargets.length,
    nodes:count(graph.nodes.size),byKind:Object.fromEntries(kinds.map(kind=>[kind,[...graph.nodes.values()].filter(node=>node.kind===kind).length])),
    byStatus:Object.fromEntries(statuses.map(status=>[status,[...graph.nodes.values()].filter(node=>node.status===status).length])),
    rawStarts:(graph.execution?.events||[]).filter(event=>event.event==='start'&&event.kind==='raw').length,
    peakConcurrency:count(graph.execution?.peakConcurrency),
    sourceClosedCount:Object.values(graph.execution?.sources||{}).filter(source=>source.closed).length,
    rawBySource:Object.fromEntries(['yahoo','rakuma','mercari'].map(source=>[source,
      {...(rawCounts[source]||{search:0,detail:0,quote:0}),
       starts:count(graph.execution?.sources?.[source]?.starts),
       closure:['source_denied','request_deferred'].includes(graph.execution?.sources?.[source]?.closed)?graph.execution.sources[source].closed:null,
       httpStatus:[401,403,429].includes(graph.execution?.sources?.[source]?.httpStatus)?graph.execution.sources[source].httpStatus:null}]))};
}
