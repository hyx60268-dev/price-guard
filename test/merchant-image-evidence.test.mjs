import test from 'node:test';
import assert from 'node:assert/strict';
import { merchantImageSet,mergeMerchantImages } from '../public/merchant-image-evidence.js';
import { reviewedProductImages,reconcileReviewedProductImages } from '../scripts/lib/reviewed-product-images.mjs';
import { inspectExternalImages,externalImagePlan } from '../scripts/lib/external-images.mjs';
import { runMerchantImageJobs,IMAGE_LOOKUP_VERSION,imageCoverage } from '../scripts/lib/merchant-image-jobs.mjs';
import { merchantRetryDelay } from '../scripts/lib/merchant-scheduling.mjs';
const reviewedAt='2026-10-01T17:00:00Z';
const official=(name='official')=>({url:'https://brand.test/'+name+'.jpg',sourceUrl:'https://brand.test/product',verification:'reviewed_exact_product_variant',reviewedAt,kind:'official_image',provenance:{authority:'brand_official_store',reviewed:true,evidenceUrl:'https://brand.test/product'}});
const photo=(angle,change={})=>({url:'https://photos.test/'+angle+'.jpg',sourceUrl:'https://seller.test/gallery',verification:'reviewed_exact_product_variant',reviewedAt,kind:'physical_photo',photoEvidence:{publisherId:'seller:one',shootId:'session:one',sceneId:'home-desk',angleId:angle,reviewedSameScene:true,reviewedAt,...change}});
const fp={dHash:'123456789abcdef0',aHash:'123456789abcdef0',centerHash:'123456789abcdef0',colorGrid:[1,80,150,60,180,240]};

test('one to two proven official images and two coherent distinct physical views are the complete publication set',()=>{
 const set=merchantImageSet({webImages:[official(),official('second'),official('third'),photo('front'),photo('back')]});
 assert.equal(set.complete,true);assert.equal(set.officialCount,2);assert.equal(set.photoCount,2);assert.deepEqual(set.missing,[]);
 assert.equal(merchantImageSet({webImages:[official(),photo('front')]}).complete,false);
});

test('same seller alone or home and park photos cannot be merged into a complete real-photo group',()=>{
 for(const second of [photo('back',{sceneId:'park'}),photo('back',{publisherId:'seller:two'}),photo('back',{shootId:'other-session'}),photo('back',{reviewedSameScene:false}),photo('back',{angleId:''})]){
  const set=merchantImageSet({webImages:[official(),photo('front'),second]});assert.equal(set.complete,false);assert.equal(set.photoCount,1);assert.ok(set.missing.includes('coherent_photos'));
 }
});

test('CDN resize duplicates, repeated view labels and duplicate visual assets never count as multiple angles',()=>{
 const front=photo('front');
 for(const duplicate of [{...photo('back'),url:front.url+'?x-oss-process=image/resize,w_100'},photo('front'),{...photo('back'),visualAssetId:'same'}]){
  const set=merchantImageSet({webImages:[official(),{...front,visualAssetId:'same'},duplicate]});assert.equal(set.photoCount,1);assert.equal(set.complete,false);
 }
});

test('a matching thumbnail or official-looking domain never becomes official or physical proof',()=>{
 const product={...official(),verification:'external_detail_image_match'};
 for(const image of [product,{...official(),provenance:undefined},{...official(),provenance:{...official().provenance,reviewed:false}},{...photo('front'),verification:'external_detail_image_match'}]){
  const set=merchantImageSet({webImages:[image]});assert.equal(set.complete,false);assert.equal(set.officialCount,0);assert.equal(set.photoCount,0);assert.equal(set.other.length,1);
 }
 assert.equal(merchantImageSet({webImages:[{...official(),sourceUrl:'https://jp.mercari.com/item/m1'}]}).status,'missing');
});

test('the inspected red Anker gallery contains two official images plus three reviewed same-scene photos, never other colours or quantities',()=>{
 const title='【中国限定】Anker ワイヤレスイヤホン 張凌赫 コラボ ギフトボックスセット AeroClip2 レッドイヤホン';
 const set=merchantImageSet({webImages:reviewedProductImages({title})});assert.equal(set.complete,true);assert.equal(set.officialCount,2);assert.equal(set.photoCount,3);assert.equal(set.groups.length,1);
 for(const wrong of [title.replace('レッド','ホワイト'),title+' 2セット',title+' 単品',title.replace('AeroClip2','AeroClip3')])assert.deepEqual(reviewedProductImages({title:wrong}),[]);
 const dentist={id:'m91581618076',title:'中国限定 第五人格 歯医者 初期衣装 ぬいぐるみ',images:['https://static.mercdn.net/item/detail/orig/photos/m91581618076_1.jpg?1790594913']};
 const partial=merchantImageSet({webImages:reviewedProductImages(dentist)});assert.equal(partial.complete,false);assert.equal(partial.status,'partial');assert.equal(partial.officialCount,0);assert.equal(partial.photoCount,3);assert.equal(partial.groups.length,1);assert.equal(partial.other.length,0);assert.deepEqual(partial.missing,['official_images']);assert.deepEqual(partial.reasons,['official_provenance_missing']);
 assert.deepEqual(new Set(externalImagePlan({...dentist,webImages:reviewedProductImages(dentist)}).map(p=>p.purpose)),new Set(['official']));
});

test('incomplete image jobs preserve good evidence through network failure and remain eligible for repair',async()=>{
 const now=Date.parse(reviewedAt),item={key:'partial',webImages:[official(),photo('front')],webImageVersion:5,webImageStatus:'verified',webImageDiagnostics:{candidates:[{url:'https://candidate.test/image',sourceUrl:'https://candidate.test/page',status:'different_view_or_product_unconfirmed'}]}};
 await runMerchantImageJobs([item],{now:()=>now,deadline:now+60000,inspect:async()=>{throw Error('HTTP 503')}});
 assert.equal(item.webImages.length,2);assert.equal(item.webImageDiagnostics.candidates.length,1);assert.equal(item.webImageStatus,'partial');assert.equal(item.webImageDiagnostics.lastAttemptStatus,'error');assert.equal(item.webImageVersion,IMAGE_LOOKUP_VERSION);
 assert.equal(merchantRetryDelay({checkedAt:reviewedAt,merchants:[{status:'ok'}],products:[item]},now),1200000);
 assert.deepEqual(imageCoverage([item]),{total:1,verified:0,partial:1,pending:0,failed:0,unmatched:0,officialReady:1,photosReady:0});
 item.webImageRetryAt=null;
 await runMerchantImageJobs([item],{now:()=>now,deadline:now+60000,inspect:async()=>({photos:[photo('back')],status:'verified'})});
 assert.equal(item.webImageStatus,'verified');assert.equal(item.webImageRetryAt,null);assert.equal(item.webImages.length,3);
});

test('official and physical gaps drive separate queries; a single matched generic image cannot stop follow-up searches',async()=>{
 const item={title:'中国限定 Figure Myethos レッド 1/7',images:['https://img.test/origin.jpg']};
 assert.deepEqual(new Set(externalImagePlan(item).map(p=>p.purpose)),new Set(['official','physical']));
 assert.deepEqual(new Set(externalImagePlan({...item,webImages:[official()]}).map(p=>p.purpose)),new Set(['physical']));
 const calls=[];
 const result=await inspectExternalImages(item,{search:async(q)=>{calls.push(q);return [{url:'https://gallery.test/page'}]},detail:async()=>[{url:'https://img.test/match.jpg',title:item.title}],fingerprint:async()=>fp});
 assert.equal(result.status,'partial');assert.ok(calls.some(q=>q.includes('官方 商品图')));assert.ok(calls.some(q=>q.includes('实拍 开箱')));assert.equal(result.candidates.length,1);assert.equal(result.photos[0].kind,'product_image');
});

test('a failed source retains previous candidate evidence and never downgrades product-specific review metadata',()=>{
 const reviewed=photo('front'),old={url:reviewed.url,sourceUrl:reviewed.sourceUrl,kind:'product_image',verification:'external_detail_image_match'};
 assert.deepEqual(mergeMerchantImages([reviewed],[old]),[reviewed]);assert.deepEqual(mergeMerchantImages([old],[reviewed]),[reviewed]);
});


test('reviewed red full-box images reject conflicting sale contents in every live merchant description field',()=>{
 const title='【中国限定】Anker AeroClip 2 ワイヤレスイヤホン 張凌赫 コラボ 限定ギフトボックス レッド';
 const positive='Anker AeroClip 2 レッドの限定ギフトボックスセットです。\nイヤホンと張凌赫の特典を含む完全なセットです。';
 assert.equal(reviewedProductImages({title,description:positive}).length,5);
 for(const description of ['外箱のみ。イヤホンと特典は付属しません。','ホワイトのイヤホン本体のみです。','レッドのギフトボックスを2セットまとめて販売します。','2セットまとめて販売します。','ギフトボックス2套合售','特典は付属しません。','イヤホンなしのセットです。']){
  for(const fields of [{description},{sourceDescription:description},{sourceDetail:{description}},{yahoo:{ownDescription:description}}])assert.deepEqual(reviewedProductImages({title,...fields}),[],JSON.stringify(fields));
 }
 assert.deepEqual(reviewedProductImages({title,description:positive,sourceDescription:'外箱のみです。'}),[]);
 assert.deepEqual(reviewedProductImages({title,sourceDetail:{description:positive,condition:{name:'本体のみ'}}}),[]);
});


test('a historical wrong reviewed mapping is removed before complete-set skipping and retry scheduling',async()=>{
 const title='【中国限定】Anker AeroClip 2 ワイヤレスイヤホン 張凌赫 コラボ 限定ギフトボックス レッド',photos=reviewedProductImages({title});
 const generic={url:'https://other.test/image.jpg',sourceUrl:'https://other.test/page',verification:'external_detail_image_match',kind:'product_image'};
 const item={key:'changed',title,description:'外箱のみ。イヤホンは付属しません。',webImages:[...photos,generic],webImageVersion:IMAGE_LOOKUP_VERSION,webImageRetryAt:'2099-01-01T00:00:00Z'};
 assert.deepEqual(reconcileReviewedProductImages(item),[generic]);
 let attempts=0;const now=Date.parse('2026-10-01T17:00:00Z');
 await runMerchantImageJobs([item],{now:()=>now,deadline:now+60000,inspect:async()=>{attempts++;return {photos:[],status:'not_found'}}});
 assert.equal(attempts,1);assert.deepEqual(item.webImages,[generic]);assert.equal(merchantImageSet(item).complete,false);
 assert.equal(reconcileReviewedProductImages({title,description:'レッドの完全なギフトボックスです。'},photos).length,5);
 const dentist={id:'m91581618076',title:'中国限定 第五人格 歯医者 初期衣装 ぬいぐるみ',images:['https://static.mercdn.net/item/detail/orig/photos/m91581618076_1.jpg?1790594913']};
 assert.equal(reconcileReviewedProductImages({...dentist,images:['https://image.test/changed']},reviewedProductImages(dentist)).length,0);
});


test('the historical Dentist single-view record adopts the later explicit same-scene review without claiming official evidence',async()=>{
 const item={id:'m91581618076',title:'中国限定 第五人格 歯医者 初期衣装 ぬいぐるみ',images:['https://static.mercdn.net/item/detail/orig/photos/m91581618076_1.jpg?1790594913']};
 const reviewed=reviewedProductImages(item),old={...reviewed[0],reviewedAt:'2026-10-01T12:55:00Z',photoEvidence:{...reviewed[0].photoEvidence,sceneId:'white-background-single-observation',angleId:'front',reviewedSameScene:false,reviewedAt:'2026-10-01T12:55:00Z'}};
 item.webImages=[old];
 assert.deepEqual(reconcileReviewedProductImages(item),[reviewed[0]]);
 const now=Date.parse('2026-10-01T18:00:00Z');
 await runMerchantImageJobs([item],{now:()=>now,deadline:now+60000,inspect:async()=>({photos:reviewed,status:'partial',reason:'image_set_incomplete'})});
 const set=merchantImageSet(item);assert.equal(item.webImages.length,3);assert.equal(set.photoCount,3);assert.equal(set.officialCount,0);assert.equal(set.complete,false);assert.deepEqual(set.missing,['official_images']);
 assert.deepEqual(imageCoverage([item]),{total:1,verified:0,partial:1,pending:0,failed:0,unmatched:0,officialReady:0,photosReady:1});
});


test('reviewed Dentist photos reject explicit changed size, clothes-only or multiple-doll sale contents while retaining unstated size',()=>{
 const item={id:'m91581618076',title:'中国限定 第五人格 歯医者 初期衣装 ぬいぐるみ',images:['https://static.mercdn.net/item/detail/orig/photos/m91581618076_1.jpg?1790594913']},known=reviewedProductImages(item);
 for(const description of ['', '初期衣装のぬいぐるみです。','サイズ：約10cm。ぬいぐるみ1体です。','尺寸:100mm','梱包箱のサイズ20cm。白い绑带2条。','サイズ10cm。白いストラップ2本。'])assert.equal(reviewedProductImages({...item,description}).length,3,description);
 for(const description of ['サイズは20cmです。','20cm','20cmのぬいぐるみです。','20cmタイプです。','ぬいぐるみ20cmです。','身長200mm','初期衣装のみです。ぬいぐるみは付属しません。','仅售娃衣，不含娃体','お洋服だけ販売します。','2件','ぬいぐるみ2体セットです。','商品内容は二件セット。','2只合售','2セットまとめて販売します。']){
  for(const fields of [{description},{sourceDescription:description},{sourceDetail:{description}},{yahoo:{ownDescription:description}}]){
   const changed={...item,...fields};assert.deepEqual(reviewedProductImages(changed),[],JSON.stringify(fields));assert.deepEqual(reconcileReviewedProductImages(changed,known),[],JSON.stringify(fields));
  }
 }
 assert.deepEqual(reviewedProductImages({...item,description:'サイズ10cm',sourceDescription:'サイズ20cm'}),[]);
 assert.deepEqual(reviewedProductImages({...item,sourceDetail:{condition:{name:'衣装のみ'}}}),[]);
});
