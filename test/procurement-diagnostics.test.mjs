import test from 'node:test';
import assert from 'node:assert/strict';
import { publicHtml,publicAccessRoute } from '../scripts/lib/external-images.mjs';
import { parsePublicProcurementDetail,readPublicProcurementDetail,safeProcurementDiagnostic,alternativeProcurementCost } from '../scripts/lib/procurement-sources.mjs';
const url='https://item.jd.com/123.html',title='Myethos 荒芜拉普兰德 手办 1/7';
const product={'@type':'Product',url,name:title,description:title,sku:'123',image:['https://images.example.org/product.jpg'],offers:{'@type':'Offer',price:'999',priceCurrency:'CNY',availability:'https://schema.org/InStock',itemCondition:'https://schema.org/NewCondition',seller:{'@id':'https://item.jd.com/shop/one',name:'店一'},shippingDetails:{shippingRate:{currency:'CNY',value:8},shippingDestination:{addressCountry:'CN'}}}};
const ld=value=>'<script type="application/ld+json">'+JSON.stringify(value)+'</script>';
const fp={dHash:'0011223344556677',aHash:'1122334455667788',centerHash:'2233445566778899',color:[12,34,56],colorGrid:[12,34,56,70,20,99]};
const item={accountId:'owner',id:'z1',title,image:'https://images.example.org/own.jpg',description:title,condition:''};

test('metadata fetch stops before a real auth redirect and retains only bounded public diagnostics downstream',async()=>{
 const requested=[],login='https://passport.jd.com/new/login.aspx?returnUrl=secret&token=secret';
 const response=await publicHtml(url,{withMetadata:true,request:async target=>{requested.push(target);return new Response(null,{status:302,headers:{location:login}})}});
 assert.deepEqual(requested,[url]);assert.equal(response.metadata.finalUrl,login);assert.equal(response.metadata.accessRoute,'login');
 const result=parsePublicProcurementDetail(response.html,url,{metadata:response.metadata});
 assert.equal(result.reason,'source_login_required');assert.equal(result.reviewComplete,false);assert.deepEqual(result.diagnostic.redirectHosts,['passport.jd.com']);assert.equal(result.diagnostic.httpStatus,302);assert.equal(result.diagnostic.stoppedBeforeAccess,true);
 for(const forbidden of ['secret','returnUrl','token','login.aspx','finalUrl'])assert.equal(JSON.stringify(result).includes(forbidden),false);
});

test('ordinary fetch and canonical mobile redirects retain the same HTML interface and exact target requirement',async()=>{
 const html=ld(product);assert.equal(await publicHtml(url,{request:async()=>new Response(html)}),html);
 let calls=0;const mobile='https://item.m.jd.com/ware/view.action?wareId=123&from=login';
 const response=await publicHtml(url,{withMetadata:true,request:async()=>++calls===1?new Response(null,{status:302,headers:{location:mobile}}):new Response(html)});
 assert.equal(response.html,html);assert.equal(response.metadata.responseBytes,Buffer.byteLength(html));assert.equal(parsePublicProcurementDetail(response.html,url,{metadata:response.metadata}).status,'quoted');
 assert.equal(publicAccessRoute(url+'?returnUrl=https://passport.jd.com/login&token=login'),null);
 const wrong=parsePublicProcurementDetail(html,url,{metadata:{finalUrl:'https://item.jd.com/456.html',httpStatus:200}});assert.equal(wrong.reason,'target_redirect_mismatch');assert.equal(wrong.reviewComplete,false);
});

test('auth status, challenge route, missing schema and wrong target produce distinct unread reasons',()=>{
 const cases=[['',{},'structured_data_missing'],['<script type="application/ld+json">{broken</script>',{},'structured_data_invalid'],[ld({'@type':'Organization'}),{},'structured_product_missing'],[ld({...product,url:'https://item.jd.com/456.html'}),{},'target_product_mismatch'],[ld([product,product]),{},'target_product_ambiguous'],['',{httpStatus:401},'source_login_required'],['',{httpStatus:403},'source_http_403'],['',{finalUrl:'https://item.jd.com/punish?token=secret'},'source_challenge']];
 for(const [html,metadata,reason] of cases){const result=parsePublicProcurementDetail(html,url,{metadata});assert.equal(result.reason,reason);assert.equal(result.reviewComplete,false);assert.equal(JSON.stringify(result).includes('secret'),false);}
 assert.equal(parsePublicProcurementDetail(ld({...product,sku:null}),url).reason,'sku_unconfirmed');assert.equal(parsePublicProcurementDetail(ld({...product,sku:null}),url).reviewComplete,true);
});

test('hidden login forms and ordinary buttons never override a complete target-bound public offer',()=>{
 const login='<button class="login-button">登录</button><form style="display:none"><input type="password"></form>';
 const result=parsePublicProcurementDetail(login+ld(product),url,{metadata:{finalUrl:url+'?from=login',httpStatus:200}});
 assert.equal(result.status,'quoted');assert.equal(result.unitCNY,999);assert.equal(result.shippingCNY,8);assert.equal(result.diagnostic.loginFormPresent,true);assert.equal(result.diagnostic.targetUrlMatched,true);
 const unread=parsePublicProcurementDetail(login,url);assert.equal(unread.reason,'structured_data_missing');assert.notEqual(unread.reason,'source_login_required');
});

test('safe diagnostics allow only finite bounded structure, never raw account state or arbitrary properties',()=>{
 const safe=safeProcurementDiagnostic({stage:'<b>detail</b> token=secret',finalUrl:'https://passport.jd.com/login?token=secret',finalHost:'item.jd.com',redirectHosts:['passport.jd.com','https://evil.test/?token=secret'],schemaScriptCount:Infinity,responseBytes:9e9,hasPublicState:true,html:'secret',cookie:'secret',token:'secret',user:{token:'secret'},expectedLabels:Array(20).fill('白色 https://x.test/login?token=secret'),visibleOptions:[{label:'<b>白色</b>',active:true,cookie:'secret'}]});
 assert.equal(safe.finalHost,'item.jd.com');assert.deepEqual(safe.redirectHosts,['passport.jd.com']);assert.equal(safe.schemaScriptCount,undefined);assert.equal(safe.responseBytes,3_000_000);assert.equal(safe.expectedLabels.length,8);assert.equal(JSON.stringify(safe).includes('secret'),false);assert.equal(JSON.stringify(safe).includes('<b>'),false);assert.equal(safe.visibleOptions[0].active,true);
});

test('actual parser diagnostics survive the procurement report and unread detail never completes a review',async()=>{
 for(const html of ['<html><form><input type="password"></form></html>',ld({...product,url:'https://item.jd.com/456.html'})]){
  const result=await alternativeProcurementCost(item,{fingerprint:async()=>fp,search:async()=>[{url}],detail:async()=>parsePublicProcurementDetail(html,url,{metadata:{httpStatus:200,finalUrl:url}})});
  assert.equal(result.status,'unavailable');assert.equal(result.reviewedAt,undefined);assert.equal(result.detailCheckedCount,1);assert.equal(result.diagnostics[0].detail.httpStatus,200);assert.equal(result.diagnostics[0].detail.finalHost,'item.jd.com');assert.equal(result.averageCNY,null);
 }
 const complete=await alternativeProcurementCost(item,{fingerprint:async()=>fp,search:async()=>[{url}],detail:async()=>parsePublicProcurementDetail(ld({...product,sku:null}),url)});
 assert.equal(complete.status,'incomplete');assert.equal(complete.reason,'no_verified_detail');assert.ok(complete.reviewedAt);assert.equal(complete.averageCNY,null);
});

test('static reader requests metadata without losing string-only test and legacy HTML readers',async()=>{
 const quote=await readPublicProcurementDetail(url,{html:async(link,options)=>{assert.equal(options.withMetadata,true);return ld(product);}});assert.equal(quote.status,'quoted');
 const denied=await readPublicProcurementDetail(url,{html:async()=>({html:'',metadata:{finalUrl:'https://passport.jd.com/login?token=secret',httpStatus:302}})});assert.equal(denied.reason,'source_login_required');assert.equal(JSON.stringify(denied).includes('secret'),false);
 const failed=await readPublicProcurementDetail(url,{html:async()=>{throw Error('network https://passport.jd.com/login?token=secret')}});assert.equal(failed.reason,'detail_fetch_error');assert.equal(failed.diagnostic.failureKind,'network');assert.equal(failed.reviewComplete,false);assert.equal(JSON.stringify(failed).includes('secret'),false);
});

test('Youzan browser access and missing public state return bounded structural diagnostics without trying alternate pages',async()=>{
 const requested='https://detail.youzan.com/show/goods?alias=2osy35s5abbdhtd';
 for(const fixture of [{final:'https://passport.youzan.com/login?token=secret',dom:{mobile:requested,state:null},reason:'source_login_required'},{final:requested,dom:{state:null},reason:'public_state_unavailable'},{final:requested,dom:{state:{goodsData:{alias:'other',goods:{alias:'other'}}}},reason:'target_product_mismatch'}]){
  let navigations=0,closed=false;
  const page={goto:async()=>{navigations++;return {status:()=>200}},url:()=>fixture.final,evaluate:async()=>fixture.dom,waitForFunction:async()=>{},close:async()=>{closed=true}};
  const result=await readPublicProcurementDetail(requested,{item,context:{newPage:async()=>page}});assert.equal(result.reason,fixture.reason);assert.equal(result.reviewComplete,false);assert.equal(result.diagnostic.httpStatus,200);assert.equal(navigations,1);assert.equal(closed,true);assert.equal(JSON.stringify(result).includes('secret'),false);
 }
});


test('a network failure after a public redirect keeps its final host but never the final query string',async()=>{
 let requests=0;
 const html=(link,options)=>publicHtml(link,{...options,request:async()=>{if(++requests===1)return new Response(null,{status:302,headers:{location:'https://item.m.jd.com/ware/view.action?wareId=123&token=secret'}});throw Error('network socket closed');}});
 const result=await readPublicProcurementDetail(url,{html});assert.equal(result.reason,'detail_fetch_error');assert.equal(result.diagnostic.failureKind,'network');assert.equal(result.diagnostic.finalHost,'item.m.jd.com');assert.deepEqual(result.diagnostic.redirectHosts,['item.m.jd.com']);assert.equal(result.reviewComplete,false);assert.equal(JSON.stringify(result).includes('secret'),false);
});


test('a matching Youzan alias shell is unread while a complete product with missing SKU remains a negative review',async()=>{
 const requested='https://detail.youzan.com/show/goods?alias=2osy35s5abbdhtd',alias='2osy35s5abbdhtd';
 const complete={alias,title,pictures:[{url:'https://images.example.org/product.jpg'}],soldStatus:'SALE',isDisplay:1,isPhysical:true};
 for(const [goods,reviewed] of [[{alias},false],[complete,true]]){
  const page={goto:async()=>({status:()=>200}),url:()=>requested,evaluate:async()=>({state:{goodsData:{alias,goods}}}),waitForFunction:async()=>{},close:async()=>{}};
  const detail=()=>readPublicProcurementDetail(requested,{item,context:{newPage:async()=>page}});
  const quote=await detail();assert.equal(quote.reviewComplete,reviewed);assert.equal(quote.reason,reviewed?'sku_unconfirmed':'public_product_content_unavailable');
  const result=await alternativeProcurementCost(item,{fingerprint:async()=>fp,search:async()=>[{url:requested}],detail});
  assert.equal(Boolean(result.reviewedAt),reviewed);assert.equal(result.averageCNY,null);assert.equal(result.sellerCount,0);
 }
});
