import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mergeAccounts,resolveCostRecord } from '../public/durable-state.js';
import { candidateId,correctionKey,mergeMatchCorrections,rejectedByMemory,invalidateCorrectedMatches } from '../public/match-memory.js';
import { parseShopProfile } from '../public/shop-profile.js';
import { FRONTEND_VERSION } from '../public/build-version.js';
import { createNavigationGate } from '../scripts/lib/xianyu-pacing.mjs';

test('search and detail navigation slots are serialized, with no wait after a long idle',async()=>{
 let now=0;const waits=[];const gate=createNavigationGate({intervalMs:8000,clock:()=>now,sleep:async ms=>{waits.push(ms);now+=ms}});
 await Promise.all([gate(),gate(),gate()]);assert.deepEqual(waits,[8000,8000]);now+=10000;await gate();assert.equal(waits.length,2);
});
test('actual procurement wins over automatic reference; overview sorts and opens the correct account',async()=>{
 const html=await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
 const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
 const dom=new JSDOM(html,{url:'https://example.test',runScripts:'outside-only'});
 try{
 Object.assign(dom.window,{mergeAccounts,resolveCostRecord,candidateId,correctionKey,mergeMatchCorrections,rejectedByMemory,invalidateCorrectedMatches,parseShopProfile,FRONTEND_VERSION,fetch:async()=>{throw Error('offline fixture')}});
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true};
 dom.window.eval(source.replace(/^import .*;\r?\n/gm,'')+`window.fixture={set(value,costs){data=value;manualCosts=costs;currentAccountId='__all__'},effective,selected,render,actionablePrice}`);
 const item={id:'same',accountId:'a',accountName:'A店',title:'商品 A',ownPrice:1000,recommendedPrice:900,averageCNY:90,yahoo:{status:'ok'},rakuma:{status:'ok'}};
 const other={...item,accountId:'b',accountName:'B店',title:'商品 B',comparisonIncomplete:true};
 const costs={'a:item:same':{accountId:'a',itemId:'same',purchaseCNY:20,manualFeeCNY:0,shippingJPY:0},'b:item:same':{accountId:'b',itemId:'same',purchaseCNY:50,manualFeeCNY:0,shippingJPY:0}};
 dom.window.fixture.set({settings:{exchangeRate:20,costMultiplier:1,profitWarningJPY:1500},items:[other,item],accounts:[{id:'a',name:'A店'},{id:'b',name:'B店'}]},costs);
 const effective=dom.window.fixture.effective(item);assert.equal(effective.purchaseCNY,20);assert.equal(effective.automaticReferenceCNY,90);assert.equal(effective.costJPY,400);assert.equal(effective.currentProfitJPY,600);
 assert.equal(dom.window.fixture.actionablePrice(other),false);
 assert.equal(dom.window.fixture.selected()[0].accountId,'a');
 dom.window.fixture.render();assert.equal(dom.window.document.querySelectorAll('.inventory-card').length,2);
 dom.window.document.querySelector('#cards [data-account="b"]').click();
 assert.equal(dom.window.document.querySelector('#detailBody h2').textContent,'商品 B');
 assert.equal(dom.window.document.querySelector('#purchaseCNY').value,'50');
 assert.equal(dom.window.document.querySelector('.scan-details').open,false);
 await new Promise(resolve=>setImmediate(resolve));
 }finally{dom.window.close()}
});
