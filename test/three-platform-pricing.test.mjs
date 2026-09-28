import { nextRakumaSearchPage } from '../scripts/lib/rakuma.mjs';
import { collectibleIdentityRequiresVisualProof,hasExplicitVariantMismatch } from '../scripts/lib/rules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { pricingDecision,PRICING_RULES_VERSION } from '../public/pricing-policy.js';
import { compactDashboardResult } from '../scripts/lib/publish.mjs';
import { yahooCompare } from '../scripts/lib/yahoo.mjs';
import { mercariCompare } from '../scripts/lib/mercari.mjs';
import { readMercariCards,readMercariDetail } from '../scripts/lib/mercari-page.mjs';
test('merchant discovery retains overseas unpriced links but pricing never treats USD or missing prices as JPY',()=>{
 const dom=new JSDOM('<main><a href="/item/m123"><img alt="中国限定 手办の画像">US$180.09</a><a href="/item/m124"><img alt="海外限定 玩具の画像"></a></main>');
 try{
  assert.equal(readMercariCards(dom.window.document).cards.length,0);
  const cards=readMercariCards(dom.window.document,{includeUnpriced:true}).cards;
  assert.equal(cards.length,2);assert.ok(cards.every(c=>c.price===null));
  assert.deepEqual(cards.map(c=>c.id),['m123','m124']);
 }finally{dom.window.close()}
});
import { acceptMatchCorrections } from '../scripts/lib/match-corrections.mjs';
import { invalidateCorrectedMatches } from '../public/match-memory.js';

const fixture=JSON.parse(await fs.readFile(new URL('./fixtures/lappland-price-regression.json',import.meta.url)));
test('Myethos Japanese brand alias is not an omitted figure variant',()=>{
 const a='新品未開封 Myethos アークナイツ 1/7 荒蕪ラップランド フィギュア 正規品';
 const b='荒蕪ラップランド 1/7 フィギュア Myethos アークナイツ ミートス';
 assert.equal(collectibleIdentityRequiresVisualProof(a,b),false);
 assert.equal(hasExplicitVariantMismatch(a,b),false);
 assert.equal(hasExplicitVariantMismatch(a,b.replace('荒蕪ラップランド','スルト')),true);
});
const now=Date.now(),source=(candidates=[])=>({status:'ok',rulesVersion:PRICING_RULES_VERSION,checkedAt:new Date(now).toISOString(),candidates});
const candidate=(price,id='seller')=>({price,id,sellerId:id,url:'https://example.test/'+id,matchMethod:'verified'});
const snapshot=()=>({id:fixture.own.id,accountId:'melon',title:fixture.own.title,ownPrice:26989,recommendedPrice:29799,yahoo:source(fixture.competitors.map(c=>({...c,matchMethod:'verified'}))),rakuma:source(),mercari:source()});
const fp={dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[100,100,100],colorGrid:Array(768).fill(100)};
for(const accountId of ['melon','momo','new-shop'])test(`${accountId}: screenshot regression accepts 26990 and never suggests 29799`,async()=>{
 const item={...fixture.own,accountId,ownPrice:26989,image:'own-image'};
 const details=[fixture.own,...fixture.competitors].map(c=>({...c,status:'OPEN',seller:{id:c.sellerId||'owner'},images:['image']}));
 const result=await yahooCompare(null,item,{forceYahooBroadSearch:true},{
  fetchYahooItemBundle:async id=>({detail:details.find(c=>c.id===id),recommendations:[]}),
  fetchYahooResult:async()=>({items:fixture.competitors.map(c=>({...c,itemStatus:'OPEN',image:'image'}))}),imageFingerprints:async()=>fp
 });
 assert.equal(result.candidates[0].price,26990);assert.equal(result.recommendedPrice,26989);
 const decision=pricingDecision({...snapshot(),accountId,yahoo:result});assert.equal(decision.complete,true);assert.equal(decision.recommendedPrice,26989);
});
test('single shared policy chooses the actual verified lowest of all three platforms',()=>{
 const item=snapshot();item.rakuma=source([candidate(26000,'r')]);item.mercari=source([candidate(25000,'m')]);
 const d=pricingDecision(item,{now});assert.equal(d.lowest.platform,'mercari');assert.equal(d.recommendedPrice,24999);
});
test('old rules, stale evidence, errors, missing platforms and pending low offers cannot recommend a price change',()=>{
 for(const change of [{rulesVersion:19},{checkedAt:new Date(now-7*3600000).toISOString()},{status:'error'},{status:'deferred_limit'},{status:'incomplete'},{status:'cached',cacheReason:'request_error'},{status:'cached',evidenceStatus:'incomplete'}]){
  const item=snapshot();item.mercari={...source(),...change};const d=pricingDecision(item,{now});assert.equal(d.complete,false);assert.equal(d.recommendedPrice,26989);
 }
 const item=snapshot();delete item.mercari;assert.equal(pricingDecision(item,{now}).complete,false);
});
test('raise requires independent sellers and a guard below higher accepted prices prevents an unsafe increase',()=>{
 const item=snapshot();item.yahoo=source([candidate(29800,'same'),candidate(30000,'same')]);assert.equal(pricingDecision(item,{now}).recommendedPrice,26989);
 const missing=snapshot();missing.yahoo=source([candidate(29800,'a'),candidate(30000,'b')].map(({sellerId,...row})=>row));assert.equal(pricingDecision(missing,{now}).recommendedPrice,26989);
 item.yahoo.candidates[1].sellerId='other';assert.equal(pricingDecision(item,{now}).recommendedPrice,29799);
 item.yahoo.raiseGuardMinPrice=26990;assert.equal(pricingDecision(item,{now}).recommendedPrice,26989);
 const compact=pricingDecision(compactDashboardResult({items:[item]}).items[0],{now});assert.equal(compact.recommendedPrice,26989);assert.equal(compact.lowest.sellerId,'same');assert.equal(compact.complete,true);
});
test('Mercari correction is account scoped, accepted by sync and immediately disables old advice',()=>{
 const item=snapshot();item.mercari=source([candidate(25000,'m')]);
 const records=acceptMatchCorrections({},{one:{accountId:'melon',itemId:item.id,platform:'mercari',candidateId:'m',updatedAt:new Date(now).toISOString()}},[item],new Set(['melon']),now);
 assert.equal(pricingDecision(invalidateCorrectedMatches(item,records),{now}).complete,false);
 assert.equal(pricingDecision(invalidateCorrectedMatches({...item,accountId:'other'},records),{now}).complete,true);
});
test('Mercari target DOM excludes cheap related cards and exposes shipping uncertainty',()=>{
 const dom=new JSDOM(`<main><article><h1>新品 Myethos ラップランド</h1><div>¥26,422</div><p>+ 送料 ¥430~1,690</p><button>購入手続きへ</button><h2>商品の説明</h2><div>新品 1/7 フィギュア</div><h3>商品の状態</h3><div>新品、未使用</div><h3>送料</h3><div>¥430~1,690</div><a href="/shops/profile/shop">店</a><h2>このショップの商品</h2><a href="/shops/product/unrelated">¥100</a></article></main>`);
 try{const detail=readMercariDetail(dom.window.document);assert.equal(detail.price,26422);assert.equal(detail.shippingKnown,false);assert.equal(detail.status,'OPEN');assert.equal(detail.description,'新品 1/7 フィギュア')}finally{dom.window.close()}
});
test('Mercari search includes Shops and regular listings with independent card prices',()=>{
 const dom=new JSDOM('<main><a href="/shops/product/abc"><img alt="Myethos フィギュアの画像 26,422円">¥26,422</a><a href="/item/m123"><img alt="Myethos フィギュアの画像 26,999円">¥26,999</a></main>');
 try{assert.deepEqual(readMercariCards(dom.window.document).cards.map(c=>c.price),[26422,26999])}finally{dom.window.close()}
});
test('Mercari verification uses actual target details, delivered price and fails closed on unknown shipping or pagination',async()=>{
 const own={...fixture.own,ownPrice:26989,image:'image'},c=fixture.competitors[0];
 const detail={...c,itemPrice:25000,shippingJPY:1000,shippingKnown:true,status:'OPEN',images:['image']};
 const deps={search:async()=>({cards:[{...c,itemStatus:'OPEN'}]}),detail:async()=>({...detail}),imageFingerprints:async()=>fp};
 const result=await mercariCompare(null,own,{},deps);assert.equal(result.lowestPrice,26000);assert.equal(result.status,'ok');
 detail.shippingKnown=false;const blocked=await mercariCompare(null,own,{},deps);assert.equal(blocked.status,'incomplete');assert.equal(blocked.candidates.length,0);
 detail.shippingKnown=true;deps.search=async()=>({cards:[{...c,itemStatus:'OPEN'}],hasMore:true});assert.equal((await mercariCompare(null,own,{},deps)).status,'incomplete');
});

test('Mercari nested heading wrappers retain target description and included shipping',()=>{
 const dom=new JSDOM('<main><article><h1>フィギュア</h1><div>¥27,000</div><button>購入手続きへ</button><div><div><div><h2>商品の説明</h2></div></div><div><p data-testid="description">未開封新品 Myethos</p></div></div><div><div><div><h3>配送料の負担</h3></div></div><div><span data-testid="配送料の負担">送料込み(出品者負担)</span></div></div></article></main>');
 try{const d=readMercariDetail(dom.window.document);assert.equal(d.description,'未開封新品 Myethos');assert.equal(d.shippingJPY,0);assert.equal(d.status,'OPEN')}finally{dom.window.close()}
});

test('Rakuma cannot silently truncate later search pages',()=>{
 const url='https://fril.jp/s?query=Myethos&transaction=selling&sort=sell_price&order=asc';
 const page=p=>url+'&page='+p;
 assert.equal(nextRakumaSearchPage('<a href="'+page(4)+'">last</a><a href="'+page(2)+'">2</a>',url),page(2));
 assert.equal(nextRakumaSearchPage('<a href="https://evil.test/s?page=2">next</a>',url),null);
});

test('Mercari responsive DOM may place price before the product h1',()=>{
 const dom=new JSDOM('<main><article><div data-testid="price"><span>¥</span><span>27,000</span></div><h1>Myethos フィギュア</h1><button>購入手続きへ</button><h2>商品の説明</h2><p>未開封新品</p><h3>配送料の負担</h3><div>送料込み(出品者負担)</div></article></main>');
 try{assert.equal(readMercariDetail(dom.window.document).price,27000)}finally{dom.window.close()}
});

test('overseas Mercari price must use original JPY and exclude USD and exchange-rate timestamps',()=>{
 const dom=new JSDOM('<main><article><h1>Myethos フィギュア</h1><div>US$180.09</div><div data-testid="converted-currency-section"><p>(</p><p>¥</p><p>27,000</p><p> 為替レート更新日時 9月27日 02:10 UTC</p><p>)</p></div><button>購入手続きへ</button><h2>商品の説明</h2><div>新品 未開封</div></article></main>');
 try{assert.equal(readMercariDetail(dom.window.document).price,27000);dom.window.document.querySelector('[data-testid="converted-currency-section"]').remove();assert.equal(readMercariDetail(dom.window.document).price,null)}finally{dom.window.close()}
});

test('Mercari public product metadata is bound to the exact target and JPY currency',()=>{
 const url='https://jp.mercari.com/item/m41780895426';
 const dom=new JSDOM(`<head><link rel="canonical" href="${url}"><meta name="product:price:currency" content="JPY"><meta name="product:price:amount" content="27000"></head><main><article><h1>Myethos フィギュア</h1><button>購入手続きへ</button><h2>商品の説明</h2><p>未開封</p></article></main>`,{url});
 try{const d=dom.window.document;assert.equal(readMercariDetail(d).price,27000);assert.equal(readMercariDetail(d).shippingKnown,false);d.querySelector('meta[name="product:price:currency"]').content='USD';assert.equal(readMercariDetail(d).price,null);d.querySelector('meta[name="product:price:currency"]').content='JPY';d.querySelector('link').href='https://jp.mercari.com/item/m999';assert.equal(readMercariDetail(d).price,null)}finally{dom.window.close()}
});

test('Mercari dedicated condition field is used even when seller prose omits it',async()=>{
 const own={...fixture.own,ownPrice:26989,image:'image'},c=fixture.competitors[0];
 const title=c.title.replace(/新品|未開封/g,'');
 const detail={...c,title,description:'Myethos アークナイツ 1/7 荒蕪ラップランド フィギュア',condition:'新品、未使用',itemPrice:25000,shippingJPY:0,shippingKnown:true,status:'OPEN',images:['image']};
 const deps={search:async()=>({cards:[{...c,title,itemStatus:'OPEN'}]}),detail:async()=>({...detail}),imageFingerprints:async()=>fp};
 const result=await mercariCompare(null,own,{},deps);assert.equal(result.lowestPrice,25000);
 detail.condition='傷や汚れあり';assert.equal((await mercariCompare(null,own,{},deps)).candidates.length,0);
});
