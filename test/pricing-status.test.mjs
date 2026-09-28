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
 const s=pricingSummary([ready,pending],options);assert.equal(s.value,1);assert.equal(s.ready,1);assert.equal(s.remaining,1);assert.match(s.note,/降价参考可使用已核验同款/);
 assert.equal(pricingSummary([item()],options).value,0);assert.equal(pricingSummary([item()],options).label,'建议调价');
});
test('status counts use the selected account inventory without mixing accounts',()=>{
 const rows=['melon','momo','new-shop'].map(accountId=>({...item(),accountId}));delete rows[0].mercari;rows[1].mercari.status='error';
 for(const [accountId,state] of [['melon','queued'],['momo','error'],['new-shop','ready']])assert.equal(pricingSummary(rows.filter(row=>row.accountId===accountId),options)[state],1);
});
