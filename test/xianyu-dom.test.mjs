import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readXianyuDetailDOM,readSettledXianyuDetail,detailStateFailure,xianyuResultStatus } from '../scripts/lib/xianyu-evidence.mjs';

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
test('hidden ancestors and transparent login shells cannot masquerade as an active login wall',()=>{
 for(const style of ['display:none','visibility:hidden','opacity:0']){
  assert.equal(detailStateFailure(read(target+`<div style="${style}"><iframe src="https://example.com/login"></iframe></div>`)),null);
 }
 const state=read(target+'<iframe src="https://example.com/login"></iframe>');assert.equal(detailStateFailure(state),'detail_login_required');assert.equal(state.diagnostic.loginSurfaces[0].kind,'login_frame');
});
test('session hydration can settle naturally, persistent login stays blocked and CAPTCHA stops immediately',async()=>{
 const valid=read(target),login={...valid,loginVisible:true},challenge={...valid,blocked:true};
 for(const [states,expected,waits] of [[[login,valid],null,1],[[login,login],'detail_login_required',1],[[challenge],'detail_blocked',0]]){
  let n=0,w=0;const page={evaluate:async()=>states[Math.min(n++,states.length-1)],waitForTimeout:async()=>{w++}};
  assert.equal(detailStateFailure(await readSettledXianyuDetail(page)),expected);assert.equal(w,waits);
 }
});
test('network error and removed listing are not generic unreadable or substitute recommendation',()=>{
  assert.equal(detailStateFailure(read('<div class="error-container--new">网络不见了</div>'+recommendations)),'detail_network_error');
  assert.equal(detailStateFailure(read('<div class="empty-container--new">糟糕！宝贝被删掉了</div>'+recommendations)),'detail_unavailable');
});
test('multiple target prices cannot be reduced to the cheapest bait amount',()=>{
  assert.equal(detailStateFailure(read(target.replace('120.50','100 - 200'))),'detail_multi_price');
});
test('technical failures retry instead of entering completed-review cooldown',()=>{
  for(const reason of ['detail_unreadable','detail_network_error','detail_error','detail_price_unconfirmed','detail_seller_unconfirmed','detail_images_unconfirmed']){
    assert.equal(xianyuResultStatus([{reason}],{cardCount:20}),'detail_inaccessible');
  }
  assert.equal(xianyuResultStatus([{reason:'description_color_mismatch'}],{cardCount:20}),'manual_review');
  assert.equal(xianyuResultStatus([{reason:'detail_blocked'}],{ready:true}),'blocked');
  assert.equal(xianyuResultStatus([{reason:'detail_login_required'},{reason:'detail_unavailable'}],{cardCount:20}),'detail_inaccessible');
  assert.equal(xianyuResultStatus([{reason:'detail_login_required'},{reason:'detail_login_required'}],{cardCount:20}),'login_required');
  assert.equal(xianyuResultStatus([],{cardCount:0,searchLoginRequired:true}),'login_required');
});

test('price range is a completed multi-price review, not a failed detail fetch',()=>{
  const state=read(target.replace('120.50','3 - 160'));
  assert.equal(state.priceRange,true);assert.equal(state.price,null);
  assert.equal(xianyuResultStatus([{reason:detailStateFailure(state)}],{cardCount:20}),'manual_review');
});
test('description heading retains the character omitted by the browser title but excludes tag paragraphs',()=>{
  const state=read(target.replace('星巴克蓝色豹纹不锈钢保温杯370ml，全新未拆封，单个出售。','鬼灭之刃 无限城篇 中国限定新绎系列\n亚克力立牌A款 时透无一郎\n\ntag 富冈义勇 不死川实弥'),'鬼灭之刃 无限城篇 中国限定新绎系列_闲鱼');
  assert.ok(state.titles.some(title=>title.includes('时透无一郎')));
  assert.ok(state.titles.every(title=>!title.includes('富冈义勇')));
  assert.equal(state.text.includes('富冈义勇'),true);
});
