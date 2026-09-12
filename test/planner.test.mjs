import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryDelta,reconcileLiveItems,shouldScanXianyu } from '../scripts/lib/planner.mjs';

test('live inventory reuses saved search metadata and reports add/remove',()=>{
  const catalog=[{id:'a',xianyuQuery:'目标 A',size:'小'}];
  const previous=[{id:'a',title:'旧 A',averageCNY:28,xianyuQuery:'旧查询'},{id:'b',title:'旧 B'}];
  const live=[{id:'a',title:'新 A',ownPrice:100},{id:'c',title:'新 C',ownPrice:200}];
  const merged=reconcileLiveItems(catalog,previous,live);
  assert.equal(merged[0].xianyuQuery,'目标 A');
  assert.equal(merged[0].averageCNY,28);
  assert.equal(merged[0].title,'新 A');
  assert.deepEqual(inventoryDelta(previous,merged),{added:['c'],removed:['b'],unchanged:1});
});

test('xianyu only runs when a verified yahoo competitor is lower',()=>{
  const item={ownPrice:100};
  assert.equal(shouldScanXianyu(item,{status:'ok',lowestPrice:99}),true);
  assert.equal(shouldScanXianyu(item,{status:'ok',lowestPrice:100}),false);
  assert.equal(shouldScanXianyu(item,{status:'error',lowestPrice:80}),false);
});
