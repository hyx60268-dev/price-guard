import test from 'node:test';
import assert from 'node:assert/strict';
import {planFullCycle,runFullCycle,SourceDeniedError} from '../scripts/lib/full-cycle-graph.mjs';
import {graphComparisonResults,graphComparisonSummary} from '../scripts/lib/graph-comparison-results.mjs';
import {pricingDecision,PRICING_RULES_VERSION} from '../public/pricing-policy.js';
import {cycleCoverage} from '../scripts/lib/cycle-coverage.mjs';
import {compactDashboardResult,scopeResultForPortalUser} from '../scripts/lib/publish.mjs';
import {FakeClock,baseTarget,planInput,fakeAdapters,acceptedOffer} from './fixtures/full-cycle-graph-fixtures.mjs';

const START=Date.parse('2026-10-16T00:00:00.000Z');
const iso=time=>new Date(time).toISOString();
const target=(id,extra={})=>baseTarget(id,{ownPrice:10000,supplier:null,...extra});
const priorSource=(extra={})=>({rulesVersion:PRICING_RULES_VERSION,status:'ok',evidenceStatus:'ok',
  checkedAt:iso(START-60000),searchCheckedAt:iso(START-60000),searchComplete:true,
  lowestPrice:2000,lowestUrl:'https://fixture.invalid/old',candidates:[{id:'old',url:'https://fixture.invalid/old',title:'Old quote',
    price:2000,sellerId:'old-seller',matchMethod:'old-verified',checkedAt:iso(START-60000)}],...extra});
async function run(targets,{dataFor,validateOffer,fetchRaw,sourceLimits,deadlineMs=1200000,delay=10}={}){
  const input=planInput(targets,{startedAt:START,deadlineAt:START+deadlineMs});
  input.accounts=input.accounts.map(account=>({...account,observedAt:START}));
  const graph=planFullCycle(input),clock=new FakeClock(START),adapters=fakeAdapters(clock,{delay,dataFor});
  adapters.validateOffer=validateOffer||((target,own,raw)=>({ ...acceptedOffer(target),quote:{...acceptedOffer(target).quote,
    id:raw.data?.id||'current',url:raw.data?.url||'https://fixture.invalid/offer/shared',title:'Current verified quote',
    image:'https://fixture.invalid/image/current.jpg',detailTitle:'Current detail title',matchMethod:'verified-physical-identity',
    price:raw.data?.price??9000,shipping:raw.data?.shipping??0,sellerId:raw.data?.sellerId||'current-seller'}}));
  if(fetchRaw)adapters.fetchRaw=(request,context)=>fetchRaw(request,context,clock,adapters);
  if(sourceLimits)adapters.sourceLimits=sourceLimits;
  const report=await runFullCycle(graph,adapters);
  return {graph,clock,report,targets};
}
function publish(result,previousItems=[]){
  const comparisons=graphComparisonResults(result.graph,{previousItems});
  const items=result.targets.map(item=>({...item,...comparisons.get(`${item.accountId}:${item.id}`)}));
  const accounts=result.graph.accounts.map(account=>({id:account.id,profileStatus:'live'}));
  const coverage=cycleCoverage(items,accounts,{startedAt:START,finishedAt:result.clock.now()});
  const dashboard=compactDashboardResult({items,accounts,cycleCoverage:coverage},{now:result.clock.now()});
  return {comparisons,items,accounts,coverage,dashboard};
}

test('graph to real consumers preserves original times and payable price across compaction',async()=>{
  const result=await run([target('one')],{dataFor:request=>request.kind==='search'?{offers:[],complete:true}:
    {title:'Current product',description:'Current detail',price:8500,shipping:500}});
  const before=JSON.stringify([...result.graph.nodes.values()]),out=publish(result),item=out.items[0],value=item.yahoo;
  const quoteNode=[...result.graph.nodes.values()].find(node=>node.kind==='decision');
  const ownNode=result.graph.nodes.get(result.graph.targets.get('account:one').ownId);
  assert.equal(value.status,'ok');assert.equal(value.evidenceStatus,'ok');assert.equal(value.searchComplete,true);
  assert.equal(value.checkedAt,iso(ownNode.result.observedAt));
  assert.equal(value.candidates[0].checkedAt,iso(quoteNode.result.observedAt));
  assert.notEqual(value.checkedAt,iso(result.graph.finishedAt));
  assert.equal(value.candidates[0].price,9000);assert.equal(value.candidates[0].itemPrice,8500);assert.equal(value.candidates[0].shippingJPY,500);
  assert.equal(value.candidates[0].title,'Current verified quote');assert.equal(value.candidates[0].image,'https://fixture.invalid/image/current.jpg');
  for(const row of [item,out.dashboard.items[0]]){
    const decision=pricingDecision(row,{now:result.clock.now()});assert.equal(decision.complete,true);assert.equal(decision.recommendedPrice,8999);
    assert.equal(row.yahoo.candidates[0].checkedAt,iso(quoteNode.result.observedAt));
  }
  assert.equal(out.coverage.priceObserved,1);assert.equal(out.coverage.priceComplete,1);assert.equal(out.coverage.costVerified,0);
  assert.equal(out.coverage.accepted,false);assert.equal(JSON.stringify([...result.graph.nodes.values()]),before,'conversion is pure');
});

test('a current partial cheaper quote can lower; partial expensive quotes cannot raise',async()=>{
  for(const price of [8000,13000]){
    const result=await run([target('one')],{dataFor:request=>request.kind==='search'?{offers:[],complete:false}:
      {description:'Current details',price}});
    const out=publish(result),row=out.dashboard.items[0],decision=pricingDecision(row,{now:result.clock.now()});
    assert.equal(row.yahoo.status,'incomplete');assert.equal(row.yahoo.evidenceStatus,'incomplete');assert.equal(row.yahoo.searchComplete,false);
    assert.equal(row.yahoo.searchCheckedAt,iso(START+10));assert.equal(row.yahoo.candidates.length,1);
    assert.equal(decision.complete,false);assert.equal(decision.recommendedPrice,price<10000?7999:10000);
    assert.equal(out.coverage.priceObserved,1);assert.equal(out.coverage.priceComplete,0);
  }
});

test('accepted quotes survive an aggregation deadline without inventing complete coverage',async()=>{
  const result=await run([target('one')]);
  const scope=result.graph.scopes.find(scope=>scope.purpose==='pricing');
  scope.status='failed';scope.result=null;scope.error={code:'deadline'};
  const row=publish(result).dashboard.items[0];
  assert.equal(row.yahoo.status,'incomplete');assert.equal(row.yahoo.deferredReason,'deadline');assert.equal(row.yahoo.candidates.length,1);
  assert.equal(pricingDecision(row,{now:result.clock.now()}).recommendedPrice,8999);
});

test('complete empty search clears old candidates and retains its actual observation',async()=>{
  const one=target('one',{candidate:null}),result=await run([one]);
  const prior={accountId:'account',id:'one',yahoo:priorSource()};
  const out=publish(result,[prior]),row=out.dashboard.items[0];
  assert.equal(row.yahoo.status,'ok');assert.equal(row.yahoo.searchComplete,true);assert.deepEqual(row.yahoo.candidates,[]);
  assert.equal(row.yahoo.checkedAt,iso(START+10));assert.equal(row.yahoo.searchCheckedAt,iso(START+10));
  assert.equal(row.yahoo.lowestPrice,null);assert.equal(pricingDecision(row,{now:result.clock.now()}).recommendedPrice,10000);
  assert.equal(out.coverage.priceComplete,1);
});

test('denied sources retain old evidence as stale and never renew quote or search clocks',async()=>{
  const result=await run([target('one')],{dataFor:()=>{throw new SourceDeniedError();}});
  const prior={accountId:'account',id:'one',yahoo:priorSource()},out=publish(result,[prior]);
  for(const row of [out.items[0],out.dashboard.items[0]]){
    assert.equal(row.yahoo.status,'stale');assert.equal(row.yahoo.evidenceStatus,'stale');assert.equal(row.yahoo.checkedAt,prior.yahoo.checkedAt);
    assert.equal(row.yahoo.searchCheckedAt,prior.yahoo.searchCheckedAt);assert.equal(row.yahoo.searchComplete,false);
    assert.equal(row.yahoo.deferredReason,'source_denied');assert.equal(row.yahoo.lastAttemptAt,iso(START));
    assert.equal(row.yahoo.candidates[0].price,2000);assert.equal(row.yahoo.candidates[0].checkedAt,prior.yahoo.candidates[0].checkedAt);
    const decision=pricingDecision(row,{now:result.clock.now()});assert.equal(decision.complete,false);assert.equal(decision.lowest,null);
    assert.equal(decision.recommendedPrice,10000);
  }
  assert.equal(out.coverage.priceObserved,0);assert.equal(out.coverage.priceComplete,0);
});

test('partial search with no current quote keeps old price stale despite a newer search observation',async()=>{
  const result=await run([target('one',{candidate:null})],{dataFor:request=>request.kind==='search'?{offers:[],complete:false}:{description:'Current detail'}});
  const prior={accountId:'account',id:'one',yahoo:priorSource()},row=publish(result,[prior]).dashboard.items[0];
  assert.equal(row.yahoo.status,'stale');assert.equal(row.yahoo.checkedAt,prior.yahoo.checkedAt);
  assert.equal(row.yahoo.searchCheckedAt,iso(START+10));assert.equal(row.yahoo.searchComplete,false);
  assert.equal(pricingDecision(row,{now:result.clock.now()}).lowest,null);
});

test('a current quote replaces prior prices instead of borrowing their old lower price',async()=>{
  const result=await run([target('one')],{dataFor:request=>request.kind==='search'?{offers:[],complete:false}:{description:'Current detail',price:13000}});
  const row=publish(result,[{accountId:'account',id:'one',yahoo:priorSource()}]).dashboard.items[0];
  assert.deepEqual(row.yahoo.candidates.map(quote=>quote.price),[13000]);assert.equal(row.yahoo.status,'incomplete');
  assert.equal(pricingDecision(row,{now:result.clock.now()}).recommendedPrice,10000);
});

test('cached or before-cycle raw reads cannot publish freshness or accepted prices',async()=>{
  for(const extra of [{observedAt:START-1},{fromCache:true}]){
    const result=await run([target('one')],{fetchRaw:async(request,context,clock)=>{
      await clock.sleep(10,context.signal);
      return {cycleId:context.cycleId,observedAt:clock.now(),fromCache:false,data:{offers:[],complete:true},...extra};
    }});
    const out=publish(result),row=out.dashboard.items[0];
    assert.equal(row.yahoo.status,'incomplete');assert.equal(row.yahoo.checkedAt,null);assert.equal(row.yahoo.searchCheckedAt,null);
    assert.deepEqual(row.yahoo.candidates,[]);assert.equal(pricingDecision(row,{now:result.clock.now()}).complete,false);
    assert.equal(out.coverage.priceObserved,0);
  }
});

test('every not-admitted target gets incomplete results, including unsupported required sources',async()=>{
  const targets=[target('same',{accountId:'a'}),target('same',{accountId:'b',platform:'rakuma'}),target('cross',{comparisonMode:'cross_platform'})];
  const result=await run(targets,{sourceLimits:{yahoo:{maxConcurrent:1,minIntervalMs:0,maxRequests:0},rakuma:{maxConcurrent:1,minIntervalMs:0,maxRequests:0}}});
  const out=publish(result);assert.equal(out.comparisons.size,3);
  for(const row of out.items)for(const source of row.comparisonMode==='cross_platform'?['yahoo','rakuma','mercari']:[row.platform]){
    assert.equal(row[source].status,'incomplete');assert.equal(row[source].checkedAt,null);assert.deepEqual(row[source].candidates,[]);
  }
  assert.equal(out.coverage.total,3);assert.equal(out.coverage.priceComplete,0);
});

test('account-qualified decisions and retained evidence survive portal scoping without cross-account leakage',async()=>{
  const targets=[target('same',{accountId:'a'}),target('same',{accountId:'b'})];
  const result=await run(targets,{validateOffer:async(target,own,raw)=>{
    const value=acceptedOffer(target);if(target.accountId==='b')value.gates.correction='reject';
    value.quote={...value.quote,url:'https://fixture.invalid/offer/shared',price:8000,matchMethod:'verified'};return value;
  }});
  const out=publish(result),a=out.items[0],b=out.items[1];
  assert.equal(a.yahoo.candidates.length,1);assert.equal(b.yahoo.candidates.length,0);
  const scoped=scopeResultForPortalUser(out.dashboard,{username:'member',accountIds:['b']});
  assert.equal(scoped.items.length,1);assert.equal(scoped.items[0].accountId,'b');assert.equal(scoped.items[0].yahoo.candidates.length,0);
  const denied=await run(targets,{dataFor:()=>{throw new SourceDeniedError();}});
  const priorA={id:'same',accountId:'a',yahoo:priorSource()},deniedOut=publish(denied,[priorA]);
  assert.equal(deniedOut.items[0].yahoo.status,'stale');assert.equal(deniedOut.items[1].yahoo.checkedAt,null);
  assert.deepEqual(deniedOut.items[1].yahoo.candidates,[]);
});

test('corrections, ownership and identity gates cannot be bypassed by a quote envelope',async()=>{
  for(const gate of ['correction','ownership','quantity','condition','identity']){
    const result=await run([target('one')],{validateOffer:async target=>{
      const value=acceptedOffer(target);value.gates[gate]='reject';value.quote={...value.quote,url:'https://fixture.invalid/offer/shared',price:100,matchMethod:'forged'};
      return {...value,accepted:true};
    }});
    const row=publish(result).dashboard.items[0];assert.deepEqual(row.yahoo.candidates,[]);
    assert.equal(pricingDecision(row,{now:result.clock.now()}).recommendedPrice,10000);
  }
});

test('malformed accepted quotes fail closed rather than yielding complete consumer coverage',async()=>{
  for(const extra of [{url:undefined},{matchMethod:undefined},{currency:'CNY',shippingCurrency:'CNY'}]){
    const result=await run([target('one')],{validateOffer:async target=>({gates:acceptedOffer(target).gates,
      quote:{...acceptedOffer(target).quote,url:'https://fixture.invalid/offer/shared',price:5000,matchMethod:'verified',...extra}})});
    const row=publish(result).dashboard.items[0];assert.equal(row.yahoo.status,'incomplete');assert.deepEqual(row.yahoo.candidates,[]);
    assert.equal(pricingDecision(row,{now:result.clock.now()}).complete,false);
  }
});

test('counts-only graph summary contains no inventory, URLs, queries or raw events',async()=>{
  const result=await run([target('secret-item',{accountId:'secret-account',query:'secret-query',title:'Secret title'})]);
  const summary=graphComparisonSummary(result.graph),serialized=JSON.stringify(summary);
  assert.equal(summary.total,1);assert.equal(summary.priceComplete,1);assert.equal(summary.completed,0);
  assert.equal(summary.costVerified,0);assert.equal(summary.productionAccepted,false);assert.ok(summary.rawStarts>0);
  for(const value of ['secret-item','secret-account','secret-query','Secret title','fixture.invalid','events','targets','inventoryIssues'])
    assert.equal(serialized.includes(value),false,value);
});

test('two independent current sellers authorize a raise only when the required source scope is complete',async()=>{
  for(const complete of [false,true]){
    const one=target('one');one.pricing.yahoo.knownOffers.push({url:'https://fixture.invalid/offer/second'});
    const result=await run([one],{dataFor:request=>request.kind==='search'?{offers:[],complete}:
      {description:'Current detail',url:request.url,price:request.url.endsWith('second')?14000:13000,
        sellerId:request.url.endsWith('second')?'seller-two':'seller-one'}});
    const row=publish(result).dashboard.items[0],decision=pricingDecision(row,{now:result.clock.now()});
    assert.equal(row.yahoo.candidates.length,2);assert.equal(decision.complete,complete);
    assert.equal(decision.recommendedPrice,complete?12999:10000);
    assert.equal(decision.priceSignal,complete?'raise':'hold');
  }
});

test('a deadline attempt cannot renew prior evidence and reports all pending targets',async()=>{
  const result=await run([target('one'),target('two')],{deadlineMs:5,delay:10});
  const previousItems=['one','two'].map(id=>({accountId:'account',id,yahoo:priorSource()})),out=publish(result,previousItems);
  assert.equal(out.items.length,2);
  for(const row of out.dashboard.items){
    assert.equal(row.yahoo.status,'stale');assert.equal(row.yahoo.checkedAt,iso(START-60000));
    assert.equal(row.yahoo.searchCheckedAt,iso(START-60000));assert.equal(row.yahoo.candidates[0].price,2000);
    assert.equal(pricingDecision(row,{now:result.clock.now()}).lowest,null);
  }
  assert.equal(out.coverage.priceObserved,0);assert.equal(out.coverage.priceComplete,0);
});

test('unobserved graph and foreign audited prior evidence cannot create a current result',()=>{
  const one=target('same'),input=planInput([one],{startedAt:START,deadlineAt:START+1200000});
  input.accounts[0].observedAt=START;
  const graph=planFullCycle(input),prior={id:'same',accountId:'account',yahoo:priorSource({audit:{accountId:'different',ownItemId:'same'}})};
  const rows=graphComparisonResults(graph,{previousItems:[prior]}),row=rows.get('account:same');
  assert.equal(rows.size,1);assert.equal(row.yahoo.status,'incomplete');assert.equal(row.yahoo.checkedAt,null);
  assert.equal(row.yahoo.lastAttemptAt,null);assert.deepEqual(row.yahoo.candidates,[]);
});

test('own retry scheduling records only each target raw dispatch and preserves prior age through shared searches',async()=>{
  const result=await run(['one','two','three'].map(id=>target(id,{candidate:null})),{
    delay:1,deadlineMs:25,sourceLimits:{yahoo:{maxConcurrent:1,minIntervalMs:10}}
  });
  const oldOwnAttempt=iso(START-120000),prior={id:'three',accountId:'account',yahoo:priorSource({ownLastAttemptAt:oldOwnAttempt})};
  const comparisons=graphComparisonResults(result.graph,{previousItems:[prior]});
  assert.equal(comparisons.get('account:one').yahoo.ownLastAttemptAt,iso(START));
  assert.equal(comparisons.get('account:two').yahoo.ownLastAttemptAt,iso(START+20));
  const untouched=comparisons.get('account:three').yahoo;
  assert.equal(untouched.lastAttemptAt,iso(START+10),'shared search activity is still reported');
  assert.equal(untouched.ownLastAttemptAt,oldOwnAttempt,'shared search cannot refresh the untouched own retry age');
  assert.equal(untouched.checkedAt,prior.yahoo.checkedAt);
  assert.equal(untouched.searchCheckedAt,iso(START+11));
  assert.equal(untouched.status,'stale');assert.equal(result.report.complete,false);
  const withoutPrior=graphComparisonResults(result.graph).get('account:three').yahoo;
  assert.equal(withoutPrior.ownLastAttemptAt,null);
  const compact=compactDashboardResult({items:[...comparisons.values()]},{now:result.clock.now()});
  for(const item of compact.items){
    const source=comparisons.get(`account:${item.id}`).yahoo;
    assert.equal(item.yahoo.ownLastAttemptAt,source.ownLastAttemptAt);
    assert.equal(item.yahoo.checkedAt,source.checkedAt);
    assert.equal(item.yahoo.searchCheckedAt,source.searchCheckedAt);
  }
});

test('failed own reads advance only target-local retry time and foreign prior attempts cannot cross accounts',async()=>{
  const result=await run([target('one',{candidate:null}),target('two',{candidate:null})],{
    delay:1,sourceLimits:{yahoo:{maxConcurrent:1,minIntervalMs:10}},
    dataFor:request=>{if(request.url?.endsWith('/one'))throw new Error('own read unavailable');return request.kind==='search'?{offers:[],complete:true}:{};}
  });
  const prior={id:'one',accountId:'account',yahoo:priorSource({ownLastAttemptAt:iso(START-120000)})};
  const row=graphComparisonResults(result.graph,{previousItems:[prior]}).get('account:one').yahoo;
  assert.equal(row.ownLastAttemptAt,iso(START));assert.equal(row.checkedAt,prior.yahoo.checkedAt);
  assert.equal(row.status,'stale');assert.equal(result.report.ownIdentityVerified,1);
  const blocked=await run([target('one',{candidate:null})],{sourceLimits:{yahoo:{maxConcurrent:1,minIntervalMs:0,maxRequests:0}}});
  const foreign={...prior,yahoo:{...prior.yahoo,audit:{accountId:'different',ownItemId:'one'}}};
  assert.equal(graphComparisonResults(blocked.graph,{previousItems:[foreign]}).get('account:one').yahoo.ownLastAttemptAt,null);
  assert.equal(graphComparisonResults(blocked.graph,{previousItems:[prior]}).get('account:one').yahoo.ownLastAttemptAt,prior.yahoo.ownLastAttemptAt);
});
