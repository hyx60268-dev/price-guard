import test from 'node:test';
import assert from 'node:assert/strict';
import { isMixedBundle,extractMercariBundleContents,resolveMercariBundles,expandMerchantBundles } from '../scripts/lib/merchant-bundles.mjs';
import { merchantProducts } from '../scripts/lib/merchant-monitor.mjs';
import { curateMerchantProducts } from '../scripts/lib/merchant-curation.mjs';
const now=Date.parse('2026-10-01T16:30:00Z'),stamp=new Date(now).toISOString();
const merchant={key:'mercari:378316315',id:'378316315',platform:'mercari',name:'みこ'};
const titles=['中国限定 第五人格 「騎士」 カッコウ ぬいぐるみ','中国限定 第五人格 闘牛士 「ダーザイン」ぬいぐるみ'];
// Public parent description read on 2026-10-01; it contains no child URLs or prices.
const description=`リクエストありがとうございます。こちらはまとめ買い商品です。
2026年09月30日23時59分までに購入してください。

■ 商品内容
・中国限定 第五人格 「騎士」 カッコウ ぬいぐるみ【新品、未使用】
・中国限定 第五人格 闘牛士 「ダーザイン」ぬいぐるみ【新品、未使用】`;
const detail=(id,title,price)=>({id,key:merchant.key+':'+id,merchant,title,price,condition:'新品、未使用',url:'https://jp.mercari.com/item/'+id,sellerId:'/user/profile/378316315',lastDetailAt:stamp,firstSeenAt:stamp,status:'SOLD',description:title+' 輸入品。袋にシワがあります。',images:['https://images.test/'+id+'.jpg']});
function fixture(){
 const parent={...detail('m57886391722','みそ様 リクエスト 2点 まとめ商品',10000),description};
 // The second detail price is synthetic test evidence, deliberately not half the total.
 // Its live page was unavailable; this fixture does not claim it was retrieved.
 const knight=detail('m92397299173',titles[0],5000),bull=detail('m94630041379',titles[1],6100);
 return {parent,knight,bull};
}
test('m57886391722 explicit description identifies two different products without invented unit prices',()=>{
 const {parent}=fixture();assert.equal(isMixedBundle(parent),true);
 assert.deepEqual(extractMercariBundleContents(parent),titles.map(title=>({title,condition:'新品、未使用'})));
 assert.equal(isMixedBundle({...parent,title:parent.title.replace('2点','2件')}),true);
 assert.equal(isMixedBundle({title:'中国限定 第五人格 騎士 2点セット'}),false);
 assert.equal(isMixedBundle({title:'POPMART NARUTO 1BOX 10ピース入り'}),false);
});
test('each component uses its own verified original price, images and description, never half of the parent',()=>{
 const records=fixture();const expanded=expandMerchantBundles(records).filter(r=>r.bundleParentId);
 assert.equal(records.parent.bundleComplete,true);assert.equal(records.parent.bundleResolution,'exact_same_seller_details');
 assert.deepEqual(expanded.map(c=>c.price),[5000,6100]);
 assert.deepEqual(expanded.map(c=>c.images),[records.knight.images,records.bull.images]);
 assert.ok(expanded.every(c=>c.componentPriceBasis==='original_listing'&&c.bundleTotalPrice===10000&&!c.description.includes('リクエスト')));
 const products=merchantProducts(records,now);assert.ok(products.every(p=>!isMixedBundle({title:p.sourceTitle})));
 const own={title:titles[0],image:records.knight.images[0],accountId:'other-shop'};
 const curated=curateMerchantProducts(products,{listingHistory:{other:own}});
 assert.equal(curated.products.length,1);assert.equal(curated.products[0].sourceId,records.bull.id);
});
test('missing, unverified or ambiguous child records keep a bundle pending instead of searching the parent title',()=>{
 for(const change of [r=>delete r.bull,r=>r.bull.price=null,r=>r.bull.price=0,r=>r.bull.lastDetailAt=null,r=>r.bull.images=[],r=>r.bull.description='',r=>r.bull.sellerId='/user/profile/123',r=>r.bull.merchant={...merchant,key:'mercari:123',id:'123'},r=>r.bull.url='https://jp.mercari.com/item/m111',r=>r.bull.condition='目立った傷や汚れなし',r=>r.other={...r.bull,id:'m111',key:'mercari:378316315:m111',url:'https://jp.mercari.com/item/m111'}]){
  const records=fixture();change(records);const expanded=expandMerchantBundles(records);
  assert.equal(records.parent.bundleComplete,false);assert.equal(expanded.some(r=>r.id==='m57886391722'||r.bundleParentId),false);
  assert.equal(records.parent.bundleUnresolved.length,1);
 }
});
test('an unverified parent or unrelated description section is never used to infer components',()=>{
 const {parent}=fixture();
 for(const description of [parent.description.replace('■ 商品内容','おすすめ商品'),parent.description.replace('2点','2点')+'\n・中国限定 第五人格 別のキャラクター【新品、未使用】',parent.description.replace(titles[1],titles[0])])assert.deepEqual(extractMercariBundleContents({...parent,description}),[]);
 assert.deepEqual(extractMercariBundleContents({...parent,title:parent.title.replace('2点','3点')}),[]);
 assert.deepEqual(extractMercariBundleContents({...parent,description:parent.description+'\n■ おすすめ商品\n・中国限定 第五人格 その他のぬいぐるみ【新品、未使用】'}).map(r=>r.title),titles);
 for(const change of [r=>r.parent.sellerId='/user/profile/123',r=>r.parent.lastDetailAt=null]){
  const records=fixture();change(records);resolveMercariBundles(records);assert.equal(records.parent.bundleComplete,false);assert.deepEqual(records.parent.components,[]);
 }
});
test('colour, costume and quantity differences do not satisfy exact bundle declarations',()=>{
 for(const suffix of [' ホワイト',' 2点セット',' 初期衣装']){
  const records=fixture();records.bull.title+=suffix;resolveMercariBundles(records);assert.equal(records.parent.bundleComplete,false);
 }
});
test('per-child price and regional filters are preserved even when the parent qualifies',()=>{
 const records=fixture();records.bull.title=records.bull.title.replace('中国限定 ','');records.bull.description='第五人格 闘牛士 ダーザイン ぬいぐるみ';
 records.parent.description=description.replace(titles[1],records.bull.title);records.knight.price=4999;
 assert.equal(expandMerchantBundles(records).filter(r=>r.bundleParentId).length,2);
 assert.deepEqual(merchantProducts(records,now),[]);
});
test('bundle reconciliation preserves confirmed image evidence only for an unchanged original item',()=>{
 const records=fixture();resolveMercariBundles(records);
 records.parent.components[0].webImages=[{url:'https://photos.test/a.jpg',sourceUrl:'https://photos.test/item'}];
 records.parent.components[0].webImageStatus='verified';resolveMercariBundles(records);
 assert.equal(records.parent.components[0].webImages.length,1);
 records.knight.images=['https://images.test/changed.jpg'];resolveMercariBundles(records);
 assert.equal(records.parent.components[0].webImages,undefined);
});
