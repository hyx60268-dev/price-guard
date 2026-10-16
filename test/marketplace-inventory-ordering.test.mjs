import test from 'node:test';
import assert from 'node:assert/strict';
import {planMarketplaceInventory,runMarketplaceInventory} from '../scripts/lib/marketplace-inventory-graph.mjs';
import {graphComparisonResults} from '../scripts/lib/graph-comparison-results.mjs';
import {compactDashboardResult} from '../scripts/lib/publish.mjs';
import {FakeClock,fakeAdapters} from './fixtures/full-cycle-graph-fixtures.mjs';

const START=Date.parse('2026-10-16T00:00:00Z');

for(const [sharedQuery,persistOwn,compactFallback] of [[false,true,false],[true,true,false],[true,false,false],[true,true,true]])test(`consecutive partial cycles advance untouched listings (shared query ${sharedQuery}, own receipt ${persistOwn}, compact fallback ${compactFallback})`,async()=>{
  const configuredAccounts=[{id:'account',platform:'rakuma'}],count=12,allOwn=new Set(),allPricing=new Set(),cycles=[];
  let items=Array.from({length:count},(_,index)=>({id:(index+1).toString(16).padStart(32,'0'),title:sharedQuery?'Synthetic shared product':`Synthetic uniqueproduct${index}`}));
  const profileOrder=items.map(item=>item.id);
  for(let round=0;round<6;round++){
    const startedAt=START+round*10000,cycleId=`partial-${round}`,deadlineAt=startedAt+3600;
    const inventories=[{accountId:'account',items,expectedCount:count,status:'live',fromCache:false,complete:true,cycleId,observedAt:startedAt,proofRef:`receipt:${round}`}];
    const before=structuredClone(inventories),planned=planMarketplaceInventory({cycleId,startedAt,deadlineAt,configuredAccounts,inventories});
    assert.equal(planned.graph.targets.size,count);assert.equal(planned.graph.accounts[0].expectedCount,count);
    assert.equal(planned.graph.scopes.filter(scope=>scope.purpose==='pricing').length,count);
    const clock=new FakeClock(startedAt),reads=[],adapter=fakeAdapters(clock,{readLog:reads});
    const report=await runMarketplaceInventory(planned,{adapters:{rakuma:adapter},clock,maxConcurrency:4,
      sourceLimits:{rakuma:{maxConcurrent:1,minIntervalMs:1200}}});
    assert.deepEqual(inventories,before,'planning and execution cannot mutate the original receipts or rows');
    assert.equal(report.total,count);assert.equal(report.plannedTargets,count);assert.equal(report.declaredInventoryTotal,count);
    assert.equal(report.priceComplete,sharedQuery?2:1);assert.equal(report.ownIdentityVerified,2);
    assert.equal(report.complete,false);assert.equal(report.coverageComplete,false);assert.equal(report.productionAccepted,false);
    assert.equal(reads.length,3);assert.equal(report.finishedAt,deadlineAt);
    const ownIds=report.targets.filter(target=>target.ownIdentityVerified).map(target=>target.targetId.split(':')[1]);
    const pricingIds=report.targets.filter(target=>target.priceComplete).map(target=>target.targetId.split(':')[1]);
    assert.ok(ownIds.every(id=>!allOwn.has(id)),`cycle ${round} must give previously untouched own listings a turn`);
    ownIds.forEach(id=>allOwn.add(id));pricingIds.forEach(id=>allPricing.add(id));cycles.push({ownIds,pricingIds});
    const published=graphComparisonResults(planned.graph,{previousItems:items});
    items=items.map(item=>{
      const record=planned.graph.targets.get(`account:${item.id}`),own=planned.graph.nodes.get(record.ownId),raw=planned.graph.nodes.get(own.rawId);
      return {...item,...published.get(record.key),...(persistOwn&&own.result?.complete?{sourceDetail:{id:item.id,observedAt:new Date(raw.result.observedAt).toISOString()}}:{})};
    });
    if(compactFallback){
      const beforeCompact=structuredClone(items);
      items=compactDashboardResult({items},{now:clock.now()}).items;
      for(const [index,item] of items.entries()){
        assert.equal(item.sourceDetail,undefined,'compact fallback has no own observation receipt');
        assert.equal(item.rakuma.ownLastAttemptAt,beforeCompact[index].rakuma.ownLastAttemptAt);
        assert.equal(item.rakuma.checkedAt,beforeCompact[index].rakuma.checkedAt);
        assert.equal(item.rakuma.searchCheckedAt,beforeCompact[index].rakuma.searchCheckedAt);
      }
    }
    assert.deepEqual(items.map(item=>item.id),profileOrder,'the next full profile receipt remains in its original order');
  }
  assert.equal(allOwn.size,count);assert.equal(allPricing.size,sharedQuery?count:6);
  assert.notDeepEqual(cycles[0].pricingIds,cycles[1].pricingIds);
  assert.deepEqual(cycles[0].ownIds,profileOrder.slice(0,2));
  assert.deepEqual(cycles[1].ownIds,profileOrder.slice(2,4));
});
