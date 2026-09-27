import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAccounts,resolveCostRecord } from '../public/durable-state.js';
import { reconcileDurableState,manualCostFor } from '../scripts/lib/state.mjs';
import { reconcileLiveItems } from '../scripts/lib/planner.mjs';

const old='2026-09-01T00:00:00Z',recent='2026-09-02T00:00:00Z';
test('older device cannot replace renamed or deleted account; restore preserves tombstone',()=>{
  const account={id:'a',profileUrl:'https://paypayfleamarket.yahoo.co.jp/user/p1',name:'old',updatedAt:old};
  const changed={...account,name:'new',updatedAt:recent};
  assert.equal(mergeAccounts([changed],[account])[0].name,'new');
  const tombstone={...changed,enabled:false};
  assert.equal(reconcileDurableState({managedAccounts:[account]},{managedAccounts:[tombstone]}).managedAccounts[0].enabled,false);
  assert.equal(mergeAccounts([tombstone],[changed])[0].enabled,false);
});
test('sold inventory gap and two relists retain manual costs through alias chain',()=>{
  const original={id:'first',accountId:'a',title:'商品 A ブルー',xianyuQuery:'商品A'};
  const [relisted]=reconcileLiveItems([],[],[{id:'second',title:original.title}],'a',[original]);
  assert.equal(relisted.relistedFrom,'first');
  const [third]=reconcileLiveItems([],[],[{id:'third',title:original.title}],'a',[relisted]);
  const costs={'a:item:first':{...original,itemId:'first',purchaseCNY:88,manualFeeCNY:10,shippingJPY:600,updatedAt:old}};
  const aliases={'a:second':'first','a:third':'second'};
  assert.equal(manualCostFor(costs,third,aliases).purchaseCNY,88);
  assert.equal(manualCostFor(costs,{...third,accountId:'b'},aliases),null);
});
test('same search words cannot transfer cost to another colour or unit',()=>{
  const record={accountId:'a',itemId:'old',title:'商品 A ブルー 単品',xianyuQuery:'商品A',purchaseCNY:88,updatedAt:old,identityKeys:['a:query:商品a']};
  for(const title of ['商品 A ブラウン 単品','商品 A ブルー 2個セット'])assert.equal(resolveCostRecord({'a:query:商品a':record},{id:'new',accountId:'a',title,xianyuQuery:'商品A'}),null);
});
test('ambiguous identical live listings do not inherit by title, direct records still work',()=>{
  const item={id:'new',accountId:'a',title:'商品 A'};
  const costs={old:{accountId:'a',itemId:'old',title:item.title,purchaseCNY:50,updatedAt:old}};
  const live=[item,{...item,id:'another'}];
  assert.equal(resolveCostRecord(costs,item,{},live),null);
  costs.direct={...costs.old,itemId:'new',purchaseCNY:60};
  assert.equal(resolveCostRecord(costs,item,{},live).purchaseCNY,60);
  assert.equal(reconcileLiveItems([],live,[...live,{...item,id:'third'}],'a')[2].relistedFrom,undefined);
});
