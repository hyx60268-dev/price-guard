import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateEvidenceOrder,extractCategoryIds,extractItemData,extractNextData,extractRecommendationCards,marketPriceDecision,queryFor,unresolvedRaiseCandidates,visualRecallEligible } from '../scripts/lib/yahoo.mjs';

test('extractNextData accepts Yahoo nonce attribute',()=>{
  const value={props:{initialState:{searchState:{search:{result:{items:[]}}}}}};
  const html=`<html><script id="__NEXT_DATA__" type="application/json" nonce="">${JSON.stringify(value)}</script></html>`;
  assert.deepEqual(extractNextData(html),value);
});

test('extractNextData rejects a challenge page',()=>{
  assert.throws(()=>extractNextData('<html>challenge</html>'),/__NEXT_DATA__/);
});

test('extracts item detail and Yahoo item-page recommendation cards',()=>{
  const value={props:{initialState:{
    itemsState:{items:{item:{id:'z679697454',title:'日本非売品 雪肌精×モンチッチ キーホルダー 2点 1セット',status:'OPEN',price:13999}}},
    recommendsState:{recommends:{recommends:{fleamarket_web_itempage:{recommendItems:{items:[{
      itemId:'z679697454',title:'日本非売品 雪肌精×モンチッチ キーホルダー 2点 1セット',price:13999,
      image:{url:'https://example.invalid/item.jpg'},seller:{id:'p76631898'},genreCategoryIds:[2511,2119,2134],
      log:{rctype:'vector',rcsm:0.9566}
    }]}}}}}
  }}};
  assert.equal(extractItemData(value).status,'OPEN');
  assert.deepEqual(extractRecommendationCards(value)[0],{
    id:'z679697454',url:'https://paypayfleamarket.yahoo.co.jp/item/z679697454',
    title:'日本非売品 雪肌精×モンチッチ キーホルダー 2点 1セット',text:'日本非売品 雪肌精×モンチッチ キーホルダー 2点 1セット',
    image:'https://example.invalid/item.jpg',price:13999,sellerId:'p76631898',itemStatus:null,
    categoryIds:[2511,2119,2134],source:'recommendation',recommendationSection:'fleamarket_web_itempage',recommendationType:'vector',recommendationScore:0.9566
  });
});

test('extracts category ids from the current Yahoo search-card shape',()=>{
  assert.deepEqual(extractCategoryIds({category:{id:2134,productCategoryId:2133,path:[{id:1},{id:2511},{id:2119},{id:2134}]}}),[2134,2133,1,2511,2119]);
});

test('uses broad recall wording while preserving distinctive product terms',()=>{
  assert.equal(queryFor('【中国限定】雪肌精×モンチッチ ペアぬいぐるみ セット 新品'),'雪肌精 モンチッチ');
  assert.equal(queryFor('鬼滅の刃 中国限定 新繹シリーズ 時透無一郎 アクリルスタンド'),'鬼滅の刃 新繹シリーズ 時透無一郎');
  assert.equal(queryFor('中国限定 MG ガンダムアストレイ クロスコントラストカラーズ 朽木黒'),'MG ガンダムアストレイ クロスコントラストカラーズ 朽木黒');
  assert.equal(queryFor('POPMART正規品 NARUTO暁フィギュア 1BOX 10ピース入り'),'POPMART NARUTO暁');
});

test('warns and raises an abnormally low own price from verified market samples',()=>{
  const result=marketPriceDecision(8000,[9800,10000,10200],{yahooUnderpriceRatio:.82,yahooUnderpriceMinimumGapJPY:1500});
  assert.equal(result.underpriced,true);
  assert.equal(result.marketMedianPrice,10000);
  assert.equal(result.recommendedPrice,9799);
  assert.equal(marketPriceDecision(9000,[9800,10000],{}).underpriced,false);
});

test('raise-price advice needs a coherent market from independent sellers',()=>{
  assert.equal(marketPriceDecision(8000,[{id:'a',sellerId:'one',price:10000},{id:'b',sellerId:'one',price:10200}],{}).underpriced,false);
  assert.equal(marketPriceDecision(8000,[{id:'bait',sellerId:'one',price:2000},{id:'a',sellerId:'two',price:10000},{id:'b',sellerId:'three',price:10200}],{}).marketMedianPrice,10100);
  assert.equal(marketPriceDecision(8000,[7500,10000,10200],{}).underpriced,false);
  assert.equal(marketPriceDecision(8000,[{sellerId:'one',price:10000},{sellerId:'two',price:15000}],{}).underpriced,false);
});

test('never treats another listing from our own Yahoo shop as market competition',()=>{
  const result=marketPriceDecision(33449,[
    {id:'own-other-character',sellerId:'mine',price:11979},
    {id:'market-a',sellerId:'other-a',price:35000},
    {id:'market-b',sellerId:'other-b',price:35500}
  ],{},{ownSellerId:'mine',plausibleCompetitors:[
    {id:'own-other-character',sellerId:'mine',price:11979},
    {id:'market-a',sellerId:'other-a',price:35000}
  ]});
  assert.equal(result.verifiedMinPrice,35000);
  assert.equal(result.plausibleMinPrice,35000);
  assert.equal(result.ownIsDefiniteLowest,true);
});

test('a small gap to the nearest same item does not trigger a raise despite high listings',()=>{
  const result=marketPriceDecision(17499,[
    {id:'low',sellerId:'one',price:17999},
    {id:'high-a',sellerId:'two',price:21388},
    {id:'high-b',sellerId:'three',price:21400}
  ],{yahooUnderpriceRatio:.82,yahooUnderpriceMinimumGapJPY:1500},{plausibleCompetitors:[{price:17999},{price:21388},{price:21400}]});
  assert.equal(result.underpriced,false);
  assert.equal(result.ownIsDefiniteLowest,true);
  assert.equal(result.raiseGuardMinPrice,17999);
  assert.equal(result.raiseRoomJPY,500);
  assert.equal(result.recommendedPrice,17499);
});

test('a one-yen-higher competitor is market evidence but never a reason to raise',()=>{
  const result=marketPriceDecision(44499,[{id:'same-box',sellerId:'other',price:44500}],{},
    {plausibleCompetitors:[{id:'same-box',sellerId:'other',price:44500}]});
  assert.equal(result.marketMinPrice,44500);
  assert.equal(result.ownIsDefiniteLowest,true);
  assert.equal(result.raiseRoomJPY,1);
  assert.equal(result.underpriced,false);
  assert.equal(result.recommendedPrice,44499);
});

test('raise-price advice is blocked when any verified or unresolved plausible candidate is not above us',()=>{
  const verifiedLower=marketPriceDecision(17499,[17000,21388,21400],{});
  assert.equal(verifiedLower.underpriced,false);
  assert.equal(verifiedLower.ownIsDefiniteLowest,false);
  const unresolvedLower=marketPriceDecision(17499,[21388,21400],{},
    {plausibleCompetitors:[{price:17000},{price:21388},{price:21400}]});
  assert.equal(unresolvedLower.underpriced,false);
  assert.equal(unresolvedLower.recommendedPrice,17499);
});

test('an unchecked plausible same-item candidate caps a raise recommendation',()=>{
  const result=marketPriceDecision(15000,[21388,21400],{},
    {plausibleCompetitors:[{price:17999},{price:21388},{price:21400}]});
  assert.equal(result.underpriced,true);
  assert.equal(result.recommendedPrice,17998);
  assert.ok(result.recommendedPrice<result.raiseGuardMinPrice);
});

test('sold or definitively mismatched cards do not cap an in-stock raise decision',()=>{
  const cards=[{id:'sold',price:17000},{id:'same',price:17999},{id:'unit',price:17500},{id:'variant-image',price:17600},{id:'error',price:17800},{id:'unchecked',price:18000}];
  const result=unresolvedRaiseCandidates(cards,[
    {id:'sold',reason:'not_open'},
    {id:'same',reason:'condition_or_packaging_mismatch'},
    {id:'unit',reason:'sale_unit_mismatch'},
    {id:'variant-image',reason:'collectible_variant_image_unconfirmed'},
    {id:'error',reason:'detail_error'}
  ]);
  assert.deepEqual(result.map(item=>item.id),['error','unchecked']);
});

test('unconfirmed lottery series and image misses remain raise-price guards',()=>{
  const cards=[{id:'series',price:50999},{id:'image',price:52000},{id:'variant',price:53000}];
  const result=unresolvedRaiseCandidates(cards,[
    {id:'series',reason:'lottery_series_unconfirmed'},
    {id:'image',reason:'physical_image_unconfirmed'},
    {id:'variant',reason:'variant_mismatch'}
  ]);
  assert.deepEqual(result.map(item=>item.id),['series','image']);
});

test('live search cards beat stale recommendation cards at the same price',()=>{
  const cards=[
    {id:'sold-rec',price:9100,titleScore:1,fromRecommendation:true,sources:['recommendation']},
    {id:'live-search',price:9100,titleScore:1,fromRecommendation:true,sources:['search','recommendation']}
  ].sort(candidateEvidenceOrder);
  assert.equal(cards[0].id,'live-search');
});

test('a cheaper candidate is checked before a higher card that merely says new',()=>{
  const cards=[
    {id:'higher-new',price:9100,conditionPriority:0,titleScore:1,sources:['search']},
    {id:'lower-unknown',price:6980,conditionPriority:1,titleScore:1,sources:['recommendation']}
  ].sort(candidateEvidenceOrder);
  assert.equal(cards[0].id,'lower-unknown');
});

test('a cheaper lottery candidate is checked before a higher fully named release',()=>{
  const cards=[
    {id:'higher-confirmed',price:68200,lotterySeriesUnconfirmed:false,conditionPriority:0,titleScore:1,sources:['search']},
    {id:'lower-needs-detail',price:50999,lotterySeriesUnconfirmed:true,conditionPriority:1,titleScore:.8,sources:['recommendation']}
  ].sort(candidateEvidenceOrder);
  assert.equal(cards[0].id,'lower-needs-detail');
});

test('visual recall rescues a renamed recommendation but still blocks another variant',()=>{
  assert.equal(visualRecallEligible({
    query:'POP MART DIMOO WORLD × PIXAR シリーズ ぬいぐるみ ペンダント',
    candidate:'DIMOO WORLD PIXAR ぬいぐるみ ペンダント',
    queryCategory:'ぬいぐるみ',candidateCategory:'ぬいぐるみ',imageScore:.91
  }),true);
  assert.equal(visualRecallEligible({
    query:'鬼滅の刃 中国限定 アクリルスタンド 不死川実弥',
    candidate:'鬼滅の刃 中国限定 アクリルスタンド 冨岡義勇',
    queryCategory:'アクリルスタンド',candidateCategory:'アクリルスタンド',imageScore:.96
  }),false);
  assert.equal(visualRecallEligible({
    query:'POPMART NARUTO 暁 フィギュア 長門',
    candidate:'POPMART NARUTO 暁 フィギュア 長門',
    queryCategory:'フィギュア',candidateCategory:'フィギュア',imageScore:.70
  }),false);
});
