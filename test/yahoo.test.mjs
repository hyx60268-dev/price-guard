import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCategoryIds,extractItemData,extractNextData,extractRecommendationCards,marketPriceDecision,queryFor } from '../scripts/lib/yahoo.mjs';

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
    categoryIds:[2511,2119,2134],source:'recommendation',recommendationType:'vector',recommendationScore:0.9566
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
  const result=marketPriceDecision(3000,[9800,10000,10200],{yahooUnderpriceRatio:.7,yahooUnderpriceMinimumGapJPY:1500});
  assert.equal(result.underpriced,true);
  assert.equal(result.marketMedianPrice,10000);
  assert.equal(result.recommendedPrice,9799);
  assert.equal(marketPriceDecision(9000,[9800,10000],{}).underpriced,false);
});
