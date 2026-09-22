import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCost,advice,coherentPrices,conditionCompatible,distinctiveCoverage,exactIdentityTitleEquivalent,hasExplicitDefect,hasExplicitVariantMismatch,hasIdentityVariantMismatch,hasLotterySeriesMismatch,hasVariantMismatch,isLikelyVariantOffer,listingSpecificationEquivalent,listingTextEquivalent,lotterySeriesEquivalent,lotterySeriesNeedsVisualConfirmation,packagedAssortmentEquivalent,productFamily,saleUnitEquivalent,semanticQuantity,semanticSameItem,titleScore,visualListingEquivalent } from '../scripts/lib/rules.mjs';
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
test('exact product identity survives different listing photos and descriptions',()=>{
  assert.equal(exactIdentityTitleEquivalent(
    '新品未開封 Wabi Inspirations Axel Vervoordt 写真集',
    '新品 Wabi Inspirations Axel Vervoordt 写真集'),true);
  assert.equal(exactIdentityTitleEquivalent(
    '中国限定 鬼滅の刃 アクリルスタンド 不死川実弥',
    '中国限定 鬼滅の刃 アクリルスタンド 冨岡義勇'),false);
  assert.equal(exactIdentityTitleEquivalent(
    'FAN HO 何藩 ファン・ホー 香港三部作 写真集 森山大道',
    '何藩 写真集 ファン・ホー Fan Ho 香港三部作 森山大道 写真家',
    '写真集、グラフ誌','タレントグッズ'),true);
  assert.equal(exactIdentityTitleEquivalent(
    'DIMOO WORLD × PIXAR ぬいぐるみペンダント',
    'DIMOO in Space Crane フィギュア'),false);
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
test('matches the reported Pokemon outer BOX and 12 inner-box wording without weakening variants',()=>{
  const own='海外限定 ポケモン30周年 梦点睛 ピカチュウ フィギュア 1BOX';
  const competitor='ポケモン 絵夢点晴 ピカチュウフィギュア第4弾 12小箱セット 被りなし';
  assert.equal(semanticSameItem({query:own,candidate:competitor,queryCategory:'フィギュア',candidateCategory:'フィギュア'}).accepted,true);
  assert.equal(packagedAssortmentEquivalent({query:own,candidate:competitor,queryCategory:'フィギュア',candidateCategory:'フィギュア',imageScore:.6983}),true);
  assert.equal(packagedAssortmentEquivalent({query:own,candidate:competitor.replace('ピカチュウ','イーブイ'),queryCategory:'フィギュア',candidateCategory:'フィギュア',imageScore:.99}),false);
  assert.equal(hasIdentityVariantMismatch('ポケモン 絵夢点睛 ピカチュウ 第3弾 フィギュア','ポケモン 絵夢点晴 ピカチュウ 第4弾 フィギュア'),true);
  assert.equal(hasIdentityVariantMismatch('ポケモン20周年 ピカチュウ フィギュア','ポケモン30周年 ピカチュウ フィギュア'),true);
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
  assert.equal(hasIdentityVariantMismatch('月のシリーズ アクリルスタンド','星のシリーズ アクリルスタンド'),true);

  const shaker='ゼンレスゾーンゼロ 流砂 アクリルスタンド 南宮羽 妄想エンジェル';
  const popup='ゼンレスゾーンゼロ 妄想エンジェル POPUP限定 南宮羽 アクリルスタンド';
  assert.equal(productFamily(shaker),'acrylic_shaker');
  assert.equal(productFamily(popup),'acrylic_stand');
  assert.equal(semanticSameItem({query:shaker,candidate:popup}).accepted,false);
});
test('Ichiban Kuji release subtitles are product identity, not optional wording',()=>{
  const bonds='一番くじ NARUTO-ナルト- 疾風伝 忍ノ絆 A賞 うずまきナルト MASTERLISE';
  const rescue='一番くじ NARUTO-ナルト- 疾風伝 風影奪還編 A賞 うずまきナルト MASTERLISE';
  const generic='一番くじ NARUTO-ナルト- A賞 うずまきナルト フィギュア\n一番くじ NARUTO 疾風伝\nA賞 ナルト MASTERLISE';
  const same='一番くじ NARUTO A賞 うずまきナルト\n一番くじ NARUTO 疾風伝 忍ノ絆 A賞 ナルト MASTERLISE';
  assert.equal(hasLotterySeriesMismatch(bonds,rescue),true);
  assert.equal(hasIdentityVariantMismatch(bonds,rescue),true);
  assert.equal(semanticSameItem({query:bonds,candidate:rescue}).accepted,false);
  assert.equal(lotterySeriesNeedsVisualConfirmation(bonds,generic),true);
  assert.equal(lotterySeriesNeedsVisualConfirmation(bonds,same),false);
  assert.equal(lotterySeriesEquivalent(bonds,same),true);
  assert.equal(lotterySeriesEquivalent(bonds,rescue),false);
  assert.equal(lotterySeriesEquivalent(bonds,same.replace('うずまきナルト','うちはサスケ')),false);
  assert.equal(hasLotterySeriesMismatch('一番くじ 鬼滅の刃 無限列車編 A賞 煉獄杏寿郎','一番くじ 鬼滅の刃 刀鍛冶の里編 A賞 煉獄杏寿郎'),true);
});
test('rejects different characters, book titles, and named variants inside one series',()=>{
  const sukuna='中国限定 POP MART 呪術廻戦 両面宿儺 シーンブロック 正規品';
  const itadori='中国限定 POP MART 呪術廻戦 虎杖悠仁 シーンブロック 正規品';
  const street='Vivian Maier: Street Photographer 写真集 新品';
  const found='Vivian Maier A Photographer Found 写真集';
  const mute='POP MART SKULLPANDA Off Mode ぬいぐるみキーホルダー Mute Mode';
  const secret='POPMART SKULLPANDA Off Mode θ シークレット「My Channel」ぬいぐるみ';
  for(const [left,right] of [[sukuna,itadori],[street,found],[mute,secret]]){
    assert.equal(hasIdentityVariantMismatch(left,right),true);
    assert.equal(hasIdentityVariantMismatch(right,left),true);
    assert.equal(semanticSameItem({query:left,candidate:right}).accepted,false);
    assert.equal(semanticSameItem({query:right,candidate:left}).accepted,false);
    assert.equal(visualListingEquivalent({query:left,candidate:right,queryCategory:productFamily(left),candidateCategory:productFamily(right),imageScore:.99}),false);
  }
  assert.equal(productFamily(sukuna),'acrylic_block');
});
test('multi-unit listings need quantity evidence even when the image is identical',()=>{
  const pair='雪肌精×モンチッチ ペアぬいぐるみ セット';
  assert.equal(hasVariantMismatch(pair,'雪肌精×モンチッチ 限定ぬいぐるみ'),true);
  assert.equal(hasExplicitVariantMismatch(pair,'雪肌精×モンチッチ 限定ぬいぐるみ'),false);
  assert.equal(visualListingEquivalent({query:pair,candidate:'雪肌精×モンチッチ 限定ぬいぐるみ',imageScore:.99}),false);
  assert.equal(visualListingEquivalent({query:pair,candidate:'雪肌精×モンチッチ 限定ぬいぐるみ 2キャラクター仕様',imageScore:.95}),true);
  assert.equal(visualListingEquivalent({query:pair,candidate:'雪肌精×モンチッチ 単品ぬいぐるみ',imageScore:.95}),false);
});
test('reads a complete BOX quantity before random-assortment wording',()=>{
  const own='TOPTOY SURE FUN 貪吃熊 ぬいぐるみ ブラインドボックス 6個入り アソートBOX';
  const competitor='TOPTOY MayMei くいしんぼうベア ぬいぐるみ BOX 6種セット。1種secretモデルがランダム封入品です。';
  assert.equal(semanticQuantity(own),6);
  assert.equal(semanticQuantity(competitor),6);
  assert.equal(saleUnitEquivalent(own,competitor),true);
  assert.equal(saleUnitEquivalent(own,'TOPTOY SURE FUN 貪吃熊 ぬいぐるみ 6個セット 1ケース'),true);
  assert.equal(saleUnitEquivalent(own,'TOPTOY くいしんぼうベア ぬいぐるみ 単品'),false);
  assert.equal(conditionCompatible('新品未開封 外装シュリンク付き',`${competitor}\n未使用`),true);
  assert.equal(semanticSameItem({query:own,candidate:competitor,queryCategory:'ぬいぐるみ',candidateCategory:'ぬいぐるみ'}).accepted,true);
});
test('a certification C mark in the description is not treated as product version C',()=>{
  const own='TOPTOY SURE FUN 貪吃熊 6個入り アソートBOX';
  const competitor='TOPTOY MayMei くいしんぼうベア BOX 6種セット\n正規証明ホロシール、またはCマーク入り';
  assert.equal(hasVariantMismatch(own,competitor),false);
  assert.equal(hasVariantMismatch('bilibili 鬼滅の刃 アクリルスタンド A','bilibili 鬼滅の刃 アクリルスタンド B'),true);
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
