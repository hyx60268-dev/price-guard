import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryDelta,isFresh,isFreshMinutes,reconcileLiveItems,shouldScanXianyu,verifiedXianyuCache } from '../scripts/lib/planner.mjs';

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

test('v3 card-only xianyu prices are never reused as trusted cache',()=>{
  assert.equal(verifiedXianyuCache({averageCNY:3,xianyu:{status:'ok'}}),null);
  assert.deepEqual(verifiedXianyuCache({averageCNY:28,xianyu:{verification:'detail_and_price_cluster',samples:[{price:28},{price:30}]}}),{
    averageCNY:28,samples:[{price:28},{price:30}],checkedAt:null,verification:'detail_and_price_cluster'
  });
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
