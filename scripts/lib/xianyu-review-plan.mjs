import { XIANYU_VERIFICATION } from './xianyu-evidence.mjs';
import { xianyuQueryFor } from './discovery.mjs';
export function xianyuReviewPlan(item,prior={}, {now=Date.now(),retryHours=24}={}){
 const value=prior.xianyu||{},query=xianyuQueryFor(item.xianyuQuery||item.title||'');
 const status=value.status==='skipped_recent_review'?value.reviewStatus:value.status,negative=['manual_review','page_empty'].includes(status);
 const changedQuery=negative&&Boolean(value.query)&&value.query!==query;
 const stamp=Date.parse(value.checkedAt||'');
 const skip=negative&&value.verification===XIANYU_VERIFICATION&&value.query===query&&Number.isFinite(stamp)&&stamp<=now&&now-stamp<retryHours*3600000;
 return {query,changedQuery,skip,reviewStatus:status};
}
