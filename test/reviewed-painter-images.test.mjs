import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewedProductImages,reconcileReviewedProductImages } from '../scripts/lib/reviewed-product-images.mjs';
import { merchantImageSet } from '../public/merchant-image-evidence.js';
import { externalImagePlan } from '../scripts/lib/external-images.mjs';
const title='中国限定 第五人格 画家 初期衣装 ぬいぐるみ';
const item={id:'m98929657142',title,images:['https://static.mercdn.net/item/detail/orig/photos/m98929657142_1.jpg?1790595067'],description:'第五人格 IdentityV ぬいぐるみ 画家 エドガー・ワルデン。衣装：初期衣装。状態：未使用品。残り1点。'};

test('actual painter gallery provides three distinct same-room photos with honest syndicated attribution and missing official images',()=>{
 const photos=reviewedProductImages(item),set=merchantImageSet({webImages:photos});
 assert.equal(photos.length,3);assert.equal(new Set(photos.map(p=>p.url)).size,3);assert.equal(new Set(photos.map(p=>p.photoEvidence.angleId)).size,3);
 assert.equal(set.photoCount,3);assert.equal(set.groups.length,1);assert.equal(set.officialCount,0);assert.equal(set.status,'partial');assert.equal(set.complete,false);assert.deepEqual(set.missing,['official_images']);
 assert.deepEqual(new Set(externalImagePlan({...item,webImages:photos}).map(p=>p.purpose)),new Set(['official']));
 for(const p of photos){assert.equal(p.kind,'physical_photo');assert.equal(p.provenance,undefined);assert.equal(p.price,undefined);assert.match(p.sourceName,/转载图库.*页面标注/);assert.match(p.photoEvidence.evidence,/未核实原店作者身份或官方授权/);assert.equal(p.photoEvidence.reviewedSameScene,true);assert.equal(new URL(p.url).hostname,'img.alicdn.com');assert.equal(new URL(p.sourceUrl).hostname,'tao.hooos.com');}
 assert.deepEqual(reviewedProductImages({sourceId:item.id,sourceTitle:item.title,sourceImages:item.images,sourceDescription:item.description}),photos);
});

test('painter evidence is bound to the observed listing, exact costume title and original primary photograph',()=>{
 const known=reviewedProductImages(item);
 for(const change of [{id:'m91581618076'},{id:'new-listing'},{title:title+' 2個セット'},{title:title.replace('初期衣装','黄金比')},{images:[]},{images:[item.images[0].replace('1790595067','1790595068')]}]){
  const changed={...item,...change};assert.deepEqual(reviewedProductImages(changed),[],JSON.stringify(change));assert.deepEqual(reconcileReviewedProductImages(changed,known),[],JSON.stringify(change));
 }
});

test('painter photos reject changed sizes, sale quantities, clothes only, missing hat and changed skins in every current description field',()=>{
 const known=reviewedProductImages(item);
 for(const description of ['サイズ：20cm。','ぬいぐるみ2体セットです。','衣装のみ。ぬいぐるみ本体は付属しません。','帽子のみ','帽子なし','ベレー帽は付属しません。','別衣装の黄金比です。','残り2点まとめて販売。']){
  for(const field of [{description},{sourceDescription:description},{sourceDetail:{description}},{yahoo:{ownDescription:description}},{condition:{name:description}}]){
   const changed={...item,...field};assert.deepEqual(reviewedProductImages(changed),[],JSON.stringify(field));assert.deepEqual(reconcileReviewedProductImages(changed,known),[],JSON.stringify(field));
  }
 }
 for(const description of ['サイズ10cm。ぬいぐるみ1体、帽子付き。','残り2点。','梱包箱のサイズ20cm。'])assert.equal(reviewedProductImages({...item,description}).length,3,description);
});

test('painter reconciliation removes incompatible saved syndicated photos while preserving unrelated evidence',()=>{
 const known=reviewedProductImages(item),unrelated={url:'https://example.com/other.jpg',sourceUrl:'https://example.com/gallery',kind:'product_image'};
 assert.deepEqual(reconcileReviewedProductImages({...item,description:'サイズ20cm。'},[...known,unrelated]),[unrelated]);
 assert.deepEqual(reconcileReviewedProductImages(item,known),known);
});
