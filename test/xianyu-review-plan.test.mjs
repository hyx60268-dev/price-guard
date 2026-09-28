import test from 'node:test';
import assert from 'node:assert/strict';
import { xianyuReviewPlan,mergeXianyuReview } from '../scripts/lib/xianyu-review-plan.mjs';
import { XIANYU_VERIFICATION } from '../scripts/lib/xianyu-evidence.mjs';
import { semanticSameItem,hasExplicitVariantMismatch } from '../scripts/lib/rules.mjs';
const now=Date.now(),item={title:'POPMART RIIZE Fluffy Club シリーズぬいぐるみペンダント'};
test('repeated queue and access deferrals retain completed review priority and do not turn errors into negative cooldowns',()=>{
 let value={status:'manual_review',query:'old RIIZE query',verification:XIANYU_VERIFICATION,checkedAt:new Date(now).toISOString()};
 for(const status of ['deferred_limit','deferred_access','deferred_access','deferred_auth']){
  value=mergeXianyuReview(value,{status,samples:[],averageCNY:null});
  assert.equal(value.status,status);assert.equal(value.reviewStatus,'manual_review');
  assert.equal(xianyuReviewPlan(item,{xianyu:value},{now}).changedQuery,true);
 }
 value=mergeXianyuReview(value,{status:'error',query:xianyuReviewPlan(item).query});
 value=mergeXianyuReview(value,{status:'deferred_limit'});
 assert.equal(xianyuReviewPlan(item,{xianyu:value},{now}).skip,false);
 assert.equal(value.reviewStatus,'error');
 value=mergeXianyuReview(value,{status:'page_empty'});
 value=mergeXianyuReview(value,{status:'deferred_limit'});
 assert.equal(xianyuReviewPlan(item,{xianyu:value},{now}).skip,true);
 assert.equal(xianyuReviewPlan(item,{xianyu:value},{now:now+25*3600000}).skip,false);
});
test('corrected query prioritizes the real failed RIIZE case instead of waiting behind unseen inventory',()=>{
 const prior={xianyu:{status:'manual_review',query:'POPMART RIIZE Fluffy Club シリーズ毛绒玩偶ペンダント',verification:XIANYU_VERIFICATION,checkedAt:new Date(now).toISOString()}};
 const plan=xianyuReviewPlan(item,prior,{now});assert.equal(plan.changedQuery,true);assert.equal(plan.skip,false);
 const observedTitle='RIIZE×泡泡玛特Fluffy Club绒绒萌友系列毛绒挂';
 assert.equal(hasExplicitVariantMismatch(plan.query,observedTitle),false);assert.equal(semanticSameItem({query:plan.query,candidate:observedTitle}).accepted,true);
 assert.equal(semanticSameItem({query:plan.query,candidate:'泡泡玛特 RIIZE mini包 耳机包'}).accepted,false);
});
test('skipped negative review preserves its original result without alternating into repeated scans',()=>{
 const query=xianyuReviewPlan(item).query;
 const prior={xianyu:{status:'skipped_recent_review',reviewStatus:'manual_review',query,verification:XIANYU_VERIFICATION,checkedAt:new Date(now).toISOString()}};
 assert.equal(xianyuReviewPlan(item,prior,{now:now+3600000}).skip,true);
 assert.equal(xianyuReviewPlan(item,prior,{now:now+25*3600000}).skip,false);
 for(const status of ['error','blocked','login_required','detail_inaccessible'])assert.equal(xianyuReviewPlan(item,{xianyu:{...prior.xianyu,status}},{now}).skip,false);
});
