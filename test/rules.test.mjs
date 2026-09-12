import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCost,advice,coherentPrices,hasVariantMismatch,isLikelyVariantOffer,titleScore } from '../scripts/lib/rules.mjs';
import { encrypt,decrypt } from '../scripts/lib/crypto.mjs';
const settings={exchangeRate:22.99,costMultiplier:1.05};
test('manual cost formula',()=>assert.equal(calculateCost(90.5,30,210,settings),3130));
test('cost stays blank until all manual values exist',()=>{
  assert.equal(calculateCost(90.5,null,210,settings),null);
  assert.equal(calculateCost(90.5,30,undefined,settings),null);
});
test('profit warning',()=>assert.equal(advice({ownPrice:4099,recommendedPrice:4099,cost:3130,warning:1500}),'不建议按推荐价出售'));
test('title similarity',()=>assert.ok(titleScore('鬼灭之刃 时透无一郎 亚克力立牌','鬼灭之刃 新绎 时透无一郎 亚克力立牌')>.7));
test('rejects extra set or version markers',()=>{
  assert.equal(hasVariantMismatch('時透無一郎 アクリルスタンド','時透無一郎 アクリルスタンド 2点セット'),true);
  assert.equal(hasVariantMismatch('時透無一郎 アクリルスタンド','時透無一郎 アクリルスタンド Bタイプ'),true);
  assert.equal(hasVariantMismatch('全8種 セット','全8種 セット'),false);
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
