import { pricingDecision,requiredPricingPlatforms } from '../../public/pricing-policy.js';
import { chooseProcurementReference } from './procurement-reference.mjs';

const stamp=value=>typeof value==='number'?value:Date.parse(value||'');
const counts=['total','priceObserved','priceComplete','costVerified','completeItems'];
function summarize(accounts,{startedAt,finishedAt,targetSeconds=1200}={}){
 const start=stamp(startedAt),end=stamp(finishedAt);
 const validWindow=Number.isFinite(start)&&Number.isFinite(end)&&end>=start;
 const durationSeconds=validWindow?(end-start)/1000:null;
 const totals=Object.fromEntries(counts.map(key=>[key,accounts.reduce((n,row)=>n+row[key],0)]));
 const inventoryComplete=accounts.length>0&&accounts.every(row=>row.inventoryComplete);
 const coverageComplete=inventoryComplete&&totals.completeItems===totals.total;
 const withinTarget=validWindow&&durationSeconds<=targetSeconds;
 const cadenceKnown=accounts.length>0&&accounts.every(row=>Number.isFinite(row.completionGapSeconds));
 const completionGapSeconds=cadenceKnown?Math.max(...accounts.map(row=>row.completionGapSeconds)):null;
 const cadenceWithinTarget=cadenceKnown&&completionGapSeconds<=targetSeconds;
 return {version:2,startedAt:validWindow?new Date(start).toISOString():null,finishedAt:validWindow?new Date(end).toISOString():null,
  targetSeconds,durationSeconds,withinTarget,inventoryComplete,...totals,coverageComplete,
  completionGapSeconds,cadenceWithinTarget,
  accepted:validWindow&&withinTarget&&coverageComplete&&cadenceWithinTarget,accounts};
}

// Snapshot publication, an attempted request and a 24-hour cache are not a new
// complete cycle. Count only actual observations made inside this scan window.
// Identity remains bound by the existing validators; timestamps cannot bless it.
export function cycleCoverage(items=[],accounts=[],options={}){
 const start=stamp(options.startedAt),end=stamp(options.finishedAt);
 const priorAccounts=new Map((options.previousCoverage?.accounts||[]).map(row=>[row.accountId,row]));
 const inCycle=value=>{const t=stamp(value);return Number.isFinite(t)&&Number.isFinite(start)&&Number.isFinite(end)&&t>=start&&t<=end};
 const rows=accounts.map(account=>{
  const row={accountId:account.id,inventoryComplete:account.profileStatus==='live',total:0,priceObserved:0,priceComplete:0,costVerified:0,completeItems:0};
  for(const item of items.filter(item=>item.accountId===account.id)){
   row.total++;
   const required=requiredPricingPlatforms(item);
   const observed=required.length>0&&required.every(platform=>inCycle(item[platform]?.checkedAt)&&
    ['ok','incomplete'].includes(item[platform]?.evidenceStatus||item[platform]?.status)&&item[platform]?.cacheReason!=='request_error');
   const priceComplete=observed&&pricingDecision(item,{now:end}).complete;
   const reference=Number.isFinite(end)?chooseProcurementReference(item,{now:end}):null;
   const costVerified=Boolean(reference&&inCycle(reference.checkedAt));
   row.priceObserved+=Number(observed);row.priceComplete+=Number(priceComplete);row.costVerified+=Number(costVerified);
   row.completeItems+=Number(priceComplete&&costVerified);
  }
  const prior=priorAccounts.get(account.id),priorEnd=stamp(prior?.lastCompleteCycleFinishedAt);
  const validPrior=Number.isFinite(priorEnd)&&priorEnd<=start;
  const complete=Number.isFinite(start)&&Number.isFinite(end)&&end>=start&&row.inventoryComplete&&row.completeItems===row.total;
  row.previousCompleteCycleFinishedAt=validPrior?new Date(priorEnd).toISOString():null;
  row.completionGapSeconds=validPrior&&Number.isFinite(end)&&end>=start?(end-priorEnd)/1000:null;
  // An incomplete attempt never advances the complete-cycle clock. The first
  // full collection establishes a baseline; a second on-time one proves cadence.
  row.lastCompleteCycleFinishedAt=complete?new Date(end).toISOString():row.previousCompleteCycleFinishedAt;
  return row;
 });
 // Orphan rows must not disappear from the denominator when account discovery
// or a malformed snapshot omits their account. They can never imply completion.
 const known=new Set(accounts.map(account=>account.id)),orphaned=items.filter(item=>!known.has(item.accountId));
 if(orphaned.length)rows.push({accountId:null,inventoryComplete:false,total:orphaned.length,priceObserved:0,priceComplete:0,costVerified:0,completeItems:0});
 return summarize(rows,options);
}

// Scope the original full-evidence result. Compact dashboards deliberately omit
// sale descriptions, so recomputing supplier identity from those would be wrong.
export function scopeCycleCoverage(coverage,accountIds=[]){
 if(!coverage)return null;
 const allowed=new Set(accountIds);
 return summarize((coverage.accounts||[]).filter(row=>allowed.has(row.accountId)),coverage);
}

// Operational acceptance checks the published scanner result separately from
// source availability or a successful deployment. Never accept an older SHA or
// an old complete snapshot merely because this workflow published successfully.
export function cycleAcceptance(status={}, {now=Date.now(),codeSha}={}){
 const cycle=status.cycleCoverage,rows=cycle?.accounts||[],end=stamp(cycle?.finishedAt),start=stamp(cycle?.startedAt);
 const reasons=[];
 if(cycle?.version!==2||!rows.length)reasons.push('missing_cycle_evidence');
 if(codeSha&&status.codeSha!==codeSha)reasons.push('wrong_code_revision');
 if(!Number.isFinite(end)||!Number.isFinite(start)||end<start||end-start>1200_000||end>now||now-end>1200_000)reasons.push('cycle_time_outside_target');
 const validCounts=row=>['total','priceComplete','costVerified','completeItems'].every(key=>Number.isSafeInteger(row[key])&&row[key]>=0&&row[key]<=row.total);
 if(!Number.isSafeInteger(status.total)||rows.some(row=>!validCounts(row))||rows.reduce((n,row)=>n+row.total,0)!==status.total)reasons.push('invalid_inventory_denominator');
 if(rows.some(row=>row.inventoryComplete!==true||row.completeItems!==row.total||row.priceComplete!==row.total||row.costVerified!==row.total))reasons.push('incomplete_price_or_cost_coverage');
 if(rows.some(row=>{
  const previous=stamp(row.previousCompleteCycleFinishedAt),gap=(end-previous)/1000;
  return !Number.isFinite(previous)||previous>start||gap<0||gap>1200||row.completionGapSeconds!==gap;
 }))reasons.push('complete_cycle_cadence_unproven');
 return {accepted:reasons.length===0,reasons,codeSha:status.codeSha||null,checkedAt:status.checkedAt||null,cycleCoverage:cycle||null};
}
