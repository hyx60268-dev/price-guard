import test from 'node:test';
import assert from 'node:assert/strict';
import { findMerchantImages } from '../scripts/lib/merchant-images.mjs';
import { externalPublicUrl,externalProductImages } from '../scripts/lib/external-images.mjs';
const fp={dHash:'123456789abcdef0',aHash:'123456789abcdef0',centerHash:'123456789abcdef0',colorGrid:[1,80,150,60,180,240]};
const title='中国限定 Anker AeroClip2 ワイヤレスイヤホン レッド ギフトボックス',item={title,description:'新品未開封 ギフトボックス',images:['https://image.test/source']};
const dependencies={search:async()=>[{url:'https://official.test/product'}],detail:async()=>[{url:'https://image.test/a',title},{url:'https://image.test/b',title}],fingerprint:async()=>fp};
test('independent image lookup returns only verified external detail photos with provenance, never procurement',async()=>{
 const photos=await findMerchantImages(item,dependencies);assert.equal(photos.length,2);assert.equal(photos[0].sourceUrl,'https://official.test/product');assert.equal(photos[0].verification,'external_detail_image_match');assert.equal(photos[0].price,undefined);
});
test('external images exclude all three comparison marketplaces, mismatched colours, bad artwork and expired budget',async()=>{
 for(const u of ['https://paypayfleamarket.yahoo.co.jp/item/x','https://jp.mercari.com/item/x','https://fril.jp/item/x','https://127.0.0.1/','http://public.test/'])assert.equal(externalPublicUrl(u),false);
 assert.deepEqual(await findMerchantImages(item,{...dependencies,deadline:0}),[]);
 assert.deepEqual(await findMerchantImages(item,{...dependencies,detail:async()=>[{url:'https://image.test/a',title:title.replace('レッド','ブルー')}]}),[]);
 assert.deepEqual(await findMerchantImages(item,{...dependencies,fingerprint:async url=>url.endsWith('source')?fp:{...fp,colorGrid:[255,255,255,255,255,255]}}),[]);
 assert.deepEqual(await findMerchantImages(item,{...dependencies,search:async()=>[{url:'https://fril.jp/item/x'}]}),[]);
});
test('official gallery parser excludes recommendation images and parses Product JSON-LD',()=>{
 const html='<img src="https://img.test/a.jpg" alt="Anker AeroClip2 商品图0"><img src="https://img.test/advert.jpg" alt="热门商品"><script type="application/ld+json">'+JSON.stringify({'@type':'Product',name:title,image:['https://img.test/b.jpg']})+'</script>';
 assert.deepEqual(externalProductImages(html).map(p=>p.url).sort(),['https://img.test/a.jpg','https://img.test/b.jpg']);
});
