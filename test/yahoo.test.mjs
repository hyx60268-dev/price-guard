import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCategoryIds,extractItemData,extractNextData,extractRecommendationCards,marketPriceDecision,queryFor,unresolvedRaiseCandidates } from '../scripts/lib/yahoo.mjs';

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
  const cards=[{id:'sold',price:17000},{id:'same',price:17999},{id:'error',price:17800},{id:'unchecked',price:18000}];
  const result=unresolvedRaiseCandidates(cards,[
    {id:'sold',reason:'not_open'},
    {id:'same',reason:'condition_or_packaging_mismatch'},
    {id:'error',reason:'detail_error'}
  ]);
  assert.deepEqual(result.map(item=>item.id),['error','unchecked']);
});
