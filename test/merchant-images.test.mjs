import test from 'node:test';
import assert from 'node:assert/strict';
import { findMerchantImages } from '../scripts/lib/merchant-images.mjs';
import { externalPublicUrl,externalProductImages,inspectExternalImages,searchImageLinks,publicHtml } from '../scripts/lib/external-images.mjs';
import { reviewedProductImages } from '../scripts/lib/reviewed-product-images.mjs';
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
test('reviewed PChome real photos bind only to the red Zhang Linghe full gift box',()=>{
 const sourceTitle='【中国限定】Anker ワイヤレスイヤホン 張凌赫 コラボ ギフトボックスセット AeroClip2 レッドイヤホン';
 const photos=reviewedProductImages({sourceTitle});assert.equal(photos.length,2);assert.ok(photos.every(p=>p.kind==='physical_photo'&&p.sourceUrl.startsWith('https://article.pchome.net/')));
 for(const title of [sourceTitle.replace('レッド','ホワイト'),sourceTitle.replace('張凌赫','別コラボ'),sourceTitle.replace('AeroClip2','AeroClip3'),sourceTitle+' 2セット',sourceTitle+' 単品'])assert.deepEqual(reviewedProductImages({title}),[]);
});

test('a failing search provider falls back and a failed page does not prevent the next verified source',async()=>{
 const providers=[];
 const r=await inspectExternalImages(item,{...dependencies,search:async(q,{provider})=>{
  providers.push(provider);if(provider==='bing')throw Error('HTTP 503');
  return [{url:'https://broken.test/product'},{url:'https://official.test/product'}];
 },detail:async url=>{if(url.includes('broken'))throw Error('HTTP 404');return dependencies.detail(url)}});
 assert.deepEqual(providers,['bing','duckduckgo']);assert.equal(r.status,'verified');assert.equal(r.photos.length,2);
 assert.deepEqual(r.failures.map(f=>f.stage),['search','detail']);assert.equal(r.pagesRead,1);
});

test('empty search, source outage and rejected product image remain separate outcomes',async()=>{
 const missing=await inspectExternalImages(item,{...dependencies,search:async()=>[]});assert.equal(missing.reason,'no_search_results');assert.equal(missing.status,'not_found');
 const failed=await inspectExternalImages(item,{...dependencies,detail:async()=>{throw Error('HTTP 503')}});assert.equal(failed.status,'error');assert.equal(failed.reason,'detail_unavailable');
 const mismatch=await inspectExternalImages(item,{...dependencies,fingerprint:async url=>url.endsWith('source')?fp:{...fp,colorGrid:[255,255,255,255,255,255]}});assert.equal(mismatch.reason,'no_verified_match');assert.deepEqual(mismatch.photos,[]);
 const lost=await inspectExternalImages(item,{...dependencies,fingerprint:async()=>null});assert.equal(lost.reason,'source_image_unavailable');assert.equal(lost.searches,0);
});

test('fallback parses only result links, unwraps public targets and rejects marketplace mirrors as image URLs',()=>{
 const html='<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbrand.test%2Fproduct">Good</a><a class="result__a" href="https://jp.mercari.com/item/x">No</a><a href="https://advert.test">Ad</a>';
 assert.deepEqual(searchImageLinks(html,'duckduckgo'),[{url:'https://brand.test/product'}]);
 const social='<meta content="https://img.test/real.jpg" property="og:image"><meta property="og:title" content="Real product"><img src="https://img.test/ad.jpg">';
 assert.deepEqual(externalProductImages(social),[{url:'https://img.test/real.jpg',title:'Real product'}]);
});

test('source transport rejects oversized streamed bodies and unsafe redirects before requesting them',async()=>{
 await assert.rejects(publicHtml('https://public.test/',{request:async()=>new Response('x'.repeat(3_000_001))}),/页面过大/);
 let count=0;await assert.rejects(publicHtml('https://public.test/',{request:async()=>{count++;return new Response(null,{status:302,headers:{location:'https://127.0.0.1/'}})}}),/地址无效/);assert.equal(count,1);
});
