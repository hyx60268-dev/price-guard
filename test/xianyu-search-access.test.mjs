import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readXianyuSearchDOM,readSettledXianyuSearch,xianyuAccessDiagnostic,xianyuResultStatus } from '../scripts/lib/xianyu-evidence.mjs';
import { merchantXianyuAccess } from '../scripts/lib/merchant-scheduling.mjs';

const cards='<a href="/item?id=1">星巴克蓝色水杯</a>';
function read(html){
 const dom=new JSDOM(html,{url:'https://www.goofish.com/search?q=test',runScripts:'outside-only'});
 Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent}});
 dom.window.HTMLElement.prototype.getBoundingClientRect=function(){return {width:200,height:40}};
 const result=dom.window.eval(`(${readXianyuSearchDOM.toString()})()`);dom.window.close();return result;
}
test('ordinary search login controls do not override verified target details or trip global access',()=>{
 for(const html of ['<button class="login-button">登录</button>','<div class="notLoginContainer--new">正常内容</div>','<a class="login-link" href="/login">请登录</a>']){
  const state=read(cards+html);assert.equal(state.loginVisible,false);assert.equal(state.blocked,false);
  assert.equal(xianyuResultStatus([],{ready:true,cardCount:1,searchLoginRequired:state.loginVisible}),'ok');
 }
});
test('search authentication iframe, modal and target mask still block despite visible result cards',()=>{
 for(const html of ['<iframe src="https://example.test/login"></iframe>','<div role="dialog" class="login-modal">登录</div>','<div class="notloginMask--new">登录查看</div>']){
  const state=read(cards+html);assert.equal(state.loginVisible,true);assert.equal(state.diagnostic.loginSurfaces.length,1);
  assert.equal(xianyuResultStatus([],{ready:true,cardCount:1,searchLoginRequired:state.loginVisible}),'login_required');
 }
});
test('hidden or transparent search login ancestors are not an active access wall',()=>{
 for(const style of ['display:none','visibility:hidden','opacity:0']){
  const state=read(cards+`<div style="${style}"><iframe src="https://example.test/login"></iframe></div>`);
  assert.equal(state.loginVisible,false);assert.equal(state.diagnostic.loginSurfaces.length,0);
 }
 assert.equal(read(cards+'<div hidden><iframe src="https://example.test/login"></iframe></div>').loginVisible,false);
});
test('search challenge frames and challenge text remain hard stops',()=>{
 for(const html of ['<iframe src="https://example.test/captcha"></iframe>','<iframe id="baxia-frame"></iframe>','<div>安全验证</div>'])assert.equal(read(cards+html).blocked,true);
});
test('search waits for a transient login shell to settle, never changes or dismisses it',async()=>{
 const valid=read(cards),login=read(cards+'<iframe src="https://example.test/login"></iframe>'),challenge=read(cards+'<iframe src="https://example.test/captcha"></iframe>');
 for(const [states,expected,waits] of [[[login,valid],false,1],[[login,login],true,1],[[challenge],false,0],[[valid],false,0]]){
  let n=0,w=0;const page={evaluate:async()=>states[Math.min(n++,states.length-1)],waitForTimeout:async()=>w++};
  const state=await readSettledXianyuSearch(page);assert.equal(state.loginVisible,expected);assert.equal(w,waits);
  if(states[0]===challenge)assert.equal(state.blocked,true);
 }
});
test('search no-results remains separate from login and does not turn recommendation links into matches',()=>{
 const state=read('<div>没有找到你想要的宝贝</div>'+cards);assert.equal(state.noResults,true);assert.equal(state.loginVisible,false);
});
test('access logs retain structural reasons but omit credentials, page text and authentication URLs',()=>{
 const secret={cookies:['SECRET'],html:'SECRET',url:'https://login.test/?token=SECRET',loginVisible:true,mainFound:true,loginSurfaces:[{kind:'login_frame',src:'SECRET'}]};
 const d=xianyuAccessDiagnostic({status:'login_required',searchDiagnostic:secret,rejected:[{reason:'detail_login_required',diagnostic:secret,title:'SECRET'}]});
 assert.equal(d.search.loginVisible,true);assert.equal(d.details[0].mainFound,true);assert.equal(d.details[0].reason,'detail_login_required');assert.doesNotMatch(JSON.stringify(d),/SECRET/);
});
test('after a cooldown expires merchant photos defer until procurement actually checks access',()=>{
 const retryAt='2026-10-01T14:52:54.904Z',access={allowed:true,reason:'login_required',retryAt};
 const before={checkedAt:'2026-10-01T14:50:34.875Z',accounts:[{scanStats:{xianyuScanned:0}}],login:{xianyuAccess:{allowed:false}}};
 assert.deepEqual(merchantXianyuAccess(before,access),{allowed:false,reason:'awaiting_procurement_check'});
 assert.equal(merchantXianyuAccess({...before,checkedAt:'2026-10-01T15:00:00Z',login:{xianyuAccess:{allowed:true}}},access).allowed,false);
 const checked={...before,checkedAt:'2026-10-01T15:00:00Z',accounts:[{scanStats:{xianyuScanned:1}}],login:{xianyuAccess:{allowed:true}}};
 assert.equal(merchantXianyuAccess(checked,access).allowed,true);
 assert.equal(merchantXianyuAccess({...checked,checkedAt:'2026-10-01T14:50:00Z'},access).allowed,false);
 assert.equal(merchantXianyuAccess(checked,{...access,allowed:false}).allowed,false);
 assert.equal(merchantXianyuAccess({}, {allowed:true,reason:null}).allowed,true);
});
