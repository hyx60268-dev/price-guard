import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { comparisonObservationsMarkup, savedYahooDetailObservations } from '../public/comparison-observations.js';
import { buildOwnedOffers } from '../public/owned-offers.js';
import { pricingDecision, PRICING_RULES_VERSION } from '../public/pricing-policy.js';

const checkedAt='2026-10-16T22:35:10.363Z',now=Date.parse('2026-10-16T22:53:00.000Z');
const account={id:'melon',platform:'yahoo_fleamarket',sellerId:'managed-melon',name:'melon',profileStatus:'live'};
function product(){
 return {id:'z705438862',accountId:'melon',accountName:'melon',platform:'yahoo_fleamarket',comparisonMode:'same_platform',itemStatus:'OPEN',sellerId:'managed-melon',title:'スーツケース',image:'https://example.test/own.jpg',ownUrl:'https://paypayfleamarket.yahoo.co.jp/item/z705438862',ownPrice:32999,averageCNY:100,recommendedPrice:27999,
  yahoo:{rulesVersion:PRICING_RULES_VERSION,status:'cached',evidenceStatus:'incomplete',cacheReason:'request_error',deferredReason:'request_cooldown_deadline',checkedAt,searchCheckedAt:'2026-10-15T22:35:10.363Z',lastAttemptAt:'2026-10-16T22:50:00.000Z',knownRefresh:{mode:'details_only'},searchComplete:false,
   audit:{ownItemId:'z705438862',accountId:'melon',rulesVersion:PRICING_RULES_VERSION},
   candidates:[{id:'z704300094',url:'https://paypayfleamarket.yahoo.co.jp/item/z704300094',title:'保存されたスーツケース',sellerId:'external-seller',price:28000,shippingJPY:0,shippingSource:'target_price_area',priceSource:'current_target_detail',itemStatus:'OPEN',matchMethod:'exact_bidirectional_title_identity',checkedAt}]}};
}
function options(item,extra={}){return {now,ownershipIndex:buildOwnedOffers([account],[item]),corrections:{},...extra}}
const select=(item,extra={})=>savedYahooDetailObservations(item,options(item,extra));
test('saved 28000 detail read survives deferred broad coverage as presentation only',()=>{
 const item=product(),before=structuredClone(item),decision=pricingDecision(item,{now});
 const rows=select(item);
 assert.equal(rows.length,1);assert.equal(rows[0].price,28000);assert.equal(rows[0].checkedAt,checkedAt);
 assert.equal(decision.canRecommend,false);assert.equal(decision.lowest,null);assert.equal(decision.complete,false);
 assert.deepEqual(item,before);assert.deepEqual(pricingDecision(item,{now}),decision);
 const dom=new JSDOM(comparisonObservationsMarkup(item,options(item)));
 try{
  const block=dom.window.document.querySelector('.comparison-observations');
  assert.match(block.textContent,/28,000/);assert.match(block.textContent,/广搜更新未完成，暂不生成自动建议/);
  assert.match(block.textContent,/详情子检查/);assert.match(block.textContent,/当前同款关系待核验/);
  assert.equal(block.querySelector('time').getAttribute('datetime'),checkedAt);
  assert.equal(block.querySelector('a').href,item.yahoo.candidates[0].url);
 }finally{dom.window.close()}
});
test('candidate clocks cannot be replaced by source, snapshot or attempt timestamps',()=>{
 for(const stamp of [undefined,null,'','not-a-date','2026-10-16','2026-10-16 (note)','2026-02-30T12:00:00.000Z',new Date(now+1).toISOString(),new Date(now-6*3600_000-1).toISOString()]){
  const item=product();item.yahoo.candidates[0].checkedAt=stamp;
  for(const key of ['checkedAt','lastAttemptAt','knownLastAttemptAt','searchCheckedAt'])item.yahoo[key]=new Date(now).toISOString();
  item.checkedAt=new Date(now).toISOString();assert.deepEqual(select(item),[],String(stamp));
 }
 const item=product();item.yahoo.checkedAt='2026-10-15T00:00:00.000Z';
 assert.equal(select(item)[0].checkedAt,checkedAt,'the child detail timestamp is independent of the envelope');
});
test('malformed, non-detail, unavailable and unpriced evidence fails closed',()=>{
 for(const change of [{id:'z99999999'},{url:'https://paypayfleamarket.yahoo.co.jp/item/z99999999'},{url:'javascript:alert(1)'},{url:'http://paypayfleamarket.yahoo.co.jp/item/z704300094'},{url:'https://paypayfleamarket.yahoo.co.jp/item/z704300094?token=secret'},{url:'https://paypayfleamarket.yahoo.co.jp/item/z704300094#different'},{url:'https://paypayfleamarket.yahoo.co.jp.evil.test/item/z704300094'},{price:0},{price:-1},{price:28000.5},{price:'28000'},{price:Infinity},{price:NaN},{sellerId:''},{matchMethod:'title_only'},{priceSource:undefined},{shippingSource:undefined},{shippingJPY:undefined},{shippingJPY:100},{itemStatus:'SOLD'},{itemStatus:undefined},{status:'SOLD'},{rulesVersion:0}]){
  const item=product();Object.assign(item.yahoo.candidates[0],change);assert.deepEqual(select(item),[],JSON.stringify(change));
 }
 for(const value of [null,false,'bad',[],{}]){const item=product();item.yahoo.candidates=[value];assert.deepEqual(select(item),[])}
 for(const value of [null,false,'bad',{}]){const item=product();item.yahoo.candidates=value;assert.deepEqual(select(item),[])}
 const malformed=product();Object.assign(malformed.yahoo,{cacheReason:null,status:'incomplete',candidates:[null]});assert.deepEqual(select(malformed),[]);
});
test('all owned listings, sellers, self rows and permanent corrections are excluded with a required ownership index',()=>{
 const item=product(),offer=item.yahoo.candidates[0];
 for(const ownershipIndex of [undefined,null,{},buildOwnedOffers([],[])])assert.deepEqual(select(item,{ownershipIndex}),[]);
 assert.deepEqual(select(item,{corrections:undefined}),[]);
 for(const corrections of [{bad:null},{bad:'invalid'},{bad:[]}])assert.deepEqual(select(item,{corrections}),[]);
 for(const owned of [{id:offer.id,accountId:'another',platform:'yahoo'},{id:'z777777777',sellerId:offer.sellerId,accountId:'another',platform:'yahoo'}]){
  assert.deepEqual(select(item,{ownershipIndex:buildOwnedOffers([account],[item,owned])}),[]);
 }
 assert.deepEqual(select(item,{ownershipIndex:buildOwnedOffers([account,{id:'another',platform:'yahoo',sellerId:offer.sellerId}],[item])}),[]);
 for(const change of [{isOwn:true},{sellerId:item.sellerId},{id:item.id,url:item.ownUrl}]){const copy=product();Object.assign(copy.yahoo.candidates[0],change);assert.deepEqual(select(copy),[])}
 const correction={accountId:item.accountId,itemId:item.id,platform:'yahoo',candidateId:offer.id,updatedAt:checkedAt,deleted:false};
 assert.deepEqual(select(item,{corrections:{one:correction}}),[]);
 assert.equal(select(item,{corrections:{one:{...correction,deleted:true}}}).length,1);
 const relisted=product();relisted.relistedFrom='z111111111';
 assert.deepEqual(select(relisted,{corrections:{one:{...correction,itemId:relisted.relistedFrom,ownTitle:relisted.title,ownImage:relisted.image}}}),[]);
 for(const location of ['rejected','knownRefresh']){
  const copy=product(),rejection={id:offer.id,reason:'not_open'};
  if(location==='rejected')copy.yahoo.rejected=[rejection];else copy.yahoo.knownRefresh.rejected=[rejection];
  assert.deepEqual(select(copy),[]);
 }
});
test('saved target audit is required and old matching versions are explicitly historical',()=>{
 for(const audit of [null,{}, {ownItemId:'z111111111',accountId:'melon',rulesVersion:PRICING_RULES_VERSION},{ownItemId:'z705438862',accountId:'other',rulesVersion:PRICING_RULES_VERSION},{ownItemId:'z705438862',accountId:'melon',rulesVersion:0}]){
  const item=product();item.yahoo.audit=audit;assert.deepEqual(select(item),[]);
 }
 const old=product();old.yahoo.rulesVersion--;old.yahoo.audit.rulesVersion--;
 assert.equal(select(old)[0].historicalRules,true);
 const markup=comparisonObservationsMarkup(old,options(old));assert.match(markup,/历史规则读数，未按当前规则核验同款/);assert.doesNotMatch(markup,/已核验同款|已接受|当前有效/);
 for(const version of [undefined,0,-1,PRICING_RULES_VERSION+1]){const item=product();item.yahoo.rulesVersion=version;item.yahoo.audit.rulesVersion=version;assert.deepEqual(select(item),[])}
 const changed=product();changed.title='当前已改为别的规格';
 assert.match(comparisonObservationsMarkup(changed,options(changed)),/当前同款关系待核验/,'ID-only audit must never invent a current title/image binding');
 for(const change of [{itemStatus:'SOLD'},{yahoo:{...product().yahoo,knownRefresh:{mode:'failed',reason:'own_title_changed'}}}]){const item={...product(),...change};assert.deepEqual(select(item),[])}
});
test('an actionable or complete comparison does not gain a contradictory no-advice block',()=>{
 const item=product();Object.assign(item.yahoo,{status:'incomplete',cacheReason:null,deferredReason:null});
 assert.equal(pricingDecision(item,{now}).canRecommend,true);assert.deepEqual(select(item),[]);
 Object.assign(item.yahoo,{status:'ok',evidenceStatus:'ok',cacheReason:null,deferredReason:null,searchComplete:true});
 assert.equal(pricingDecision(item,{now}).complete,true);assert.deepEqual(select(item),[]);
});
test('detail markup escapes saved text and deduplicates without modifying candidate order',()=>{
 const item=product();item.yahoo.candidates[0].title='<img src=x onerror=alert(1)> & "saved"';
 item.yahoo.candidates.push({...item.yahoo.candidates[0],checkedAt:'2026-10-16T22:30:00.000Z',price:29000});
 const before=structuredClone(item),dom=new JSDOM(comparisonObservationsMarkup(item,options(item)));
 try{assert.equal(dom.window.document.querySelectorAll('li').length,1);assert.equal(dom.window.document.querySelector('img'),null);assert.match(dom.window.document.body.textContent,/<img src=x onerror=alert\(1\)>/);assert.equal(select(item)[0].price,28000);assert.deepEqual(item,before)}finally{dom.window.close()}
});

async function uiFixture(){
 const [html,source]=await Promise.all(['index.html','app.js'].map(name=>fs.readFile(new URL('../public/'+name,import.meta.url),'utf8')));
 const dom=new JSDOM(html,{url:'https://example.test',runScripts:'outside-only'}),win=dom.window;
 for(const match of source.matchAll(/^import .* from '(\.\/[^']+)';/gm))Object.assign(win,await import(new URL('../public/'+match[1].slice(2),import.meta.url)));
 let clock=now;Object.assign(win,{fetch:async()=>{throw Error('offline fixture')},setInterval:()=>0,pricingDecision:(item,settings)=>pricingDecision(item,{now:clock,...settings})});win.Date.now=()=>clock;
 win.HTMLDialogElement.prototype.showModal=function(){this.open=true};win.HTMLDialogElement.prototype.close=function(){this.open=false};
 win.eval(source.replace(/^import .*;\r?\n/gm,'')+`window.fixture={set(value,costs){data=value;manualCosts=costs;currentAccountId='__all__';matchCorrections={}},render,detail,effective,refresh(){refreshDetailPrices()},costs:()=>manualCosts,corrections:()=>matchCorrections}`);
 const item=product(),data={checkedAt:new Date(now).toISOString(),settings:{exchangeRate:20,costMultiplier:1,profitWarningJPY:1500},items:[item],accounts:[account]},costs={'melon:item:z705438862':{accountId:'melon',itemId:item.id,purchaseCNY:123,manualFeeCNY:10,shippingJPY:500,updatedAt:checkedAt}};
 win.fixture.set(data,costs);win.fixture.render();win.fixture.detail(item.id,item.accountId);
 await new Promise(resolve=>setImmediate(resolve));
 return {win,dom,item,data,costs,setClock(value){clock=value}};
}
test('real detail UI shows 28000 and original time without a recommendation; correction removes it immediately',async()=>{
 const f=await uiFixture();
 try{
  const doc=f.win.document,before=structuredClone(f.item),costs=structuredClone(f.costs),decision=pricingDecision(f.item,{now});
  assert.match(doc.querySelector('.comparison-observations').textContent,/28,000/);
  assert.match(doc.querySelector('#detailLowest').textContent,/待核验/);assert.equal(doc.querySelector('#detailRecommendation').textContent,'暂无建议');
  assert.equal(doc.querySelector('#detailSavedQuotes time').getAttribute('datetime'),checkedAt);
  assert.equal(doc.querySelector('#detailSavedQuotes a').href,f.item.yahoo.candidates[0].url);
  assert.equal(doc.querySelector('#previewAfterProfit').textContent,'—');assert.equal(doc.querySelector('#purchaseCNY').value,'123');
  assert.equal(doc.querySelector('.comparison-observations').closest('details'),null,'saved evidence is visible without expanding an evidence accordion');
  const button=[...doc.querySelectorAll('[data-correct]')].find(node=>node.closest('li').textContent.includes('保存されたスーツケース'));
  assert.ok(button);button.click();
  assert.equal(doc.querySelector('.comparison-observations'),null);assert.equal(doc.querySelector('#detailRecommendation').textContent,'暂无建议');
  assert.equal(Object.values(f.win.fixture.corrections())[0].candidateId,'z704300094');
  assert.equal(JSON.parse(f.win.localStorage.getItem('priceGuard.matchCorrections.v1'))['melon:z705438862:yahoo:z704300094'].deleted,false);
  f.win.fixture.refresh();assert.equal(doc.querySelector('.comparison-observations'),null);
  assert.deepEqual(f.item,before);assert.deepEqual(f.costs,costs);assert.deepEqual(pricingDecision(f.item,{now}),decision);
 }finally{f.win.close()}
});
test('open detail refresh expires saved evidence without replacing cost inputs or renewing its timestamp',async()=>{
 const f=await uiFixture();
 try{
  const doc=f.win.document,input=doc.querySelector('#purchaseCNY'),form=doc.querySelector('#manualCostForm');input.value='321.23';input.focus();
  f.setClock(Date.parse(checkedAt)+6*3600_000+1);f.win.fixture.refresh();
  assert.equal(doc.querySelector('.comparison-observations'),null);assert.equal(doc.querySelector('#purchaseCNY'),input);assert.equal(input.value,'321.23');assert.equal(doc.activeElement,input);assert.equal(doc.querySelector('#manualCostForm'),form);
  assert.equal(f.item.yahoo.candidates[0].checkedAt,checkedAt);assert.equal(f.win.fixture.costs()['melon:item:z705438862'].purchaseCNY,123);
 }finally{f.win.close()}
});
