import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseProcurementReference,mergeXianyuCostEvidence,verifiedPublicProcurementCache,verifiedXianyuReference,bindProcurementTarget,procurementTarget,sameProcurementTarget,hasCompletedPublicProcurementReview } from '../scripts/lib/procurement-reference.mjs';
import { verifiedXianyuCache } from '../scripts/lib/planner.mjs';
import { XIANYU_VERIFICATION } from '../scripts/lib/xianyu-evidence.mjs';
import { procurementTargetsEqual,verifiedPublicCostEvidence } from '../scripts/lib/procurement-evidence.mjs';
import { publicProcurementItem } from './fixtures/procurement-reference.mjs';
const now=Date.parse('2026-10-01T17:00:00Z');
const withXianyu=item=>({...item,xianyu:{averageCNY:95,verification:XIANYU_VERIFICATION,checkedAt:new Date(now).toISOString(),samples:[
 {id:'x1',sellerKey:'x-a',price:90,priceSource:'target_detail'},{id:'x2',sellerKey:'x-b',price:100,priceSource:'target_detail'}]}});

test('fresh public procurement chooses an independently verified landed amount without mutating Xianyu',()=>{
 const item=publicProcurementItem(now);item.xianyu={status:'deferred_access',averageCNY:null,samples:[]};
 const before=structuredClone(item),selected=chooseProcurementReference(item,{now});
 assert.equal(selected.referenceProvider,'public_cn');assert.equal(selected.averageCNY,105);
 assert.equal(selected.sourceLabel,'国内采购渠道');assert.deepEqual(item,before);
 assert.equal(verifiedXianyuReference(item,{now}),null);
});

test('valid Xianyu reference stays preferred and cannot borrow a public top-level amount',()=>{
 const item=withXianyu(publicProcurementItem(now));
 assert.equal(chooseProcurementReference(item,{now}).averageCNY,95);
 delete item.xianyu.averageCNY;
 assert.equal(verifiedXianyuReference(item,{now}),null);
 assert.equal(chooseProcurementReference(item,{now}).averageCNY,105);
 delete item.referenceProvider;item.averageCNY=95;
 assert.equal(verifiedXianyuReference(item,{now}).averageCNY,95);
});

test('public cache cannot survive account, relist, title, image or sample target changes',()=>{
 for(const field of ['accountId','id','title','image']){
  const item=publicProcurementItem(now);item[field]+='-different';
  assert.equal(verifiedPublicProcurementCache(item,{now}),null,field);
  const sampleChanged=publicProcurementItem(now);sampleChanged.procurementSource.samples[0].target[field]+='-different';
  assert.equal(verifiedPublicProcurementCache(sampleChanged,{now}),null,'sample '+field);
 }
 const item=publicProcurementItem(now);delete item.accountId;
 assert.equal(verifiedPublicProcurementCache(item,{now}),null);
 const bound=bindProcurementTarget(item.procurementSource,{...item,accountId:'another-shop'});
 assert.deepEqual(bound.target,procurementTarget({...item,accountId:'another-shop'}));
 assert.equal(bound.samples[0].target.accountId,'shop-a');
});

test('public reference uses a hard 24-hour limit, checks sample freshness and rejects future or altered amounts',()=>{
 for(const change of [
  item=>item.procurementSource.checkedAt=new Date(now-86400000).toISOString(),
  item=>item.procurementSource.checkedAt=new Date(now+300001).toISOString(),
  item=>item.procurementSource.samples[0].checkedAt=new Date(now-86400001).toISOString(),
  item=>item.procurementSource.averageCNY=1,
  item=>item.procurementSource.samples[1].sellerIdentityKey=item.procurementSource.samples[0].sellerIdentityKey,
  item=>item.procurementSource.samples[0].shippingKnown=false,
  item=>item.procurementSource.samples[0].skuVerified=false]){
  const item=publicProcurementItem(now);change(item);
  assert.equal(verifiedPublicProcurementCache(item,{now,maxAgeHours:168}),null);
 }
 const item=publicProcurementItem(now);
 assert.ok(verifiedPublicProcurementCache(item,{now:now+86399000}));
 assert.equal(verifiedPublicProcurementCache(item,{now:now+86400000}),null);
});

test('a completed no-match review is distinct from an unavailable or deferred attempt',()=>{
 for(const status of ['incomplete','unavailable','deferred']){
  const item=publicProcurementItem(now);Object.assign(item.procurementSource,{status,averageCNY:null,samples:[]});
  assert.equal(hasCompletedPublicProcurementReview(item,{now}),status==='incomplete');
  assert.equal(chooseProcurementReference(item,{now}),null);
 }
 const item=publicProcurementItem(now);Object.assign(item.procurementSource,{status:'incomplete',averageCNY:null,samples:[],reviewVersion:0});
 assert.equal(hasCompletedPublicProcurementReview(item,{now}),false);
});

test('a failed current attempt cannot extend the age of historical Xianyu prices',()=>{
 const prior=withXianyu(publicProcurementItem(now));prior.xianyu.checkedAt=new Date(now-3600000).toISOString();
 prior.xianyu.reviewedAt=prior.xianyu.checkedAt;prior.xianyu.reviewVersion=XIANYU_VERIFICATION;
 const failure={status:'login_required',checkedAt:new Date(now).toISOString(),averageCNY:null,samples:[]};
 const merged=mergeXianyuCostEvidence(prior,failure,{now,xianyuFreshHours:2});
 assert.equal(merged.status,'login_required');assert.equal(merged.reviewStatus,'login_required');
 assert.equal(merged.checkedAt,prior.xianyu.checkedAt);assert.equal(merged.lastAttemptAt,failure.checkedAt);
 assert.equal(merged.averageCNY,95);assert.equal(merged.costEvidenceStatus,'cached_verified');
 assert.equal(verifiedXianyuReference({xianyu:merged},{now:now+3600000,xianyuFreshHours:2}),null);
});

test('expired prior evidence and explicit null or altered Xianyu amounts never revive from a retry',()=>{
 const prior=withXianyu(publicProcurementItem(now));prior.xianyu.checkedAt=new Date(now-3*3600000).toISOString();
 const failure={status:'error',checkedAt:new Date(now).toISOString(),averageCNY:null,samples:[]};
 const merged=mergeXianyuCostEvidence(prior,failure,{now,xianyuFreshHours:2});
 assert.equal(merged.averageCNY,null);assert.deepEqual(merged.samples,[]);assert.equal(merged.lastAttemptAt,failure.checkedAt);
 for(const amount of [null,undefined,1]){
  const item=withXianyu(publicProcurementItem(now));item.referenceProvider='xianyu';item.averageCNY=95;item.xianyu.averageCNY=amount;
  assert.equal(verifiedXianyuCache(item),null);assert.equal(verifiedXianyuReference(item,{now}),null);
 }
});

test('a newly verified Xianyu observation replaces the old timestamp, while deferred work adds no attempt',()=>{
 const prior=withXianyu(publicProcurementItem(now));prior.xianyu.checkedAt=new Date(now-3600000).toISOString();
 const current={...prior.xianyu,status:'ok',checkedAt:new Date(now).toISOString()};
 const live=mergeXianyuCostEvidence(prior,current,{now});
 assert.equal(live.checkedAt,current.checkedAt);assert.equal(live.lastAttemptAt,current.checkedAt);assert.equal(live.costEvidenceStatus,'verified');
 const deferred=mergeXianyuCostEvidence(prior,{status:'deferred_access',averageCNY:null,samples:[]},{now});
 assert.equal(deferred.checkedAt,prior.xianyu.checkedAt);assert.equal(deferred.lastAttemptAt,undefined);assert.equal(deferred.averageCNY,95);
 const invalid={...current,averageCNY:1};
 assert.equal(mergeXianyuCostEvidence({},invalid,{now}).averageCNY,null);
});

test('observed quantity or condition changes invalidate both cached public prices and the final selected reference',()=>{
 for(const change of [item=>item.sourceDetail.description='红色整套礼盒 2 套，含 AeroClip 2 耳机。',
  item=>item.sourceDetail.condition='中古',item=>item.sourceDetail.description='',item=>item.sourceDetail.condition='']){
  const item=publicProcurementItem(now);assert.ok(verifiedPublicProcurementCache(item,{now}));change(item);
  assert.equal(verifiedPublicProcurementCache(item,{now}),null);assert.equal(chooseProcurementReference(item,{now}),null);
  assert.equal(sameProcurementTarget(item.procurementSource.target,item),false);
  assert.equal(hasCompletedPublicProcurementReview(item,{now}),false);
 }
});

test('newly observed semantics invalidate explicit unknown bindings and legacy four-field bindings never qualify',()=>{
 const item=publicProcurementItem(now);delete item.sourceDetail;delete item.description;delete item.condition;
 const unknown=procurementTarget(item);item.procurementSource.target=unknown;
 for(const sample of item.procurementSource.samples)sample.target={...unknown};
 assert.ok(verifiedPublicProcurementCache(item,{now}));
 item.sourceDetail={description:'红色整套礼盒 2 套',condition:'新品、未使用'};
 assert.equal(verifiedPublicProcurementCache(item,{now}),null);
 const legacy=publicProcurementItem(now);delete legacy.procurementSource.target.description;delete legacy.procurementSource.target.condition;
 assert.equal(verifiedPublicProcurementCache(legacy,{now}),null);
 const legacySamples=publicProcurementItem(now);for(const sample of legacySamples.procurementSource.samples){delete sample.target.description;delete sample.target.condition;}
 assert.equal(verifiedPublicCostEvidence(legacySamples.procurementSource.samples,{now}).ready,false);
});

test('full observed description is bound without truncation while whitespace-only changes remain equivalent',()=>{
 const item=publicProcurementItem(now),target=item.procurementSource.target;
 item.sourceDetail.description='  '+target.description.replaceAll(' ','  ')+'\n';
 item.sourceDetail.condition='  新品、未使用  ';
 assert.ok(verifiedPublicProcurementCache(item,{now}));
 const original='商品説明。'.repeat(500)+' 1セット';item.sourceDetail.description=original;
 const before=procurementTarget(item);item.sourceDetail.description=original.replace('1セット','2セット');
 assert.equal(procurementTargetsEqual(before,procurementTarget(item)),false);
 const sampleChanged=publicProcurementItem(now);sampleChanged.procurementSource.samples[0].target.condition='中古';
 assert.equal(verifiedPublicCostEvidence(sampleChanged.procurementSource.samples,{now}).ready,false);
 assert.equal(verifiedPublicProcurementCache(sampleChanged,{now}),null);
});

test('structured source condition preserves names, IDs and nested labels instead of becoming unknown',()=>{
 const item=publicProcurementItem(now);
 item.sourceDetail.condition={name:'新品、未使用',key:'unused',metadata:{label:' New ',code:1}};
 const bound=procurementTarget(item);item.procurementSource.target={...bound};
 for(const sample of item.procurementSource.samples)sample.target={...bound};
 assert.notEqual(bound.condition,'');assert.ok(verifiedPublicProcurementCache(item,{now}));
 item.sourceDetail.condition={metadata:{code:1,label:'New'},key:'unused',name:'新品、未使用'};
 assert.ok(verifiedPublicProcurementCache(item,{now}),'key order and whitespace are stable');
 item.sourceDetail.condition.name='中古';
 assert.equal(verifiedPublicProcurementCache(item,{now}),null);
 item.sourceDetail.condition.name='新品、未使用';item.sourceDetail.condition.key='used';
 assert.equal(chooseProcurementReference(item,{now}),null);
 item.sourceDetail.condition={};
 assert.equal(verifiedPublicProcurementCache(item,{now}),null);
});
