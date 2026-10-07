import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { merchantCardsMarkup } from '../public/merchant-view.js';
import { reviewedProductImages } from '../scripts/lib/reviewed-product-images.mjs';
import { procurementLabel,publicProcurementMarkup,visiblePurchasableOffers } from '../public/procurement-view.js';
import { invalidateCorrectedMatches,mergeMatchCorrections,correctionKey,candidateId,rejectedByMemory } from '../public/match-memory.js';
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


test('procurement shows the actual delivery scope without rendering supplier markup',()=>{
 const sample={unitCNY:1120,shippingCNY:0,landedCNY:1120,deliveryTerms:'中国大陆中通包邮；顺丰到付不采用。<img src=x onerror=bad()>'};
 const dom=new JSDOM(publicProcurementMarkup({procurementSource:{samples:[sample]}}));
 try{assert.match(dom.window.document.body.textContent,/配送条件：中国大陆中通包邮；顺丰到付不采用/);assert.equal(dom.window.document.querySelectorAll('img').length,0);}finally{dom.window.close()}
 const legacy=new JSDOM(publicProcurementMarkup({procurementSource:{samples:[{...sample,deliveryTerms:null}]}}));
 try{assert.doesNotMatch(legacy.window.document.body.textContent,/配送条件/);}finally{legacy.window.close()}
});

test('a real retail quote with unknown sealing is visible without becoming a cost',()=>{
 const now=Date.parse('2026-10-07T15:00:00Z'),target={accountId:'owner',id:'z1',title:'完整手办',image:'https://images.example.org/1.jpg',description:'新品未開封',condition:'未使用'};
 const offer={target,verification:'public_purchasable_offer_v1',eligibility:'condition_unconfirmed',condition:'retail_unspecified',
  identity:{method:'reviewed_catalog_identity'},catalogIdentity:{method:'reviewed_catalog_identity',scope:'catalogue_product_only',sealVerified:false},
  status:'quoted',inStock:true,currency:'CNY',shippingKnown:true,unitCNY:1120,shippingCNY:0,landedCNY:1120,price:1120,
  url:'https://www.alter-shanghai.cn/m/spotPage/298.html',canonicalUrl:'https://www.alter-shanghai.cn/m/spotPage/298.html',
  checkedAt:new Date(now-60000).toISOString(),deliveryTerms:'中通包邮；限购1件',sellerName:'阿尔塔在线'};
 const item={...target,procurementTarget:{...target},procurementSource:{status:'incomplete',averageCNY:null,samples:[],purchasableOffers:[offer]}};
 const text=new JSDOM(publicProcurementMarkup(item,{now})).window.document.body.textContent;
 assert.match(text,/1,120/);assert.match(text,/未注明是否原封/);assert.match(text,/尚未计入成本及利润/);assert.doesNotMatch(text,/已采用的供应商报价/);
 for(const changed of [{accountId:'other'},{id:'z2'},{title:'另一个手办'},{image:'https://images.example.org/2.jpg'}]){
  assert.doesNotMatch(new JSDOM(publicProcurementMarkup({...item,...changed},{now})).window.document.body.textContent,/1,120/);
 }
 for(const changed of [{checkedAt:new Date(now-25*3600000).toISOString()},{price:999},{inStock:false},{condition:'used'}]){
  assert.doesNotMatch(new JSDOM(publicProcurementMarkup({...item,procurementSource:{...item.procurementSource,purchasableOffers:[{...offer,...changed}]}},{now})).window.document.body.textContent,/1,120/);
 }
});

function currentOfferFixture(){
 const now=Date.now(),target={accountId:'owner',id:'z1',title:'完整手办',image:'https://images.example.org/1.jpg',description:'新品未開封',condition:'未使用'};
 const offer={id:'298',skuId:'AL20744',target:{...target},verification:'public_purchasable_offer_v1',eligibility:'condition_unconfirmed',condition:'retail_unspecified',
 identity:{method:'reviewed_catalog_identity'},catalogIdentity:{method:'reviewed_catalog_identity',scope:'catalogue_product_only',sealVerified:false},
 status:'quoted',inStock:true,currency:'CNY',shippingKnown:true,unitCNY:1120,shippingCNY:0,landedCNY:1120,price:1120,
 url:'https://www.alter-shanghai.cn/m/spotPage/298.html',canonicalUrl:'https://www.alter-shanghai.cn/m/spotPage/298.html',checkedAt:new Date(now).toISOString()};
 return {now,offer,item:{...target,procurementTarget:{...target},procurementSource:{status:'incomplete',samples:[],purchasableOffers:[offer]}}};
}

test('purchasable offers reject semantic drift, missing compact binding and explicit cleared observations',()=>{
 const {now,offer,item}=currentOfferFixture();
 assert.equal(visiblePurchasableOffers(item,now).length,1);
 for(const changed of [{description:'空箱のみ。本体なし'},{condition:'中古'},{sourceDetail:{description:''}},{sourceDetail:{condition:null}},{yahoo:{ownDescription:'衣服だけ'}},{yahoo:{ownCondition:{name:'中古'}}},{procurementTarget:undefined},{procurementTarget:{...item.procurementTarget,description:'空箱のみ'}}])assert.equal(visiblePurchasableOffers({...item,...changed},now).length,0,JSON.stringify(changed));
 const compact={...item};delete compact.description;delete compact.condition;
 assert.equal(visiblePurchasableOffers(compact,now).length,1);
 const withoutDescription={...offer,target:{...offer.target}};delete withoutDescription.target.description;
 assert.equal(visiblePurchasableOffers({...compact,procurementSource:{purchasableOffers:[withoutDescription]}},now).length,0);
 const condition={name:'未使用',key:'new'},serialized=JSON.stringify({key:'new',name:'未使用'});
 assert.equal(visiblePurchasableOffers({...compact,sourceDetail:{condition},procurementTarget:{...compact.procurementTarget,condition:serialized},procurementSource:{purchasableOffers:[{...offer,target:{...offer.target,condition:serialized}}]}},now).length,1);
});

test('rejecting a purchasable offer removes only that source and preserves actual cost, adopted samples and undo',()=>{
 const {now,offer,item}=currentOfferFixture(),other={...offer,id:'other',canonicalUrl:'https://detail.youzan.com/show/goods?alias=other',url:'https://detail.youzan.com/show/goods?alias=other'};
 const live={...item,averageCNY:99,referenceProvider:'xianyu',costSource:'manual',manualCost:{purchaseCNY:80,manualFeeCNY:4,shippingJPY:500},procurementSource:{...item.procurementSource,samples:[{id:'valid-sample',price:99}],purchasableOffers:[offer,other]}};
 const record={accountId:item.accountId,itemId:item.id,platform:'procurement',candidateId:offer.canonicalUrl,candidateUrl:offer.canonicalUrl,updatedAt:new Date(now).toISOString()};
 const saved={[correctionKey(record)]:record},corrected=invalidateCorrectedMatches(live,saved);
 assert.equal(candidateId('procurement',offer),offer.canonicalUrl);
 assert.deepEqual(corrected.procurementSource.purchasableOffers,[other]);assert.deepEqual(corrected.procurementSource.samples,live.procurementSource.samples);
 assert.equal(corrected.averageCNY,99);assert.equal(corrected.referenceProvider,'xianyu');assert.equal(corrected.costSource,'manual');assert.deepEqual(corrected.manualCost,live.manualCost);
 assert.equal(invalidateCorrectedMatches({...live,accountId:'other'},saved).procurementSource.purchasableOffers.length,2);
 assert.equal(invalidateCorrectedMatches(live,{[correctionKey(record)]:{...record,deleted:true}}).procurementSource.purchasableOffers.length,2);
 for(const oldId of ['298','AL20744',offer.canonicalUrl])assert.ok(rejectedByMemory({old:{...record,candidateId:oldId,candidateUrl:undefined}},item,'procurement',offer));
 assert.equal(rejectedByMemory({wrong:{...record,candidateId:'298',candidateUrl:'https://different.example/298'}},item,'procurement',offer),undefined);
});
