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

test('the displayed procurement reference names the actual selected seller, variant and payable amount',()=>{
 const a={canonicalUrl:'https://detail.youzan.com/show/goods?alias=white',url:'https://detail.youzan.com/show/goods?alias=white',skuId:'white-1',sellerKey:'youzan:1',sellerName:'Supplier A',selectedVariant:'白色礼盒',unitCNY:999,shippingCNY:0,landedCNY:999};
 const b={...a,canonicalUrl:'https://detail.youzan.com/show/goods?alias=other',url:'https://detail.youzan.com/show/goods?alias=other',skuId:'white-2',sellerKey:'youzan:2',sellerName:'Supplier B',unitCNY:1099,landedCNY:1099};
 const item={referenceProvider:'public_cn',procurementSource:{status:'ok',selectedQuote:{...a},samples:[a,b]}};
 const dom=new JSDOM(publicProcurementMarkup(item));
 try{const adopted=dom.window.document.querySelectorAll('strong');assert.equal(adopted.length,1);assert.match(adopted[0].parentElement.textContent,/Supplier A.*白色礼盒.*¥999/s);assert.equal(adopted[0].parentElement.querySelector('a').href,a.url);assert.doesNotMatch(dom.window.document.body.textContent,/至少两家|中位数/);}finally{dom.window.close()}
 const stale=new JSDOM(publicProcurementMarkup({...item,referenceProvider:null}));
 try{assert.equal(stale.window.document.querySelectorAll('strong').length,0);}finally{stale.window.close()}
});
