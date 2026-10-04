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
