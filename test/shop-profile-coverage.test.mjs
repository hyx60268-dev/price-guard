import test from 'node:test';
import assert from 'node:assert/strict';
import { parseShopProfile } from '../public/shop-profile.js';
import { mergeAccountConfigs } from '../scripts/lib/state.mjs';
import { cachedComparison,comparisonIncomplete,pricingCoverage } from '../scripts/lib/pricing-coverage.mjs';
import { fairPriorityRoundRobin } from '../scripts/lib/planner.mjs';
import { MATCHING_RULES_VERSION } from '../scripts/lib/rules.mjs';
import { discoverRakumaProfile,extractRakumaDetail,extractRakumaSearchCards } from '../scripts/lib/rakuma.mjs';
import { yahooCompare,marketPriceDecision } from '../scripts/lib/yahoo.mjs';

test('shop URL normalization is shared, platform-aware and restricted to genuine profile hosts',()=>{
  const yahoo=parseShopProfile('https://paypayfleamarket.yahoo.co.jp/user/p123/?share=1');
  const rakuma=parseShopProfile('https://fril.jp/shop/abc123/?share=1');
  assert.equal(yahoo.id,'account-p123');assert.equal(rakuma.id,'account-rakuma-abc123');
  assert.equal(rakuma.profileUrl,'https://fril.jp/shop/abc123');
  for(const url of ['http://fril.jp/shop/a','https://fril.jp.evil.test/shop/a','https://item.fril.jp/abc','https://user:pass@fril.jp/shop/abc'])assert.equal(parseShopProfile(url),null);
  const accounts=mergeAccountConfigs([{id:'y',profileUrl:yahoo.profileUrl}],[{id:'r',profileUrl:rakuma.profileUrl},{id:'r2',profileUrl:rakuma.profileUrl+'/'}]);
  assert.deepEqual(accounts.map(a=>a.platform),['yahoo_fleamarket','rakuma']);
});

const cached={rulesVersion:MATCHING_RULES_VERSION,status:'incomplete',checkedAt:new Date().toISOString()};
test('caching cannot turn incomplete/error evidence into successful coverage',()=>{
  assert.equal(comparisonIncomplete(cachedComparison(cached)),true);
  assert.equal(cachedComparison({...cached,status:'error'}),null);
  assert.equal(comparisonIncomplete(cachedComparison({...cached,status:'cached',evidenceStatus:'ok',cacheReason:'request_error'})),true);
  assert.equal(cachedComparison({...cached,rulesVersion:MATCHING_RULES_VERSION-1}),null);
  const coverage=pricingCoverage([{yahoo:cachedComparison(cached),rakuma:{...cached,status:'ok'}},{yahoo:{...cached,status:'ok'}}],[{profileStatus:'live'}]);
  assert.equal(coverage.complete,false);assert.equal(coverage.platforms.yahoo.incomplete,1);assert.equal(coverage.platforms.rakuma.remaining,1);
});
test('unreviewed large-shop inventory precedes already-refreshed small shops',()=>{
  const result=fairPriorityRoundRobin([[{id:'small-checked',priority:3}],[{id:'large-new',priority:2},{id:'large-new-2',priority:2}]]);
  assert.deepEqual(result.map(x=>x.id),['large-new','large-new-2','small-checked']);
});
const card=(id,price=1000,sold=false)=>`<a class="link_shop_image" href="https://item.fril.jp/${id}" data-rat-item_name="商品${id}" data-rat-itemid="123/99" data-rat-price="[${price}]"><img data-original="https://img.fril.jp/img/99/m/1.jpg">${sold?'<span class="sold-out">SOLD OUT</span>':''}</a>`;
test('Rakuma inventory follows every profile page, filters sold listings and deduplicates',async()=>{
  const urls=[];
  const result=await discoverRakumaProfile('https://fril.jp/shop/testshop',{}, {fetchHtml:async url=>{
    urls.push(url);return '<div class="item-list">'+(url.endsWith('/page/2')?card('bb')+card('cc',2000,true):card('aa')+card('bb')+'<link rel="next" href="/shop/testshop/page/2">')+'</div>';
  }});
  assert.equal(result.pages,2);assert.deepEqual(result.items.map(x=>x.id),['aa','bb']);
  assert.ok(result.items.every(x=>x.platform==='rakuma'&&x.ownPrice===1000));assert.equal(result.complete,true);
  assert.equal(urls[1],'https://fril.jp/shop/testshop/page/2');
  await assert.rejects(discoverRakumaProfile('https://fril.jp/shop/testshop',{}, {fetchHtml:async()=>'<html>challenge</html>'}),/不可读/);
});
test('Rakuma detail images never include another item from the recommendation rail',()=>{
  const html=`<script type="application/ld+json">${JSON.stringify({'@type':'Product',name:'商品',description:'新品',image:'https://img.fril.jp/img/11/l/1.jpg',offers:{price:1000,availability:'https://schema.org/InStock'}})}</script><img src="https://img.fril.jp/img/22/l/1.jpg"><img src="https://img.fril.jp/img/11/l/2.jpg">`;
  assert.deepEqual(extractRakumaDetail(html,'https://item.fril.jp/aa').images,['https://img.fril.jp/img/11/l/1.jpg','https://img.fril.jp/img/11/l/2.jpg']);
});
test('Rakuma own listings use supplied source details, never a Yahoo request with a Rakuma ID',async()=>{
  const result=await yahooCompare(null,{id:'aabbcc',platform:'rakuma',title:'ボトル ブルー 370ml',ownPrice:1000,sourceDetail:{description:'新品 未使用',images:[],category:'ボトル'}},{},{
    fetchYahooItemBundle:async()=>{assert.fail('must not fetch a Rakuma hash on Yahoo')},
    fetchYahooResult:async()=>({items:[]}),imageFingerprints:async()=>null
  });
  assert.equal(result.audit.ownDetailLoaded,true);assert.equal(result.sourceStatus.search,'ok');
});
test('19680 has a safe raise to the nearest verified 21400, not to a high median',()=>{
  const r=marketPriceDecision(19680,[21400,21500,21990,22480,22500]);
  assert.equal(r.underpriced,true);assert.equal(r.recommendedPrice,21399);
  assert.equal(marketPriceDecision(21399,[21400,21500,21990]).underpriced,false);
});
test('one detail-verified pair triggers a limited-sample opportunity; title-only evidence cannot',()=>{
  const sample={id:'pair',sellerId:'other',price:19999,url:'https://example.test/item/pair',matchMethod:'detail_type_quantity_equivalent_text'};
  assert.equal(marketPriceDecision(13899,[sample]).recommendedPrice,19998);
  assert.equal(marketPriceDecision(13899,[sample]).singleVerified,true);
  assert.equal(marketPriceDecision(13899,[{price:19999}]).underpriced,false);
  assert.equal(marketPriceDecision(13899,[sample],{},{plausibleCompetitors:[{price:13000}]}).underpriced,false);
});
