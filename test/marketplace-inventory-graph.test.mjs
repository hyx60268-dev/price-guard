import test from 'node:test';
import assert from 'node:assert/strict';
import {planMarketplaceInventory,marketplaceGraphHandlers,runMarketplaceInventory} from '../scripts/lib/marketplace-inventory-graph.mjs';
import {graphCounts} from '../scripts/lib/full-cycle-graph.mjs';
import {FakeClock,fakeAdapters} from './fixtures/full-cycle-graph-fixtures.mjs';
const cycleId='receipt-fixture';
const receipt=(accountId,items,extra={})=>({accountId,items,expectedCount:items.length,status:'live',fromCache:false,complete:true,cycleId,observedAt:0,proofRef:'synthetic-collector-receipt',...extra});
const input=()=>({cycleId,startedAt:0,configuredAccounts:[{id:'a',platform:'yahoo',sellerId:'own-a'},{id:'b',platform:'rakuma',sellerId:'own-b'}],
  inventories:[receipt('a',[{id:'one',title:'Synthetic blue 370ml bottle'}]),receipt('b',[{id:'aa',title:'Synthetic blue 370ml bottle'}])]});

test('all configured accounts and every inventory row become obligations before dispatch',()=>{
  const {graph,ownedOffers}=planMarketplaceInventory(input());assert.equal(graph.targets.size,2);assert.equal(graph.accounts.length,2);
  assert.equal(graphCounts(graph).rawBySource.yahoo.search,1);assert.equal(graphCounts(graph).rawBySource.rakuma.search,1);
  assert.equal(ownedOffers.yahoo.sellers.has('own-a'),true);assert.equal(ownedOffers.rakuma.sellers.has('own-b'),true);
  assert.equal(graphCounts(graph).targetsWithoutEligibleSupplierDiscoveryBindings,2);
});
test('missing, duplicated, unknown accounts or shrunken inventories cannot silently reduce denominator',()=>{
  for(const change of [
    {inventories:input().inventories.slice(0,1)},
    {inventories:[...input().inventories,receipt('c',[])]},
    {inventories:[...input().inventories,input().inventories[0]]},
    {inventories:[receipt('a',[{id:'one',title:'One'}],{expectedCount:0}),input().inventories[1]]}
  ])assert.throws(()=>planMarketplaceInventory({...input(),...change}));
});
test('failed inventory keeps prior rows and original observation but never becomes current coverage',async()=>{
  const value=input();value.inventories[0]={...value.inventories[0],status:'error',observedAt:-1,complete:false};
  const planned=planMarketplaceInventory(value),clock=new FakeClock(),fixture=fakeAdapters(clock);
  const adapters={yahoo:fixture,rakuma:fixture};
  const report=await runMarketplaceInventory(planned,{adapters,clock,sourceLimits:fixture.sourceLimits});
  assert.equal(report.total,2);assert.equal(report.complete,false);assert.ok(report.inventoryIssues.length);
  assert.equal(planned.graph.accounts[0].observedAt,-1);assert.equal(report.costVerified,0);
});
test('unsupported source and absent supplier collector remain mandatory missing work',async()=>{
  const value=input();value.configuredAccounts[1].platform='mercari';value.inventories[1].items[0].url='https://jp.mercari.com/item/m123';
  const planned=planMarketplaceInventory(value),clock=new FakeClock(),fixture=fakeAdapters(clock);
  const report=await runMarketplaceInventory(planned,{adapters:{yahoo:fixture},clock,sourceLimits:fixture.sourceLimits});
  assert.equal(report.total,2);assert.equal(report.complete,false);assert.equal(report.costVerified,0);assert.equal(report.priceComplete,1);
});
test('observed 1461-item scale plans 1440 exact unique queries and1461 own details without selection budgets',()=>{
  const configuredAccounts=[],inventories=[];let yahoo=0;
  for(const [id,platform,count] of [['a','yahoo',98],['b','yahoo',48],['c','yahoo',489],['d','rakuma',826]]){
    configuredAccounts.push({id,platform});const items=[];
    for(let i=0;i<count;i++)items.push({id:`${id}-${i}`,title:`Synthetic product ${platform==='yahoo'?yahoo++%627:i%813}`});
    inventories.push(receipt(id,items));
  }
  const {graph}=planMarketplaceInventory({cycleId,startedAt:0,configuredAccounts,inventories}),counts=graphCounts(graph);
  assert.equal(counts.targets,1461);assert.equal(counts.rawBySource.yahoo.search,627);assert.equal(counts.rawBySource.rakuma.search,813);
  assert.equal(counts.rawBySource.yahoo.detail+counts.rawBySource.rakuma.detail,1461);
  assert.equal(counts.targetsWithoutEligibleSupplierDiscoveryBindings,1461);
});
test('dispatcher keeps source-specific validation and never turns missing adapters into acceptance',async()=>{
  const called=[];const handlers=marketplaceGraphHandlers({yahoo:{validateOwn:()=>({complete:true}),validateOffer:()=>{called.push('yahoo');return {observed:true}}}});
  assert.deepEqual(handlers.validateOwn({platform:'yahoo'},null,{}),{complete:true});
  assert.deepEqual(handlers.validateOffer({},null,null,{source:'rakuma'}).reason,'offer_source_adapter_unavailable');
  assert.deepEqual(called,[]);assert.deepEqual(handlers.candidatesFromOwn({},null,{source:'rakuma'}),[]);
});

test('all managed historical ownership remains excluded independently of current price freshness',()=>{
  const planned=planMarketplaceInventory({...input(),historicalOwnedItems:[{id:'old-own',accountId:'a',platform:'yahoo',sellerId:'historical-managed'}]});
  assert.equal(planned.ownedOffers.yahoo.items.has('old-own'),true);assert.equal(planned.ownedOffers.yahoo.sellers.has('historical-managed'),true);
  assert.equal(planned.graph.targets.size,2);
});

test('cached or unspecified inventory provenance cannot be promoted into a current receipt',async()=>{
  for(const fromCache of [true,undefined]){
    const value=input();value.inventories[0].fromCache=fromCache;
    const planned=planMarketplaceInventory(value);assert.equal(planned.assessInventoryCoverage(null,{now:0}).complete,false);
    assert.equal(planned.graph.accounts[0].status,'cached');assert.ok(planned.graph.inventoryIssues.length);
  }
});
test('malformed optional historical candidates cannot stop current mandatory discovery',()=>{
  for(const candidates of [[null,{}, {url:'invalid'}, {url:'https://example.invalid/private'}],{},null]){
    const value=input();value.inventories[0].items[0].yahoo={candidates};
    const {graph}=planMarketplaceInventory(value);assert.equal(graphCounts(graph).rawBySource.yahoo.search,1);
    assert.equal([...graph.nodes.values()].find(n=>n.kind==='scope'&&n.source==='yahoo').problem,undefined);
  }
});

test('within-account admission prioritizes missing and oldest evidence without mutating receipt order',()=>{
  const startedAt=10000,stamp=at=>new Date(at).toISOString();
  const items=[
    {id:'recent',title:'Recent',sourceDetail:{id:'recent',observedAt:stamp(8000)},yahoo:{checkedAt:stamp(8000)}},
    {id:'retry',title:'Recent failed attempt',sourceDetail:{id:'retry',observedAt:stamp(100)},yahoo:{checkedAt:stamp(100),lastAttemptAt:stamp(9000),ownLastAttemptAt:stamp(9000),status:'error'}},
    {id:'old',title:'Old',sourceDetail:{id:'old',observedAt:stamp(200)},yahoo:{checkedAt:stamp(200)}},
    {id:'missing-comparison',title:'Missing comparison',sourceDetail:{id:'missing-comparison',observedAt:stamp(9500)}},
    {id:'missing-all',title:'Missing all'},
    {id:'also-missing',title:'Stable missing tie'}
  ];
  const value={cycleId,startedAt,configuredAccounts:[{id:'a',platform:'yahoo'}],inventories:[receipt('a',items,{observedAt:startedAt})]};
  const before=structuredClone(value),{graph}=planMarketplaceInventory(value);
  assert.deepEqual([...graph.targets.values()].map(record=>record.target.id),['missing-all','also-missing','missing-comparison','old','recent','retry']);
  assert.deepEqual(value,before);
  assert.equal(graph.targets.size,items.length);assert.equal(graph.accounts[0].expectedCount,items.length);
  assert.equal(graph.targets.get('a:retry').target.yahoo.checkedAt,stamp(100),'retry ordering never refreshes evidence');
});

test('age ordering ignores publication time, unrequired sources, invalid/future times and foreign target evidence',()=>{
  const startedAt=10000,stamp=at=>new Date(at).toISOString();
  const items=[
    {id:'old',title:'Old',sourceDetail:{id:'old',observedAt:100},yahoo:{checkedAt:stamp(100)}},
    {id:'foreign',title:'Foreign',checkedAt:stamp(9000),sourceDetail:{id:'prior-listing',observedAt:stamp(9000)},yahoo:{checkedAt:stamp(9000),audit:{accountId:'b',ownItemId:'foreign'}}},
    {id:'future',title:'Future',sourceDetail:{id:'future',observedAt:stamp(20000)},yahoo:{checkedAt:stamp(20000),lastAttemptAt:'invalid'}},
    {id:'unrequired',title:'Unrequired',checkedAt:stamp(9000),rakuma:{checkedAt:stamp(9000)}}
  ];
  const {graph}=planMarketplaceInventory({cycleId,startedAt,configuredAccounts:[{id:'a',platform:'yahoo'}],inventories:[receipt('a',items,{observedAt:startedAt})]});
  assert.deepEqual([...graph.targets.values()].map(record=>record.target.id),['foreign','future','unrequired','old']);
});

test('each required comparison source influences age without a permanently missing source pinning touched targets',()=>{
  const startedAt=10000,stamp=at=>new Date(at).toISOString(),source=at=>({lastAttemptAt:stamp(at)});
  const items=[
    {id:'recent-one',title:'Recent one',yahoo:source(9000)},
    {id:'old-one',title:'Old one',yahoo:source(100)},
    {id:'untouched',title:'Untouched'},
    {id:'two-sources',title:'Two sources',yahoo:source(9000),rakuma:source(8000)},
    {id:'all-sources',title:'All sources',yahoo:source(100),rakuma:source(100),mercari:source(100)}
  ];
  const {graph}=planMarketplaceInventory({cycleId,startedAt,comparisonMode:'cross_platform',configuredAccounts:[{id:'a',platform:'yahoo'}],inventories:[receipt('a',items,{observedAt:startedAt})]});
  assert.deepEqual([...graph.targets.values()].map(record=>record.target.id),['untouched','old-one','recent-one','two-sources','all-sources']);
  assert.equal(graph.scopes.filter(scope=>scope.purpose==='pricing').length,15);
});

test('oldest-first ordering stays inside configured account round-robin turns',()=>{
  const startedAt=10000;
  const a=[{id:'a-recent',title:'Recent',yahoo:{lastAttemptAt:9000}},{id:'a-missing',title:'Missing'}];
  const b=[{id:'b-recent',title:'Recent',yahoo:{lastAttemptAt:8000}},{id:'b-old',title:'Old',yahoo:{lastAttemptAt:100}}];
  const {graph}=planMarketplaceInventory({cycleId,startedAt,configuredAccounts:[{id:'a',platform:'yahoo'},{id:'b',platform:'yahoo'}],inventories:[receipt('b',b,{observedAt:startedAt}),receipt('a',a,{observedAt:startedAt})]});
  assert.deepEqual([...graph.targets.keys()],['a:a-missing','b:b-old','a:a-recent','b:b-recent']);
});
