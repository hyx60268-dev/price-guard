import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCost,advice,coherentPrices,conditionCompatible,distinctiveCoverage,hasExplicitDefect,hasExplicitVariantMismatch,hasIdentityVariantMismatch,hasVariantMismatch,isLikelyVariantOffer,listingSpecificationEquivalent,listingTextEquivalent,productFamily,semanticQuantity,semanticSameItem,titleScore,visualListingEquivalent } from '../scripts/lib/rules.mjs';
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

test('same branded box accepts piece-versus-figure quantity wording',()=>{
  assert.equal(listingSpecificationEquivalent('POPMART正規品 NARUTO暁フィギュア 1BOX 10ピース入り','POPMART NARUTO 暁 フィギュア 1BOX 10体セット 新品未開封'),true);
  assert.equal(listingSpecificationEquivalent('POPMART NARUTO 暁 フィギュア 1BOX 10体セット','POPMART NARUTO 暁 フィギュア 1BOX 8体セット'),false);
});
test('rejects extra set or version markers',()=>{
  assert.equal(hasVariantMismatch('時透無一郎 アクリルスタンド','時透無一郎 アクリルスタンド 2点セット'),true);
  assert.equal(hasVariantMismatch('時透無一郎 アクリルスタンド','時透無一郎 アクリルスタンド Bタイプ'),true);
  assert.equal(hasVariantMismatch('bilibili 鬼滅の刃 アクリルスタンド A','bilibili 鬼滅の刃 アクリルスタンド B'),true);
  assert.equal(hasVariantMismatch('全8種 セット','全8種 セット'),false);
});
test('same primary product with a bonus card remains a competitor',()=>{
  const own='鳴潮 薪火シリーズ 長離「振り返れば傘の向こうにVer.」 1/7スケール フィギュア 正規品';
  const competitor='新品未開封 鳴潮 Metheus Series 長離 1/7スケール フィギュア 特典カード付き';
  assert.equal(hasVariantMismatch(own,competitor),false);
  assert.equal(visualListingEquivalent({query:own,candidate:competitor,imageScore:.887}),true);
});
test('same-looking image cannot override pair, version, or product-family conflicts',()=>{
  assert.equal(visualListingEquivalent({query:'雪肌精×モンチッチ ペアぬいぐるみ',candidate:'雪肌精×モンチッチ 単品ぬいぐるみ',imageScore:.99}),false);
  assert.equal(visualListingEquivalent({query:'鳴潮 長離 フィギュア Aタイプ',candidate:'鳴潮 長離 フィギュア Bタイプ',imageScore:.99}),false);
  assert.equal(visualListingEquivalent({query:'鳴潮 長離 フィギュア',candidate:'鳴潮 長離 アクリルスタンド',imageScore:.99}),false);
});
test('rejects the three reported collectible variant false positives',()=>{
  const lastOne='一番くじ NARUTO-ナルト- 疾風伝 風影奪還編 ラストワン賞 デイダラ MASTERLISE フィギュア';
  const prizeA='NARUTO-ナルト- 疾風伝 デイダラ A賞 フィギュア';
  assert.equal(hasIdentityVariantMismatch(lastOne,prizeA),true);
  assert.equal(semanticSameItem({query:lastOne,candidate:prizeA}).accepted,false);
  assert.equal(visualListingEquivalent({query:lastOne,candidate:prizeA,imageScore:.99}),false);

  const hierophant='Re:ゼロから始める異世界生活 ガーフィール タロットカード V 教皇 The Hierophant 中国限定';
  const judgement='Re:ゼロから始める異世界生活 フェルト タロットカード XX 審判 Judgement 中国限定';
  assert.equal(hasIdentityVariantMismatch(hierophant,judgement),true);
  assert.equal(listingSpecificationEquivalent(hierophant,judgement),false);
  assert.equal(hasIdentityVariantMismatch('月のシリーズ アクリルスタンド','星のシリーズ アクリルスタンド'),false);

  const shaker='ゼンレスゾーンゼロ 流砂 アクリルスタンド 南宮羽 妄想エンジェル';
  const popup='ゼンレスゾーンゼロ 妄想エンジェル POPUP限定 南宮羽 アクリルスタンド';
  assert.equal(productFamily(shaker),'acrylic_shaker');
  assert.equal(productFamily(popup),'acrylic_stand');
  assert.equal(semanticSameItem({query:shaker,candidate:popup}).accepted,false);
});
test('an omitted quantity may reach visual verification but an explicit single cannot',()=>{
  const pair='雪肌精×モンチッチ ペアぬいぐるみ セット';
  assert.equal(hasVariantMismatch(pair,'雪肌精×モンチッチ 限定ぬいぐるみ'),true);
  assert.equal(hasExplicitVariantMismatch(pair,'雪肌精×モンチッチ 限定ぬいぐるみ'),false);
  assert.equal(visualListingEquivalent({query:pair,candidate:'雪肌精×モンチッチ 限定ぬいぐるみ',imageScore:.95}),true);
  assert.equal(visualListingEquivalent({query:pair,candidate:'雪肌精×モンチッチ 単品ぬいぐるみ',imageScore:.95}),false);
});
test('treats pair and two-piece one-set wording as the same quantity',()=>{
  const own='雪肌精×モンチッチ ペアぬいぐるみ セット 限定';
  const competitor='日本非売品 雪肌精×モンチッチ キーホルダー 2点 1セット';
  assert.equal(semanticQuantity(own),2);
  assert.equal(semanticQuantity(competitor),2);
  assert.equal(hasVariantMismatch(own,competitor),false);
});
test('reads character-count wording from a full Yahoo description',()=>{
  assert.equal(semanticQuantity('ホワイトとグレー、2キャラクター仕様のぬいぐるみマスコットです。'),2);
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
  assert.equal(conditionCompatible('未使用品です','新品・未開封品（OPP袋入り）'),true);
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
