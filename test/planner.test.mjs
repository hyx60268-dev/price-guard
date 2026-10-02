import test from 'node:test';
import assert from 'node:assert/strict';
import { comparisonAttemptTime,retainComparisonAttempt,currentInventoryAdditions,fairRoundRobin,inventoryDelta,isFresh,isFreshMinutes,parsePriceAuditItemIds,prioritizePriceAuditItems,reconcileLiveItems,shouldScanXianyu,verifiedXianyuCache } from '../scripts/lib/planner.mjs';
import { manualCostFor } from '../scripts/lib/state.mjs';
import { cachedComparison } from '../scripts/lib/pricing-coverage.mjs';
import { pricingDecision,PRICING_RULES_VERSION } from '../public/pricing-policy.js';

test('Yahoo minute cache does not accidentally last for hours',()=>{
  const now=Date.parse('2026-09-12T12:00:00Z');
  assert.equal(isFreshMinutes('2026-09-12T11:50:00Z',15,now),true);
  assert.equal(isFreshMinutes('2026-09-12T11:30:00Z',15,now),false);
  assert.equal(isFresh('2026-09-12T11:30:00Z',15,now),true);
});

test('live inventory reuses saved search metadata and reports add/remove',()=>{
  const catalog=[{id:'a',xianyuQuery:'目标 A',size:'小'}];
  const previous=[{id:'a',title:'旧 A',averageCNY:28,xianyuQuery:'旧查询'},{id:'b',title:'旧 B'}];
  const live=[{id:'a',title:'新 A',ownPrice:100},{id:'c',title:'新 C',ownPrice:200}];
  const merged=reconcileLiveItems(catalog,previous,live);
  assert.equal(merged[0].xianyuQuery,'目标 A');
  assert.equal(merged[0].averageCNY,28);
  assert.equal(merged[0].title,'新 A');
  assert.deepEqual(inventoryDelta(previous,merged),{added:['c'],removed:['b'],relisted:[],unchanged:1});
});

test('xianyu only runs when a verified yahoo competitor is lower',()=>{
  const item={ownPrice:100};
  assert.equal(shouldScanXianyu(item,{status:'ok',lowestPrice:99}),true);
  assert.equal(shouldScanXianyu(item,{status:'ok',lowestPrice:100}),false);
  assert.equal(shouldScanXianyu(item,{status:'error',lowestPrice:80}),false);
});

test('legacy xianyu prices without target price and seller evidence are invalidated',()=>{
  assert.equal(verifiedXianyuCache({averageCNY:3,xianyu:{status:'ok'}}),null);
  assert.equal(verifiedXianyuCache({averageCNY:28,xianyu:{verification:'detail_and_price_cluster',samples:[{price:28},{price:30}]}}),null);
  assert.equal(verifiedXianyuCache({averageCNY:88,xianyu:{verification:'detail_text_images_price_cluster_v5',samples:[{price:86},{price:90}]}}),null);
});

test('relisted item inherits metadata and is reported as a relist instead of add/remove',()=>{
  const previous=[{accountId:'m',id:'old',title:'中国限定 商品 A 新品',xianyuQuery:'商品A 中国版',averageCNY:28}];
  const live=[{id:'new',title:'中国限定 商品 A 新品',ownPrice:3000}];
  const merged=reconcileLiveItems([],previous,live,'m');
  assert.equal(merged[0].id,'new');
  assert.equal(merged[0].relistedFrom,'old');
  assert.equal(merged[0].xianyuQuery,'商品A 中国版');
  assert.equal(merged[0].averageCNY,28);
  assert.deepEqual(inventoryDelta(previous,merged),{added:[],removed:[],relisted:[{from:'old',to:'new',title:'中国限定 商品 A 新品'}],unchanged:0});
});

test('ambiguous duplicate title does not inherit the wrong cost metadata',()=>{
  const previous=[{id:'old-a',title:'同名商品',xianyuQuery:'A'},{id:'old-b',title:'同名商品',xianyuQuery:'B'}];
  const merged=reconcileLiveItems([],previous,[{id:'new',title:'同名商品',ownPrice:3000}],'m');
  assert.equal(merged[0].relistedFrom,undefined);
  assert.equal(merged[0].xianyuQuery,'');
});

test('a relist gains priority only on its first refresh while manual costs remain linked',()=>{
  const previous=[{accountId:'m',id:'old',title:'中国限定 商品 A 新品',xianyuQuery:'商品A 中国版'}];
  const live=[{id:'new',title:'中国限定 商品 A 新品',ownPrice:3000}];
  const costs={'m:old':{accountId:'m',itemId:'old',purchaseCNY:28,manualFeeCNY:10,shippingJPY:210,updatedAt:'2026-10-01T00:00:00Z'}};
  const first=reconcileLiveItems([],previous,live,'m');
  const firstDelta=inventoryDelta(previous,first);
  assert.equal(currentInventoryAdditions(firstDelta).has('new'),true);
  assert.equal(manualCostFor(costs,first[0])?.purchaseCNY,28);

  const second=reconcileLiveItems([],first,live,'m');
  const secondDelta=inventoryDelta(first,second);
  assert.deepEqual(secondDelta,{added:[],removed:[],relisted:[],unchanged:1});
  assert.equal(currentInventoryAdditions(secondDelta).has('new'),false);
  assert.equal(second[0].relistedFrom,'old');
  assert.equal(second[0].xianyuQuery,'商品A 中国版');
  const inherited=manualCostFor(costs,second[0]);
  for(const [field,value] of Object.entries(costs['m:old']))assert.equal(inherited?.[field],value);
  assert.equal(manualCostFor(costs,{...second[0],accountId:'other'}),null);
});

test('an unchanged relist target is not a new event even if its origin remains in the prior inventory',()=>{
  const previous=[{id:'old',title:'商品 A'},{id:'new',title:'商品 A',relistedFrom:'old'}];
  const delta=inventoryDelta(previous,[previous[1]]);
  assert.deepEqual(delta,{added:[],removed:['old'],relisted:[],unchanged:1});
  assert.deepEqual([...currentInventoryAdditions(delta)],[]);
  assert.deepEqual([...currentInventoryAdditions({added:['fresh'],relisted:[{from:'before',to:'after'}]})],['fresh','after']);
});

test('requested price audit IDs are bounded, deduplicated and reject URLs or malformed IDs',()=>{
  assert.deepEqual([...parsePriceAuditItemIds(' z685606778, z685606778, m12345678, , https://example.com/item/z99, bad id, ../old ')],['z685606778','m12345678']);
  assert.deepEqual([...parsePriceAuditItemIds()],[]);
  assert.equal(parsePriceAuditItemIds('x'.repeat(81)).size,0);
  assert.deepEqual([...parsePriceAuditItemIds(Array.from({length:23},(_,i)=>'z'+i).join(','))],Array.from({length:20},(_,i)=>'z'+i));
});

test('requested price audits promote only eligible existing tasks without changing evidence or account context',()=>{
  const tasks=[
    {context:{account:{id:'a'}},item:{id:'ordinary-a'},priority:0},
    {context:{account:{id:'b'}},item:{id:'target-b'},priority:3,prior:{checkedAt:'2026-10-01T01:00:00Z'}},
    {context:{account:{id:'c'}},item:{id:'ordinary-c'},priority:2},
    {context:{account:{id:'a'}},item:{id:'target-a'},priority:3}
  ];
  assert.equal(prioritizePriceAuditItems(tasks),tasks);
  const reordered=prioritizePriceAuditItems(tasks,parsePriceAuditItemIds('not-in-live-inventory,target-a,target-b'));
  assert.deepEqual(reordered.map(task=>task.item.id),['target-b','target-a','ordinary-a','ordinary-c']);
  assert.equal(reordered.length,tasks.length);
  assert.equal(reordered[0],tasks[1]);
  assert.equal(reordered[1],tasks[3]);
  assert.equal(reordered[0].priority,3);
  assert.equal(reordered[0].prior.checkedAt,'2026-10-01T01:00:00Z');
  assert.deepEqual(tasks.map(task=>task.item.id),['ordinary-a','target-b','ordinary-c','target-a']);
});

test('failed old evidence rotates behind an unattempted peer across successive rounds',()=>{
  const oldest='2026-10-01T01:00:00.000Z',peerChecked='2026-10-01T02:00:00.000Z',firstAttempt='2026-10-01T12:00:00.000Z',secondAttempt='2026-10-01T12:20:00.000Z';
  const failed={status:'ok',rulesVersion:PRICING_RULES_VERSION,checkedAt:oldest,candidates:[]};
  const peer={status:'ok',rulesVersion:PRICING_RULES_VERSION,checkedAt:peerChecked,candidates:[]};
  const order=sources=>sources.map(([id,source])=>({id,time:comparisonAttemptTime(source)})).sort((a,b)=>a.time-b.time).map(task=>task.id);
  assert.deepEqual(order([['failed',failed],['peer',peer]]),['failed','peer']);
  const failedOnce=retainComparisonAttempt(cachedComparison(failed,'request_error'),failed,firstAttempt);
  assert.equal(failedOnce.checkedAt,oldest);
  assert.deepEqual(order([['failed',failedOnce],['peer',peer]]),['peer','failed']);
  const deferred=retainComparisonAttempt(cachedComparison(failedOnce,'scan_budget'),failedOnce);
  assert.equal(deferred.lastAttemptAt,firstAttempt);
  const peerAttempted=retainComparisonAttempt({...peer,checkedAt:secondAttempt},peer,secondAttempt);
  assert.deepEqual(order([['failed',deferred],['peer',peerAttempted]]),['failed','peer']);
});

test('a retry timestamp never extends a failed or expired quote validity',()=>{
  const now=Date.parse('2026-10-01T12:00:00Z');
  const prior={status:'ok',rulesVersion:PRICING_RULES_VERSION,checkedAt:'2026-10-01T01:00:00.000Z',candidates:[{id:'external',price:9000,sellerId:'external',url:'https://example.test/item',matchMethod:'detail_verified'}]};
  const failed=retainComparisonAttempt(cachedComparison(prior,'request_error'),prior,new Date(now).toISOString());
  assert.equal(failed.checkedAt,prior.checkedAt);
  assert.equal(failed.lastAttemptAt,new Date(now).toISOString());
  for(const result of [failed,retainComparisonAttempt(cachedComparison(failed,'scan_budget'),failed),retainComparisonAttempt(prior,prior,new Date(now).toISOString())]){
    assert.equal(pricingDecision({ownPrice:10000,yahoo:result},{now}).canRecommend,false);
    assert.equal(isFreshMinutes(result.checkedAt,20,now),false);
  }
});

test('budget deferral preserves the last real attempt without inventing fresh evidence',()=>{
  const prior={status:'error',rulesVersion:PRICING_RULES_VERSION,checkedAt:'2026-10-01T12:00:00.000Z'};
  const deferred={status:'deferred_budget',rulesVersion:PRICING_RULES_VERSION,checkedAt:null,candidates:[]};
  const first=retainComparisonAttempt(deferred,prior),second=retainComparisonAttempt(deferred,first);
  assert.equal(first.checkedAt,null);
  assert.equal(second.checkedAt,null);
  assert.equal(first.lastAttemptAt,prior.checkedAt);
  assert.equal(second.lastAttemptAt,prior.checkedAt);
  assert.equal(comparisonAttemptTime(second),Date.parse(prior.checkedAt));
  assert.equal(retainComparisonAttempt(deferred,{}),deferred);
  assert.equal(Number.isNaN(comparisonAttemptTime({checkedAt:'invalid'})),true);
});

test('multi-shop Yahoo work is interleaved fairly',()=>{
  assert.deepEqual(fairRoundRobin([['a1','a2','a3'],['b1'],['c1','c2']]),['a1','b1','c1','a2','c2','a3']);
});
