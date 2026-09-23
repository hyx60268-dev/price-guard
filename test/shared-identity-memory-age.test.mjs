import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { encrypt, decrypt } from '../scripts/lib/crypto.mjs';
import { offerIdentityGuard } from '../scripts/lib/offer-identity.mjs';
import { listingAge } from '../scripts/lib/listing-age.mjs';
import { acceptMatchCorrections } from '../scripts/lib/match-corrections.mjs';
import { candidateId, correctionKey, invalidateCorrectedMatches, rejectedByMemory } from '../public/match-memory.js';
import { reconcileDurableState } from '../scripts/lib/state.mjs';
import { scopeResultForPortalUser } from '../scripts/lib/publish.mjs';
import { sameDiscoveryProduct } from '../scripts/lib/discovery.mjs';
import { yahooCompare } from '../scripts/lib/yahoo.mjs';
import { xianyuCost } from '../scripts/lib/xianyu.mjs';

const cases=JSON.parse(await fs.readFile(new URL('./fixtures/user-match-regressions.json',import.meta.url),'utf8'));
for(const row of cases)test(`saved user case: ${row.case}`,()=>{
  const result=offerIdentityGuard(row);
  assert.equal(result.accepted,!row.expected);
  if(row.expected)assert.equal(result.reason,row.expected);
});
test('Chinese colour and quantity statements remain hard conflicts across languages',()=>{
  assert.equal(offerIdentityGuard({ownTitle:'スターバックス ボトル ブルー',ownDescription:'新品',candidateTitle:'星巴克 杯 棕色',candidateDescription:'全新',checkImages:false}).accepted,false);
  assert.equal(offerIdentityGuard({ownTitle:'MG ガンダム',ownDescription:'1個',candidateTitle:'MG ガンダム',candidateDescription:'2个',checkImages:false}).reason,'sale_unit_mismatch');
});
test('discovery reads sale contents before grouping identical trilogy titles',()=>{
  assert.equal(sameDiscoveryProduct({title:'FAN HO 香港三部作 写真集',description:'3冊セット'},{title:'FAN HO 香港三部作 写真集',description:'黒とベージュセット売り、別売り不可'}),false);
});

const now=Date.parse('2026-09-23T12:00:00Z'),days=n=>new Date(now-n*86400000).toISOString();
const listing=()=>({id:'own',accountId:'melon',itemStatus:'OPEN',title:'FAN HO 写真集',ownPrice:10000,image:'own-image',yahoo:{ownListingId:'own',ownListedAt:days(31),candidates:[{id:'other',price:7000,title:'FAN HO 写真集'}]}});
test('30-day reminders require current live status and the same listing, never its update date',()=>{
  assert.equal(listingAge(listing(),{},'live',now).eligible,true);
  assert.equal(listingAge({...listing(),yahoo:{ownListingId:'own',ownListedAt:days(29.99)}},{},'live',now).eligible,false);
  assert.equal(listingAge({...listing(),yahoo:{ownListingId:'own',ownListedAt:days(30)}},{},'live',now).eligible,true);
  assert.equal(listingAge(listing(),{},'error',now).eligible,false);
  assert.equal(listingAge({...listing(),itemStatus:'SOLD'},{},'live',now).eligible,false);
  const noDate={...listing(),yahoo:{},updateDate:days(99)};
  assert.equal(listingAge(noDate,{},'live',now).days,0);
  const old={...listing(),listingAge:{firstObservedAt:days(35)}};
  assert.equal(listingAge(noDate,old,'live',now).eligible,true);
  assert.equal(listingAge({...noDate,id:'relisted',relistedFrom:'own'},old,'live',now).days,0);
  assert.equal(listingAge({...listing(),id:'relisted',relistedFrom:'own'},old,'live',now).days,0);
  assert.equal(listingAge({...listing(),yahoo:{ownListedAt:days(-1)}},{},'live',now).days,0);
});

const record=(overrides={})=>({accountId:'melon',itemId:'own',platform:'yahoo',candidateId:'other',updatedAt:new Date(now).toISOString(),...overrides});
test('corrections survive newer scan caches, retain undo tombstones and respect portal permissions',()=>{
  const saved=acceptMatchCorrections({}, {a:record()},[listing()],new Set(['melon']),now);
  const key=correctionKey(record());
  assert.equal(saved[key].ownTitle,listing().title);
  assert.throws(()=>acceptMatchCorrections({}, {a:record({accountId:'boss'})},[listing()],new Set(['melon']),now),/无权/);
  assert.throws(()=>acceptMatchCorrections({}, {a:record({candidateId:'invented'})},[listing()],null,now),/样本/);
  const restored=reconcileDurableState({checkedAt:days(-1),matchCorrections:{}},{checkedAt:days(1),matchCorrections:saved});
  assert.equal(restored.matchCorrections[key].deleted,false);
  const undone=acceptMatchCorrections(saved,{a:record({deleted:true,updatedAt:new Date(now+1).toISOString()})},[listing()],null,now);
  assert.equal(reconcileDurableState({matchCorrections:saved},{matchCorrections:undone}).matchCorrections[key].deleted,true);
  assert.deepEqual(scopeResultForPortalUser({matchCorrections:saved},{accountIds:['boss']}).matchCorrections,{});
});
test('corrections stop stale prices immediately, preserve user fees and avoid other shops',()=>{
  const saved=acceptMatchCorrections({}, {a:record()},[listing()],null,now);
  const own={...listing(),recommendedPrice:6999,manualCost:{purchaseCNY:80,shippingJPY:500}};
  const held=invalidateCorrectedMatches(own,saved);
  assert.equal(held.recommendedPrice,10000);
  assert.deepEqual(held.manualCost,own.manualCost);
  assert.equal(held.yahoo.rulesVersion,0);
  assert.equal(invalidateCorrectedMatches({...own,accountId:'boss'},saved).recommendedPrice,6999);
  assert.ok(rejectedByMemory(saved,{...own,id:'relisted',relistedFrom:'own'},'yahoo',{id:'other'}));
  assert.equal(candidateId('xianyu',{url:'https://www.goofish.com/item?id=123&x=1'}),'123');
});
test('Yahoo replay actually consumes saved corrections before comparison',async()=>{
  const own=listing(),saved=acceptMatchCorrections({}, {a:record()},[own],null,now);
  const result=await yahooCompare(null,own,{matchCorrections:saved},{fetchYahooItemBundle:async()=>({detail:{title:own.title,description:'新品',images:[]},recommendations:[{id:'other',title:own.title,price:7000,source:'recommendation',recommendationScore:.999}]}),fetchYahooResult:async()=>({items:[]}),imageFingerprints:async()=>null});
  assert.equal(result.competitorCount,0);
  assert.equal(result.recommendedPrice,10000);
  assert.ok(result.rejected.some(row=>row.reason==='saved_user_correction'));
});
test('Xianyu replay reads full descriptions rather than accepting identical trilogy titles',async()=>{
  const title='FAN HO 香港三部作 写真集';
  const detail={goto:async()=>{},waitForLoadState:async()=>{},waitForTimeout:async()=>{},close:async()=>{},evaluate:async()=>({text:'新品 黒とベージュセット売り、別売り不可。写真集です。',titles:[title],images:['unused-image'],price:90,sellerKey:'goofish:seller',optionCount:0,blocked:false,loginVisible:false})};
  const page={goto:async()=>{},waitForLoadState:async()=>{},waitForTimeout:async()=>{},waitForSelector:async()=>{},url:()=> 'https://www.goofish.com/search',context:()=>({newPage:async()=>detail}),evaluate:async()=>({blocked:false,loginVisible:false}),locator:()=>({evaluateAll:async()=>[{id:'123',url:'https://www.goofish.com/item?id=123',title,text:title,priceText:'90'}]})};
  const result=await xianyuCost(page,{title,xianyuQuery:title,description:'新品 未使用 3冊セット'},{});
  assert.equal(result.averageCNY,null);
  assert.ok(result.rejected.some(row=>row.reason==='sale_unit_mismatch'));
});

test('encrypted correction sync publishes a safe price and retains fees and email',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url)),temp=await fs.mkdtemp(path.join(os.tmpdir(),'price-guard-correction-'));
  try{
    await fs.cp(path.join(root,'scripts'),path.join(temp,'scripts'),{recursive:true});
    for(const directory of ['public','state','config'])await fs.mkdir(path.join(temp,directory),{recursive:true});
    await fs.copyFile(path.join(root,'public/match-memory.js'),path.join(temp,'public/match-memory.js'));
    await fs.writeFile(path.join(temp,'package.json'),' {"type":"module"}');
    await fs.symlink(await fs.realpath(path.join(root,'node_modules')),path.join(temp,'node_modules'));
    await fs.writeFile(path.join(temp,'config/accounts.json'),JSON.stringify({accounts:[{id:'melon',enabled:true}]}));
    const password='controlled-fixture-only',own={...listing(),recommendedPrice:6999};
    const manualCosts={a:{accountId:'melon',itemId:'own',title:own.title,purchaseCNY:80,manualFeeCNY:10,shippingJPY:500,updatedAt:days(1)}};
    const previous={version:6,checkedAt:days(1),settings:{exchangeRate:20,costMultiplier:1,profitWarningJPY:1500},items:[own],accounts:[{id:'melon',items:[own]}],manualCosts,portalPreferences:{admin:{notificationEmail:'retained@example.test'}}};
    await fs.writeFile(path.join(temp,'state/latest.json.enc'),encrypt(Buffer.from(JSON.stringify(previous)),password));
    const payload={version:1,matchCorrections:{a:record()}};
    const body=`<!-- PRICE_GUARD_SYNC_V1\n${encrypt(Buffer.from(JSON.stringify(payload)),password).toString('base64url')}\n-->`;
    const eventPath=path.join(temp,'event.json');await fs.writeFile(eventPath,JSON.stringify({repository:{owner:{login:'owner'}},issue:{title:'[Price Guard Sync:admin]',user:{login:'owner'},body}}));
    await promisify(execFile)(process.execPath,['scripts/sync-input.mjs'],{cwd:temp,env:{...process.env,DASHBOARD_PASSWORD:password,GITHUB_EVENT_PATH:eventPath,PORTAL_USERS_JSON:'',GITHUB_OUTPUT:''}});
    const result=JSON.parse(decrypt(await fs.readFile(path.join(temp,'public/data/latest.json.enc')),password));
    assert.equal(result.items[0].recommendedPrice,10000);
    assert.equal(result.accounts[0].items[0].recommendedPrice,10000);
    assert.equal(result.items[0].costJPY,2300);
    assert.deepEqual(result.manualCosts,manualCosts);
    assert.equal(result.portalPreferences.admin.notificationEmail,'retained@example.test');
    assert.equal(Object.keys(result.matchCorrections).length,1);
  }finally{await fs.rm(temp,{recursive:true,force:true})}
});
