import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalSaleTitle,clusterSellerSales,containsDiscoveryKeyword,eligibleDiscoveryCard,groupDiscoveryCandidates,isOwnedDiscoverySource,isWithinDays,mercariDiscoverySearchUrl,mercariSoldEvidence,parseListingTime,rewriteListing,sameDiscoveryProduct,sameSaleProduct,sellerIdFromProfile,validDiscoveryXianyu,xianyuQueryFor,yahooDiscoverySearchUrl } from '../scripts/lib/discovery.mjs';

test('discovery URLs use the live sold and price filters',()=>{
  const mercari=new URL(mercariDiscoverySearchUrl({keyword:'中国限定',minPriceJPY:4999}));
  assert.equal(mercari.searchParams.get('status'),'sold_out|trading');
  assert.equal(mercari.searchParams.get('price_min'),'4999');
  assert.equal(mercari.searchParams.get('sort'),'created_time');
  assert.equal(mercari.searchParams.get('order'),'desc');

  const yahoo=new URL(yahooDiscoverySearchUrl({keyword:'中国限定',minPriceJPY:4999}));
  assert.equal(yahoo.searchParams.get('sold'),'1');
  assert.equal(yahoo.searchParams.get('minPrice'),'4999');
  assert.equal(yahoo.searchParams.get('sort'),'openTime');
  assert.equal(yahoo.searchParams.get('order'),'desc');
  assert.equal(yahoo.searchParams.has('open'),false);
});

test('same product clusters relists but not different quantities',()=>{
  assert.equal(sameSaleProduct({title:'中国限定 鬼滅の刃 新繹 アクスタ 時透無一郎 新品'},{title:'鬼滅の刃 新繹 アクリルスタンド 時透無一郎 中国限定'}),true);
  assert.equal(sameSaleProduct({title:'中国限定 ぬいぐるみ 1点'},{title:'中国限定 ぬいぐるみ 2点セット'}),false);
  const groups=clusterSellerSales([{title:'中国限定 ポケモン ピカチュウ ぬいぐるみ',price:8000},{title:'ポケモン 中国限定 ピカチュウ ぬいぐるみ',price:8200},{title:'中国限定 ポケモン ピカチュウ ぬいぐるみ 新品',price:8500}]);
  assert.equal(groups[0].items.length,3);
});

test('discovery deduplicates harmless seller wording but keeps variants separate',()=>{
  assert.equal(sameDiscoveryProduct({title:'即日発送 鬼滅の刃 中国限定 新繹シリーズ 不死川実弥 アクリルスタンド'},{title:'鬼滅の刃 新繹シリーズ 中国限定 アクリルスタンド 不死川実弥'}),true);
  assert.equal(sameDiscoveryProduct({title:'在庫複数 当日発送 鬼滅の刃 中国限定 新繹シリーズ 不死川実弥 アクリルスタンド'},{title:'鬼滅の刃 新繹シリーズ アクリルスタンド 不死川実弥'}),true);
  assert.equal(sameDiscoveryProduct({title:'中国限定 アクリルスタンド 不死川実弥'},{title:'中国限定 アクリルスタンド 冨岡義勇'}),false);
  assert.equal(sameDiscoveryProduct({title:'あんスタ 瀬名泉 ワイヤレスイヤホン LCD搭載 中国限定 bilibili'},{title:'あんスタ 朱桜司 ワイヤレスイヤホン LCD搭載 中国限定 bilibili'}),false);
  assert.equal(sameDiscoveryProduct({title:'MG ガンダムアストレイ クロスコントラストカラーズ 落桜白'},{title:'MG ガンダムアストレイ クロスコントラストカラーズ 朽木黒'}),false);
  assert.equal(sameDiscoveryProduct({title:'鬼滅の刃 中国限定 新繹シリーズ アクリルスタンド B 全8種 ランダム'},{title:'鬼滅の刃 中国限定 新繹シリーズ アクリルスタンド A 全8種 ランダム'}),false);
  assert.equal(sameDiscoveryProduct({title:'鬼滅の刃 中国限定 新繹シリーズ 冨岡義勇 アクリルスタンド'},{title:'鬼滅の刃 中国限定 新繹シリーズ 富岡義勇 アクリルスタンド'}),true);
  assert.equal(sameDiscoveryProduct({title:'雪肌精×モンチッチ ペアぬいぐるみ セット 限定'},{title:'日本非売品 雪肌精×モンチッチ キーホルダー 2点セット'}),true);
});

test('cross-platform candidate grouping compares actual group members',()=>{
  const candidates=[
    {sourceTitle:'ドラゴンボール VSオムニバス超 一番くじ ラストワン賞 究極神龍',sourcePlatform:'yahoo'},
    {sourceTitle:'中国限定 ドラゴンボール VSオムニバス超 一番くじ ラストワン賞 究極神龍',sourcePlatform:'mercari'},
    {sourceTitle:'MG ガンダムアストレイ クロスコントラストカラーズ 朽木黒',sourcePlatform:'yahoo'}
  ];
  const groups=groupDiscoveryCandidates(candidates);
  assert.equal(groups.length,2);
  assert.equal(groups[0].length,2);
  assert.equal(groups[1].length,1);
});

test('Mercari discovery verifies keyword and detail-page sold evidence',()=>{
  assert.equal(containsDiscoveryKeyword('鬼滅の刃 中国 限定 アクリルスタンド','中国限定'),true);
  assert.equal(containsDiscoveryKeyword('鬼滅の刃 中国限定 アクリルスタンド','中国限定'),true);
  assert.equal(mercariSoldEvidence({checkoutText:'売り切れました'}),true);
  assert.equal(mercariSoldEvidence({text:'※売り切れのためコメントできません'}),true);
  assert.equal(mercariSoldEvidence({checkoutText:'購入手続きへ',text:'販売中'}),false);
});

test('relative timestamps and rolling month are handled',()=>{
  const now=Date.parse('2026-09-13T03:00:00Z');
  assert.equal(parseListingTime('3時間前',now),'2026-09-13T00:00:00.000Z');
  assert.equal(isWithinDays('2026-08-15T03:00:00Z',30,now),true);
  assert.equal(isWithinDays('2026-08-13T02:59:59Z',30,now),false);
});

test('discovery enforces sold price date and valid xianyu images',()=>{
  const now=Date.parse('2026-09-13T03:00:00Z');
  assert.equal(eligibleDiscoveryCard({sold:true,price:4999,soldAt:'2026-09-12T03:00:00Z',title:'中国限定 商品'},{minPriceJPY:4999,windowDays:30},now),true);
  assert.equal(eligibleDiscoveryCard({sold:false,price:9000,soldAt:'2026-09-12T03:00:00Z',title:'中国限定 商品'},{minPriceJPY:4999,windowDays:30},now),false);
  assert.equal(validDiscoveryXianyu({status:'ok',query:'商品',averageCNY:28,samples:[{price:28,independentImages:['https://a/1','https://a/2','https://a/3']},{price:30}]}).ready,true);
  assert.equal(validDiscoveryXianyu({status:'ok',query:'商品',averageCNY:28,samples:[{price:28,independentImages:['https://a/1','https://a/2']},{price:30}]}).ready,false);
  assert.equal(validDiscoveryXianyu({status:'ok',query:'商品',averageCNY:3,samples:[{price:3,independentImages:['https://a/1']},{price:28}]}).ready,false);
});

test('queries are translated and proposed title stays within 40 characters',()=>{
  assert.match(xianyuQueryFor('鬼滅の刃 中国限定 時透無一郎 アクリルスタンド'),/鬼灭之刃/);
  const rewritten=rewriteListing({title:'【新品未使用】鬼滅の刃 中国限定 新繹シリーズ 時透無一郎 アクリルスタンド',description:'中国 上海限定',condition:'新品、未使用'});
  assert.ok(Array.from(rewritten.proposedTitle).length<=40);
  assert.match(rewritten.proposedDescription,/中国限定/);
  assert.equal(canonicalSaleTitle('【新品】 中国限定 商品 A'),'商品 A');
});

test('all configured Yahoo accounts and their items are excluded from discovery',()=>{
  assert.equal(sellerIdFromProfile('https://paypayfleamarket.yahoo.co.jp/user/p76217154'),'p76217154');
  const owned={sellerIds:new Set(['p76217154','pSECOND']),itemIds:new Set(['z111'])};
  assert.equal(isOwnedDiscoverySource({id:'z999',sellerId:'p76217154'},owned),true);
  assert.equal(isOwnedDiscoverySource({id:'z111',sellerId:'other'},owned),true);
  assert.equal(isOwnedDiscoverySource({id:'z999',sellerId:'other'},owned),false);
});
