import {summarizeSavedComparisonAudit} from './comparison-audit-summary.mjs';
import {classifyYahooCardConflict,YAHOO_CARD_CONFLICT_REASONS} from './yahoo-card-conflicts.mjs';
import {planYahooCardDetailOrder,summarizeYahooCardTitleGates} from './yahoo-card-detail-plan.mjs';

const reasons=new Set(YAHOO_CARD_CONFLICT_REASONS);
const histogram=rows=>{const result={};for(const row of rows){const key=reasons.has(row.conflict.reason)?row.conflict.reason:'unknown_reason';result[key]=(result[key]||0)+1;}return result;};
const sum=(rows,fn)=>rows.filter(fn).length;
// Selection model only, under the ORIGINAL 80 total / 64 detail / 32 per-target
// limits. No request is made; retained observations are never re-dated.
function schedule(targets,prerequisiteReads){
 const remaining=targets.map(target=>[...target.order.rows]),used=targets.map(()=>0),selected=targets.map(()=>[]),readIds=new Set();
 const budget=Math.max(0,Math.min(64,80-prerequisiteReads));
 for(;;){
  let progressed=false;
  for(let index=0;index<targets.length;index++){
   if(!remaining[index].length)continue;
   const other=1-index,allowance=32+(remaining[other].length===0?Math.max(0,32-used[other]):0);
   // Like the original controller, cached pages remain usable even if a
   // preceding uncached candidate can no longer receive a page reservation.
   const position=remaining[index].findIndex(row=>readIds.has(row.id)||readIds.size<budget&&used[index]<allowance);
   if(position<0)continue;
   const [next]=remaining[index].splice(position,1),cached=readIds.has(next.id);
   selected[index].push(next);progressed=true;
   if(!cached){readIds.add(next.id);used[index]++;}
  }
  if(!progressed)break;
 }
 return {selected,requests:used,uniqueRequests:readIds.size,budget};
}
export function summarizeSavedCardCounterfactual(state,{now=Date.now()}={}){
 const original=summarizeSavedComparisonAudit(state,{now});
 if(!original.valid)return {valid:false,reason:'saved_audit_invalid'};
 try{
  const targets=state.comparisonAudit.targets.map(target=>{
   const eligible=target.rows.filter(row=>row.eligible).map(row=>{
    const decisions=row.cardObservations.map(card=>classifyYahooCardConflict({ownDetail:target.ownObservation,card}));
    // Multiple inconsistent cards cannot prove exclusion. Every observation
    // must independently establish a definitive contradiction.
    const exclude=decisions.length>0&&decisions.every(result=>result.classification==='definitive_conflict');
    return {row,exclude,conflict:exclude?decisions[0]:decisions.find(result=>result.classification==='unresolved')||
     {classification:'unresolved',reason:'no_definitive_card_conflict'}};
   });
   const retained=eligible.filter(entry=>!entry.exclude);
   const planRows=entries=>entries.map(({row})=>({id:row.id,title:row.cardObservations[0].title,
    priceJPY:row.priceComparison.status==='confirmed_lower'?row.priceComparison.observations[0].deliveredPriceJPY:null}));
   const context={ownTitle:target.ownObservation.title,ownPriceJPY:target.ownObservation.priceJPY};
   const order=planYahooCardDetailOrder({...context,rows:planRows(retained)});
   const titleGateDiagnostics={eligible:summarizeYahooCardTitleGates({...context,rows:planRows(eligible)}),
    retained:summarizeYahooCardTitleGates({...context,rows:planRows(retained)})};
   return {target,eligible,retained,order,titleGateDiagnostics};
  });
  const entries=targets.flatMap(target=>target.eligible),byId=new Map();
  for(const entry of entries){if(!byId.has(entry.row.id))byId.set(entry.row.id,[]);byId.get(entry.row.id).push(entry);}
  const requests=state.comparisonAudit.controller.requests.filter(row=>row.transportStarted&&['known','detail'].includes(row.kind));
  const requestedIds=new Set(requests.map(row=>row.candidateId));
  // Conservative source-level saving: a shared page is avoidable only if ALL
  // eligible target uses would be excluded, including previously unpaired uses.
  const avoidableIds=new Set([...requestedIds].filter(id=>byId.has(id)&&byId.get(id).every(entry=>entry.exclude)));
  const prerequisiteReads=state.comparisonAudit.controller.counts.pageFetches-requests.length;
  const planned=schedule(targets,prerequisiteReads);
  const counts=target=>{
   const excluded=target.eligible.filter(entry=>entry.exclude);
   const excludedIds=new Set(excluded.map(entry=>entry.row.id));
   return {eligible:target.eligible.length,definitiveConflict:excluded.length,retained:target.retained.length,
    excludedPreviouslyPaired:sum(excluded,entry=>entry.row.paired),
    excludedPreviouslyStrictRejected:sum(excluded,entry=>entry.row.paired&&entry.row.baseline?.status==='rejected'),
    excludedPreviouslyStrictComparable:sum(excluded,entry=>entry.row.paired&&entry.row.baseline?.status==='comparable'),
    excludedPreviouslyStrictLower:sum(excluded,entry=>entry.row.paired&&entry.row.baseline?.status==='comparable'&&entry.row.baseline?.lowerThanOwn===true),
    excludedPreviouslyUnpairedUnknown:sum(excluded,entry=>!entry.row.paired),
    excludedOriginalNetworkAttempts:requests.filter(request=>request.targetId===target.target.targetId&&excludedIds.has(request.candidateId)).length};
  };
  const results=targets.map((target,index)=>{
   const selectedIds=new Set(planned.selected[index].map(row=>row.id));
   const selected=target.retained.filter(entry=>selectedIds.has(entry.row.id));
   return {targetId:target.target.targetId,counts:counts(target),conflictReasons:histogram(target.eligible.filter(entry=>entry.exclude)),
    retainedReasons:histogram(target.retained),orderTiers:target.order.counts,titleGateDiagnostics:target.titleGateDiagnostics,
    planned:{selectedRows:selected.length,newPageReads:planned.requests[index],
     explorationRows:planned.selected[index].filter(row=>row.exploration).length,
     previouslyPaired:sum(selected,entry=>entry.row.paired),previouslyUnpairedUnknown:sum(selected,entry=>!entry.row.paired),
     previouslyStrictRejected:sum(selected,entry=>entry.row.paired&&entry.row.baseline?.status==='rejected'),
     previouslyStrictComparable:sum(selected,entry=>entry.row.paired&&entry.row.baseline?.status==='comparable'),
     retainedButNotSelected:target.retained.length-selected.length}};
  });
  return {valid:true,version:1,scope:'offline_counterfactual_of_saved_observations',source:original.source,
   sourceRequestsMade:0,stateWrites:0,canRecommend:false,targets:results,
   originalUniqueDetailRequests:requestedIds.size,originalDetailAttempts:requests.length,
   potentiallyAvoidableUniqueDetailRequests:avoidableIds.size,
   retainedOriginalUniqueDetailRequests:requestedIds.size-avoidableIds.size,
   planned:{prerequisitePageReads:prerequisiteReads,availableDetailPages:planned.budget,
    uniqueDetailPages:planned.uniqueRequests,selectedTargetRows:planned.selected.reduce((total,rows)=>total+rows.length,0)},
   interpretation:[
    'Potentially avoidable reads are a counterfactual, not measured new-run savings.',
    'Only distinct originally requested IDs excluded for every eligible target use count as potentially avoidable.',
    'The recorded strict baseline has its own limitations; agreement is not independent human ground truth.',
    'Excluded or selected previously unpaired rows have unknown detail outcomes; zero recorded comparable exclusions does not prove lossless recall.',
    'The queue model reserves one in four slots for uncertain low-price exploration and keeps all retained IDs reachable.',
    'Page counts model the original limits only. They establish neither timing nor complete inventory coverage.'
   ]};
 }catch{return {valid:false,reason:'counterfactual_invalid'};}
}
