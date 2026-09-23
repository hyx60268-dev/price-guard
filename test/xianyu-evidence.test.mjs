import test from 'node:test';
import assert from 'node:assert/strict';
import { detailStateFailure,positivePrice,verifiedCostEvidence,XIANYU_VERIFICATION } from '../scripts/lib/xianyu-evidence.mjs';
import { discoveryProfit,nextMercariPage,rotateDiscoverySellers,validDiscoveryXianyu,xianyuQueryFor } from '../scripts/lib/discovery.mjs';
import { verifiedXianyuCache } from '../scripts/lib/planner.mjs';

const sample=(id,sellerKey,price=100)=>({id,sellerKey,price,priceSource:'target_detail'});
test('challenge frame takes precedence over visible recommendation text and images',()=>{
  assert.equal(detailStateFailure({blocked:true,text:'为你推荐',titles:['原神 菲林斯'],images:['recommendation'],price:65,sellerKey:'other'}),'detail_blocked');
  assert.equal(detailStateFailure({titles:[],text:'为你推荐'}),'detail_unreadable');
});
test('metadata title and search card cannot replace actual target price seller and photos',()=>{
  const detail={titles:['星稚梦旅菲林斯合影卡'],text:'原神 星稚梦旅 菲林斯合影卡 正版单张 未拆封'};
  assert.equal(detailStateFailure(detail),'detail_price_unconfirmed');
  assert.equal(detailStateFailure({...detail,price:65}),'detail_seller_unconfirmed');
  assert.equal(detailStateFailure({...detail,price:65,sellerKey:'a'}),'detail_images_unconfirmed');
  assert.equal(detailStateFailure({...detail,price:65,sellerKey:'a',images:['photo']}),null);
});
test('three unidentified sellers or one seller with three listings never constitute independent evidence',()=>{
  assert.equal(verifiedCostEvidence([sample('1',''),sample('2',''),sample('3','')]).ready,false);
  assert.equal(verifiedCostEvidence([sample('1','a'),sample('2','a'),sample('3','a')]).ready,false);
  assert.equal(verifiedCostEvidence([sample('1','a'),sample('1','b')]).ready,false);
});
test('automatic cost uses target-detail prices from different identified sellers',()=>{
  const samples=[sample('1','a',100),sample('2','b',102)];
  assert.equal(verifiedCostEvidence(samples).median,101);
  assert.equal(verifiedCostEvidence(samples).ready,true);
  assert.equal(verifiedCostEvidence([{...samples[0],priceSource:'search_card'},samples[1]]).ready,false);
  assert.equal(verifiedXianyuCache({averageCNY:101,xianyu:{verification:XIANYU_VERIFICATION,samples}}).averageCNY,101);
  assert.equal(verifiedCostEvidence([sample('1','a',50),sample('2','b',200)]).ready,false);
});
test('null blank and zero costs cannot produce profit or pass discovery gates',()=>{
  for(const purchaseCNY of [null,undefined,'',0,'0',' ',NaN]){
    assert.equal(positivePrice(purchaseCNY),null);
    const profit=discoveryProfit({purchaseCNY,sourcePriceJPY:20000},{exchangeRate:23,costMultiplier:1});
    assert.equal(profit.ready,false);assert.equal(profit.estimatedProfitJPY,null);assert.equal(profit.qualified,false);
  }
  assert.equal(validDiscoveryXianyu({status:'ok',averageCNY:null,samples:[sample('1','a'),sample('2','b')]}).ready,false);
});
test('Mercari follows supplied next-page links without guessing tokens or changing origin',()=>{
  const current='https://jp.mercari.com/search?keyword=test';
  assert.equal(nextMercariPage('/search?keyword=test&page_token=v1%3A1',current),'https://jp.mercari.com/search?keyword=test&page_token=v1%3A1');
  assert.equal(nextMercariPage(current,current),null);
  assert.equal(nextMercariPage('https://evil.example/search?page_token=x',current),null);
  assert.equal(nextMercariPage('/item/m123',current),null);
});
test('bounded discovery rotates sellers rather than checking the same prefix each time',()=>{
  const sellers=[{id:'a'},{id:'b'},{id:'c'}];
  assert.deepEqual(rotateDiscoverySellers(sellers,{a:'2026-09-23',b:'2026-09-22'},2).map(row=>row.id),['c','b']);
});
test('live inventory without hand-written Chinese query receives product-specific translations',()=>{
  assert.equal(xianyuQueryFor('中国限定 スターバックス ステンレスボトル ブルー 370ml'),'星巴克 不锈钢水杯 蓝色 370ml');
  assert.match(xianyuQueryFor('鬼滅の刃 新繹 時透無一郎 アクリルスタンド'),/鬼灭之刃 新绎 时透无一郎 亚克力立牌/);
});
