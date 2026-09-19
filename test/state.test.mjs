import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateManualFields,discoveryDismissalKey,manualCostFor,manualCostKey,mergeAccountConfigs,mergeDiscoveryReviews,mergeDismissedDiscoveries,mergeManualCosts,reconcileDurableState } from '../scripts/lib/state.mjs';
import { mergePortalUserRecords,portalUsersForResult,portalUsersFromEnv,scopeResultForPortalUser } from '../scripts/lib/publish.mjs';

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

test('uploaded discovery products keep a stable cross-device dismissal key',()=>{
  const item={id:'candidate',sourceTitle:'中国限定 鬼滅の刃 新繹 アクリルスタンド 不死川実弥'};
  const key=discoveryDismissalKey(item),older={[key]:{productKey:key,title:item.sourceTitle,updatedAt:'2026-01-01T00:00:00Z'}};
  const merged=mergeDismissedDiscoveries(older,{[key]:{productKey:key,title:item.sourceTitle,updatedAt:'2026-01-02T00:00:00Z'}});
  assert.equal(discoveryDismissalKey({...item,productKey:key}),key);
  assert.equal(merged[key].updatedAt,'2026-01-02T00:00:00Z');
});

test('published sync state cannot be lost to a newer scan cache',()=>{
  const cache={dataRevision:'2026-01-03T00:00:00Z',managedAccounts:[],manualCosts:{a:{purchaseCNY:10,updatedAt:'2026-01-01T00:00:00Z'}}};
  const published={dataRevision:'2026-01-02T00:00:00Z',managedAccounts:[{id:'momoka',name:'桃香',profileUrl:'https://paypayfleamarket.yahoo.co.jp/user/p2',updatedAt:'2026-01-02T00:00:00Z'}],manualCosts:{a:{purchaseCNY:20,updatedAt:'2026-01-02T00:00:00Z'}}};
  const merged=reconcileDurableState(cache,published);
  assert.equal(merged.managedAccounts[0].name,'桃香');
  assert.equal(merged.manualCosts.a.purchaseCNY,20);
});

test('manual discovery review keeps verified price and image set',()=>{
  const merged=mergeDiscoveryReviews({}, {p:{productKey:'p',purchaseCNY:'28',images:['https://a/1','bad','https://a/2','https://a/3'],updatedAt:'2026-01-01T00:00:00Z'}});
  assert.equal(merged.p.purchaseCNY,28);
  assert.deepEqual(merged.p.images,['https://a/1','https://a/2','https://a/3']);
});

test('portal user sees only assigned shops and costs',()=>{
  const users=portalUsersFromEnv(JSON.stringify([{username:'staff-a',displayName:'A',password:'12345678',githubLogin:'a',notificationEmail:'staff@example.com',accountIds:['shop-a']}]));
  const result={accounts:[{id:'shop-a'},{id:'shop-b'}],items:[{id:'a',accountId:'shop-a',title:'A'},{id:'b',accountId:'shop-b',title:'B'}],manualCosts:{a:{accountId:'shop-a'},b:{accountId:'shop-b'}},portalPreferences:{'staff-a':{notificationEmail:'new@example.com'}},managedAccounts:[{id:'shop-a'},{id:'shop-b'}]};
  const scoped=scopeResultForPortalUser(result,users[0]);
  assert.deepEqual(scoped.accounts.map(account=>account.id),['shop-a']);
  assert.deepEqual(scoped.items.map(value=>value.id),['a']);
  assert.deepEqual(Object.keys(scoped.manualCosts),['a']);
  assert.equal(scoped.portalUser.role,'member');
  assert.equal(scoped.portalUser.notificationEmail,'new@example.com');
  assert.equal(scoped.portalPreferences,undefined);
  assert.equal(scoped.portalUsers,undefined);
});

test('admin can create a login before the user adds a shop',()=>{
  const users=portalUsersFromEnv(JSON.stringify([{username:'new-user',displayName:'新人',password:'12345678'}]));
  assert.deepEqual(users[0].accountIds,[]);
  const scoped=scopeResultForPortalUser({accounts:[],items:[],manualCosts:{},managedAccounts:[]},users[0]);
  assert.equal(scoped.portalUser.displayName,'新人');
  assert.deepEqual(scoped.accounts,[]);
});

test('encrypted portal records override legacy env users and keep deletion tombstones',()=>{
  const env=JSON.stringify([{username:'staff',displayName:'旧昵称',password:'old-pass-123',accountIds:['old']}]);
  const result={portalUsers:[{username:'staff',displayName:'新昵称',password:'new-pass-123',accountIds:[],enabled:true,updatedAt:'2026-09-19T00:00:00Z'}]};
  assert.equal(portalUsersForResult(result,env)[0].displayName,'新昵称');
  const deleted=mergePortalUserRecords(result.portalUsers,[{username:'staff',displayName:'新昵称',password:'',enabled:false,updatedAt:'2026-09-20T00:00:00Z'}]);
  assert.equal(portalUsersForResult({portalUsers:deleted},env).length,0);
});
