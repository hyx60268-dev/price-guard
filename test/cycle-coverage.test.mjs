import test from 'node:test';
import assert from 'node:assert/strict';
import { cycleCoverage,scopeCycleCoverage } from '../scripts/lib/cycle-coverage.mjs';
import { PRICING_RULES_VERSION } from '../public/pricing-policy.js';
import { publicProcurementItem } from './fixtures/procurement-reference.mjs';
const start=Date.parse('2026-10-15T22:00:00Z'),end=start+600_000;
const options={startedAt:start,finishedAt:end,previousCoverage:{accounts:[{accountId:'shop-a',lastCompleteCycleFinishedAt:new Date(start-600_000).toISOString()}]}};
const account={id:'shop-a',profileStatus:'live'};
function row(time=start+60_000){
 const item=publicProcurementItem(time);
 return {...item,platform:'yahoo_fleamarket',comparisonMode:'same_platform',yahoo:{status:'ok',rulesVersion:PRICING_RULES_VERSION,checkedAt:new Date(time).toISOString(),candidates:[]}};
}
test('complete current price and verified actual cost are required for every product in the cycle',()=>{
 const full=cycleCoverage([row()],[account],options);
 assert.equal(full.accepted,true);assert.equal(full.completeItems,1);assert.equal(full.durationSeconds,600);
 const old=row(start-1),mixed=cycleCoverage([row(),{...old,id:'old'}],[account],options);
 assert.equal(mixed.total,2);assert.equal(mixed.priceObserved,1);assert.equal(mixed.costVerified,1);assert.equal(mixed.accepted,false);
});
test('fresh snapshot, attempts, manual costs and invalid amounts cannot manufacture current cost evidence',()=>{
 const item=row();item.procurementSource.averageCNY=1;item.checkedAt=new Date(end).toISOString();item.manualCost={purchaseCNY:100};
 const result=cycleCoverage([item],[account],options);assert.equal(result.priceComplete,1);assert.equal(result.costVerified,0);assert.equal(result.accepted,false);
 const failed=row();Object.assign(failed.yahoo,{status:'cached',cacheReason:'request_error',lastAttemptAt:new Date(end).toISOString()});
 assert.equal(cycleCoverage([failed],[account],options).priceObserved,0);
 const incomplete=row();incomplete.yahoo.status='incomplete';
 const checked=cycleCoverage([incomplete],[account],options);assert.equal(checked.priceObserved,1);assert.equal(checked.priceComplete,0);assert.equal(checked.accepted,false);
});
test('time limit, future observations, failed inventory and orphan rows fail closed',()=>{
 assert.equal(cycleCoverage([row()],[account],{...options,finishedAt:start+1200_001}).accepted,false);
 assert.equal(cycleCoverage([row(end+1)],[account],options).priceObserved,0);
 assert.equal(cycleCoverage([row()],[{...account,profileStatus:'cached'}],options).accepted,false);
 assert.equal(cycleCoverage([row()],[],options).total,1);assert.equal(cycleCoverage([row()],[],options).accepted,false);
 assert.equal(cycleCoverage([],[],options).accepted,false);
 assert.equal(cycleCoverage([row()],[account],{startedAt:'invalid',finishedAt:end}).accepted,false);
});
test('employee aggregates retain only authorized account coverage and do not reuse global acceptance',()=>{
 const coverage=cycleCoverage([row(),{...row(),accountId:'hidden',id:'hidden'}],[account,{id:'hidden',profileStatus:'cached'}],options);
 assert.equal(coverage.accepted,false);
 const visible=scopeCycleCoverage(coverage,['shop-a']);assert.equal(visible.accepted,true);assert.equal(visible.total,1);
 assert.equal(JSON.stringify(visible).includes('hidden'),false);assert.equal(scopeCycleCoverage(coverage,[]).accepted,false);
});

test('first recovery and a fast scan after a multi-hour gap do not prove continuous20-minute service',()=>{
 const first=cycleCoverage([row()],[account],{startedAt:start,finishedAt:end});
 assert.equal(first.coverageComplete,true);assert.equal(first.withinTarget,true);assert.equal(first.accepted,false);assert.equal(first.completionGapSeconds,null);
 assert.equal(first.accounts[0].lastCompleteCycleFinishedAt,new Date(end).toISOString());
 const delayed=cycleCoverage([row()],[account],{...options,previousCoverage:{accounts:[{accountId:account.id,lastCompleteCycleFinishedAt:new Date(start-3*3600_000).toISOString()}]}});
 assert.equal(delayed.coverageComplete,true);assert.equal(delayed.durationSeconds,600);assert.equal(delayed.completionGapSeconds,11400);assert.equal(delayed.accepted,false);
});
test('partial attempts preserve the last complete observation rather than resetting cadence',()=>{
 const partial=cycleCoverage([row(start-1)],[account],options);
 assert.equal(partial.coverageComplete,false);assert.equal(partial.accounts[0].lastCompleteCycleFinishedAt,options.previousCoverage.accounts[0].lastCompleteCycleFinishedAt);
 const next=cycleCoverage([row(end+60_000)],[account],{startedAt:end,finishedAt:end+600_000,previousCoverage:partial});
 assert.equal(next.coverageComplete,true);assert.equal(next.completionGapSeconds,1800);assert.equal(next.accepted,false);
 const nextTimely=cycleCoverage([row(end+60_000)],[account],{startedAt:end,finishedAt:end+600_000,previousCoverage:cycleCoverage([row()],[account],options)});
 assert.equal(nextTimely.completionGapSeconds,600);assert.equal(nextTimely.accepted,true);
});
test('published-cycle gate validates all rows, cadence, freshness and exact code revision independently',async()=>{
 const { cycleAcceptance }=await import('../scripts/lib/cycle-coverage.mjs');
 const status={total:1,codeSha:'new-sha',checkedAt:new Date(end).toISOString(),cycleCoverage:cycleCoverage([row()],[account],options)};
 assert.equal(cycleAcceptance(status,{now:end,codeSha:'new-sha'}).accepted,true);
 assert.equal(cycleAcceptance(status,{now:end+1200_001}).accepted,false);
 assert.equal(cycleAcceptance(status,{now:end,codeSha:'old-sha'}).accepted,false);
 assert.equal(cycleAcceptance({...status,total:2},{now:end}).accepted,false);
 const forged=structuredClone(status);forged.cycleCoverage.accounts[0].completionGapSeconds=1;
 assert.equal(cycleAcceptance(forged,{now:end}).accepted,false);
 const sampled=structuredClone(status);sampled.cycleCoverage.accounts[0].costVerified=0;sampled.cycleCoverage.accepted=true;
 assert.equal(cycleAcceptance(sampled,{now:end}).accepted,false);
 assert.equal(cycleAcceptance({},{now:end}).accepted,false);
});
