import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCost,advice,coherentPrices,conditionCompatible,distinctiveCoverage,hasExplicitDefect,hasVariantMismatch,isLikelyVariantOffer,listingTextEquivalent,productFamily,semanticQuantity,semanticSameItem,titleScore } from '../scripts/lib/rules.mjs';
import { encrypt,decrypt } from '../scripts/lib/crypto.mjs';
const settings={exchangeRate:22.99,costMultiplier:1.05};
test('manual cost formula',()=>assert.equal(calculateCost(90.5,30,210,settings),3130));
test('cost stays blank until all manual values exist',()=>{
  assert.equal(calculateCost(90.5,null,210,settings),null);
  assert.equal(calculateCost(90.5,30,undefined,settings),null);
});
test('profit warning',()=>assert.equal(advice({ownPrice:4099,recommendedPrice:4099,cost:3130,warning:1500}),'不建议按推荐价出售'));
test('title similarity',()=>assert.ok(titleScore('鬼灭之刃 时透无一郎 亚克力立牌','鬼灭之刃 新绎 时透无一郎 亚克力立牌')>.7));
test('identical title and description can verify a product despite a different first photo',()=>{
  const title='鬼滅の刃 中国限定 新繹シリーズ 不死川実弥 アクリルスタンド';
  const description='中国限定で販売された不死川実弥のアクリルスタンドです。新品未使用です。';
  assert.equal(listingTextEquivalent(title,description,title,description),true);
  assert.equal(listingTextEquivalent(title,'正規品の未開封商品です',title,'正規品の未開封商品です'),true);
  assert.equal(listingTextEquivalent(title,description,title.replace('不死川実弥','冨岡義勇'),description.replace('不死川実弥','冨岡義勇')),false);
});
test('rejects extra set or version markers',()=>{
  assert.equal(hasVariantMismatch('時透無一郎 アクリルスタンド','時透無一郎 アクリルスタンド 2点セット'),true);
  assert.equal(hasVariantMismatch('時透無一郎 アクリルスタンド','時透無一郎 アクリルスタンド Bタイプ'),true);
  assert.equal(hasVariantMismatch('bilibili 鬼滅の刃 アクリルスタンド A','bilibili 鬼滅の刃 アクリルスタンド B'),true);
  assert.equal(hasVariantMismatch('全8種 セット','全8種 セット'),false);
});
test('treats pair and two-piece one-set wording as the same quantity',()=>{
  const own='雪肌精×モンチッチ ペアぬいぐるみ セット 限定';
  const competitor='日本非売品 雪肌精×モンチッチ キーホルダー 2点 1セット';
  assert.equal(semanticQuantity(own),2);
  assert.equal(semanticQuantity(competitor),2);
  assert.equal(hasVariantMismatch(own,competitor),false);
});
test('matches the Monchhichi pair by distinctive names, quantity, and plush category',()=>{
  const own='雪肌精×モンチッチ ペアぬいぐるみ セット 限定';
  const competitor='日本非売品 雪肌精×モンチッチ キーホルダー 2点 1セット';
  assert.deepEqual(distinctiveCoverage(own,competitor).tokens,['雪肌精','モンチッチ']);
  assert.equal(semanticSameItem({query:own,candidate:competitor,queryCategory:'ぬいぐるみ 2134',candidateCategory:'ぬいぐるみ 2134'}).accepted,true);
  assert.equal(semanticSameItem({query:own,candidate:'日本非売品 雪肌精×モンチッチ Girl 1点',queryCategory:'ぬいぐるみ 2134',candidateCategory:'ぬいぐるみ 2134'}).accepted,false);
  assert.equal(semanticSameItem({query:own,candidate:'雪肌精×モンチッチ 限定コラボ ぬいぐるみ ブルー',queryCategory:'ぬいぐるみ 2134',candidateCategory:'ぬいぐるみ 2134'}).accepted,false);
});
test('rejects actual defects but not generic overseas-product disclaimers',()=>{
  assert.equal(hasExplicitDefect('通常品','箱に大きな破損があります。'),true);
  assert.equal(hasExplicitDefect('通常品','海外製品のため、外箱の凹み等がある場合がございます。'),false);
  assert.equal(hasExplicitDefect('【訳あり】商品',''),true);
});
test('requires the same physical product family',()=>{
  assert.equal(productFamily('不死川実弥 アクリルスタンド'),'acrylic_stand');
  assert.equal(productFamily('不死川実弥 レーザーチケット'),'ticket');
  assert.equal(productFamily('ディアボロ シールウエハース'),'sticker');
  assert.equal(semanticSameItem({query:'不死川実弥 アクリルスタンド',candidate:'不死川実弥 レーザーチケット'}).accepted,false);
});
test('new sealed full products reject opened, no-box, and box-only listings',()=>{
  assert.equal(conditionCompatible('新品未開封 フィギュア','開封品 展示していました'),false);
  assert.equal(conditionCompatible('新品、未使用 箱あり','中古 本体のみ 箱なし'),false);
  assert.equal(conditionCompatible('新品未開封 MASTERLISE フィギュア','MASTERLISE 外箱のみ'),false);
  assert.equal(conditionCompatible('新品未開封 フィギュア','新品未開封 フィギュア'),true);
});
test('rejects xianyu multi-variant bait but allows a whole-set query',()=>{
  assert.equal(isLikelyVariantOffer('全系列多款可选，标价为最低款价格','角色A 徽章'),true);
  assert.equal(isLikelyVariantOffer('全系列展示，整套出售','全套 8个 徽章'),false);
  assert.equal(isLikelyVariantOffer('下单后联系客服改价','角色A 徽章'),true);
});
test('drops isolated low-price bait from a coherent cluster',()=>{
  assert.deepEqual(coherentPrices([{price:3},{price:28},{price:30}]).map(x=>x.price),[28,30]);
  assert.deepEqual(coherentPrices([{price:3}]),[]);
});
test('encryption roundtrip',()=>{const b=Buffer.from('价格守卫');assert.equal(decrypt(encrypt(b,'12345678'),'12345678').toString(),b.toString())});
