import test from 'node:test';
import assert from 'node:assert/strict';
import { createCostResolver,resolveCostRecord } from '../public/durable-state.js';
test('indexed cost lookup preserves account isolation, relist links and ambiguous-title rejection',()=>{
 const inventory=[{id:'new',accountId:'a',title:'same'},{id:'duplicate',accountId:'a',title:'same'},{id:'b',accountId:'b',title:'same'},{id:'c',accountId:'a',title:'unique'}];
 const costs={old:{accountId:'a',itemId:'old',title:'same',purchaseCNY:8},other:{accountId:'b',itemId:'b',title:'same',purchaseCNY:10},u:{accountId:'a',title:'unique',purchaseCNY:12}};
 const aliases={'a:new':'old'},resolve=createCostResolver(costs,aliases,inventory);
 for(const item of inventory)assert.deepEqual(resolve(item),resolveCostRecord(costs,item,aliases,inventory));
 assert.equal(resolve(inventory[1]),null);
});
test('1200 inventory lookups normalize inventory once instead of scanning every title for every row',()=>{
 let reads=0;const inventory=Array.from({length:1200},(_,i)=>({id:String(i),accountId:'a',get title(){reads++;return 'product '+i}}));
 const resolve=createCostResolver({}, {},inventory);for(const item of inventory)resolve(item);
 assert.ok(reads<=2400,`title reads ${reads}`);
});
