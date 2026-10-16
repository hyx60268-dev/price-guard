import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { normalizeNativeSupplierDetail,currentNativeSupplierQuotes } from '../scripts/lib/native-supplier-quotes.mjs';
import { nativeQuoteTarget,validNativeSupplierQuote,nativeSupplierQuotesMarkup } from '../public/native-supplier-quotes.js';
import { compactDashboardResult } from '../scripts/lib/publish.mjs';
import { chooseProcurementReference,procurementTarget } from '../scripts/lib/procurement-reference.mjs';
import { publicProcurementMarkup } from '../public/procurement-view.js';
import { invalidateCorrectedMatches } from '../public/match-memory.js';

const now=Date.parse('2026-10-15T23:50:00Z');
function fixture(){
 // Synthetic adapter input: this tests the ingress contract, not live collection.
 const item={accountId:'shop-a',id:'zfixture123',title:'INERA FENRIR 1/72 模型 1套',image:'https://inventory.example/fenrir.jpg',
  sourceDetail:{description:'白灰配色 1套 未组装。外盒已开封检查。',condition:{key:'unused',name:'新品、未使用'}}};
 const observation={source:'taobao',finalUrl:'https://item.taobao.com/item.htm?id=100000001&skuId=200000001',accessStatus:'readable',httpStatus:200,pageKind:'target_detail',
  fetchedAt:new Date(now).toISOString(),contentSha256:createHash('sha256').update('synthetic selected SKU response').digest('hex'),detailTitle:'INERA FENRIR 1/72 白灰色 模型',
  selectedOffer:{productId:'100000001',skuId:'200000001',sellerKey:'taobao:external-fixture-shop',sellerName:'测试供应商',selectedVariant:'白灰色，1套',quantity:1,saleContents:'1套未组装模型',
   nativePrice:599,currency:'CNY',priceKind:'selected_sku_total',purchaseType:'ordinary',priceCondition:'unconditional',priceEvidence:'所选白灰色1套价格：人民币599',currencyEvidence:'人民币 CNY',isOwn:false,
   availability:{status:'in_stock',evidence:'所选SKU库存3件'}}};
 return {item,observation};
}
function observedItem(){const {item,observation}=fixture();return {...item,nativeSupplierQuotes:[normalizeNativeSupplierDetail(item,observation,{now})]}}

test('native detail ingress survives storage/publication/UI with original evidence and unknown freight',()=>{
 const item=observedItem();assert.ok(item.nativeSupplierQuotes[0]);
 const result=JSON.parse(JSON.stringify({accounts:[{id:'shop-a'}],items:[item]}));
 const published=JSON.parse(JSON.stringify(compactDashboardResult(result,{now}))).items[0];
 assert.equal(published.sourceDetail,undefined);assert.deepEqual(published.nativeSupplierQuotes,item.nativeSupplierQuotes);
 assert.equal(validNativeSupplierQuote(published.nativeSupplierQuotes[0],published,{now}),true);
 assert.equal(chooseProcurementReference(published,{now}),null);
 const dom=new JSDOM(publicProcurementMarkup(published,{now}));
 assert.match(dom.window.document.body.textContent,/599 CNY/);
 assert.match(dom.window.document.body.textContent,/中国境内运费：未知/);
 assert.match(dom.window.document.body.textContent,/商品成色／封装未注明/);
 assert.match(dom.window.document.body.textContent,/尚未计入成本、利润或本轮成本核验完成数/);
 assert.equal(dom.window.document.querySelector('.native-supplier-quotes a').href,item.nativeSupplierQuotes[0].url);
 assert.equal(published.nativeSupplierQuotes[0].checkedAt,new Date(now).toISOString());
});

test('native target binding matches shared semantics and invalidates changes after the full description tail',()=>{
 const {item}=fixture();item.sourceDetail.description='完整描述 '.repeat(600)+'一套';
 assert.deepEqual(nativeQuoteTarget(item),procurementTarget(item));
 const quote=normalizeNativeSupplierDetail(item,fixture().observation,{now});
 for(const change of [row=>row.accountId='another',row=>row.id+='relist',row=>row.title+='黑色',row=>row.image+='?changed=1',row=>row.sourceDetail.description+='二套',row=>row.sourceDetail.condition.key='used',row=>row.sourceDetail.description='']){
  const changed=structuredClone(item);change(changed);changed.nativeSupplierQuotes=[quote];
  assert.deepEqual(currentNativeSupplierQuotes(changed,{now}),[]);
  assert.deepEqual(compactDashboardResult({items:[changed]},{now}).items[0].nativeSupplierQuotes,[]);
 }
});

test('blocked/unselected/conditional/deposit/card observations cannot produce even a native quote',()=>{
 for(const change of [row=>row.accessStatus='login_required',row=>row.accessStatus='captcha',row=>row.httpStatus=412,row=>row.pageKind='search_card',row=>row.selectedOffer=null,
  row=>row.selectedOffer.priceKind='starting_price',row=>row.selectedOffer.priceKind='deposit',row=>row.selectedOffer.purchaseType='preorder',row=>row.selectedOffer.priceCondition='coupon_required',
  row=>row.selectedOffer.currency=null,row=>row.selectedOffer.currencyEvidence='¥',row=>row.selectedOffer.priceEvidence='人民币599起：其他SKU',row=>row.selectedOffer.nativePrice=99,
  row=>row.contentSha256='missing',row=>row.selectedOffer.quantity=null,row=>row.selectedOffer.skuId='',row=>row.selectedOffer.isOwn=true]){
  const {item,observation}=fixture();change(observation);
  assert.equal(normalizeNativeSupplierDetail(item,observation,{now}),null);
 }
});

test('native quotes reject expired/future evidence and cannot be refreshed by a failed attempt',()=>{
 const item=observedItem(),quote=item.nativeSupplierQuotes[0];
 assert.equal(validNativeSupplierQuote(quote,item,{now:now+86399999}),true);
 assert.equal(validNativeSupplierQuote(quote,item,{now:now+86400000}),false);
 assert.equal(validNativeSupplierQuote(quote,item,{now:now-1}),false);
 const {observation}=fixture();observation.accessStatus='login_required';observation.fetchedAt=new Date(now+60000).toISOString();
 assert.equal(normalizeNativeSupplierDetail(item,observation,{now:now+60000}),null);
 assert.equal(quote.checkedAt,new Date(now).toISOString());
 const forged={...quote,checkedAt:new Date(now+60000).toISOString()};
 assert.equal(validNativeSupplierQuote(forged,item,{now:now+60000}),false);
});

test('native publication rejects owned sellers and match corrections; tombstones restore only valid evidence',()=>{
 const item=observedItem(),quote=item.nativeSupplierQuotes[0];
 const corrections={one:{accountId:item.accountId,itemId:item.id,platform:'procurement',candidateId:quote.url,candidateUrl:quote.url,updatedAt:new Date(now).toISOString()}};
 assert.deepEqual(currentNativeSupplierQuotes(item,{now,ownedSellerKeys:[quote.sellerKey]}),[]);
 assert.deepEqual(compactDashboardResult({items:[item],managedAccounts:[{platform:'taobao',sellerId:'external-fixture-shop'}]},{now}).items[0].nativeSupplierQuotes,[]);
 assert.deepEqual(compactDashboardResult({items:[item],matchCorrections:corrections},{now}).items[0].nativeSupplierQuotes,[]);
 assert.deepEqual(invalidateCorrectedMatches(item,corrections).nativeSupplierQuotes,[]);
 corrections.one.deleted=true;assert.equal(currentNativeSupplierQuotes(item,{now,matchCorrections:corrections}).length,1);
});

test('native render escapes source content and rejects wrong URL hosts, secret query fields and receipt substitution',()=>{
 const item=observedItem(),quote=item.nativeSupplierQuotes[0];quote.sellerName='<script>alert(1)</script>';
 const dom=new JSDOM(nativeSupplierQuotesMarkup(item,{now}));assert.equal(dom.window.document.querySelector('script'),null);
 assert.match(dom.window.document.body.textContent,/<script>/);
 for(const value of ['javascript:alert(1)','https://item.taobao.com.evil.example/item.htm?id=1','https://item.taobao.com/item.htm?id=1&token=secret','https://user:pass@item.taobao.com/item.htm?id=1','https://item.taobao.com/']){
  const changed={...quote,url:value,canonicalUrl:value,provenance:{...quote.provenance,finalUrl:value}};
  assert.equal(validNativeSupplierQuote(changed,item,{now}),false);
 }
 assert.equal(validNativeSupplierQuote({...quote,provenance:{...quote.provenance,finalUrl:quote.url+'&skuId=other'}},item,{now}),false);
});

test('published freight and condition remain explicit reference facts and never become a cost',()=>{
 const {item,observation}=fixture();Object.assign(observation.selectedOffer,{
  condition:{status:'new',evidence:'全新未组装'},identity:{status:'catalog_only',evidence:'Reviewed model/variant; physical package not checked'},
  shipping:{status:'published_terms',destinationCountry:'CN',amount:0,currency:'CNY',scope:'江浙沪包邮，其他地区另计',evidence:'江浙沪包邮，其他地区另计',applicability:'unconfirmed'}});
 item.nativeSupplierQuotes=[normalizeNativeSupplierDetail(item,observation,{now})];assert.ok(item.nativeSupplierQuotes[0]);
 assert.equal(chooseProcurementReference(item,{now}),null);
 assert.match(new JSDOM(nativeSupplierQuotesMarkup(item,{now})).window.document.body.textContent,/适用性待核验/);
 observation.selectedOffer.shipping.amount=null;assert.equal(normalizeNativeSupplierDetail(item,observation,{now}),null);
});

test('out-of-stock detail amount is visibly unavailable and explicit currencies do not imply FX or landed cost',()=>{
 const {item,observation}=fixture();Object.assign(observation.selectedOffer,{nativePrice:122.99,currency:'USD',priceEvidence:'USD 122.99',currencyEvidence:'USD',availability:{status:'out_of_stock',evidence:'Sold out'}});
 item.nativeSupplierQuotes=[normalizeNativeSupplierDetail(item,observation,{now})];assert.ok(item.nativeSupplierQuotes[0]);
 const body=new JSDOM(nativeSupplierQuotesMarkup(item,{now})).window.document.body.textContent;
 assert.match(body,/122.99 USD/);assert.match(body,/缺货/);assert.equal(chooseProcurementReference(item,{now}),null);
 assert.equal(item.averageCNY,undefined);assert.equal(item.nativeSupplierQuotes[0].shipping.amount,null);
});

test('native detail URLs must bind actual product/SKU and cannot be a login page or unresolved platform route',()=>{
 for(const url of ['https://item.taobao.com/login','https://item.taobao.com/item.htm?id=999&skuId=200000001',
  'https://item.taobao.com/item.htm?id=100000001&skuId=999','https://item.taobao.com/item.htm?id=100000001&id=999',
  'https://item.taobao.com/item.htm?id=100000001&itemId=999','https://item.taobao.com/item.htm?id=100000001&skuId=200000001&skuId=200000001']){
  const {item,observation}=fixture();observation.finalUrl=url;assert.equal(normalizeNativeSupplierDetail(item,observation,{now}),null,url);
 }
 for(const [source,url] of [['bilibili','https://mall.bilibili.com/detail.html?itemsId=100000001'],['dewu','https://m.dewu.com/product/100000001']]){
  const {item,observation}=fixture();observation.source=source;observation.finalUrl=url;observation.selectedOffer.sellerKey=source+':seller';
  assert.equal(normalizeNativeSupplierDetail(item,observation,{now}),null,'unreviewed route is not an adapter');
 }
});

test('tracking changes preserve receipt URLs but cannot bypass a native procurement rejection',()=>{
 const {item,observation}=fixture(),quote=normalizeNativeSupplierDetail(item,observation,{now});
 const records={one:{accountId:item.accountId,itemId:item.id,platform:'procurement',candidateId:quote.canonicalUrl,candidateUrl:quote.canonicalUrl,deleted:false}};
 observation.finalUrl+='&spm=another';const changed=normalizeNativeSupplierDetail(item,observation,{now});
 assert.notEqual(changed.url,quote.url);assert.equal(changed.canonicalUrl,quote.canonicalUrl);
 item.nativeSupplierQuotes=[changed];assert.deepEqual(currentNativeSupplierQuotes(item,{now,matchCorrections:records}),[]);
 assert.deepEqual(invalidateCorrectedMatches(item,records).nativeSupplierQuotes,[]);
});

test('native Xianyu observations honor existing numeric-item rejections and tombstones',()=>{
 const {item,observation}=fixture();observation.source='xianyu';observation.finalUrl='https://www.goofish.com/item?id=100000001';observation.selectedOffer.sellerKey='xianyu:external';
 item.nativeSupplierQuotes=[normalizeNativeSupplierDetail(item,observation,{now})];assert.ok(item.nativeSupplierQuotes[0]);
 const records={one:{accountId:item.accountId,itemId:item.id,platform:'xianyu',candidateId:'100000001',deleted:false}};
 assert.deepEqual(currentNativeSupplierQuotes(item,{now,matchCorrections:records}),[]);
 assert.deepEqual(invalidateCorrectedMatches(item,records).nativeSupplierQuotes,[]);
 records.one.deleted=true;assert.equal(currentNativeSupplierQuotes(item,{now,matchCorrections:records}).length,1);
});

test('owned supplier identity uses account platform fallback without cross-platform ID collisions',()=>{
 const item=observedItem();item.platform='yahoo';item.sellerId='external-fixture-shop';
 assert.equal(currentNativeSupplierQuotes(item,{now}).length,1,'same literal seller ID on Yahoo is a different namespace');
 const result={accounts:[{id:'managed-supplier',platform:'taobao'}],items:[item,{id:'owned-product',accountId:'managed-supplier',sellerId:'external-fixture-shop'}]};
 assert.deepEqual(compactDashboardResult(result,{now}).items[0].nativeSupplierQuotes,[],'managed supplier item inherits account platform');
});

test('inventory reconciliation preserves native observation time and publication invalidates changed live targets',async()=>{
 const { reconcileLiveItems }=await import('../scripts/lib/planner.mjs');
 const item=observedItem(),quote=item.nativeSupplierQuotes[0];
 const active=reconcileLiveItems([],[item],[{id:item.id,title:item.title,image:item.image,ownPrice:14880}],item.accountId);
 const published=compactDashboardResult({items:active},{now:now+60_000}).items[0];
 assert.equal(published.nativeSupplierQuotes.length,1);assert.equal(published.nativeSupplierQuotes[0].checkedAt,quote.checkedAt);
 assert.equal(chooseProcurementReference(published,{now:now+60_000}),null);
 const changed=reconcileLiveItems([],[item],[{id:item.id,title:item.title+' 红色',image:item.image}],item.accountId);
 assert.deepEqual(compactDashboardResult({items:changed},{now:now+60_000}).items[0].nativeSupplierQuotes,[]);
});
