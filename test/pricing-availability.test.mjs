import test from 'node:test';
import assert from 'node:assert/strict';
import { pricingDecision,PRICING_RULES_VERSION } from '../public/pricing-policy.js';
import { pricingSummary } from '../public/pricing-status.js';
import { mercariCompare } from '../scripts/lib/mercari.mjs';
import { exactQueryFor } from '../scripts/lib/yahoo.mjs';
import { xianyuQueryFor } from '../scripts/lib/discovery.mjs';
import { hasExplicitVariantMismatch } from '../scripts/lib/rules.mjs';
const now=Date.now();
const source=(price=9000,status='ok')=>({status,rulesVersion:PRICING_RULES_VERSION,checkedAt:new Date(now).toISOString(),candidates:[{price,sellerId:'seller',url:'https://example.test/item',matchMethod:'detail_verified'}]});
for(const accountId of ['melon','local-1789214704376','account-p6579087'])test(`${accountId}: unavailable platform does not hide independently verified lower offer`,()=>{
 const item={accountId,ownPrice:10000,yahoo:source(),rakuma:{status:'error'},mercari:{status:'deferred_limit'}};
 const d=pricingDecision(item,{now});assert.equal(d.complete,false);assert.equal(d.canRecommend,true);assert.equal(d.recommendedPrice,8999);
 assert.equal(pricingSummary([item],{now}).actionable,1);
 item.yahoo=source(12000);assert.equal(pricingDecision(item,{now}).canRecommend,false);assert.equal(pricingDecision(item,{now}).recommendedPrice,10000);
});
test('failed, expired, corrected or deferred source candidates cannot supply partial advice',()=>{
 for(const patch of [{status:'error'},{status:'deferred_limit'},{status:'invalidated'},{cacheReason:'request_error'},{checkedAt:new Date(now-7*3600000).toISOString()},{rulesVersion:19}]){
  const d=pricingDecision({ownPrice:10000,yahoo:{...source(),...patch}},{now});assert.equal(d.lowest,null);assert.equal(d.canRecommend,false);
 }
 const d=pricingDecision({ownPrice:10000,yahoo:source(9000,'incomplete')},{now});assert.equal(d.canRecommend,true);assert.equal(d.complete,false);
});
test('clear wrong colours cannot consume the limited detail budget',async()=>{
 const title='新品 スターバックス ボトル ブルー 370ml';let reads=0;
 const result=await mercariCompare(null,{title,ownPrice:10000,description:'新品 未使用',image:'own'},{maxMercariDetailChecks:1},{
  imageFingerprints:async()=>null,
  search:async()=>({cards:[{id:'wrong',title:title.replace('ブルー','ブラウン'),price:500,url:'wrong',itemStatus:'OPEN'}]}),
  detail:async()=>{reads++;throw Error('wrong detail should never be requested')}
 });
 assert.equal(reads,0);assert.equal(result.status,'ok');assert.equal(result.rejected[0].reason,'description_color_mismatch');
 assert.match(result.query,/ボトル.*ブルー/);
});
test('platform search retains product type, quantity and variant',()=>{
 assert.match(exactQueryFor('新品 中国限定 HIRONO アクリルスタンド 2点セット ブラック'),/アクリルスタンド 2点セット ブラック/);
});
test('Xianyu search translates entire compound without removing collection identity',()=>{
 assert.equal(xianyuQueryFor('POPMART RIIZE Fluffy Club シリーズぬいぐるみペンダント'),'POPMART RIIZE Fluffy Club 系列毛绒挂件');
 assert.equal(hasExplicitVariantMismatch('RIIZE Fluffy Club ぬいぐるみペンダント','RIIZE Fluffy Club 系列毛绒挂件'),false);
 assert.equal(hasExplicitVariantMismatch('RIIZE Fluffy Club ぬいぐるみペンダント ブラック','RIIZE Fluffy Club 系列毛绒挂件 白色'),true);
});
