import test from 'node:test';
import assert from 'node:assert/strict';
import {marketplaceShippingEvidence,shippingTermsUnproven,targetPriceAreaTerms} from '../scripts/lib/marketplace-shipping-evidence.mjs';
const proof=extra=>marketplaceShippingEvidence({source:'yahoo',chargeKnown:true,proofSource:'target_price_area',amount:0,currency:'JPY',destination:'JP',...extra});

test('proven target-local freight is independent from an unspecified carrier',()=>{
  for(const method of [undefined,null,'','未定','unknown'])assert.deepEqual(proof({method}),{shippingChargeKnown:true,shippingSource:'target_price_area',shippingMethod:null,reason:null});
  assert.equal(proof({method:'おてがる配送'}).shippingMethod,'おてがる配送');
  assert.equal(proof({source:'rakuma',proofSource:'listing_shipping_fee_row',method:'未定'}).shippingChargeKnown,true);
});

for(const extra of [{chargeKnown:false},{chargeKnown:undefined},{proofSource:'site_policy'},{proofSource:'listing_shipping_fee_row'},
  {amount:null},{amount:NaN},{amount:-1},{currency:''},{currency:'USD'},{destination:''},{destination:'US'},{source:'other'}])
test(`missing or contradictory freight proof stays unknown: ${JSON.stringify(extra)}`,()=>assert.equal(proof(extra).shippingChargeKnown,false));

for(const description of ['着払いです','送料別途500円','購入者負担です','追加送料が必要です','送料無料ではありません','発送不可です',
  '直接引き取り限定です','手渡しのみです','北海道・沖縄・離島は追加送料が必要です','送料無料（沖縄除く）','2点以上で送料無料',
  '同梱時のみ送料無料','5000円以上購入の場合は送料無料','送料は要相談','pickup only','collection-only','no shipping',
  'additional shipping charges apply','free shipping except Okinawa','仅自提','偏远地区加收运费'])
test(`conditional, conflicting or non-deliverable target remains unknown: ${description}`,()=>{
  assert.equal(shippingTermsUnproven(description),true);assert.equal(proof({description}).reason,'shipping_terms_unconfirmed');
});

for(const description of ['not pickup-only; shipping is available','This is no longer collection-only.','No additional shipping fees.',
  '追加送料はありません','別途送料不要','着払いではありません','手渡しのみではありません','以前は引取限定でしたが現在は発送可能です',
  'Previously pickup-only, now shipping available','同梱可能です。1点でも送料無料です。','送料無料です。開封済みの場合は画像をご確認ください。','送料無料の限定品です。','引取可。配送のみでも可能です。'])
test(`explicit negative or historical pickup statement is not current restriction: ${description}`,()=>assert.equal(proof({description}).shippingChargeKnown,true));

test('fee contradictions are read from the target price region, not recommendations or footer policy',()=>{
  const body='<h1>Target</h1><div>100円 送料無料 沖縄は追加送料</div><h2>商品の説明</h2><p>Other</p><footer>手渡しのみ</footer>';
  assert.equal(proof({feeText:targetPriceAreaTerms(body,'Target')}).shippingChargeKnown,false);
  const allowed='<h1>Target</h1><div>100円 送料無料</div><h2>この商品に似た商品</h2><p>手渡しのみ</p><footer>追加送料</footer>';
  assert.equal(proof({feeText:targetPriceAreaTerms(allowed,'Target')}).shippingChargeKnown,true);
  assert.equal(targetPriceAreaTerms(body,'Other'),'');
});

for(const description of ['送料無料（関東限定）','関東限定で送料無料','Free shipping only within Tokyo',
  '送料込み 【 東京都内 限定 】','送料無料（\n大阪府・京都府 のみ\n）','神奈川県のみ送料無料','本州限定 送料無料',
  '送料無料［指定地域限定］','送料無料［ 東京 限定 ］','［東京都内限定］で送料無料','配送先は東京都内に限ります','発送は関西のみ','関東限定の配送',
  'Free delivery only to Osaka','Shipping only within Hokkaido','Only within Tokyo: free shipping',
  'Free shipping to Tokyo only'])test(`explicit regional fee or delivery limit is not proven for JP: ${description}`,()=>{
  assert.equal(proof({description}).reason,'shipping_terms_unconfirmed');
});
for(const title of ['東京限定マグカップ 送料無料','関東限定品 送料無料','中国限定 サンリオバッグ',
  '京都限定デザイン。送料無料です。','送料無料の大阪限定タンブラー'])test(`regional merchandise edition does not become a shipping restriction: ${title}`,()=>{
  assert.equal(proof({title}).shippingChargeKnown,true);
});

for(const description of ['1万円以上で送料が無料','10000円以上購入で送料無料','送料無料は会員限定',
 '会員限定で送料無料','Free shipping for orders over 10000 yen','Free shipping on purchases above 50 dollars',
 '発送は行いません','配送には対応しておりません','配送に対応していません','直接取りに来られる方のみ',
 '送料無料の商品ではありません','条件付き送料無料'])test(`explicit qualification or non-delivery cannot borrow a free-fee label: ${description}`,()=>{
  assert.equal(proof({description}).reason,'shipping_terms_unconfirmed');
});

for(const description of ['送料無料の対象は本州です','関東地方にお住まいの方は送料無料','送料は含まれていません',
 '送料無料対象地域は四国','大阪府在住の方のみ送料無料','配送料が商品代金に含まれておりません'])test(`targeted recipients and excluded fees keep applicability unknown: ${description}`,()=>{
  assert.equal(proof({description}).reason,'shipping_terms_unconfirmed');
});

for(const description of ['送料は別です','送料は含まれておりません','送料は購入者の負担となります',
 '送料は別料金です','送料を別に頂きます'])test(`particle-aware current shipping charge exclusions remain unknown: ${description}`,()=>{
  assert.equal(proof({description}).reason,'shipping_terms_unconfirmed');
});
for(const description of ['追加送料はありません','送料は別料金ではありません','購入者の負担ではありません'])
test(`explicitly negated extra charges do not contradict proven zero fee: ${description}`,()=>assert.equal(proof({description}).shippingChargeKnown,true));
