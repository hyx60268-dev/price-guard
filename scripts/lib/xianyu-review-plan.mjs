import { XIANYU_VERIFICATION } from './xianyu-evidence.mjs';
import { xianyuQueryFor } from './discovery.mjs';
const deferredStatuses=new Set(['skipped_recent_review','deferred_limit','deferred_access','deferred_auth','not_requested']);
export function mergeXianyuReview(prior={},current={}){
 const reviewStatus=deferredStatuses.has(current.status)
  ? (deferredStatuses.has(prior.status)?prior.reviewStatus:prior.status)
  : current.status;
 return {...prior,...current,reviewStatus};
}
export function xianyuReviewPlan(item,prior={}, {now=Date.now(),retryHours=24}={}){
 const value=prior.xianyu||{},query=xianyuQueryFor(item.xianyuQuery||item.title||'');
 const status=deferredStatuses.has(value.status)?value.reviewStatus:value.status,negative=['manual_review','page_empty'].includes(status);
 const changedQuery=negative&&Boolean(value.query)&&value.query!==query;
 const stamp=Date.parse(value.checkedAt||'');
 const skip=negative&&value.verification===XIANYU_VERIFICATION&&value.query===query&&Number.isFinite(stamp)&&stamp<=now&&now-stamp<retryHours*3600000;
 return {query,changedQuery,skip,reviewStatus:status};
}
