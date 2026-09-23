import test from 'node:test';
import assert from 'node:assert/strict';
import { yahooCompare } from '../scripts/lib/yahoo.mjs';
import { productFamily,descriptionColorMismatch,explicitSaleContents,hasExplicitDefect,saleUnitEquivalent,semanticQuantity,collectibleIdentityRequiresVisualProof } from '../scripts/lib/rules.mjs';
import { primaryProductSimilarity } from '../scripts/lib/image.mjs';

// Text transcribed from the user's 2026-09-23 screenshots. Images below are
// controlled evidence fixtures, NOT claims of a live image-model evaluation.
const fp=(value=100)=>({dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[value,value,value],colorGrid:Array(768).fill(value)});
async function replay({accountId='melon',ownTitle,title,ownDescription='新品 未使用',description='新品 未使用',sameImage=false,missingPrimary=false,missingOwnDescription=false,secondary=false}){
  const item={id:'own',accountId,title:ownTitle,ownPrice:15000,image:'own-primary',yahoo:{searchCheckedAt:new Date().toISOString()}};
  const candidate={id:'other',title,price:7000,image:'other-primary',sellerId:'competitor',source:'recommendation',recommendationScore:.999};
  const ownDetail={id:'own',title:ownTitle,description:missingOwnDescription?'':ownDescription,status:'OPEN',images:['own-primary',...(secondary?['shared-back']:[])]};
  const detail={id:'other',title,description,status:'OPEN',price:7000,seller:{id:'competitor'},images:['other-primary',...(secondary?['shared-back']:[])]};
  return yahooCompare(null,item,{}, {
    fetchYahooItemBundle:async id=>id==='own'?{detail:ownDetail,recommendations:[candidate]}:{detail},
    fetchYahooResult:async()=>({items:[]}),
    imageFingerprints:async url=>missingPrimary&&url==='own-primary'?null:fp(url==='other-primary'&&!sameImage?200:100)
  });
}

test('description sale members override a trilogy heading; 冊 and kanji counts work',()=>{
  const two='何藩 写真集 香港三部作\n黒とベージュセット売り、別売り不可';
  assert.equal(explicitSaleContents(two).quantity,2);
  assert.equal(semanticQuantity('香港三部作\n三冊セット'),3);
  assert.equal(saleUnitEquivalent('香港三部作\n三冊セット',two),false);
  assert.equal(saleUnitEquivalent('香港三部作',two),false);
  assert.equal(saleUnitEquivalent('写真集\n3冊セット','写真集\n三冊セット'),true);
  assert.equal(saleUnitEquivalent('本 2冊セット','本 3冊セット'),false);
});

test('seller category and bonus prose do not override the actual product type',()=>{
  assert.equal(productFamily('FAN HO 香港三部作 写真集','トレーディングカード'), 'book');
  assert.equal(productFamily('FAN HO 香港三部作 写真集\n特典カード付き','キーホルダー'), 'book');
  assert.equal(productFamily('冨岡義勇 アクリルスタンド','フィギュア'), 'acrylic_stand');
});

test('actual hiragana scratches and uncertain dirt are defects; generic disclaimers are not',()=>{
  assert.equal(hasExplicitDefect('写真集','初期きずスレあり\n汚れはシュリンクか本体かは不明'),true);
  assert.equal(hasExplicitDefect('写真集','汚れはシュリンクか本体かは不明'),true);
  assert.equal(hasExplicitDefect('写真集','傷や汚れなし'),false);
  assert.equal(hasExplicitDefect('写真集','海外製品のため初期きずがある場合がございます'),false);
});

for(const accountId of ['melon','local-1789214704376','account-p6579087']){
  test(`${accountId}: three books cannot match two even with identical title/photos`,async()=>{
    const title='FAN HO 何藩 ファン・ホー 香港三部作 写真集 森山大道';
    const result=await replay({accountId,ownTitle:title,title,ownDescription:'新品 未使用\n3冊セット',description:'新品 未使用\n黒とベージュセット売り、別売り不可',sameImage:true});
    assert.equal(result.detailCheckedCount,1);
    assert.equal(result.competitorCount,0);
    assert.ok(result.rejected.some(row=>row.reason==='sale_unit_mismatch'));
    assert.equal(result.recommendedPrice,15000);
  });
  for(const [label,ownTitle,title] of [
    ['Kitty colours','海外限定Hello Kitty x TBH ネックピロー 正規品','海外限定Hello Kitty x TBH ネックピロー'],
    ['Giyu artwork','鬼滅の刃 冨岡義勇 正規品 海外限定 『鬼滅の刃』 冨岡義勇 アクリルスタンド','鬼滅の刃 冨岡義勇 アクリルスタンド 中国限定']
  ])test(`${accountId}: ${label} cannot bypass primary-image evidence with generic titles`,async()=>{
    const result=await replay({accountId,ownTitle,title,secondary:true});
    assert.equal(result.detailCheckedCount,1);
    assert.equal(result.competitorCount,0);
    assert.ok(result.rejected.some(row=>row.reason==='primary_variant_unconfirmed'));
    assert.equal(result.recommendedPrice,15000);
    assert.equal(result.audit.accountId,accountId);
  });
}

test('series wording is no longer the switch for acrylic artwork verification',()=>{
  const candidate='鬼滅の刃 冨岡義勇 アクリルスタンド 中国限定';
  for(const title of ['中国限定 鬼滅の刃 無限城編 新繹シリーズ アクリルスタンド 冨岡義勇',candidate]){
    assert.equal(collectibleIdentityRequiresVisualProof(title,candidate),true);
  }
});

test('a missing first photo cannot be replaced by a shared box/back image',async()=>{
  const title='海外限定Hello Kitty x TBH ネックピロー';
  const result=await replay({ownTitle:title,title,sameImage:true,secondary:true,missingPrimary:true});
  assert.equal(result.competitorCount,0);
  assert.ok(result.rejected.some(row=>row.reason==='primary_variant_unconfirmed'));
});

test('missing own description is not rescued by exact-title/identical-photo shortcuts',async()=>{
  const title='FAN HO 何藩 香港三部作 写真集';
  const result=await replay({ownTitle:title,title,sameImage:true,missingOwnDescription:true});
  assert.equal(result.competitorCount,0);
  assert.ok(result.rejected.some(row=>row.reason==='sale_description_unavailable'));
});

test('same variant with complete descriptions and matching primary evidence remains comparable',async()=>{
  const title='海外限定Hello Kitty x TBH ネックピロー';
  const result=await replay({ownTitle:title,title,sameImage:true});
  assert.equal(result.competitorCount,1);
  assert.equal(result.recommendedPrice,6999);
});

test('primary-image colour gate does not average away colour-only differences',()=>{
  assert.equal(primaryProductSimilarity(fp(100),fp(100)),1);
  assert.ok(primaryProductSimilarity(fp(100),fp(200))<.98);
  assert.equal(primaryProductSimilarity(null,fp(100)),null);
});

test('explicit body colour overrides an identical generic title and photo',async()=>{
  const title='海外限定Hello Kitty x TBH ネックピロー';
  const left=`${title}\n新品 未使用\n【カラー】ブラック`,right=`${title}\n新品 未使用\n【カラー】ベージュ`;
  assert.equal(descriptionColorMismatch(left,right),true);
  assert.equal(descriptionColorMismatch(`${title}\n${title}（ブラック×ゴールド）`,`${title}\n${title}（ベージュ×ブルー）`),true);
  assert.equal(descriptionColorMismatch(`${title}\n${title}（ブラック×ゴールド）`,`${title}\n${title}（ブラック×ブルー）`),true);
  const result=await replay({ownTitle:title,title,ownDescription:'新品 未使用\n【カラー】ブラック',description:'新品 未使用\n【カラー】ベージュ',sameImage:true});
  assert.equal(result.competitorCount,0);
  assert.ok(result.rejected.some(row=>row.reason==='description_color_mismatch'));
});
