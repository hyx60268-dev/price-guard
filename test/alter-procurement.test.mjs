import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {ALTER_NARBERAL_URL,readAlterPublicDOM,alterQuoteFromDOM,isAlterNarberalTarget,isAlterProcurementUrl,readAlterProcurementDetail} from '../scripts/lib/alter-procurement.mjs';
import {procurementSource,canonicalProcurementUrl,knownProcurementUrls,readPublicProcurementDetail} from '../scripts/lib/procurement-sources.mjs';
import {verifiedProcurementAuthority} from '../scripts/lib/procurement-authority.mjs';
import {procurementQuoteSelection} from '../scripts/lib/procurement-evidence.mjs';
import {alterDetailHTML} from './fixtures/alter-procurement.mjs';
const item={title:'ALTER オーバーロード ナーベラル・ガンマ so-bin Ver.フィギュア'};
function read(html=alterDetailHTML){
 const dom=new JSDOM(html,{url:ALTER_NARBERAL_URL,runScripts:'outside-only'});
 Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){const visit=n=>n.nodeType===3?n.nodeValue:n.nodeType===1&&dom.window.getComputedStyle(n).display!=='none'?[...n.childNodes].map(visit).join(''):'';return visit(this)}});
 dom.window.HTMLElement.prototype.getBoundingClientRect=()=>({width:100,height:100});
 const result=dom.window.eval('('+readAlterPublicDOM.toString()+')()');dom.window.close();return result;
}
test('direct recall requires exact brand, character and edition, and rejects conflicting scales',()=>{
 for(const title of [item.title,item.title+' 1/8','ALTER 娜贝拉尔·伽玛 so-bin Ver. 1/8 再版'])assert.equal(isAlterNarberalTarget({title}),true,title);
 for(const title of [item.title.replace('ナーベラル・ガンマ','アルベド'),item.title.replace('ALTER','OTHER'),item.title+' 1/7',item.title+' 1/80',item.title+' 初版',item.title+' AL99999'])assert.equal(isAlterNarberalTarget({title}),false,title);
 assert.deepEqual(knownProcurementUrls(item),[ALTER_NARBERAL_URL]);
 assert.equal(procurementSource(ALTER_NARBERAL_URL),'alter_shanghai');assert.equal(canonicalProcurementUrl(ALTER_NARBERAL_URL),ALTER_NARBERAL_URL);
 for(const url of [ALTER_NARBERAL_URL.replace('/298','/299'),ALTER_NARBERAL_URL+'?id=299',ALTER_NARBERAL_URL.replace('https:','http:'),ALTER_NARBERAL_URL.replace('.cn','.cn.evil.org')])assert.equal(isAlterProcurementUrl(url),false);
});
test('observed retail detail reads full price instead of hidden deposit or generic preorder terms',()=>{
 const dom=read(),quote=alterQuoteFromDOM(dom,item);
 assert.equal(quote.status,'quoted');assert.equal(quote.unitCNY,1120);assert.equal(quote.skuId,'AL20744');assert.equal(quote.shippingCNY,0);assert.equal(quote.inStock,true);
 assert.equal(quote.purchaseLimit,1);assert.match(quote.shippingMethod,/中通.*顺丰.*不适用/);
 assert.equal(quote.condition,'retail_unspecified');assert.equal(quote.conditionEvidence,undefined);
 assert.equal(verifiedProcurementAuthority(quote)?.type,'reviewed_retailer');
 const selection=procurementQuoteSelection(quote);assert.equal(selection.shippingMethod,quote.shippingMethod);assert.equal(selection.purchaseLimit,1);assert.equal(selection.deliveryTerms,quote.deliveryTerms);
 const changed=alterQuoteFromDOM(read(alterDetailHTML.replaceAll('1120','1190')),item);assert.equal(changed.unitCNY,1190);
});
test('retail target, price, stock, shipping and gallery gaps fail explicitly',()=>{
 const scenarios=[
 ['AL20744','AL20745','target_product_unconfirmed'],['全额：','定金：','full_price_unconfirmed'],
 ['有库存','无库存','out_of_stock'],['免运费','运费另议','shipping_method_unconfirmed'],
 ['中通快递（包邮）','中通快递（到付）','shipping_method_unconfirmed'],
 ['RMB 1120元','RMB 999元','price_evidence_mismatch'],['１／８','１／７','target_product_unconfirmed']];
 for(const [from,to,reason]of scenarios)assert.equal(alterQuoteFromDOM(read(alterDetailHTML.replace(from,to)),item).reason,reason,from);
 const noGallery=read();noGallery.images=[];assert.equal(alterQuoteFromDOM(noGallery,item).reason,'product_gallery_missing');
 const duplicate=read();duplicate.duplicateFields=true;assert.equal(alterQuoteFromDOM(duplicate,item).reason,'target_product_unconfirmed');
 for(const key of ['blocked','login']){const blocked=read();blocked[key]=true;assert.equal(alterQuoteFromDOM(blocked,item).status,'unavailable')}
 const other=read();other.url=other.url.replace('/298','/299');assert.equal(alterQuoteFromDOM(other,item).reason,'target_redirect_mismatch');
});
test('reader never opens a page for wrong target and never accepts a login redirect',async()=>{
 let opened=0,closed=0;
 const page={goto:async()=>({status:()=>200}),url:()=>ALTER_NARBERAL_URL,waitForFunction:async()=>{},evaluate:async()=>read(),close:async()=>{closed++}};
 const context={newPage:async()=>{opened++;return page}};
 assert.equal((await readPublicProcurementDetail(ALTER_NARBERAL_URL,{item:{title:'ALTER アルベド so-bin 1/8'},context})).reason,'target_product_mismatch');assert.equal(opened,0);
 assert.equal((await readPublicProcurementDetail(ALTER_NARBERAL_URL,{item,context})).status,'quoted');assert.equal(opened,1);assert.equal(closed,1);
 page.url=()=> 'https://www.alter-shanghai.cn/m/login.html';
 assert.equal((await readAlterProcurementDetail(ALTER_NARBERAL_URL,{item,context})).reason,'target_redirect_mismatch');assert.equal(closed,2);
});

test('new supplier invalidates only its stale negative review and preserves retry after a new attempt',async()=>{
 const {runPublicProcurement}=await import('../scripts/lib/procurement-runner.mjs');
 const {procurementTarget,PUBLIC_PROCUREMENT_VERIFICATION}=await import('../scripts/lib/procurement-evidence.mjs');
 const {hasCompletedPublicProcurementReview}=await import('../scripts/lib/procurement-reference.mjs');
 const now=Date.now(),subject={...item,id:'z-test',accountId:'owner',image:'https://images.example.org/own.jpg',description:'完整手办',condition:''};
 const negative={status:'incomplete',verification:PUBLIC_PROCUREMENT_VERIFICATION,reviewVersion:1,checkedAt:new Date(now-1000).toISOString(),reviewedAt:new Date(now-1000).toISOString(),target:procurementTarget(subject),samples:[]};
 assert.equal(hasCompletedPublicProcurementReview({...subject,procurementSource:negative},{now}),false);
 assert.equal(hasCompletedPublicProcurementReview({...subject,procurementSource:{...negative,sourcePlanVersion:2}},{now}),true);
 let reads=0;
 const task={item:subject,prior:{procurementSource:negative}};
 const options={now:()=>now,deadline:now+60000,lookup:async()=>{reads++;return {status:'incomplete',samples:[]}}};
 const fresh=await runPublicProcurement([[task]],options);assert.equal(reads,1);assert.equal(fresh.get('owner:z-test').sourcePlanVersion,2);
 task.prior.procurementSource=fresh.get('owner:z-test');await runPublicProcurement([[task]],options);assert.equal(reads,1);
});
test('complete procurement pipeline never accepts a different sale unit, accessory or release',async()=>{
 const {alternativeProcurementCost}=await import('../scripts/lib/procurement-sources.mjs');
 const fp={dHash:'0011223344556677',aHash:'1122334455667788',centerHash:'2233445566778899',color:[12,34,56],colorGrid:[12,34,56,70,20,99]};
 for(const [description,reason] of [['2体セット','sale_unit_mismatch'],['空箱のみ、フィギュア本体は付属しません','target_sale_content_mismatch'],['杖のみ、フィギュア本体なし','target_sale_content_mismatch'],['初版 2019年','target_release_mismatch'],['1/7 フィギュア','target_scale_mismatch'],['新品未開封','sealed_condition_unconfirmed']]){
  const subject={title:'ALTER OVERLORD 娜贝拉尔·伽玛 so-bin Ver.【再版】 AL20744',id:'z-test',accountId:'owner',image:'https://images.example.org/own.jpg',description};
  const quote=alterQuoteFromDOM(read(),subject);
  const result=await alternativeProcurementCost(subject,{fingerprint:async()=>fp,search:async()=>[{url:ALTER_NARBERAL_URL}],detail:async()=>quote});
  assert.notEqual(result.status,'ok',description);assert.equal(result.averageCNY,null,description);assert.ok(result.diagnostics.some(row=>row.reason===reason),JSON.stringify(result.diagnostics));
 }
});

test('identical complete catalog unit can reach selected retail quote without bypassing condition',async()=>{
 const {alternativeProcurementCost}=await import('../scripts/lib/procurement-sources.mjs');
 const fp={dHash:'0011223344556677',aHash:'1122334455667788',centerHash:'2233445566778899',color:[12,34,56],colorGrid:[12,34,56,70,20,99]};
 const subject={title:'ALTER OVERLORD 娜贝拉尔·伽玛 so-bin Ver.【再版】 AL20744',id:'fixture',accountId:'fixture',image:'https://images.example.org/own.jpg',description:'AL20744 1/8 完整手办'};
 const quote=alterQuoteFromDOM(read(),subject);
 // Identical fingerprints here are a fixture, never a live identity assertion.
 const result=await alternativeProcurementCost(subject,{fingerprint:async()=>fp,search:async()=>[],detail:async()=>quote});
 assert.equal(result.status,'ok',JSON.stringify(result.diagnostics));assert.equal(result.averageCNY,1120);
 assert.equal(result.selectedQuote.deliveryTerms,quote.deliveryTerms);
});
