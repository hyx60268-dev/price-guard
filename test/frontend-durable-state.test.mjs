import { merchantProductKey,merchantDismissed,postedMerchantRecord } from '../public/merchant-records.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mergeAccounts,resolveCostRecord,createCostResolver } from '../public/durable-state.js';
import { candidateId,correctionKey,mergeMatchCorrections,rejectedByMemory,invalidateCorrectedMatches } from '../public/match-memory.js';
import { parseShopProfile } from '../public/shop-profile.js';
import { FRONTEND_VERSION } from '../public/build-version.js';

test('browser migration respects cloud tombstones and sync preserves relisted costs and clears',async()=>{
  const html=await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://example.test',runScripts:'outside-only'});
  try{
    Object.assign(dom.window,{merchantProductKey,merchantDismissed,postedMerchantRecord,mergeAccounts,resolveCostRecord,createCostResolver,candidateId,correctionKey,mergeMatchCorrections,rejectedByMemory,invalidateCorrectedMatches,parseShopProfile,FRONTEND_VERSION,
      fetch:async()=>{throw Error('offline fixture')}});
    dom.window.eval(source.replace(/^import .*;\r?\n/gm,'')+`
      window.fixture={set(value,costs){data=value;manualCosts=costs},migrateLocalData,getLocal,manualFor,syncCosts};`);
    const a={id:'a',profileUrl:'https://paypayfleamarket.yahoo.co.jp/user/p1',name:'old',updatedAt:'2026-01-01'};
    dom.window.localStorage.setItem('priceGuard.localAccounts.v2',JSON.stringify([a]));
    const item={id:'new',accountId:'a',title:'商品 A',xianyuQuery:'商品'};
    const record={accountId:'a',itemId:'old',title:item.title,purchaseCNY:30,manualFeeCNY:10,shippingJPY:500,updatedAt:'2026-01-01'};
    dom.window.fixture.set({items:[item],accounts:[],managedAccounts:[{...a,enabled:false,updatedAt:'2026-01-02'}],relistAliases:{'a:new':'old'}},{'a:item:old':record});
    dom.window.fixture.migrateLocalData();
    assert.equal(dom.window.fixture.getLocal().length,0);
    assert.equal(dom.window.fixture.manualFor(item).purchaseCNY,30);
    assert.equal(dom.window.fixture.syncCosts()['a:item:new'].purchaseCNY,30);
    dom.window.fixture.set({items:[item],relistAliases:{'a:new':'old'}},{'a:item:old':record,'a:item:new':{...record,itemId:'new',deleted:true,updatedAt:'2026-01-03'}});
    assert.equal(dom.window.fixture.manualFor(item).purchaseCNY,undefined);
    assert.equal(dom.window.fixture.syncCosts()['a:item:new'].deleted,true);
    await new Promise(resolve=>setImmediate(resolve));
  }finally{dom.window.close()}
});
