import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { merchantCardsMarkup } from '../public/merchant-view.js';
import { reviewedProductImages } from '../scripts/lib/reviewed-product-images.mjs';
import { procurementLabel,publicProcurementMarkup } from '../public/procurement-view.js';
import { invalidateCorrectedMatches,mergeMatchCorrections,correctionKey } from '../public/match-memory.js';
test('merchant card shows official images and a complete same-scene photo group beyond the old two-image cap',()=>{
 const item={sourceTitle:'【中国限定】Anker AeroClip 2 ワイヤレスイヤホン 張凌赫 コラボ 限定ギフトボックス レッド',sourcePriceJPY:29900};
 item.webImages=reviewedProductImages(item);const dom=new JSDOM(merchantCardsMarkup([item]));
 try{assert.equal(dom.window.document.querySelectorAll('img').length,5);assert.match(dom.window.document.body.textContent,/官方图 2\/1–2 · 同组实拍 3\/至少2/);assert.match(dom.window.document.body.textContent,/图片组齐全/);}finally{dom.window.close()}
});
test('generic matching photos from unrelated publishers do not claim a complete official and real-photo set',()=>{
 const dom=new JSDOM(merchantCardsMarkup([{sourcePriceJPY:5000,webImages:[{url:'https://photos.test/a',sourceUrl:'https://source.test/a'},{url:'https://photos.test/b',sourceUrl:'https://different.test/b'}]}]));
 try{assert.match(dom.window.document.body.textContent,/图片补全中/);assert.match(dom.window.document.body.textContent,/官方图 0\/1–2 · 同组实拍 0\/至少2/);assert.doesNotMatch(dom.window.document.body.textContent,/图片组齐全/);}finally{dom.window.close()}
});
test('public procurement presents real source and shipping separately and escapes source text',()=>{
 const item={referenceProvider:'public_cn',procurementSource:{status:'ok',samples:[{url:'javascript:bad()',sellerName:'<script>bad</script>',unitCNY:999,shippingCNY:0,landedCNY:999}]}};
 assert.match(procurementLabel(item),/国内/);const dom=new JSDOM(publicProcurementMarkup(item));
 try{assert.equal(dom.window.document.querySelectorAll('script').length,0);assert.equal(dom.window.document.querySelector('a').getAttribute('href'),'#');assert.match(dom.window.document.body.textContent,/商品 ¥999＋国内运费 ¥0＝¥999/);}finally{dom.window.close()}
});
test('public procurement corrections persist, isolate accounts and invalidate only the selected evidence',()=>{
 const sample={id:'youzan:sku-1'},item={accountId:'a',id:'own',title:'red',image:'a.jpg',averageCNY:999,referenceProvider:'public_cn',procurementSource:{verification:'v1',samples:[sample]}};
 const r={accountId:'a',itemId:'own',platform:'procurement',candidateId:'youzan:sku-1',updatedAt:'2026-10-01T17:00:00Z'};
 const corrections=mergeMatchCorrections({}, {[correctionKey(r)]:r});assert.equal(Object.keys(corrections).length,1);
 assert.equal(invalidateCorrectedMatches(item,corrections).averageCNY,null);
 assert.equal(invalidateCorrectedMatches({...item,accountId:'b'},corrections).averageCNY,999);
 assert.equal(invalidateCorrectedMatches(item,{[correctionKey(r)]:{...r,deleted:true}}).averageCNY,999);
});
