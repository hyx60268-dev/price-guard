import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {classifyYahooCardConflict,YAHOO_CARD_CONFLICT_REASONS,YAHOO_CARD_CONFLICT_VERSION} from '../scripts/lib/yahoo-card-conflicts.mjs';
const figure='APEX ヴァイオレット・エヴァーガーデン 自動手記人形Ver. 1/7 フィギュア';
const own=(title=figure,description='新品未開封 フィギュア1点')=>({title,description});
function classify(title,detail=own(),extra={}){return classifyYahooCardConflict({ownDetail:detail,card:{title,...extra}})}
function unresolved(title,detail=own(),extra={}){assert.equal(classify(title,detail,extra).classification,'unresolved',title)}
function rejected(title,reason,detail=own()){assert.deepEqual(classify(title,detail),{classification:'definitive_conflict',reason},title)}

test('result is a bounded rejection-only vocabulary, with no recommendations, raw text or fabricated clocks',()=>{
 const args={ownDetail:{...own(),observedAt:'2026-10-18T02:32:57.448Z'},card:{title:figure+' ジャンク',observedAt:'2026-10-18T02:33:01.655Z'}};
 const before=structuredClone(args),decision=classifyYahooCardConflict(args);
 assert.equal(YAHOO_CARD_CONFLICT_VERSION,1);assert.ok(Object.isFrozen(YAHOO_CARD_CONFLICT_REASONS));
 assert.deepEqual(Object.keys(decision).sort(),['classification','reason']);assert.ok(YAHOO_CARD_CONFLICT_REASONS.includes(decision.reason));
 assert.deepEqual(args,before);assert.ok(!JSON.stringify(decision).includes('2026'));assert.ok(!('canRecommend' in decision));
 for(const input of [undefined,{},null,{ownDetail:own(),card:{}},{ownDetail:{title:figure},card:{title:figure}}]){
  const row=classifyYahooCardConflict(input);
  assert.equal(row.classification,'unresolved');assert.ok(YAHOO_CARD_CONFLICT_REASONS.includes(row.reason));
 }
 unresolved('x'.repeat(1001));unresolved(figure,{...own(),description:'x'.repeat(30001)});
});

test('prices, low image scores, source statuses, strict verifier reasons and categories cannot exclude',()=>{
 for(const price of [undefined,null,0,1,100,999999])for(const primaryImageScore of [undefined,null,0,.1,1]){
  unresolved(figure,own(),{price,primaryImageScore,reason:'physical_product_type_unconfirmed',category:'カード',itemStatus:'SOLD'});
 }
 unresolved(figure,own(figure,'商品です'),{price:1,ownPrice:30000,imageSimilarity:0});
});

test('matching, missing, unknown, truncated, conditional or self-contradictory card terms always require detail',()=>{
 for(const title of [figure,figure+' 新品未使用',figure+' 未使用品',figure+' …',figure+' ...',figure+' 傷ありかもしれません',
  figure+' 状態不明',figure+' 破損あり？',figure+' 新品 中古',figure+' 未開封 開封済',figure+' ブルー レッド',
  figure+' 1/8',figure+' 2点セット 3点セット',figure+' 1BOX 単品',figure+' 箱あり 箱なし',figure+' 特典付き 特典なし'])unresolved(title);
 for(const title of [figure+' ジャンク',figure+' 中古',figure+' 箱なし'])unresolved(title,own(figure,'状態不明 商品です'));
 unresolved(figure+' 破損あり',own(figure+' ジャンク','破損あり'));
});

test('real positive damage terms contradict explicit new own terms; negative damage and disclaimers do not',()=>{
 for(const term of ['ジャンク','訳あり','難あり','破損あり','破損品','パーツ欠品','部品欠品','付属品欠品','箱潰れ','箱ダメージ','キズあり','傷有り','有瑕疵','缺件']){
  rejected(figure+' '+term,'explicit_card_defect');
 }
 for(const term of ['傷なし','傷はありません','キズ無し','汚れなし','破損なし','欠品なし','无瑕疵','無瑕疵','没有瑕疵','没有破损',
  '難ありではありません','ジャンクではない','箱ダメージはありません','破損がある場合があります','初期傷の可能性あり'])unresolved(figure+' '+term);
 rejected(figure+' 傷なし 台座破損あり','explicit_card_defect');
});

test('bonus omission is unknown, explicit required absence rejects, extras and negative-inclusion grammar remain safe',()=>{
 const withBonus=own(figure+' 特典付き');
 for(const term of ['特典なし','特典無し','特典カードなし','特典は付属しません','特典カードはありません','特典付属しない',
  '特典付きではありません','特典が付属していない','特典付属なし','特典欠品']){
  rejected(figure+' '+term,'explicit_card_required_bonus_absent',withBonus);
  unresolved(figure+' 特典付き',own(figure+' '+term));
  unresolved(figure+' '+term,own());
 }
 for(const title of [figure,figure+' 特典付き',figure+' 特典カード付き',figure+' 特典なし 特典付き',figure+' 特典不明'])unresolved(title,withBonus);
 for(const term of ['特典は付属します','特典が付属します','特典付属','特典が付属、']){
  rejected(figure+' 特典なし','explicit_card_required_bonus_absent',own(figure+' '+term));
 }
});

test('only explicit incompatible physical types reject, mixed titles and bonus parts are unresolved',()=>{
 for(const title of ['ヴァイオレット・エヴァーガーデン アクリルスタンド','ヴァイオレット・エヴァーガーデン ポストカード',
  'ヴァイオレット・エヴァーガーデン 特典カードのみ','ヴァイオレット・エヴァーガーデン 写真集']){
  rejected(title,'explicit_card_product_type_mismatch');
 }
 for(const title of ['ヴァイオレット・エヴァーガーデン','APEX 特典',figure+' 特典カード付き',figure+' アクリルスタンド',
  figure+' 特典カードのみ',figure+' カード',figure+' 特典アクリルスタンド付き',figure+' 用のカード',figure+' ではなくカード'])unresolved(title);
 rejected('ヴァイオレット アクリルスタンド','explicit_card_product_type_mismatch',own(figure+' 特典カード付き'));
 unresolved('ヴァイオレット カード',own('ヴァイオレット','新品未開封'));
 unresolved('ヴァイオレット カード',own(figure+' カード','新品未開封'));
});

test('unknown quantities are never one and BOX versus single needs both explicit terms',()=>{
 const box=own('ポケモン フィギュア 1BOX','新品未開封');
 for(const title of ['ポケモン フィギュア','ポケモン フィギュア ランダム','ポケモン フィギュア 全12種',
  'ポケモン フィギュア 1BOX 12個入り','ポケモン フィギュア バラ売り不可','ポケモン フィギュア 単品販売不可'])unresolved(title,box);
 for(const title of ['ポケモン フィギュア 単品','ポケモン フィギュア 1個のみ'])rejected(title,'explicit_card_sale_unit_mismatch',box);
 unresolved('ポケモン フィギュア 1BOX',own('ポケモン フィギュア','新品未開封'));
 rejected('ポケモン フィギュア 1BOX','explicit_card_sale_unit_mismatch',own('ポケモン フィギュア 単品','新品未開封'));
 for(const [left,right] of [[2,3],[3,1]])rejected(`フィギュア ${right}体セット`,'explicit_card_quantity_mismatch',own(`フィギュア ${left}体セット`,'新品未開封'));
 unresolved('フィギュア 3体セット',own('フィギュア','新品未開封'));
 unresolved('フィギュア',own('フィギュア 3体セット','新品未開封'));
 unresolved('フィギュア 特典カード3枚付き',own('フィギュア','新品 フィギュア1点'));
 unresolved('フィギュア 1BOX 12個入り',own('フィギュア 1BOX','新品未開封\n【1個の内容】\nフィギュア1個\nカード1枚'));
});

test('condition conflicts are explicit; missing condition and opened-but-unused do not imply a conflict',()=>{
 rejected(figure+' 中古','explicit_card_condition_mismatch');
 rejected(figure+' 開封済','explicit_card_condition_mismatch');
 rejected(figure+' 箱なし','explicit_card_packaging_mismatch');
 rejected(figure+' 箱のみ','explicit_card_packaging_mismatch');
 for(const title of [figure,figure+' 開封済 未使用',figure+' 本体のみ'])unresolved(title,own(figure,'新品 未使用'));
 unresolved(figure+' 箱のみ',own(figure,'商品の状態は不明'));
 unresolved(figure+' 未使用品');unresolved(figure+' 外箱のみ確認のため開封');
 unresolved(figure+' 箱なし',own(figure+' 箱なし','新品 未使用'));
});

test('variants need two singleton explicit facets; brand changes, translations and missing qualifiers are unknown',()=>{
 rejected('Myethos ラップランド 1/8 フィギュア','explicit_card_variant_mismatch',own('Myethos ラップランド 1/7 フィギュア'));
 rejected('スターバックス ボトル ブラウン 370ml','explicit_card_variant_mismatch',own('スターバックス ボトル ブルー 370ml'));
 rejected('RIIZE ぬいぐるみ 白色','explicit_card_variant_mismatch',own('RIIZE ぬいぐるみ ブラック'));
 rejected('一番くじ フィギュア B賞','explicit_card_variant_mismatch',own('一番くじ フィギュア A賞'));
 rejected('ポケモン 梦点睛 フィギュア 第4弾','explicit_card_variant_mismatch',own('ポケモン 梦点睛 フィギュア 3代目'));
 for(const title of ['ヴァイオレット・エヴァーガーデン フィギュア グッドスマイルカンパニー',figure+' 正規品',figure+' 公式写真',
  'APEX ヴァイオレット・エヴァーガーデン フィギュア','APEX ヴァイオレット・エヴァーガーデン 1/7 フィギュア'])unresolved(title);
 unresolved('ポケモン 梦点睛 フィギュア 第3弾 4代目',own('ポケモン 梦点睛 フィギュア 3代目'));
 unresolved('スターバックス ボトル ブラウン ブルー 370ml',own('スターバックス ボトル ブルー 370ml'));
 unresolved('スターバックス ボトル 370ml',own('スターバックス ボトル ブルー 370ml'));
});

test('existing real user title fixtures stay regression evidence, never import unobserved competitor description',()=>{
 const fixtures=JSON.parse(readFileSync(new URL('./fixtures/user-match-regressions.json',import.meta.url),'utf8'));
 const targeted=fixtures.filter(row=>/2026-10-16|整端与单盒|星巴克蓝色和棕色|Myethos荒蕪ラップランド1\/7不能比1\/8/.test(row.case));
 assert.ok(targeted.length>=8);
 for(const row of targeted){
  const actual=classify(row.candidateTitle,{title:row.ownTitle,description:row.ownDescription});
  const explicit=/整端与单盒|星巴克蓝色和棕色|不能比1\/8/.test(row.case);
  assert.equal(actual.classification,explicit?'definitive_conflict':'unresolved',row.case);
 }
 for(const row of fixtures.filter(row=>row.expected===null))unresolved(row.candidateTitle,{title:row.ownTitle,description:row.ownDescription});
 const bodyOnly=fixtures.find(row=>row.case.includes('标题白色不能掩盖正文红色'));
 unresolved(bodyOnly.candidateTitle,{title:bodyOnly.ownTitle,description:bodyOnly.ownDescription});
});


test('explicitly incomplete metadata and own-detail contradictions cannot be hidden by compact parsing',()=>{
 unresolved(figure+' ジャンク',own(),{titleTruncated:true});
 unresolved(figure+' ジャンク',own(),{truncated:true});
 unresolved(figure+' 中古',own(figure+' 新品同様','商品です'));
 unresolved(figure+' 中古',own(figure+' 未使用に近い','商品です'));
 unresolved(figure+' 開封済',own(figure+' 未開封','未開封ではありません。開封済です'));
 unresolved(figure+' 特典なし',own(figure+' 特典付き','特典付きではありません。新品未開封'));
 unresolved(figure+' 中古',own(figure+' 新品','説明'.repeat(90)+' 中古です'));
 for(const title of [figure+' 箱のみ確認のため開封',figure+' 箱だけを開封',figure+' 箱のみ開封'])unresolved(title);
 const box=own('フィギュア 1BOX','新品未開封');
 for(const title of ['フィギュア 2体セット バラ売り可','フィギュア セット/単品','フィギュア 2体セット 単品も可'])unresolved(title,box);
 unresolved('フィギュア 1BOX 12個入り',own('フィギュア 1BOX','新品未開封\n各小箱には1個入りです'));
});


test('accessory inclusion cannot backtrack through negative or partial wording to invent a main product',()=>{
 const required=own(figure+' 特典付き');
 for(const term of ['特典カード付属しない','特典カード付属しません','特典カード付属していない','特典カード付属していません']){
  rejected(figure+' '+term,'explicit_card_required_bonus_absent',required);
  unresolved(figure+' '+term,own());
  unresolved(figure+' アクリルスタンド '+term,required);
 }
 for(const term of ['特典カード付いていない','特典カード付きではない','特典カード付きではありません']){
  rejected(figure+' '+term,'explicit_card_required_bonus_absent',required);
 }
 for(const title of [figure+' 特典カード付属し',figure+' 特典カード付きでは',figure+' 特典カード付属するか未確認'])unresolved(title,required);
});
