import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateManualFields,manualCostFor,manualCostKey,mergeAccountConfigs,mergeManualCosts } from '../scripts/lib/state.mjs';

const item={accountId:'m',id:'new',title:'中国限定 商品 A 新品',xianyuQuery:'商品A 中国版',ownPrice:5000,recommendedPrice:4500,averageCNY:20};

test('manual cost uses stable identity after a Yahoo relist',()=>{
  const old={accountId:'m',itemId:'old',title:item.title,xianyuQuery:item.xianyuQuery,purchaseCNY:30,manualFeeCNY:10,shippingJPY:210,updatedAt:'2026-01-01T00:00:00Z',identityKeys:[manualCostKey(item)]};
  assert.equal(manualCostFor({'m:old':old},item)?.purchaseCNY,30);
});

test('newer encrypted sync record wins and tombstone clears it',()=>{
  const key=manualCostKey(item);
  const base={[key]:{accountId:'m',purchaseCNY:30,updatedAt:'2026-01-01T00:00:00Z',identityKeys:[key]}};
  const merged=mergeManualCosts(base,{[key]:{accountId:'m',deleted:true,updatedAt:'2026-01-02T00:00:00Z',identityKeys:[key]}});
  assert.equal(manualCostFor(merged,item),null);
});

test('server calculation exposes current and repriced profit',()=>{
  const fields=calculateManualFields(item,{purchaseCNY:30,manualFeeCNY:10,shippingJPY:210},{exchangeRate:22.99,costMultiplier:1.05,profitWarningJPY:1500});
  assert.equal(fields.costJPY,1187);
  assert.equal(fields.currentProfitJPY,3813);
  assert.equal(fields.afterProfitJPY,3313);
});

test('managed account config is merged with static accounts',()=>{
  const accounts=mergeAccountConfigs([{id:'main',name:'A',profileUrl:'https://paypayfleamarket.yahoo.co.jp/user/p1',catalogFile:'config/a.json'}],[{id:'account-p2',name:'B',profileUrl:'https://paypayfleamarket.yahoo.co.jp/user/p2'}]);
  assert.deepEqual(accounts.map(account=>account.id),['main','account-p2']);
});
