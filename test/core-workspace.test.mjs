import { snapshotFreshness,elapsedLabel } from '../public/dashboard-freshness.js';
import { procurementLabel,publicProcurementMarkup } from '../public/procurement-view.js';
import { merchantProductKey,merchantDismissed,postedMerchantRecord } from '../public/merchant-records.js';
import { merchantMonitorStatus } from '../public/merchant-status.js';
import { syncHandoff,copySyncBody } from '../public/sync-handoff.js';
import { buildOwnedOffers,excludeOwnedOffers } from '../public/owned-offers.js';
import { merchantProfile,mergeMerchantConfigs } from '../public/merchant-config.js';
import { selectMerchantProducts,merchantCardsMarkup } from '../public/merchant-view.js';
import { pricingDecision, PLATFORM_LABELS, PRICING_RULES_VERSION } from '../public/pricing-policy.js';
import { pricingStatus, pricingSummary } from '../public/pricing-status.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mergeAccounts,resolveCostRecord,createCostResolver } from '../public/durable-state.js';
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
 Object.assign(dom.window,{snapshotFreshness,elapsedLabel,procurementLabel,publicProcurementMarkup,merchantProductKey,merchantDismissed,postedMerchantRecord,merchantMonitorStatus,syncHandoff,copySyncBody,buildOwnedOffers,excludeOwnedOffers,merchantProfile,mergeMerchantConfigs,selectMerchantProducts,merchantCardsMarkup,pricingStatus,pricingSummary,pricingDecision,PLATFORM_LABELS,mergeAccounts,resolveCostRecord,createCostResolver,candidateId,correctionKey,mergeMatchCorrections,rejectedByMemory,invalidateCorrectedMatches,parseShopProfile,FRONTEND_VERSION,fetch:async()=>{throw Error('offline fixture')}});
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true};
 dom.window.eval(source.replace(/^import .*;\r?\n/gm,'')+`window.fixture={set(value,costs){data=value;manualCosts=costs;currentAccountId='__all__'},effective,selected,render,actionablePrice}`);
 const item={id:'same',accountId:'a',accountName:'A店',title:'商品 A',ownPrice:1000,recommendedPrice:900,averageCNY:90,yahoo:{status:'ok',rulesVersion:PRICING_RULES_VERSION,checkedAt:new Date().toISOString(),candidates:[{price:901,url:'https://example.com/a',id:'1',matchMethod:'verified'}]},rakuma:{status:'ok',rulesVersion:PRICING_RULES_VERSION,checkedAt:new Date().toISOString()},mercari:{status:'ok',rulesVersion:PRICING_RULES_VERSION,checkedAt:new Date().toISOString()}};
 const other={...item,accountId:'b',accountName:'B店',title:'商品 B',comparisonIncomplete:true,mercari:{status:'error'}};
 const costs={'a:item:same':{accountId:'a',itemId:'same',purchaseCNY:20,manualFeeCNY:0,shippingJPY:0},'b:item:same':{accountId:'b',itemId:'same',purchaseCNY:50,manualFeeCNY:0,shippingJPY:0}};
 dom.window.fixture.set({settings:{exchangeRate:20,costMultiplier:1,profitWarningJPY:1500},items:[other,item],accounts:[{id:'a',name:'A店'},{id:'b',name:'B店'}]},costs);
 const effective=dom.window.fixture.effective(item);assert.equal(effective.purchaseCNY,20);assert.equal(effective.automaticReferenceCNY,90);assert.equal(effective.costJPY,400);assert.equal(effective.currentProfitJPY,600);
 assert.equal(dom.window.fixture.actionablePrice(other),true);
 assert.equal(dom.window.fixture.selected()[0].accountId,'a');
 dom.window.fixture.render();assert.equal(dom.window.document.querySelectorAll('.inventory-card').length,2);
 assert.match(dom.window.document.querySelector('#pricingProgress').textContent,/三平台全部完成 1\/2/);
 assert.match(dom.window.document.querySelector('#cards').textContent,/建议降价/);
 dom.window.document.querySelector('#cards [data-account="b"]').click();
 assert.equal(dom.window.document.querySelector('#detailBody h2').textContent,'商品 B');
 assert.equal(dom.window.document.querySelector('#purchaseCNY').value,'50');
 assert.equal(dom.window.document.querySelector('.scan-details').open,false);
 const stale={...item,ownPrice:26989,recommendedPrice:29799,yahoo:{...item.yahoo,rulesVersion:19,matchLabel:'与下一家同款存在提价空间'}};
 dom.window.fixture.set({settings:{exchangeRate:20,costMultiplier:1,profitWarningJPY:1500},items:[stale],accounts:[{id:'a',name:'A店'}]},costs);
 dom.window.fixture.render();dom.window.document.querySelector('#cards [data-account="a"]').click();
 const text=dom.window.document.querySelector('#detailBody').textContent;
 assert.ok(text.includes('暂无可靠调价依据'));assert.ok(!text.includes('29,799'));assert.ok(!text.includes('与下一家同款存在提价空间'));
 assert.ok(!text.includes('Yahoo最低'));assert.ok(!text.includes('乐天Rakuma最低'));
 dom.window.eval("startCloudSync=async()=>{};renderMerchantSettings();");
 const input=dom.window.document.querySelector('#merchantUrls');input.value='https://fril.jp/shop/example\nhttps://jp.mercari.com/user/profile/123';
 await dom.window.document.querySelector('#merchantForm').onsubmit({preventDefault(){}});
 assert.equal(dom.window.document.querySelectorAll('.merchant-row').length,2);
 assert.match(dom.window.document.querySelector('#merchantList').textContent,/本机已保存/);
 input.value='https://not-a-marketplace.test/shop/bad';await dom.window.document.querySelector('#merchantForm').onsubmit({preventDefault(){}});
 assert.equal(dom.window.document.querySelectorAll('.merchant-row').length,2);
 assert.match(dom.window.document.querySelector('#merchantSaveStatus').textContent,/商家主页/);
 await dom.window.document.querySelector('[data-remove-merchant]').onclick();
 assert.equal(dom.window.document.querySelectorAll('.merchant-row').length,1);
 dom.window.document.querySelector('#syncBody').value='encrypted-test-body';
 await dom.window.document.querySelector('#copySyncBody').onclick();
 assert.match(dom.window.document.querySelector('#syncCopyStatus').textContent,/未允许复制/);
 assert.equal(dom.window.document.querySelector('#syncBody').selectionEnd,19);
 await new Promise(resolve=>setImmediate(resolve));
 }finally{dom.window.close()}
});

test('supplier offer has a working correction button and disappears immediately without clearing manual costs',async()=>{
 const html=await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8'),source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
 const dom=new JSDOM(html,{url:'https://example.test',runScripts:'outside-only'});
 try{
  Object.assign(dom.window,{snapshotFreshness,elapsedLabel,procurementLabel,publicProcurementMarkup,merchantProductKey,merchantDismissed,postedMerchantRecord,merchantMonitorStatus,syncHandoff,copySyncBody,buildOwnedOffers,excludeOwnedOffers,merchantProfile,mergeMerchantConfigs,selectMerchantProducts,merchantCardsMarkup,pricingStatus,pricingSummary,pricingDecision,PLATFORM_LABELS,mergeAccounts,resolveCostRecord,createCostResolver,candidateId,correctionKey,mergeMatchCorrections,rejectedByMemory,invalidateCorrectedMatches,parseShopProfile,FRONTEND_VERSION,fetch:async()=>{throw Error('offline fixture')}});
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true};
  dom.window.eval(source.replace(/^import .*;\r?\n/gm,'')+`window.fixture={set(value,costs){data=value;manualCosts=costs;matchCorrections={};currentAccountId='__all__'},detail,corrections:()=>matchCorrections,costs:()=>manualCosts}`);
  const target={accountId:'a',id:'own',title:'完整手办',image:'https://images.example.org/1.jpg',description:'新品未開封',condition:'未使用'};
  const offer={target,verification:'public_purchasable_offer_v1',eligibility:'condition_unconfirmed',condition:'retail_unspecified',identity:{method:'reviewed_catalog_identity'},catalogIdentity:{method:'reviewed_catalog_identity',scope:'catalogue_product_only',sealVerified:false},status:'quoted',inStock:true,currency:'CNY',shippingKnown:true,unitCNY:1120,shippingCNY:0,landedCNY:1120,price:1120,url:'https://www.alter-shanghai.cn/m/spotPage/298.html',canonicalUrl:'https://www.alter-shanghai.cn/m/spotPage/298.html',id:'298',checkedAt:new Date().toISOString(),detailTitle:'娜贝拉尔',sellerName:'阿尔塔在线'};
  const item={...target,procurementTarget:{...target},accountName:'A店',ownPrice:20000,procurementSource:{status:'incomplete',samples:[],purchasableOffers:[offer]}};
  const costs={'a:item:own':{accountId:'a',itemId:'own',purchaseCNY:80,manualFeeCNY:4,shippingJPY:500}};
  dom.window.fixture.set({settings:{exchangeRate:20,costMultiplier:1,profitWarningJPY:1500},items:[item],accounts:[{id:'a',name:'A店'}]},costs);
  dom.window.fixture.detail('own','a');
  assert.match(dom.window.document.querySelector('.procurement-evidence').textContent,/1,120/);
  const button=dom.window.document.querySelector('[data-correct]');assert.ok(button);button.click();
  assert.doesNotMatch(dom.window.document.querySelector('.procurement-evidence').textContent,/1,120/);
  const [record]=Object.values(dom.window.fixture.corrections());assert.equal(record.platform,'procurement');assert.equal(record.candidateId,offer.canonicalUrl);assert.equal(record.candidateUrl,offer.canonicalUrl);
  assert.equal(dom.window.document.querySelector('#purchaseCNY').value,'80');assert.equal(dom.window.fixture.costs()['a:item:own'].shippingJPY,500);
  dom.window.document.querySelector('[data-undo-correction]').click();
  assert.match(dom.window.document.querySelector('.procurement-evidence').textContent,/1,120/);
  await new Promise(resolve=>setImmediate(resolve));
 }finally{dom.window.close()}
});
