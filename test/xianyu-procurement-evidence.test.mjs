import test from 'node:test';
import assert from 'node:assert/strict';
import { xianyuProcurementItem } from './fixtures/xianyu-procurement.mjs';
import { verifiedXianyuReference,chooseProcurementReference,procurementTarget } from '../scripts/lib/procurement-reference.mjs';
import { verifiedXianyuCache } from '../scripts/lib/planner.mjs';
import { verifiedCostEvidence } from '../scripts/lib/xianyu-evidence.mjs';
import { verifiedPurchasableXianyuEvidence,xianyuPurchaseTerms,canonicalXianyuOffer } from '../scripts/lib/xianyu-procurement-evidence.mjs';
import { compactDashboardResult } from '../scripts/lib/publish.mjs';
import { xianyuProcurementMarkup } from '../public/procurement-view.js';

const now=Date.now(),check=item=>verifiedXianyuReference(item,{now});
test('Xianyu automatic cost selects an actual payable offer and keeps the median only as a benchmark',()=>{
 const item=xianyuProcurementItem(now,{},[100,110]),reference=check(item);
 assert.equal(reference.averageCNY,100);assert.equal(reference.benchmarkMedianCNY,105);
 assert.equal(reference.selectedQuote.landedCNY,100);assert.equal(reference.selectedQuote.canonicalUrl,item.xianyu.samples[0].url);
 item.xianyu.averageCNY=105;assert.equal(check(item),null);
});
test('legacy detail-price samples cannot become a purchase cost by adding a new top-level verification label',()=>{
 const item=xianyuProcurementItem(now);item.xianyu.samples=[{id:'1',sellerKey:'a',price:95,priceSource:'target_detail'},{id:'2',sellerKey:'b',price:105,priceSource:'target_detail'}];
 assert.equal(verifiedCostEvidence(item.xianyu.samples).ready,true,'only the historical price benchmark exists');
 assert.equal(check(item),null);assert.equal(verifiedXianyuCache(item),null);assert.equal(chooseProcurementReference(item,{now}),null);
});
test('Xianyu cost binds full account, listing, image, variant, quantity and condition observations',()=>{
 for(const field of ['accountId','id','title','image','description','condition']){
  const item=xianyuProcurementItem(now);item[field]+=' changed';assert.equal(check(item),null,field);
  const sample=xianyuProcurementItem(now);sample.xianyu.samples[0].target[field]+=' changed';assert.equal(check(sample),null,'sample '+field);
 }
 const item=xianyuProcurementItem(now);item.sourceDetail={description:item.description,condition:'中古'};assert.equal(check(item),null);
 const empty=xianyuProcurementItem(now);empty.sourceDetail={description:'',condition:''};assert.equal(check(empty),null);
});
test('currency, stock, freight, source URL, full-sale quantity and source timestamps are independently mandatory',()=>{
 const mutations=[s=>s.currency='JPY',s=>delete s.currencyEvidence,s=>s.inStock=false,s=>s.shippingKnown=false,s=>s.shippingCNY=null,
  s=>s.shippingScope='unknown',s=>s.quantity=2,s=>s.quantity=null,s=>s.selectedVariant='another variant',s=>s.unitCNY=1,
  s=>s.url='https://www.goofish.com/item?id=999',s=>s.url='https://example.org/item?id=1',s=>s.priceSource='search_card',
  s=>s.checkedAt=new Date(now+1).toISOString(),s=>s.checkedAt=new Date(now-86400000).toISOString(),s=>delete s.checkedAt,
  s=>s.isOwn=true,s=>s.sellerKey='unknown',s=>s.detailDescription='',s=>s.detailImages=[]];
 for(const mutate of mutations){const item=xianyuProcurementItem(now);mutate(item.xianyu.samples[0]);assert.equal(check(item),null,String(mutate));}
 const stale=xianyuProcurementItem(now-86400000);stale.xianyu.checkedAt=new Date(now).toISOString();assert.equal(check(stale),null,'refreshing envelope cannot refresh source observations');
});
test('only explicit applicable freight and current availability count; sold target badges override an old description',()=>{
 assert.equal(xianyuPurchaseTerms('现货 全国包邮').shippingKnown,true);
 for(const text of ['现货 包邮','现货 全国包邮偏远除外','现货 全国包邮 新疆不发','现货 全国包邮 顺丰到付','现货 满99全国包邮','现货 全国包邮不含运费'])assert.equal(xianyuPurchaseTerms(text).shippingKnown,false,text);
 for(const text of ['全国包邮','现货 已售出 全国包邮','暂无现货 全国包邮','预售 有货 全国包邮','现货 求购 全国包邮'])assert.equal(xianyuPurchaseTerms(text).inStock,false,text);
 const item=xianyuProcurementItem(now);item.xianyu.samples[0].purchaseTermsText+=' 已售出';assert.equal(check(item),null);
});
test('exact canonical detail and independent external seller identity remain mandatory',()=>{
 assert.equal(canonicalXianyuOffer('https://www.goofish.com/item?id=1&tracking=x'),'https://www.goofish.com/item?id=1');
 for(const url of ['https://www.goofish.com/item?id=1&id=2','https://www.goofish.com.evil.test/item?id=1','https://www.goofish.com/search?id=1','http://www.goofish.com/item?id=1'])assert.equal(canonicalXianyuOffer(url),null);
 const item=xianyuProcurementItem(now);item.xianyu.samples[1].sellerKey=item.xianyu.samples[0].sellerKey;assert.equal(check(item),null);
 const own=xianyuProcurementItem(now);assert.equal(verifiedPurchasableXianyuEvidence(own.xianyu.samples,{target:procurementTarget(own),now,ownedSellerKeys:[own.xianyu.samples[0].sellerKey]}).ready,false);
});
test('identity acceptance cannot override conflicting color, quantity or opened condition in source details',()=>{
 for(const text of ['中古 開封済 ホワイト 1個 现货 全国包邮','新品 レッド 1個 现货 全国包邮','新品 ホワイト 2個 现货 全国包邮']){
  const item=xianyuProcurementItem(now);const sample=item.xianyu.samples[0];sample.detailDescription=text;sample.purchaseTermsText=text;assert.equal(check(item),null,text);
 }
});
test('compact publication retains a revalidatable selected supplier quote and never republishes expired automatic costs',()=>{
 const item={...xianyuProcurementItem(now),referenceProvider:'xianyu'};
 const compact=compactDashboardResult({items:[item]},{now}).items[0];
 assert.ok(check(compact));assert.deepEqual(compact.xianyu.selectedQuote,item.xianyu.selectedQuote);
 assert.equal(compact.xianyu.samples[0].shippingEvidence,'全国包邮');
 const expired=compactDashboardResult({items:[item]},{now:now+86400000}).items[0];
 assert.equal(expired.averageCNY,null);assert.equal(expired.xianyu.averageCNY,null);assert.equal(expired.xianyu.selectedQuote,null);
});
test('supplier display names the actual payable offer and labels the median only as a benchmark',()=>{
 const item={...xianyuProcurementItem(now,{},[100,110]),referenceProvider:'xianyu'};
 const compact=compactDashboardResult({items:[item]},{now}).items[0],markup=xianyuProcurementMarkup(compact,now);
 assert.match(markup,/已采用的供应商报价/);assert.match(markup,/商品 ¥100＋国内运费 ¥0＝¥100/);
 assert.match(markup,/价格中位数 ¥105/);assert.match(markup,/不用于成本和利润/);
 compact.xianyu.benchmarkCheckedAt=new Date(now-86400000).toISOString();compact.xianyu.averageCNY=null;
 assert.equal(xianyuProcurementMarkup(compact,now),'','a failed attempt cannot renew an old benchmark');
});
