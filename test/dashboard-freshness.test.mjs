import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { snapshotFreshness,UPDATE_DELAY_MS } from '../public/dashboard-freshness.js';
import { pricingDecision,PRICING_RULES_VERSION } from '../public/pricing-policy.js';
import { pricingStatus,pricingSummary } from '../public/pricing-status.js';

test('two-hour operational alert does not extend or shorten per-offer price validity',()=>{
 const now=Date.parse('2026-10-04T14:00:00Z');
 assert.equal(snapshotFreshness(new Date(now-UPDATE_DELAY_MS).toISOString(),{now}).state,'fresh');
 assert.equal(snapshotFreshness(new Date(now-UPDATE_DELAY_MS-1).toISOString(),{now}).state,'delayed');
 assert.equal(snapshotFreshness('invalid',{now}).state,'unknown');
 assert.equal(snapshotFreshness(new Date(now+120000).toISOString(),{now}).state,'unknown');
 const item=product('1',now-3*3600000);
 assert.equal(snapshotFreshness(item.yahoo.checkedAt,{now}).state,'delayed');
 assert.equal(pricingDecision(item,{now}).canRecommend,true);
 assert.equal(pricingDecision(item,{now:now+4*3600000}).canRecommend,false);
});
function product(id,checkedAt){
 return {id,accountId:'a',accountName:'A店',title:'商品 '+id,ownPrice:44499,lowestPrice:41999,recommendedPrice:41998,ownUrl:'https://example.test/own/'+id,image:'https://example.test/image.jpg',averageCNY:100,
 yahoo:{status:'ok',rulesVersion:PRICING_RULES_VERSION,checkedAt:new Date(checkedAt).toISOString(),candidates:[{id:'other-'+id,price:41999,url:'https://example.test/offer/'+id,sellerId:'other',matchMethod:'verified'}]},
 rakuma:{status:'ok',rulesVersion:PRICING_RULES_VERSION,checkedAt:new Date(checkedAt).toISOString()},mercari:{status:'ok',rulesVersion:PRICING_RULES_VERSION,checkedAt:new Date(checkedAt).toISOString()}};
}
async function fixture(now,products,snapshotAt=now){
 const [html,source]=await Promise.all(['index.html','app.js'].map(name=>fs.readFile(new URL('../public/'+name,import.meta.url),'utf8')));
 const dom=new JSDOM(html,{url:'https://example.test',runScripts:'outside-only'}),win=dom.window;
 for(const match of source.matchAll(/^import .* from '(\.\/[^']+)';/gm))Object.assign(win,await import(new URL('../public/'+match[1].slice(2),import.meta.url)));
 let clock=now;
 Object.assign(win,{snapshotFreshness:(stamp,options)=>snapshotFreshness(stamp,{now:clock,...options}),pricingDecision:(item,options)=>pricingDecision(item,{now:clock,...options}),pricingStatus:(item,options)=>pricingStatus(item,{now:clock,...options}),pricingSummary:(items,options)=>pricingSummary(items,{now:clock,...options}),fetch:async()=>{throw Error('offline fixture')},setInterval:()=>0});
 win.Date.now=()=>clock;
 win.HTMLDialogElement.prototype.showModal=function(){this.open=true};
 win.HTMLDialogElement.prototype.close=function(){this.open=false};
 win.eval(source.replace(/^import .*;\r?\n/gm,'')+`window.fixture={set(value,costs={}){data=value;manualCosts=costs;currentAccountId='__all__';},render,checkCloudStatus,detail,page(value){if(value!==undefined)pricingPage=value;return pricingPage},data(){return data},costs(){return manualCosts}}`);
 const data={checkedAt:new Date(snapshotAt).toISOString(),dataRevision:'same-revision',settings:{exchangeRate:20,costMultiplier:1,profitWarningJPY:1500},items:products,accounts:[{id:'a',name:'A店',profileStatus:'live'}]};
 win.fixture.set(data);win.fixture.render();await new Promise(resolve=>setImmediate(resolve));
 return {dom,win,data,setClock(value){clock=value},online(status=data){win.fetch=async()=>({ok:true,json:async()=>status})}};
}
test('HTTP 200 with unchanged two-day-old data shows outage and explains empty reprice filter',async()=>{
 const now=Date.parse('2026-10-04T14:00:00Z'),old=now-48*3600000;
 const f=await fixture(now,[product('1',old)],old);
 try{
  f.online();await f.win.fixture.checkCloudStatus(true);
  const doc=f.win.document;
  assert.equal(doc.querySelector('#freshnessNotice').hidden,false);
  assert.match(doc.querySelector('#freshnessText').textContent,/2 天/);
  assert.match(doc.querySelector('#stamp').textContent,/最近成功扫描/);
  assert.doesNotMatch(doc.querySelector('#rows').textContent,/41,999|41,998/);
  assert.match(doc.querySelector('#rows').textContent,/待核验.*暂无建议/);
  doc.querySelector('#filter').value='reprice';f.win.fixture.render();
  assert.match(doc.querySelector('#emptyText').textContent,/报价已过期/);
  doc.querySelector('#showAllItems').click();
  assert.equal(doc.querySelectorAll('.inventory-card').length,1);
  assert.equal(f.win.fixture.data().checkedAt,new Date(old).toISOString());
 }finally{f.dom.window.close()}
});
test('unchanged polling expires an open detail without losing draft costs, focus or page',async()=>{
 const now=Date.parse('2026-10-04T14:00:00Z'),quoteAt=now-6*3600000+60000;
 const f=await fixture(now,Array.from({length:24},(_,i)=>product(String(i),quoteAt)));
 try{
  const doc=f.win.document;f.online();f.win.fixture.page(2);f.win.fixture.render();f.win.fixture.detail('12','a');
  const form=doc.querySelector('#manualCostForm'),input=doc.querySelector('#purchaseCNY');
  input.value='123.45';input.focus();input.dispatchEvent(new f.win.Event('input'));
  assert.equal(doc.querySelector('#detailRecommendation').textContent,'¥41,998');
  f.setClock(now+120000);await f.win.fixture.checkCloudStatus(true);
  assert.equal(doc.querySelector('#manualCostForm'),form);
  assert.equal(doc.querySelector('#purchaseCNY'),input);assert.equal(input.value,'123.45');assert.equal(doc.activeElement,input);
  assert.equal(doc.querySelector('#detail').open,true);assert.equal(f.win.fixture.page(),2);
  assert.equal(doc.querySelector('#detailRecommendation').textContent,'暂无建议');
  assert.match(doc.querySelector('#detailLowest').textContent,/待核验/);
  assert.match(doc.querySelector('#detailCoverage').textContent,/商品核验时间/);
  assert.equal(doc.querySelector('#previewAfterProfit').textContent,'—');
  assert.equal(Object.keys(f.win.fixture.costs()).length,0,'poll must not save an unsubmitted cost');
  assert.equal(doc.querySelector('#freshnessNotice').hidden,true,'snapshot itself is current; only item offers expired');
 }finally{f.dom.window.close()}
});
test('a newer status cannot make the older snapshot on screen appear fresh',async()=>{
 const now=Date.parse('2026-10-04T14:00:00Z'),old=now-48*3600000;
 const f=await fixture(now,[product('1',old)],old);
 try{
  f.online({...f.data,dataRevision:'new-revision',checkedAt:new Date(now).toISOString()});
  await f.win.fixture.checkCloudStatus(false);
  assert.equal(f.win.document.querySelector('#freshnessNotice').hidden,false);
  assert.match(f.win.document.querySelector('#freshnessText').textContent,/2 天/);
 }finally{f.dom.window.close()}
});

test('same-platform dashboard labels only its required market and keeps native failure visible',async()=>{
 const now=Date.parse('2026-10-15T22:00:00Z'),item={...product('1',now),platform:'yahoo_fleamarket',comparisonMode:'same_platform'};
 item.rakuma={status:'error'};item.mercari={status:'error'};
 const f=await fixture(now,[item]);
 try{
  assert.match(f.win.document.body.textContent,/同平台/);
  assert.equal(f.win.pricingStatus(item).state,'ready');
  f.win.fixture.detail('1');
  assert.match(f.win.document.querySelector('#detail').textContent,/不参与本轮比价|当前仅比较/);
  item.yahoo.status='error';f.win.fixture.render();
  assert.notEqual(f.win.pricingStatus(item).state,'ready');
 }finally{f.win.close()}
});

test('cached valid pricing does not appear as a completed current20-minute price-and-cost cycle',async()=>{
 const now=Date.parse('2026-10-15T23:00:00Z'),item={...product('1',now-4*3600_000),platform:'yahoo_fleamarket',comparisonMode:'same_platform'};
 const f=await fixture(now,[item]);
 try{
  f.data.cycleCoverage={finishedAt:new Date(now).toISOString(),withinTarget:true,accounts:[{accountId:'a',inventoryComplete:true,total:1,priceComplete:0,costVerified:0,completeItems:0}]};
  f.win.fixture.render();
  assert.match(f.win.document.querySelector('#statusGrid').textContent,/20分钟全量周期未完成.*比价 0\/1.*成本 0\/1/);
  assert.match(f.win.document.querySelector('#pricingProgress').textContent,/有效覆盖 1\/1/);
  assert.match(f.win.document.querySelector('#pricingProgress').textContent,/不代表20分钟内全量更新完成/);
  Object.assign(f.data.cycleCoverage.accounts[0],{priceComplete:1,costVerified:1,completeItems:1});f.win.fixture.render();
  assert.match(f.win.document.querySelector('#statusGrid').textContent,/首次全量已齐，连续周期待验证/);
  f.data.cycleCoverage.accounts[0].completionGapSeconds=4*3600;f.win.fixture.render();
  assert.match(f.win.document.querySelector('#statusGrid').textContent,/本轮已齐，更新间隔超时/);
  f.data.cycleCoverage.accounts[0].completionGapSeconds=1200;f.win.fixture.render();
  assert.match(f.win.document.querySelector('#statusGrid').textContent,/20分钟全量周期已完成/);
  f.setClock(now+20*60_000+1);f.win.fixture.render();
  assert.match(f.win.document.querySelector('#statusGrid').textContent,/最近完整周期已过期/);
 }finally{f.win.close()}
});

test('native supplier quote can be rejected in the real correction dialog without becoming cost',async()=>{
 const { normalizeNativeSupplierDetail }=await import('../scripts/lib/native-supplier-quotes.mjs');
 const now=Date.now(),item=product('1',now),url='https://item.taobao.com/item.htm?id=1001&skuId=2001';
 const quote=normalizeNativeSupplierDetail(item,{source:'taobao',finalUrl:url,accessStatus:'readable',httpStatus:200,pageKind:'target_detail',fetchedAt:new Date(now).toISOString(),contentSha256:'a'.repeat(64),detailTitle:'测试待核验报价',selectedOffer:{productId:'1001',skuId:'2001',sellerKey:'taobao:external',sellerName:'测试供应商',selectedVariant:'白色1套',quantity:1,saleContents:'1套模型',nativePrice:599,currency:'CNY',priceKind:'selected_sku_total',purchaseType:'ordinary',priceCondition:'unconditional',priceEvidence:'人民币599',currencyEvidence:'人民币 CNY',isOwn:false}},{now});
 assert.ok(quote);item.nativeSupplierQuotes=[quote];
 const f=await fixture(now,[item]);
 try{
  f.win.fixture.detail('1');const doc=f.win.document;
  assert.match(doc.querySelector('.native-supplier-quotes').textContent,/尚未计入成本/);
  const button=[...doc.querySelectorAll('[data-correct]')].find(node=>node.closest('li').textContent.includes('测试待核验报价'));
  assert.ok(button);button.click();
  assert.equal(doc.querySelector('.native-supplier-quotes'),null);
  const rejected=[...doc.querySelectorAll('[data-correct]')].find(node=>node.closest('li').textContent.includes('测试待核验报价'));
  assert.equal(rejected.disabled,true);assert.match(doc.querySelector('#detailBody').textContent,/已排除/);
 }finally{f.win.close()}
});
