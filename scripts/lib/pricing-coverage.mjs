import { pricingDecision,requiredPricingPlatforms } from '../../public/pricing-policy.js';
import { MATCHING_RULES_VERSION } from './rules.mjs';

export function cachedComparison(value,reason='fresh_cache'){
  if(!value||value.rulesVersion!==MATCHING_RULES_VERSION||!value.checkedAt)return null;
  const evidenceStatus=value.evidenceStatus||value.status;
  if(!['ok','incomplete'].includes(evidenceStatus))return null;
  return {...value,status:'cached',evidenceStatus,cacheReason:reason==='fresh_cache'&&value.cacheReason==='request_error'?'request_error':reason};
}
// Deferral is an attempted read, not fresh evidence. Keep accepted quote and
// broad-search clocks unchanged; the existing request_error policy disables it.
export function deferredYahooComparison(prior={},error={}){
  return {...prior,status:prior.checkedAt?'cached':'deferred_budget',evidenceStatus:prior.evidenceStatus||prior.status,
    checkedAt:prior.checkedAt||null,cacheReason:'request_error',deferredReason:error.reason||'request_deadline',
    retryAt:error.retryAt??null};
}
export function comparisonIncomplete(value={}){
  return !['ok','cached'].includes(value.evidenceStatus||value.status)||value.cacheReason==='request_error';
}
export function pricingCoverage(items=[],accounts=[]){
  const platforms={};
  for(const platform of ['yahoo','rakuma','mercari']){
    const eligible=items.filter(item=>requiredPricingPlatforms(item).includes(platform));
    const checked=eligible.filter(item=>item[platform]?.rulesVersion===MATCHING_RULES_VERSION&&
      ['ok','incomplete'].includes(item[platform]?.evidenceStatus||item[platform]?.status)&&item[platform]?.checkedAt);
    const incomplete=checked.filter(item=>!pricingDecision(item).coverage[platform]).length;
    platforms[platform]={total:eligible.length,checked:checked.length,remaining:eligible.length-checked.length,
      incomplete,complete:checked.length===eligible.length&&incomplete===0};
  }
  return {rulesVersion:MATCHING_RULES_VERSION,platforms,
    inventoryComplete:accounts.every(account=>account.profileStatus==='live'),
    complete:accounts.every(account=>account.profileStatus==='live')&&items.every(item=>pricingDecision(item).complete)&&Object.values(platforms).every(row=>row.complete)};
}
