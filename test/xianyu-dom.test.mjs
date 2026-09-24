import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readXianyuDetailDOM,detailStateFailure,xianyuResultStatus } from '../scripts/lib/xianyu-evidence.mjs';

// Structural fixture from the public PC detail bundle 0.0.175. Deliberately no
// h1, og:title, itemTitle or detailTitle: that is the real extraction regression.
const target=`<div class="item-user-container--new"><a href="/personal?userId=12345">seller</a></div>
<div class="item-main-window--new"><img src="https://example.com/target.jpg"></div>
<div class="item-main-info--new"><div class="price--new">120.50</div><div class="origin--new">原价¥300</div>
<div class="notLoginContainer--new"><span class="desc--new">星巴克蓝色豹纹不锈钢保温杯370ml，全新未拆封，单个出售。</span></div></div>`;
const recommendations=`<div class="item-feeds-container--new"><h2>为你推荐</h2><a href="/item?id=99"><h1>错误推荐</h1><div class="price--new">1</div><img src="https://example.com/other.jpg"></a></div>`;
function read(html,title='星巴克蓝色豹纹370ml_闲鱼'){
  const dom=new JSDOM(`<title>${title}</title>${html}`,{url:'https://www.goofish.com/item?id=7',runScripts:'outside-only'});
  Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent}});
  dom.window.HTMLElement.prototype.getBoundingClientRect=function(){return {width:200,height:200}};
  const result=dom.window.eval(`(${readXianyuDetailDOM.toString()})()`);dom.window.close();return result;
}
test('current PC description layout supplies target details, not recommendations or original price',()=>{
  const state=read(target+recommendations);
  assert.equal(detailStateFailure(state),null);assert.equal(state.price,120.5);
  assert.equal(state.sellerKey,'goofish:12345');assert.equal(state.loginVisible,false);
  assert.deepEqual([...state.images],['https://example.com/target.jpg']);
  assert.equal(state.text.includes('错误推荐'),false);
});
test('site title and recommendation-only page never provide target evidence',()=>{
  const state=read(recommendations);assert.equal(detailStateFailure(state),'detail_unreadable');
  assert.equal(state.images.length,0);assert.equal(state.price,null);
});
test('target description can name an offer when browser title is generic',()=>{
  assert.equal(detailStateFailure(read(target,'闲鱼 - 闲不住')),null);
});
test('visible login mask and security challenge override otherwise complete target data',()=>{
  assert.equal(detailStateFailure(read(target+'<div class="notloginMask--new">请登录</div>')),'detail_login_required');
  assert.equal(detailStateFailure(read(target+'<iframe src="https://example.com/captcha"></iframe>')),'detail_blocked');
  assert.equal(detailStateFailure(read(target+'<div style="display:none" class="notloginMask--new">请登录</div>')),null);
});
test('network error and removed listing are not generic unreadable or substitute recommendation',()=>{
  assert.equal(detailStateFailure(read('<div class="error-container--new">网络不见了</div>'+recommendations)),'detail_network_error');
  assert.equal(detailStateFailure(read('<div class="empty-container--new">糟糕！宝贝被删掉了</div>'+recommendations)),'detail_unavailable');
});
test('multiple target prices cannot be reduced to the cheapest bait amount',()=>{
  assert.equal(detailStateFailure(read(target.replace('120.50','100 - 200'))),'detail_price_unconfirmed');
});
test('technical failures retry instead of entering completed-review cooldown',()=>{
  for(const reason of ['detail_unreadable','detail_network_error','detail_error','detail_price_unconfirmed','detail_seller_unconfirmed','detail_images_unconfirmed']){
    assert.equal(xianyuResultStatus([{reason}],{cardCount:20}),'detail_inaccessible');
  }
  assert.equal(xianyuResultStatus([{reason:'description_color_mismatch'}],{cardCount:20}),'manual_review');
  assert.equal(xianyuResultStatus([{reason:'detail_blocked'}],{ready:true}),'blocked');
});
