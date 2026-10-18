import test from 'node:test';
import assert from 'node:assert/strict';
import { pricingStatus,pricingSummary } from '../public/pricing-status.js';
import { PRICING_RULES_VERSION } from '../public/pricing-policy.js';
const now=Date.now(),options={now};
const source=()=>({rulesVersion:PRICING_RULES_VERSION,status:'ok',checkedAt:new Date(now).toISOString(),candidates:[]});
const item=()=>({ownPrice:20000,yahoo:source(),rakuma:source(),mercari:source()});
test('old inventory has no misleading zero adjustment count',()=>{
 const rows=Array.from({length:1166},()=>({ownPrice:20000,yahoo:{...source(),rulesVersion:19}}));
 const s=pricingSummary(rows,options);assert.equal(s.value,'—');assert.equal(s.label,'比价更新中');assert.equal(s.ready,0);assert.equal(s.queued,1166);
});
test('actual failure, expired evidence, missing shipping and pending batches remain distinct',()=>{
 for(const [sourcePatch,state] of [[{status:'error'},'error'],[{checkedAt:new Date(now-7*3600000).toISOString()},'stale'],[{status:'incomplete',rejected:[{reason:'shipping_unconfirmed'}]},'insufficient'],[{status:'deferred_limit',checkedAt:null},'queued']]){
  const row=item();Object.assign(row.mercari,sourcePatch);const status=pricingStatus(row,options);assert.equal(status.state,state);assert.equal(status.complete,false);if(state==='insufficient')assert.equal(status.platforms[2].reason,'运费未确认');
 }
});
test('partial inventory reports verified advice separately from remaining inventory',()=>{
 const ready=item();ready.yahoo.candidates=[{price:19000,url:'https://example.test/item',matchMethod:'verified'}];
 const pending=item();delete pending.mercari;
 const s=pricingSummary([ready,pending],options);assert.equal(s.value,1);assert.equal(s.ready,1);assert.equal(s.remaining,1);assert.match(s.note,/部分平台已核验的降价参考/);
 assert.equal(pricingSummary([item()],options).value,0);assert.equal(pricingSummary([item()],options).label,'建议调价');
});
test('status counts use the selected account inventory without mixing accounts',()=>{
 const rows=['melon','momo','new-shop'].map(accountId=>({...item(),accountId}));delete rows[0].mercari;rows[1].mercari.status='error';
 for(const [accountId,state] of [['melon','queued'],['momo','error'],['new-shop','ready']])assert.equal(pricingSummary(rows.filter(row=>row.accountId===accountId),options)[state],1);
});


test('recognized deadline and priority deferrals stay separate from actual collection errors without promoting evidence',()=>{
 for(const deferredReason of ['request_deadline','request_cooldown_deadline','deferred_due_to_priority','deferred_due_to_comparison_audit'])for(const rulesVersion of [PRICING_RULES_VERSION,22]){
  const row={platform:'yahoo',comparisonMode:'same_platform',ownPrice:20000,yahoo:{...source(),rulesVersion,status:'cached',cacheReason:'request_error',deferredReason,checkedAt:new Date(now-7*3600000).toISOString()}};
  const saved=structuredClone(row),status=pricingStatus(row,options),summary=pricingSummary([row],options);
  assert.equal(status.state,'deferred');assert.equal(status.complete,false);assert.equal(status.decision.canRecommend,false);
  assert.equal(summary.ready,0);assert.equal(summary.deferred,1);assert.equal(summary.error,0);assert.equal(summary.value,'—');
  assert.deepEqual(row,saved);
 }
 for(const patch of [{status:'error',deferredReason:'request_deadline'},{status:'cached',deferredReason:'unknown_failure'},{status:'cached',deferredReason:null}]){
  const row={platform:'yahoo',comparisonMode:'same_platform',ownPrice:20000,yahoo:{...source(),cacheReason:'request_error',...patch}};
  assert.equal(pricingStatus(row,options).state,'error');
 }
});

test('reported 1447 deferred records are not labeled HTTP failures and remain outside valid coverage',()=>{
 const ready=Array.from({length:16},()=>({platform:'yahoo',comparisonMode:'same_platform',ownPrice:20000,yahoo:source()}));
 const unknown=Array.from({length:4},()=>({platform:'yahoo',comparisonMode:'same_platform',ownPrice:20000,yahoo:{...source(),status:'incomplete'}}));
 const delayed=(count,platform,reason)=>Array.from({length:count},()=>({platform,comparisonMode:'same_platform',ownPrice:20000,[platform]:{...source(),status:'cached',cacheReason:'request_error',deferredReason:reason}}));
 const summary=pricingSummary([...ready,...unknown,...delayed(610,'yahoo','request_cooldown_deadline'),...delayed(837,'rakuma','deferred_due_to_priority')],options);
 assert.equal(summary.total,1467);assert.equal(summary.ready,16);assert.equal(summary.insufficient,4);assert.equal(summary.deferred,1447);assert.equal(summary.error,0);assert.equal(summary.actionable,0);
});
