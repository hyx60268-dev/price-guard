import test from 'node:test';
import assert from 'node:assert/strict';
import { curateMerchantProducts,sameMerchantProduct,prepareMerchantVisuals } from '../scripts/lib/merchant-curation.mjs';
import { reviewedMerchantArtworkPair } from '../scripts/lib/reviewed-merchant-artwork.mjs';
import { merchantProducts,recordMerchantObservation } from '../scripts/lib/merchant-monitor.mjs';

const title='ゼンゼロ 閃魂コラボ 中国限定 仲夏幻夢 コレクションカード 葉瞬光 SS';
const ownImage='https://auctions.c.yimg.jp/images.auctions.yahoo.co.jp/image/dr000/auc0209/users/aa1954d0eebeb0f0f7bd68ff5ed1999553cba189/i-img1200x1139-17905653659655renmq.jpg';
const productImage='https://auctions.c.yimg.jp/images.auctions.yahoo.co.jp/image/dr000/auc0209/users/6aa9cce46b086b8efaedf39aa01c3fb136c1c313/i-img924x1200-1789455503749i0m89i.jpg';
const ownedSha='1d38e8b967c58f88a27f101e689b7c177f1d7fc79514ea64340a262f21a2982d',productSha='fd4e706f97f0184cd1dd4e8c09a7b948d2983050265c9d75344bcd491e959c32';
function observed(){return {
 owned:{id:'z693691302',platform:'yahoo_fleamarket',accountId:'melon',sellerId:'p76217154',title,image:ownImage,
  yahoo:{ownImages:[ownImage],ownDescription:'ゼンゼロ 閃魂コラボ 中国限定 仲夏幻夢 コレクションカード 葉瞬光 SS 写真の通りです。 海外輸入品については、化粧箱に開封跡・箱潰れ・傷・凹み・汚れがある場合がございます ご覧頂きありがとうございます。 よろしくお願いいたします。'},
  primaryFingerprint:{url:ownImage,contentSha256:ownedSha}},
 product:{key:'yahoo:p59959877:z683731310',sourceId:'z683731310',sourcePlatform:'yahoo',seller:{id:'p59959877'},sourceTitle:title,sourceImages:[productImage],
  sourceDescription:'ゼンレスゾーンゼロ（ゼンゼロ）と閃魂のコラボレーションによる、中国限定の仲夏幻夢コレクションカードです。キャラクターは葉瞬光（SS-201）となります。 【商品名】ゼンゼロ 閃魂コラボ 仲夏幻夢 葉瞬光 SS-201 ホロ箔押しカード 【状態】実物写真をご参照ください コレクション整理のため出品いたします。大切に保管しておりましたが、素人保管のため細かな状態を気にされる方はご遠慮ください。 よろしくお願いいたします。',
  primaryFingerprint:{url:productImage,contentSha256:productSha}}
}}
test('2026-10-04 reported SS card different-angle pair is excluded only when that exact product is in owned inventory',()=>{
 const {owned,product}=observed();
 assert.equal(sameMerchantProduct(product,owned),false,'the ordinary duplicate-photo threshold was not weakened');
 assert.equal(reviewedMerchantArtworkPair(product,owned)?.kind,'reviewed_inventory_artwork');
 assert.equal(curateMerchantProducts([product],{}).products.length,1);
 for(const inventory of [{items:[owned]},{listingHistory:{old:owned}}]){
  const result=curateMerchantProducts([product],inventory);assert.equal(result.excludedOwned,1);assert.deepEqual(result.reviewedOwnedExclusions,[{productId:'z683731310',ownedId:'z693691302',method:'reviewed_inventory_artwork'}]);assert.equal(result.products.length,0);
 }
 assert.equal(curateMerchantProducts([product,{...product,sourceId:owned.id,sourceImages:[ownImage],primaryFingerprint:owned.primaryFingerprint}]).products.length,2,'review is not a general grouping override');
});
test('either side changed ID, seller, text, primary URL or image bytes revokes reviewed card exclusion',()=>{
 for(const side of ['owned','product'])for(const mutation of [
  p=>{p[side==='owned'?'id':'sourceId']+='changed'},
  p=>{if(side==='owned')p.sellerId='other';else p.seller.id='other'},
  p=>{p[side==='owned'?'title':'sourceTitle']+=' SR'},
  p=>{if(side==='owned')p.yahoo.ownDescription+='2枚セット';else p.sourceDescription+='2枚セット'},
  p=>{if(side==='owned')p.yahoo.ownDescription='';else p.sourceDescription=''},
  p=>{if(side==='owned')p.yahoo.ownImages=['https://wrong.test/card'];else p.sourceImages=['https://wrong.test/card']},
  p=>{p.primaryFingerprint.contentSha256='f'.repeat(64)},p=>{delete p.primaryFingerprint}
 ]){
  const row=observed();mutation(row[side]);assert.equal(reviewedMerchantArtworkPair(row.product,row.owned),null,side+': '+mutation);
  assert.equal(curateMerchantProducts([row.product],{items:[row.owned]}).products.length,1);
 }
 const row=observed();assert.equal(reviewedMerchantArtworkPair({...row.product,sourcePlatform:'mercari'},row.owned),null);
 assert.equal(reviewedMerchantArtworkPair(row.owned,row.product),null);
});
test('current matching primary bytes upgrade old cached fingerprints before owned-card exclusion',async()=>{
 const {product,owned}=observed(),calls=[];
 const dashboard={items:[owned],merchantPrimaryImages:{[productImage]:{url:productImage},[ownImage]:{url:ownImage}}};
 dashboard.merchantPrimaryImages=await prepareMerchantVisuals([product],dashboard,{fingerprint:async url=>{calls.push(url);return {url,contentSha256:url===ownImage?ownedSha:productSha}}});
 assert.deepEqual(calls,[productImage,ownImage]);assert.equal(curateMerchantProducts([product],dashboard).products.length,0);
});
test('a title-only card or failed primary download never inherits reviewed artwork evidence',async()=>{
 const {product,owned}=observed();delete owned.yahoo.ownDescription;
 assert.equal(curateMerchantProducts([product],{items:[owned]}).products.length,1);
 const row=observed();delete row.product.primaryFingerprint;delete row.owned.primaryFingerprint;
 const dashboard={items:[row.owned]};dashboard.merchantPrimaryImages=await prepareMerchantVisuals([row.product],dashboard,{fingerprint:async()=>null});
 assert.equal(curateMerchantProducts([row.product],dashboard).products.length,1);
});
test('Dentist listing at the observed 4900 yen correctly leaves curated selection without deleting stored photo evidence',()=>{
 const merchant={key:'mercari:378316315',platform:'mercari',id:'378316315'},now=Date.parse('2026-10-04T14:00:00Z');
 const item={id:'m91581618076',title:'中国限定 第五人格 歯医者 初期衣装 ぬいぐるみ',status:'OPEN',price:5000,images:['https://static.mercdn.net/item/detail/orig/photos/m91581618076_1.jpg?1790594913']};
 let records=recordMerchantObservation({},merchant,[item],now);
 assert.equal(merchantProducts(records,now)[0].webImages.length,3);
 records=recordMerchantObservation(records,merchant,[{...item,price:4900}],now+1000);
 assert.equal(merchantProducts(records,now+1000).length,0);
 assert.equal(Object.keys(records).length,1);
 records=recordMerchantObservation(records,merchant,[{...item,price:5000}],now+2000);
 assert.equal(merchantProducts(records,now+2000)[0].webImages.length,3);
});
