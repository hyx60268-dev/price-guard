import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import sharp from 'sharp';
import { xianyuCost } from '../scripts/lib/xianyu.mjs';
import { mergeXianyuCostEvidence,chooseProcurementReference } from '../scripts/lib/procurement-reference.mjs';
import { compactDashboardResult } from '../scripts/lib/publish.mjs';
import { xianyuProcurementMarkup } from '../public/procurement-view.js';

const title='星巴克 蓝色 豹纹 不锈钢 保温杯 370ml 1個';
const item={accountId:'shop-a',id:'z123456789',title,description:title+' 新品 未使用',condition:'未使用',image:'https://fixtures.example/own.png'};
const defaults={currency:'￥',terms:'全新未拆封。现货，全国包邮。',extra:'',seller:'12345',price:100};
// Same observed PC component structure as xianyu-dom.test.mjs. Values below
// are synthetic fixtures, not live-source observations or accepted inventory.
function detailHTML({currency,terms,extra,seller,price}={...defaults}){
 return `<title>${title}_闲鱼</title><div class="item-user-container--new"><a href="/personal?userId=${seller}">seller</a></div>
 <div class="item-main-window--new"><img src="https://fixtures.example/product.png"></div>
 <div class="item-main-info--new"><div class="price--new">${currency}${price}</div><div class="origin--new">原价¥300</div>
 <div class="notLoginContainer--new"><span class="desc--new">${title}\n\n${terms}</span></div>${extra}</div>
 <div class="item-feeds-container--new"><h2>为你推荐</h2><a href="/item?id=99"><h1>错误推荐</h1><div class="price--new">1</div><img src="https://fixtures.example/recommendation.png"></a></div>`;
}
function mockBrowser({offers=[{},{}],searchExtra=''}={}){
 const visited=[],pages=[];
 const search=offers.map((_,i)=>`<div><a href="/item?id=${i+1}" title="${title}"><span class="title">${title}</span><span class="price">￥${100+i*10}</span><img src="https://fixtures.example/product.png"></a></div>`).join('')+searchExtra;
 const context={newPage:async()=>createPage()};
 function createPage(){
  let dom;
  const page={context:()=>context,url:()=>dom?.window.location.href||'about:blank',
   goto:async url=>{visited.push(url);dom?.window.close();const id=new URL(url).searchParams.get('id');
    dom=new JSDOM(id?detailHTML({...defaults,price:100+(Number(id)-1)*10,seller:String(12344+Number(id)),...offers[Number(id)-1]}):search,{url,runScripts:'outside-only'});
    Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent}});
    dom.window.HTMLElement.prototype.getBoundingClientRect=function(){return {width:200,height:200}};
   },
   waitForLoadState:async()=>{},waitForTimeout:async()=>{},waitForSelector:async()=>{},
   evaluate:async fn=>dom.window.eval(`(${fn.toString()})()`),
   locator:selector=>({evaluateAll:async(fn,arg)=>{dom.window.fixtureNodes=[...dom.window.document.querySelectorAll(selector)];dom.window.fixtureArg=arg;return dom.window.eval(`(${fn.toString()})(fixtureNodes,fixtureArg)`)}}),
   close:async()=>dom?.window.close()};pages.push(page);return page;
 }
 return {page:createPage(),visited,close:async()=>Promise.all(pages.map(p=>p.close()))};
}
async function collect(options={}){
 const browser=mockBrowser(options);
 try{return {cost:await xianyuCost(browser.page,item,{maxXianyuSamples:5,maxXianyuDetailChecks:6}),visited:browser.visited};}
 finally{await browser.close();}
}
function publish(cost,{now=Date.now(),currentItem=item,priorItem=item}={}){
 const stored=JSON.parse(JSON.stringify({...currentItem,xianyu:mergeXianyuCostEvidence(priorItem,cost,{now,currentItem})}));
 const selected=chooseProcurementReference(stored,{now});
 const row={...stored,averageCNY:selected?.averageCNY??null,referenceProvider:selected?.referenceProvider??null,referenceCheckedAt:selected?.checkedAt??null};
 const compact=JSON.parse(JSON.stringify(compactDashboardResult({items:[row]},{now}))).items[0];
 return {stored,compact,reference:chooseProcurementReference(compact,{now}),markup:xianyuProcurementMarkup(compact,now)};
}

test('actual Xianyu producer DOM reader survives storage, merge, compact publication and consumer revalidation',async t=>{
 // Network isolation only replaces image transport. Real card/detail readers,
 // image fingerprints, identity rules, quote selection and consumers execute.
 const pixels=Buffer.alloc(32*32*3);for(let i=0;i<pixels.length;i++)pixels[i]=(i*17+Math.floor(i/32)*43)%256;
 const png=await sharp(pixels,{raw:{width:32,height:32,channels:3}}).png().toBuffer();
 const requests=[];t.mock.method(globalThis,'fetch',async url=>{requests.push(String(url));assert.match(String(url),/^https:\/\/fixtures\.example\//);return new Response(png,{headers:{'content-type':'image/png'}})});
 const {cost,visited}=await collect();
 assert.equal(cost.status,'ok',JSON.stringify(cost.rejected));assert.equal(cost.averageCNY,100);assert.equal(cost.benchmarkMedianCNY,105);
 assert.equal(cost.samples.length,2);assert.equal(cost.detailCheckedCount,2);assert.equal(visited.length,3);
 assert.equal(cost.samples[0].detailDescription.includes('错误推荐'),false);assert.equal(cost.samples[0].currency,'CNY');
 assert.equal(cost.samples[0].shippingCNY,0);assert.equal(cost.samples[0].inStock,true);assert.equal(cost.samples[0].quantity,1);
 assert.ok(requests.length>0);assert.equal(requests.some(url=>url.includes('recommendation')),false);
 const result=publish(cost);
 assert.equal(result.reference.averageCNY,100);assert.deepEqual(result.reference.selectedQuote,cost.selectedQuote);
 assert.match(result.markup,/已采用的供应商报价/);assert.match(result.markup,/商品 ¥100＋国内运费 ¥0＝¥100/);assert.match(result.markup,/中位数 ¥105/);

 await t.test('missing actual quote evidence never becomes cost after publication',async()=>{
  for(const changes of [{currency:''},{terms:'全新未拆封。现货。'},{terms:'全新未拆封。全国包邮。'},{extra:'<span>已售出</span>'}]){
   const {cost:missing}=await collect({offers:[changes,changes]});
   assert.equal(missing.averageCNY,null,JSON.stringify(changes));assert.equal(missing.selectedQuote,null);
   const published=publish(missing);assert.equal(published.reference,null);assert.equal(published.compact.averageCNY,null);assert.doesNotMatch(published.markup,/已采用的供应商报价/);
  }
 });
 await t.test('search and detail access barriers stop and cannot be refreshed into success',async()=>{
  for(const [options,status,count] of [
   [{searchExtra:'<iframe src="https://fixtures.example/login"></iframe>'},'login_required',1],
   [{offers:[{extra:'<iframe src="https://fixtures.example/captcha"></iframe>'},{}]},'blocked',2],
   [{offers:[{extra:'<div class="notloginMask--new">请登录</div>'},{extra:'<div class="notloginMask--new">请登录</div>'}]},'login_required',3]]){
   const {cost:blocked,visited}=await collect(options);assert.equal(blocked.status,status);assert.equal(visited.length,count);assert.equal(publish(blocked).reference,null);
   const now=Date.parse(cost.checkedAt)+1000,retained=publish({...blocked,checkedAt:new Date(now).toISOString()},{now,priorItem:{...item,xianyu:cost}});
   assert.equal(retained.reference.checkedAt,cost.checkedAt,'attempt never refreshes the prior actual quote');
   assert.equal(retained.stored.xianyu.costEvidenceStatus,'cached_verified');
  }
 });
 await t.test('changed target, stale sources and forged envelope amount do not survive the same pipeline',()=>{
  assert.equal(publish(cost,{currentItem:{...item,title:title+' 2個'},priorItem:{...item,xianyu:cost}}).reference,null);
  assert.equal(publish(cost,{now:Date.parse(cost.checkedAt)+86400000}).reference,null);
  assert.equal(publish({...cost,averageCNY:105}).reference,null);
 });
});
