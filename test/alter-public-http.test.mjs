import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {alterDetailHTML,observedAlterOwn} from './fixtures/alter-procurement.mjs';
import {ALTER_NARBERAL_URL} from '../scripts/lib/alter-procurement.mjs';
import {parseAlterPublicHTML,readAlterPublicHTTP} from '../scripts/lib/alter-public-http.mjs';
import {alternativeProcurementCost,readPublicProcurementDetail} from '../scripts/lib/procurement-sources.mjs';
import {runPublicProcurement} from '../scripts/lib/procurement-runner.mjs';
import {compactDashboardResult} from '../scripts/lib/publish.mjs';
import {chooseProcurementReference} from '../scripts/lib/procurement-reference.mjs';
import {nativeSupplierQuotesMarkup} from '../public/native-supplier-quotes.js';
import {normalizeNativeSupplierDetail,currentNativeSupplierQuotes} from '../scripts/lib/native-supplier-quotes.mjs';
import {procurementTarget} from '../scripts/lib/procurement-evidence.mjs';

// Minimal server-template reconstruction based on the public HTTP observation
// of 2026-10-16. No network, live owned-inventory or current stock is asserted by
// this fixture. Production records carry their actual response hash/timestamp.
export const httpHTML=alterDetailHTML
 .replace('<span style="display:none">原价：</span><em style="display:none">￥0.00</em>','<span class="xs2">原价：</span><em class="xs2">￥0.00</em>')
 .replace('<span id="yuan">全额：</span>','<span id="yuan">促销价：</span>')
 .replace('<span style="display:none">定金：</span><em style="display:none">￥0.00</em>','<span class="xs">定金：</span><em class="xs">￥0.00</em>')
 .replace('</body>',`<input id="Stock" value="1"><script>$(function(){if("2" == 2){$(".xs").hide();}if("0.00" == 0 || "0.00" == null){$(".xs2").hide();$("#yuan").html("全额：");}else{$("#yuan").html("促销价：");}});</script></body>`);
const subject=()=>structuredClone(observedAlterOwn);
const fetchedAt=new Date().toISOString();
const receipt={finalUrl:ALTER_NARBERAL_URL,httpStatus:200,fetchedAt};
const response=(body=httpHTML,status=200,headers={})=>new Response(body,{status,headers:{'content-type':'text/html',...headers}});

test('public HTTP template produces an exact native quote without inventing landed freight or seal',()=>{
 const quote=parseAlterPublicHTML(httpHTML,subject(),receipt);
 assert.equal(quote.status,'quoted');assert.equal(quote.unitCNY,1120);assert.equal(quote.skuId,'AL20744');assert.equal(quote.quantity,1);assert.equal(quote.inStock,true);assert.equal(quote.purchaseLimit,1);
 assert.equal(quote.shippingKnown,false);assert.equal(quote.shippingCNY,null);assert.equal(quote.landedCNY,null);
 assert.equal(quote.nativeObservation.selectedOffer.condition.status,'unknown');assert.equal(quote.nativeObservation.selectedOffer.shipping.applicability,'unconfirmed');
 assert.equal(quote.provenance.fetchedAt,fetchedAt);assert.equal(quote.provenance.contentSha256,createHash('sha256').update(httpHTML).digest('hex'));
});
test('HTTP template rejects deposit, ambiguous prices, SKU/stock mismatch and hidden product roots',()=>{
 for(const html of [httpHTML.replace('"2" == 2','"1" == 2'),httpHTML.replace('"0.00" == 0','"100.00" == 0'),httpHTML.replace('￥0.00','￥100.00'),httpHTML.replace('AL20744','AL99999'),httpHTML.replace('有库存','无库存'),httpHTML.replace('RMB 1120元','RMB 100元'),httpHTML.replace('value="1"','value="2"'),httpHTML.replace('PVC&amp;ABS涂装完成品','配件'),httpHTML.replace('class="spot_one','style="display:none" class="spot_one'),httpHTML.replace('<h2>','<h2><p class="plis"><span id="yuan">促销价：</span>￥100</p>')]){
  assert.notEqual(parseAlterPublicHTML(html,subject(),receipt).status,'quoted');
 }
 for(const suffix of ['<iframe src="/captcha"></iframe>','<input type="password">'])assert.equal(parseAlterPublicHTML(httpHTML+suffix,subject(),receipt).status,'unavailable');
});
test('HTTP reader stops on blocked/redirected/oversize responses without a browser or retry',async()=>{
 for(const status of [302,401,403,412,429,503]){let calls=0;const result=await readAlterPublicHTTP(ALTER_NARBERAL_URL,{item:subject(),request:async()=>{calls++;return response('',status,{location:'/login.html'})}});assert.equal(calls,1);assert.equal(result.status,'unavailable');assert.equal(result.nativeObservation,undefined)}
 let calls=0;assert.equal((await readAlterPublicHTTP(ALTER_NARBERAL_URL,{item:{title:'wrong product'},request:async()=>{calls++;return response()}})).reason,'target_product_mismatch');assert.equal(calls,0);
 assert.equal((await readAlterPublicHTTP(ALTER_NARBERAL_URL,{item:subject(),request:async()=>response('x'.repeat(150001))})).reason,'public_response_too_large');
 const quote=await readPublicProcurementDetail(ALTER_NARBERAL_URL,{item:subject(),request:async()=>response(),getContext:()=>{throw Error('browser must not be opened')}});assert.equal(quote.status,'quoted');
});
test('HTTP receipt hashes original bytes and rejects invalid UTF-8 without a replacement-character quote',async()=>{
 const bytes=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(httpHTML)]);
 const quote=await readAlterPublicHTTP(ALTER_NARBERAL_URL,{item:subject(),request:async()=>response(bytes)});
 assert.equal(quote.status,'quoted');assert.equal(quote.provenance.contentSha256,createHash('sha256').update(bytes).digest('hex'));
 const malformed=Buffer.concat([Buffer.from(httpHTML),Buffer.from([0xff])]);
 const failed=await readAlterPublicHTTP(ALTER_NARBERAL_URL,{item:subject(),request:async()=>response(malformed)});
 assert.equal(failed.reason,'public_response_invalid_encoding');assert.equal(failed.nativeObservation,undefined);
});
test('real producer shape survives runner, JSON storage, publication and UI while cost stays missing',async()=>{
 const item=subject();let reads=0;
 const results=await runPublicProcurement([[{item,prior:{}}]],{deadline:Date.now()+30000,lookup:(target,options)=>alternativeProcurementCost(target,{...options,
  detail:(url,opts)=>readPublicProcurementDetail(url,{...opts,request:async()=>{reads++;return response()}}),
  fingerprint:async()=>null,search:async()=>{throw Error('unrelated search must not run')}})});
 assert.equal(reads,1);const reference=results.get(item.accountId+':'+item.id);
 assert.equal(reference.nativeSupplierQuotes.length,1);assert.equal(reference.detailCheckedCount,1);assert.equal(reference.status,'unavailable');
 const stored=JSON.parse(JSON.stringify({...item,procurementSource:reference}));
 const packed=compactDashboardResult({items:[stored]}).items[0];
 assert.equal(packed.nativeSupplierQuotes.length,1);assert.deepEqual(packed.procurementSource.nativeSupplierQuotes,[]);
 assert.equal(packed.nativeSupplierQuotes[0].checkedAt,reference.nativeSupplierQuotes[0].checkedAt);
 assert.equal(chooseProcurementReference(stored),null);assert.equal(chooseProcurementReference(packed),null);
 const markup=nativeSupplierQuotesMarkup(packed);assert.match(markup,/1,120 CNY/);assert.match(markup,/运费适用地区待核验/);assert.match(markup,/成色／封装未注明/);
 const changed={...stored,title:stored.title+' 1/7'};assert.deepEqual(compactDashboardResult({items:[changed]}).items[0].nativeSupplierQuotes,[]);
 const expired=compactDashboardResult({items:[stored]},{now:Date.parse(reference.nativeSupplierQuotes[0].checkedAt)+86400001}).items[0];assert.deepEqual(expired.nativeSupplierQuotes,[]);
});
test('new same-target stock-out retires a prior native quote; network failure cannot renew it',()=>{
 const item=subject(),observation=parseAlterPublicHTML(httpHTML,item,receipt).nativeObservation;
 const quote=normalizeNativeSupplierDetail(item,observation),later=new Date(Date.parse(fetchedAt)+1000).toISOString();
 const reference={attempted:true,checkedAt:later,target:procurementTarget(item),nativeSupplierQuotes:[],diagnostics:[{url:ALTER_NARBERAL_URL,reason:'out_of_stock'}]};
 assert.deepEqual(currentNativeSupplierQuotes({...item,nativeSupplierQuotes:[quote],procurementSource:reference},{now:Date.parse(later)}),[]);
 for(const changed of [{...reference,diagnostics:[{url:ALTER_NARBERAL_URL,reason:'source_http_502'}]},{...reference,target:{...reference.target,id:'other'}},{...reference,diagnostics:{}},{...reference,checkedAt:new Date(Date.parse(later)+1000).toISOString()},{...reference,checkedAt:new Date(Date.parse(fetchedAt)-1000).toISOString()}]){
  const retained=currentNativeSupplierQuotes({...item,nativeSupplierQuotes:[quote],procurementSource:changed},{now:Date.parse(later)});assert.equal(retained.length,1);assert.equal(retained[0].checkedAt,fetchedAt);
 }
});
