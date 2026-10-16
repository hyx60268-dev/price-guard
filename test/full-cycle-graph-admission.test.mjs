import test from 'node:test';
import assert from 'node:assert/strict';
import {planFullCycle,runFullCycle,graphCounts} from '../scripts/lib/full-cycle-graph.mjs';
import {planMarketplaceInventory,runMarketplaceInventory} from '../scripts/lib/marketplace-inventory-graph.mjs';
import {RequestDeferredError} from '../scripts/lib/request-cooldown.mjs';
import {FakeClock,baseTarget,planInput,fakeAdapters} from './fixtures/full-cycle-graph-fixtures.mjs';

const candidateRead = read => Boolean(read.request.url?.includes('/candidate/'));
const blockers = report => report.missingTargets.flatMap(target => target.missing.flatMap(obligation => obligation.blockers));

function frontierFixture({targetCount=8,offerCount=1,deadlineAt=100}={}) {
  const targets = Array.from({length:targetCount}, (_, index) => baseTarget(`item-${index}`, {
    query:`query-${index}`, candidate:null, supplier:null
  }));
  const graph = planFullCycle(planInput(targets, {deadlineAt})), clock = new FakeClock(), reads = [];
  const adapters = fakeAdapters(clock, {readLog:reads, dataFor:request => request.kind !== 'search' ? {} : {
    offers:request.query.q === 'query-0' ? Array.from({length:offerCount}, (_, index) => ({url:`https://fixture.invalid/candidate/${index}`})) : [],
    complete:true
  }});
  adapters.maxConcurrency = 1;
  adapters.sourceLimits = {yahoo:{maxConcurrent:1,minIntervalMs:10}};
  return {graph,clock,reads,adapters};
}

test('new candidate details produce verified quotes before initial roots exhaust the fixed deadline', async () => {
  const {graph,reads,adapters} = frontierFixture();
  const before = graphCounts(graph), report = await runFullCycle(graph,adapters);
  const firstCandidate = reads.findIndex(candidateRead);
  assert.equal(firstCandidate,2, 'own and search can immediately be followed by their screened detail');
  assert.ok(reads.slice(firstCandidate+1).some(read => read.request.kind === 'search'));
  const scope = graph.scopes.find(node => node.targetKey === 'account:item-0');
  assert.equal(scope.result.complete,true);
  assert.equal(scope.result.quotes.length,1);
  assert.equal(report.priceComplete,4);
  assert.equal(report.finishedAt,100);
  assert.equal(report.total,8);
  assert.equal(report.plannedTargets,8);
  assert.equal(report.complete,false);
  assert.equal(report.productionAccepted,false);
  assert.equal(report.counts.rawBySource.yahoo.search,before.rawBySource.yahoo.search);
  assert.equal(report.counts.rawBySource.yahoo.detail,before.rawBySource.yahoo.detail+1);
  assert.equal(reads.length,10);
});

test('large candidate frontiers alternate with roots and cannot starve original own/search obligations', async () => {
  const {graph,reads,adapters} = frontierFixture({targetCount:4,offerCount:25,deadlineAt:1000});
  const report = await runFullCycle(graph,adapters);
  const rootReads = reads.filter(read => !candidateRead(read));
  assert.equal(rootReads.length,8);
  assert.equal(reads.filter(candidateRead).length,25);
  assert.equal(report.ownIdentityVerified,4);
  assert.equal(report.priceComplete,4);
  const lastRoot = reads.findLastIndex(read => !candidateRead(read));
  assert.equal(lastRoot,13, 'each ready root receives a turn despite the long candidate backlog');
  for (let index=2;index<lastRoot;index++) {
    if(candidateRead(reads[index]))assert.equal(candidateRead(reads[index+1]),false);
  }
  assert.equal(new Set(reads.map(read => read.nodeId)).size,reads.length);
  assert.ok(reads.slice(1).every((read,index) => read.at-reads[index].at>=10));
  assert.equal(report.execution.sources.yahoo.peakConcurrency,1);
});

test('account target turns follow configured order across unequal inventories without changing the denominator', async () => {
  const cycleId='account-fairness',configuredAccounts=['a','b','c','empty'].map(id => ({id,platform:'yahoo'}));
  const inventories=[['c',1],['a',4],['empty',0],['b',3]].map(([accountId,count]) => ({
    accountId,items:Array.from({length:count},(_,index)=>({id:`${accountId}-${index}`,title:`Synthetic ${accountId} product ${index}`})),
    expectedCount:count,status:'live',fromCache:false,complete:true,cycleId,observedAt:0,proofRef:`fixture:${accountId}`
  }));
  const planned=planMarketplaceInventory({cycleId,startedAt:0,configuredAccounts,inventories});
  assert.deepEqual([...planned.graph.targets.keys()],['a:a-0','b:b-0','c:c-0','a:a-1','b:b-1','a:a-2','b:b-2','a:a-3']);
  assert.deepEqual(planned.graph.accounts.map(account=>[account.id,account.expectedCount]),[['a',4],['b',3],['c',1],['empty',0]]);
  const clock=new FakeClock(),reads=[],adapter=fakeAdapters(clock,{readLog:reads});
  const report=await runMarketplaceInventory(planned,{adapters:{yahoo:adapter},clock,maxConcurrency:1,
    sourceLimits:{yahoo:{maxConcurrent:1,minIntervalMs:0,maxRequests:6}}});
  assert.deepEqual(reads.filter(read=>read.request.kind==='detail').map(read=>read.request.url.split('/').at(-1)),['a-0','b-0','c-0']);
  assert.equal(report.total,8);assert.equal(report.plannedTargets,8);assert.equal(report.priceComplete,3);
  assert.equal(report.complete,false);assert.equal(report.inventoryIssues.length,0);
  assert.deepEqual(report.inventoryCounts.map(({accountId,denominator})=>[accountId,denominator]),[['a',4],['b',3],['c',1],['empty',0]]);
});

test('held collector sources retain deferred diagnostics and stop locally while independent sources complete', async () => {
  for(const retryAt of [100,60000,'indefinite']) {
    const graph=planFullCycle(planInput([baseTarget('y1'),baseTarget('y2'),baseTarget('r1',{platform:'rakuma'})],{deadlineAt:100}));
    const clock=new FakeClock(),reads=[],error=Object.freeze(new RequestDeferredError('request_cooldown_deadline',retryAt));
    const adapters=fakeAdapters(clock,{readLog:reads,dataFor:request=>{
      if(request.source==='yahoo')throw error;
      return request.kind==='search'?{offers:[],complete:true}:{};
    }});
    adapters.sourceLimits.yahoo.maxConcurrent=1;
    const report=await runFullCycle(graph,adapters);
    assert.equal(reads.filter(read=>read.request.source==='yahoo').length,1);
    assert.equal(report.execution.sources.yahoo.closed,'request_deferred');
    assert.equal(report.execution.sources.yahoo.reason,'request_cooldown_deadline');
    assert.equal(report.execution.sources.yahoo.retryAt,retryAt);
    assert.equal(report.completed,1);assert.equal(report.total,3);assert.equal(report.complete,false);
    assert.ok(report.targets.find(target=>target.targetId==='account:r1').complete);
    const deferred=blockers(report).filter(blocker=>blocker.code==='request_deferred');
    assert.ok(deferred.length>=2);
    assert.ok(deferred.every(blocker=>blocker.reason==='request_cooldown_deadline'&&blocker.retryAt===retryAt));
    assert.ok(blockers(report).every(blocker=>blocker.code!=='source_denied'));
    assert.equal(error.code,'request_deferred');assert.equal(error.retryAt,retryAt);
    assert.equal(report.declaredInventoryTotal,3);assert.equal(report.registeredInventoryTotal,3);
  }
});

test('deferral within the remaining window is visible without closing independent same-source work', async () => {
  const graph=planFullCycle(planInput([baseTarget('one'),baseTarget('two')],{deadlineAt:100}));
  const clock=new FakeClock(),reads=[];
  const adapters=fakeAdapters(clock,{readLog:reads,dataFor:request=>{
    if(request.url?.endsWith('/one'))throw new RequestDeferredError('collector_slot_unavailable',20);
    return request.kind==='search'?{offers:[],complete:true}:{};
  }});
  adapters.sourceLimits.yahoo.maxConcurrent=1;
  const report=await runFullCycle(graph,adapters);
  assert.equal(report.execution.sources.yahoo.closed,null);
  assert.ok(reads.filter(read=>read.request.source==='yahoo').length>1);
  assert.equal(report.completed,1);assert.equal(report.complete,false);
  assert.ok(blockers(report).some(blocker=>blocker.code==='request_deferred'&&blocker.reason==='collector_slot_unavailable'&&blocker.retryAt===20));
});

test('partial live receipts retain their original scope denominator after fair reordering and admission', async () => {
  const targets=[baseTarget('one',{accountId:'a'}),baseTarget('two',{accountId:'b'})];
  const input=planInput(targets);input.accounts[0].expectedCount=1461;
  const graph=planFullCycle(input),clock=new FakeClock();
  const report=await runFullCycle(graph,fakeAdapters(clock));
  assert.equal(report.completed,2);assert.equal(report.plannedTargets,2);assert.equal(report.total,1462);
  assert.equal(report.coverageComplete,false);assert.equal(report.complete,false);
  assert.ok(report.inventoryIssues.some(issue=>issue.code==='inventory_count_mismatch'&&issue.accountId==='a'));
});

test('concurrent deferred responses never shorten the source hold diagnostic', async () => {
  for(const firstHold of [60000,'indefinite']) {
    const graph=planFullCycle(planInput([baseTarget('one'),baseTarget('two')],{deadlineAt:100}));
    const clock=new FakeClock(),reads=[];
    const adapters=fakeAdapters(clock,{readLog:reads,dataFor:request=>{
      if(request.source==='yahoo')throw new RequestDeferredError('request_cooldown_deadline',request.kind==='detail'?firstHold:100);
      return request.kind==='search'?{offers:[],complete:true}:{};
    }});
    adapters.sourceLimits.yahoo.maxConcurrent=2;
    const report=await runFullCycle(graph,adapters);
    assert.equal(reads.filter(read=>read.request.source==='yahoo').length,2);
    assert.equal(report.execution.sources.yahoo.retryAt,firstHold);
    const originalReads=[...graph.nodes.values()].filter(node=>node.kind==='raw'&&node.source==='yahoo'&&reads.some(read=>read.nodeId===node.id));
    assert.deepEqual(originalReads.map(node=>node.error.retryAt),[firstHold,100]);
    const remainingRoots=[...graph.nodes.values()].filter(node=>node.kind==='raw'&&node.source==='yahoo'&&node.unconditionalRead&&!reads.some(read=>read.nodeId===node.id));
    assert.ok(remainingRoots.length);
    assert.ok(remainingRoots.every(node=>node.error.code==='request_deferred'&&node.error.retryAt===firstHold));
    assert.equal(report.complete,false);
  }
});
