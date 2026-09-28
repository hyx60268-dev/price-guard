import test from 'node:test';
import assert from 'node:assert/strict';
import { findMerchantImages } from '../scripts/lib/merchant-images.mjs';
const fp={dHash:'123456789abcdef0',aHash:'123456789abcdef0',centerHash:'123456789abcdef0',colorGrid:[1,80,150,60,180,240]};
const title='中国限定 Anker AeroClip2 ワイヤレスイヤホン レッド ギフトボックス',item={id:'self',title,description:'新品未開封 ギフトボックス',images:['https://image.test/source'],merchant:{id:'shop'}};
const dependencies={search:async()=>({items:[{id:'other',title,thumbnailImageUrl:'https://image.test/a'}]}),detail:async()=>({detail:{id:'other',title,description:item.description,seller:{id:'another'},images:[{url:'https://image.test/a'},{url:'https://image.test/b'}]}}),fingerprint:async()=>fp};
test('independent public image lookup returns target gallery with traceable sources, no procurement result',async()=>{
 const photos=await findMerchantImages(item,dependencies);assert.equal(photos.length,2);assert.equal(photos[0].sourceUrl,'https://paypayfleamarket.yahoo.co.jp/item/other');assert.equal(photos[0].verification,'detail_identity_primary_image');assert.equal(photos[0].price,undefined);
});
test('public image lookup rejects different color, mismatched image, seller self-copy and expired budget',async()=>{
 assert.deepEqual(await findMerchantImages(item,{...dependencies,deadline:0}),[]);
 assert.deepEqual(await findMerchantImages(item,{...dependencies,detail:async()=>({detail:{...(await dependencies.detail()).detail,title:title.replace('レッド','ブルー')}})}),[]);
 assert.deepEqual(await findMerchantImages(item,{...dependencies,fingerprint:async url=>url.endsWith('source')?fp:{...fp,colorGrid:[255,255,255,255,255,255]}}),[]);
 assert.deepEqual(await findMerchantImages(item,{...dependencies,detail:async()=>({detail:{...(await dependencies.detail()).detail,seller:{id:'shop'}}})}),[]);
});
