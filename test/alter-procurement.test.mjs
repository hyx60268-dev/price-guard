import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {ALTER_NARBERAL_URL,readAlterPublicDOM,alterQuoteFromDOM,isAlterNarberalTarget,isAlterProcurementUrl,readAlterProcurementDetail} from '../scripts/lib/alter-procurement.mjs';
import {procurementSource,canonicalProcurementUrl,knownProcurementUrls,readPublicProcurementDetail} from '../scripts/lib/procurement-sources.mjs';
import {verifiedProcurementAuthority} from '../scripts/lib/procurement-authority.mjs';
import {procurementQuoteSelection} from '../scripts/lib/procurement-evidence.mjs';
import {alterDetailHTML,observedAlterOwn,observedAlterFingerprints} from './fixtures/alter-procurement.mjs';
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

async function observedCatalogResult(subject=structuredClone(observedAlterOwn),mutateQuote=value=>value){
 const {alternativeProcurementCost}=await import('../scripts/lib/procurement-sources.mjs');
 const quote=mutateQuote(alterQuoteFromDOM(read(),subject));
 const fp=async url=>({...observedAlterFingerprints[url===subject.image?'own':'source'],url});
 const result=await alternativeProcurementCost(subject,{fingerprint:fp,search:async()=>[],detail:async()=>quote});
 return {subject,quote,result};
}
test('observed catalog identity exposes a current retail offer without asserting unopened automatic cost',async()=>{
 const {catalogueTextDigest}=await import('../scripts/lib/reviewed-procurement-catalog.mjs');
 const {chooseProcurementReference,verifiedPurchasableProcurementOffers}=await import('../scripts/lib/procurement-reference.mjs');
 const {verifiedPublicCostEvidence}=await import('../scripts/lib/procurement-evidence.mjs');
 const {subject,quote,result}=await observedCatalogResult();
 assert.equal(catalogueTextDigest(subject.sourceDetail.description),'4b071eefc90120a19f6947febf7999e43c7079ae65e553422f6015013a2a031f');
 assert.equal(catalogueTextDigest(quote.detailDescription),'5a41a303f0fb9adb937de33ca78e4a3b456f9dbf865634fcad52c9e1955eea1f',quote.detailDescription);
 assert.equal(result.status,'incomplete');assert.equal(result.averageCNY,null);assert.deepEqual(result.samples,[]);assert.equal(result.selectedQuote,undefined);
 assert.equal(result.purchasableOffers.length,1,JSON.stringify(result.diagnostics));
 const stored={...subject,procurementSource:JSON.parse(JSON.stringify(result))};
 const offers=verifiedPurchasableProcurementOffers(stored);assert.equal(offers.length,1);
 assert.equal(offers[0].price,1120);assert.equal(offers[0].shippingCNY,0);assert.equal(offers[0].purchaseLimit,1);
 assert.equal(offers[0].eligibility,'condition_unconfirmed');assert.equal(offers[0].condition,'retail_unspecified');
 assert.ok(offers[0].identity.primaryImageScore<.98);assert.equal(offers[0].identity.method,'reviewed_catalog_identity');
 assert.equal(chooseProcurementReference(stored),null);assert.equal(verifiedPublicCostEvidence(offers).ready,false);
 assert.ok(result.diagnostics.some(row=>row.reason==='sealed_condition_unconfirmed'&&row.purchasableOffer===true));
});

test('catalog offer expires and any changed target or supplier identity revokes it',async()=>{
 const {verifiedPurchasableProcurementOffers}=await import('../scripts/lib/procurement-reference.mjs');
 const {subject,result}=await observedCatalogResult(),base={...subject,procurementSource:result};
 const time=Date.parse(result.purchasableOffers[0].checkedAt);
 assert.equal(verifiedPurchasableProcurementOffers(base,{now:time+23*3600000}).length,1);
 assert.equal(verifiedPurchasableProcurementOffers(base,{now:time+25*3600000}).length,0);
 const scenarios=[
  item=>item.accountId='other-account',item=>item.id='relisted-id',item=>item.title+=' 1/7',item=>item.image+='?different=1',
  item=>item.sourceDetail.seller.id='another-seller',item=>item.sourceDetail.description+=' 開封済み',item=>item.sourceDetail.condition={key:'used',text:'傷や汚れあり'},item=>item.sourceDetail.status='SOLD',
  item=>item.procurementSource.purchasableOffers[0].skuId='AL99999',item=>item.procurementSource.purchasableOffers[0].selectedVariant+=' 初版',
  item=>item.procurementSource.purchasableOffers[0].detailDescription+=' 1/7',item=>item.procurementSource.purchasableOffers[0].detailImages[0]+='?changed=1',
  item=>item.procurementSource.purchasableOffers[0].inStock=false,item=>item.procurementSource.purchasableOffers[0].price=900,
  item=>item.procurementSource.purchasableOffers[0].shippingKnown=false,item=>item.procurementSource.purchasableOffers[0].quantity=2,
  item=>item.procurementSource.purchasableOffers[0].catalogIdentity.supplier.imageSha256='0'.repeat(64),
  item=>item.procurementSource.purchasableOffers={unexpected:true}
 ];
 for(const change of scenarios){const changed=structuredClone(base);change(changed);assert.equal(verifiedPurchasableProcurementOffers(changed,{now:time+1}).length,0,String(change));}
 // The supplier can change its real payable price without changing product identity.
 const updated=await observedCatalogResult(undefined,quote=>({...quote,unitCNY:1190,landedCNY:1190,price:1190}));
 assert.equal(verifiedPurchasableProcurementOffers({...updated.subject,procurementSource:updated.result})[0].price,1190);
});

test('public runner retains only current bound catalog offers and never renews their age on a skip',async()=>{
 const {runPublicProcurement}=await import('../scripts/lib/procurement-runner.mjs');
 const {subject,result}=await observedCatalogResult(),key=subject.accountId+':'+subject.id;
 const checkedAt=result.purchasableOffers[0].checkedAt,now=Date.parse(checkedAt)+1000;
 const task={item:subject,prior:{procurementSource:result}};
 let calls=0;
 const run=(tasks=task,options={})=>runPublicProcurement([[tasks]],{now:()=>now,deadline:now+60000,lookup:async()=>{calls++;return {status:'error',samples:[]}},...options});
 const cached=await run();assert.equal(calls,0);assert.equal(cached.get(key).purchasableOffers.length,1);assert.equal(cached.get(key).purchasableOffers[0].checkedAt,checkedAt);
 const changed=structuredClone(task);changed.item.accountId='other-account';
 const deferred=await run(changed,{deadline:now});assert.deepEqual(deferred.get('other-account:'+subject.id).purchasableOffers,[]);
 const expired=await run(task,{now:()=>now+25*3600000,deadline:now});assert.deepEqual(expired.get(key).purchasableOffers,[]);
 const failure=await run(task,{now:()=>now+3600000,deadline:now+3600000+60000});assert.equal(calls,1);assert.deepEqual(failure.get(key).purchasableOffers,[]);assert.equal(failure.get(key).status,'error');
 const wrongReturn=structuredClone(result);wrongReturn.purchasableOffers[0].target.accountId='other-account';
 const fresh=await run({item:subject,prior:{}},{lookup:async()=>wrongReturn});assert.deepEqual(fresh.get(key).purchasableOffers,[]);
});

test('compact publication validates current full semantics before keeping a catalog offer',async()=>{
 const {compactDashboardResult}=await import('../scripts/lib/publish.mjs');
 const {procurementTarget}=await import('../scripts/lib/procurement-reference.mjs');
 const {visiblePurchasableOffers}=await import('../public/procurement-view.js');
 const {subject,result}=await observedCatalogResult(),row={...subject,description:'stale card text',condition:'used',procurementSource:result};
 const packed=compactDashboardResult({items:[row]}).items[0];
 assert.equal(packed.sourceDetail,undefined);assert.equal(packed.procurementSource.purchasableOffers.length,1);
 assert.deepEqual(packed.procurementTarget,procurementTarget(row));
 assert.equal(packed.description,procurementTarget(row).description);assert.equal(packed.condition,procurementTarget(row).condition);
 assert.equal(visiblePurchasableOffers(packed).length,1);
 for(const field of ['description','condition']){
  for(const value of ['',field==='description'?'1/7 本体なし':'開封済み']){
   const changed=structuredClone(row);changed.sourceDetail[field]=value;
   // A leftover binding from an earlier publication cannot supersede new facts.
   changed.procurementTarget=packed.procurementTarget;
   const invalid=compactDashboardResult({items:[changed]}).items[0];
   assert.deepEqual(invalid.procurementSource.purchasableOffers,[]);assert.equal(invalid.procurementTarget,undefined);
  }
 }
});

test('procurement corrections sync for displayed offers, stay account scoped and clear cached publication',async()=>{
 const {acceptMatchCorrections}=await import('../scripts/lib/match-corrections.mjs');
 const {candidateId,correctionKey,invalidateCorrectedMatches}=await import('../public/match-memory.js');
 const {compactDashboardResult}=await import('../scripts/lib/publish.mjs');
 const {runPublicProcurement}=await import('../scripts/lib/procurement-runner.mjs');
 const {subject,result}=await observedCatalogResult(),row={...subject,procurementSource:result},offer=result.purchasableOffers[0],now=Date.now();
 const raw={accountId:subject.accountId,itemId:subject.id,platform:'procurement',candidateId:candidateId('procurement',offer),candidateUrl:'https://example.test/untrusted',updatedAt:new Date(now).toISOString()};
 const incoming={[correctionKey(raw)]:raw},saved=acceptMatchCorrections({},incoming,[row],new Set([subject.accountId]),now);
 assert.equal(Object.values(saved)[0].candidateUrl,ALTER_NARBERAL_URL);assert.equal(Object.values(saved)[0].candidateId,ALTER_NARBERAL_URL);
 assert.deepEqual(invalidateCorrectedMatches(row,saved).procurementSource.purchasableOffers,[]);
 const packed=compactDashboardResult({items:[row],matchCorrections:saved}).items[0];assert.deepEqual(packed.procurementSource.purchasableOffers,[]);
 const cached=await runPublicProcurement([[{item:subject,prior:row}]],{matchCorrections:saved,now:()=>now,deadline:now+60000,lookup:async()=>{throw Error('retry should remain skipped')}});
 assert.deepEqual(cached.get(subject.accountId+':'+subject.id).purchasableOffers,[]);assert.equal(cached.get(subject.accountId+':'+subject.id).attempted,false);
 assert.throws(()=>acceptMatchCorrections({},incoming,[row],new Set(['another-account']),now),/无权/);
 assert.throws(()=>acceptMatchCorrections({}, {'bad':{...raw,candidateId:'https://unknown.test/item'}},[row],null,now),/已展示/);
 const otherAccount={...raw,accountId:'other'};
 assert.equal(compactDashboardResult({items:[row],matchCorrections:{other:otherAccount}}).items[0].procurementSource.purchasableOffers.length,1);
 const legacy=acceptMatchCorrections({}, {'legacy':{...raw,candidateId:'298'}},[row],null,now);assert.equal(Object.values(legacy)[0].candidateId,ALTER_NARBERAL_URL);
 const undo=Object.fromEntries(Object.entries(saved).map(([key,value])=>[key,{...value,deleted:true,updatedAt:new Date(now+1).toISOString()}]));
 const restored=acceptMatchCorrections(saved,undo,[row],null,now+1);assert.equal(compactDashboardResult({items:[row],matchCorrections:restored}).items[0].procurementSource.purchasableOffers.length,1);
});

test('full encrypted publication cannot retain a sidecar invalidated by a new observed description',async()=>{
 const fs=await import('node:fs/promises'),path=await import('node:path'),os=await import('node:os');
 const {writeOutputs}=await import('../scripts/lib/publish.mjs');const {decrypt}=await import('../scripts/lib/crypto.mjs');
 const {subject,result}=await observedCatalogResult(),root=await fs.mkdtemp(path.join(os.tmpdir(),'price-guard-catalog-')),password='fixture-publication-password';
 try{
  const row={...subject,sourceDetail:{...subject.sourceDetail,description:'1/7 本体なし'},procurementSource:result,ownPrice:24999};
  const data={version:6,checkedAt:new Date().toISOString(),settings:{},accounts:[{id:subject.accountId}],items:[row],manualCosts:{},managedAccounts:[]};
  await writeOutputs({root,result:data,previous:null,password});
  for(const file of ['public/data/state.json.enc','public/data/latest.json.enc']){
   const published=JSON.parse(decrypt(await fs.readFile(path.join(root,file)),password).toString('utf8'));
   assert.deepEqual(published.items[0].procurementSource.purchasableOffers,[]);assert.equal(published.items[0].procurementTarget,undefined);
  }
 }finally{
  assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('price-guard-catalog-'));
  await fs.rm(root,{recursive:true,force:true});
 }
});
