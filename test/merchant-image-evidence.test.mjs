import test from 'node:test';
import assert from 'node:assert/strict';
import { merchantImageSet,mergeMerchantImages } from '../public/merchant-image-evidence.js';
import { reviewedProductImages } from '../scripts/lib/reviewed-product-images.mjs';
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
 const partial=merchantImageSet({webImages:reviewedProductImages(dentist)});assert.equal(partial.complete,false);assert.equal(partial.other.length,1);
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
