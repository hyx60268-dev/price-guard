import { mergeXianyuReview } from './xianyu-review-plan.mjs';
import { XIANYU_VERIFICATION, verifiedCostEvidence } from './xianyu-evidence.mjs';
import { PUBLIC_PROCUREMENT_VERIFICATION, verifiedPublicCostEvidence, procurementTarget, procurementTargetsEqual } from './procurement-evidence.mjs';

const positive=value=>Number.isFinite(value)&&value>0;
const fresh=(value,hours,now)=>{const time=Date.parse(value||'');return Number.isFinite(time)&&time<=now+300000&&now-time<Math.max(0,hours)*3600000};
const publicHours=hours=>Math.min(24,Number.isFinite(Number(hours))&&Number(hours)>0?Number(hours):24);
export { procurementTarget } from './procurement-evidence.mjs';

// Public references are scoped to the exact inventory row, including its image.
// A relist or renamed/changed variant must be checked again; manual costs remain separate.
export function sameProcurementTarget(target,item={}){
 return procurementTargetsEqual(target,procurementTarget(item));
}
export function bindProcurementTarget(reference={},item={}){
 // Never rewrite sample targets: they describe which item the collector verified.
 return {...reference,target:procurementTarget(item)};
}

export function verifiedXianyuReference(item={}, {now=Date.now(),xianyuFreshHours=168}={}){
 const cost=item.xianyu||{},evidence=verifiedCostEvidence(cost.samples);
 // Old snapshots stored only the top-level amount. Once a provider is explicit,
 // another provider's amount must never be borrowed to validate Xianyu evidence.
 const amount=Object.hasOwn(cost,'averageCNY')?cost.averageCNY:
  !item.referenceProvider||item.referenceProvider==='xianyu'?item.averageCNY:null;
 if(cost.verification!==XIANYU_VERIFICATION||!evidence.ready||!positive(amount)||
  Math.abs(amount-evidence.median)>=.01||!fresh(cost.checkedAt,Number(xianyuFreshHours)||168,now))return null;
 return {averageCNY:evidence.median,referenceProvider:'xianyu',sourceLabel:'闲鱼',checkedAt:cost.checkedAt,samples:evidence.samples};
}

export function verifiedPublicProcurementCache(item={}, {now=Date.now(),maxAgeHours=24}={}){
 const cost=item.procurementSource||{},hours=publicHours(maxAgeHours);
 if(cost.verification!==PUBLIC_PROCUREMENT_VERIFICATION||!sameProcurementTarget(cost.target,item)||
  !fresh(cost.checkedAt,hours,now)||!positive(cost.averageCNY)||!Array.isArray(cost.samples)||
  !cost.samples.length||!cost.samples.every(sample=>sameProcurementTarget(sample.target,item)))return null;
 const evidence=verifiedPublicCostEvidence(cost.samples,{now,maxAgeHours:hours});
 if(!evidence.ready||Math.abs(cost.averageCNY-evidence.median)>=.01)return null;
 return {...cost,averageCNY:evidence.median,samples:evidence.samples,referenceProvider:'public_cn',
  sourceLabel:'国内采购渠道',checkedAt:cost.checkedAt};
}

export function chooseProcurementReference(item={},options={}){
 const xianyu=verifiedXianyuReference(item,options);
 if(xianyu)return xianyu;
 const other=verifiedPublicProcurementCache(item,{now:options.now,maxAgeHours:options.maxPublicAgeHours});
 if(!other)return null;
 return {averageCNY:other.averageCNY,referenceProvider:'public_cn',sourceLabel:other.sourceLabel,checkedAt:other.checkedAt,samples:other.samples};
}

export function hasCompletedPublicProcurementReview(item={}, {now=Date.now(),maxAgeHours=24}={}){
 const cost=item.procurementSource||{};
 if(verifiedPublicProcurementCache(item,{now,maxAgeHours}))return true;
 return cost.status==='incomplete'&&cost.verification===PUBLIC_PROCUREMENT_VERIFICATION&&cost.reviewVersion===1&&
  sameProcurementTarget(cost.target,item)&&fresh(cost.reviewedAt,publicHours(maxAgeHours),now);
}

// An attempted request is not a new price observation. Retaining a valid older
// reference keeps its original evidence timestamp even when the retry fails.
export function mergeXianyuCostEvidence(priorItem={},current={},options={}){
 const prior=priorItem.xianyu||{},merged=mergeXianyuReview(prior,current);
 const attempted=!['cached_verified','skipped_recent_review','deferred_limit','deferred_access','deferred_auth','not_requested'].includes(current.status)&&Boolean(current.status);
 const lastAttemptAt=attempted&&current.checkedAt?current.checkedAt:prior.lastAttemptAt;
 const live=['ok','cached_verified'].includes(current.status)?verifiedXianyuReference({xianyu:current},options):null;
 if(live)return {...merged,averageCNY:live.averageCNY,samples:live.samples,checkedAt:live.checkedAt,lastAttemptAt,
  verification:XIANYU_VERIFICATION,costEvidenceStatus:current.status==='ok'?'verified':'cached_verified'};
 const cached=verifiedXianyuReference(priorItem,options);
 if(cached)return {...merged,averageCNY:cached.averageCNY,samples:cached.samples,checkedAt:cached.checkedAt,lastAttemptAt,
  verification:XIANYU_VERIFICATION,costEvidenceStatus:'cached_verified'};
 return {...merged,averageCNY:null,samples:[],lastAttemptAt,costEvidenceStatus:'missing'};
}
