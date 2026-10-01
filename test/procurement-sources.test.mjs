import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { PUBLIC_PROCUREMENT_VERIFICATION,procurementSource,canonicalProcurementUrl,embeddedPublicJSON,procurementSellerIdentity,chooseYouzanSku,youzanQuoteFromPublicState,parsePublicProcurementDetail,readYouzanPublicDOM,readPublicProcurementDetail,settleYouzanSelection,verifiedPublicCostEvidence,alternativeProcurementCost } from '../scripts/lib/procurement-sources.mjs';
const url='https://detail.youzan.com/show/goods?alias=2osy35s5abbdhtd';
const title='Anker AeroClip 2 张凌赫 联名 礼盒 白色';
const target={accountId:'owner',id:'z1',title,image:'https://images.example.org/own.jpg',description:title,condition:''};
const item={...target,description:title};
// Public page observed 2026-10-02: base SKU values both 119900 cents,
// selected white is 999 CNY / 84 units; red is 1199 CNY / sold out.
// Never infer the white promotion applies to red from the PC headline.
const youzan={isCloseBusiness:false,goodsData:{alias:'2osy35s5abbdhtd',goods:{alias:'2osy35s5abbdhtd',id:6370790552,kdtId:41125317,title:'Anker AeroClip 2 张凌赫 联名 礼盒',subTitle:'新品完整礼盒',soldStatus:'SALE',isDisplay:1,isPhysical:true,itemType:'NORMAL',pictures:[{url:'https://img01.yzcdn.cn/white.jpg'}]},shop:{kdtId:41125317,shopName:'Anker安克官方商城'},delivery:{supportExpress:true,canExpressReach:true,postage:{isDelivery:true,min:0,max:0,desc:'免运费'}},skuInfo:{props:[{k:'颜色',k_s:'s1',v:[{id:560443548,name:'【凌赫同款白】「声声有赫」限定礼盒'},{id:560443547,name:'【凌赫红】「声声有赫」限定礼盒'}]}],skus:[{skuId:15099721490,s1:'560443548',disableStatus:0},{skuId:15099721489,s1:'560443547',disableStatus:0}],skuStocks:[{skuId:15099721490,disable:false,stockNum:84},{skuId:15099721489,disable:false,stockNum:0}],skuPrices:[{skuId:15099721490,price:119900},{skuId:15099721489,price:119900}]}}};
const chosen={skuId:'15099721490',variant:'【凌赫同款白】「声声有赫」限定礼盒',quantity:1,visible:true,price:999,stock:84};
const now='2026-10-02T01:00:00Z';
function sample(n=1,overrides={}){return {verification:PUBLIC_PROCUREMENT_VERIFICATION,source:'jd',id:String(n),skuId:String(n),url:'https://item.jd.com/'+n+'.html',canonicalUrl:'https://item.jd.com/'+n+'.html',sellerKey:'jd:shop'+n,sellerName:'seller'+n,sellerIdentityKey:'seller'+n,unitCNY:100+n,shippingCNY:0,landedCNY:100+n,price:100+n,currency:'CNY',inStock:true,skuVerified:true,shippingKnown:true,priceSource:'target_detail',detailTitle:title,detailDescription:title,detailImages:['https://images.example.org/'+n+'.jpg'],selectedVariant:'白色',checkedAt:now,identity:{accepted:true,primaryImageScore:1,titleScore:1},target:{...target},...overrides};}
const ld=(changes={})=>'<script type="application/ld+json">'+JSON.stringify({'@type':'Product',url:'https://item.jd.com/123.html',name:title,description:title,sku:'123',color:'白色',image:['https://images.example.org/123.jpg'],offers:{'@type':'Offer',price:'999',priceCurrency:'CNY',availability:'https://schema.org/InStock',itemCondition:'https://schema.org/NewCondition',seller:{'@id':'https://item.jd.com/shop/one',name:'店一'},shippingDetails:{shippingRate:{currency:'CNY',value:8},shippingDestination:{addressCountry:'CN'}}},...changes})+'</script>';
const fp={dHash:'0011223344556677',aHash:'1122334455667788',centerHash:'2233445566778899',color:[12,34,56],colorGrid:[12,34,56,70,20,99]};

test('procurement routes accept detail URLs only and never Japan, image or news prices',()=>{
 assert.equal(procurementSource(url),'youzan');assert.equal(canonicalProcurementUrl('https://shop41317485.m.youzan.com/wscgoods/detail/2osy35s5abbdhtd?x=1'),url);
 for(const bad of ['https://jp.mercari.com/item/m123','https://www.jd.com/hprm/123.html','https://article.pchome.net/content-2197942-13.html','http://item.jd.com/123.html','https://localhost/item/123','https://item.jd.com.evil.com/123.html'])assert.equal(procurementSource(bad),null);
});
test('actual Youzan red unavailable cannot use the white 999 promotion or base price',()=>{
 assert.equal(chooseYouzanSku(youzan.goodsData,{title:'Anker AeroClip 2 ホワイト'}).skuId,'15099721490');
 assert.equal(chooseYouzanSku(youzan.goodsData,{title:'Anker AeroClip 2 レッド'}).reason,'out_of_stock');
 assert.equal(chooseYouzanSku(youzan.goodsData,{title:'Anker AeroClip 2'}).reason,'sku_unconfirmed');
 const quote=youzanQuoteFromPublicState(youzan,item,url,chosen);assert.equal(quote.status,'quoted');assert.equal(quote.unitCNY,999);assert.equal(quote.shippingCNY,0);assert.equal(quote.sellerKey,'youzan:41125317');
 assert.equal(youzanQuoteFromPublicState(youzan,{...item,title:'Anker AeroClip 2 红色'},url,chosen).reason,'out_of_stock');
 assert.equal(youzanQuoteFromPublicState(youzan,item,url).reason,'selected_sku_price_unconfirmed');
});
test('Youzan quote requires correct target, complete selected options, current stock and explicit shipping',()=>{
 for(const changed of [{...chosen,quantity:2},{...chosen,variant:'红色'},{...chosen,stock:80},{...chosen,conditionedPrice:true}])assert.equal(youzanQuoteFromPublicState(youzan,item,url,changed).status,'incomplete');
 const unknown=structuredClone(youzan);unknown.goodsData.delivery.postage.max=1000;assert.equal(youzanQuoteFromPublicState(unknown,item,url,chosen).reason,'shipping_unconfirmed');
 assert.equal(youzanQuoteFromPublicState(youzan,item,url.replace('2osy35s5abbdhtd','other'),chosen).reason,'target_product_unconfirmed');
 const other=structuredClone(youzan);other.goodsData.goods.isVirtualCoupon=true;assert.equal(youzanQuoteFromPublicState(other,item,url,chosen).status,'incomplete');
});
test('public state parsing ignores login data and only captures visible selected SKU price',()=>{
 const state={...youzan,user:{token:'must-not-leave-dom'},goodsData:youzan.goodsData};
 const dom=new JSDOM('<script>window._global = '+JSON.stringify(state)+';</script><div class="sku-container"><div class="sku-header">剩余 84 件</div><div class="sku__price-num">999</div><div class="sku-oriprice">1199</div><div class="sku-row__item--active"><span class="sku-row__item-name-text">'+chosen.variant+'</span></div><input value="1"></div>',{runScripts:'outside-only'});
 Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent}});
 dom.window.HTMLElement.prototype.getBoundingClientRect=()=>({width:100,height:100});
 const result=dom.window.eval('('+readYouzanPublicDOM.toString()+')()');assert.equal(result.selected.price,999);assert.equal(result.selected.stock,84);assert.equal(result.selected.quantity,1);assert.equal(result.state.goodsData.alias,'2osy35s5abbdhtd');assert.equal(result.state.user,undefined);
 assert.equal(embeddedPublicJSON('<script>window._global = {"a":"}\\"","n":2};</script>').n,2);
 dom.window.close();
});
test('structured product quotes require SKU-bound current CNY offer, seller, stock and freight',()=>{
 const q=parsePublicProcurementDetail(ld(),'https://item.jd.com/123.html');assert.equal(q.status,'quoted');assert.equal(q.unitCNY,999);assert.equal(q.shippingCNY,8);assert.equal(q.landedCNY,1007);
 assert.equal(parsePublicProcurementDetail(ld(),'https://item.jd.com/456.html').reason,'target_product_unconfirmed');
 const parsed=JSON.parse(ld().replace(/^.*?>/,'').replace(/<\/script>$/,''));
 for(const patch of [{url:'https://item.jd.com/999.html'},{priceValidUntil:'2020-01-01'},{itemOffered:{sku:'999'}},{priceCurrency:'JPY'},{price:'999-1199'},{availability:'https://schema.org/OutOfStock'},{seller:{name:'anonymous'}},{shippingDetails:{}},{'@type':'AggregateOffer'},{lowPrice:1},{description:'券后专享'},{description:'定金'}])assert.notEqual(parsePublicProcurementDetail(ld({offers:{...parsed.offers,...patch}}),'https://item.jd.com/123.html').status,'quoted');
 assert.equal(parsePublicProcurementDetail(ld({hasVariant:[{}]}),'https://item.jd.com/123.html').reason,'sku_unconfirmed');
});
test('two independent seller evidence is target-bound, fresh, complete and numerically consistent',()=>{
 assert.equal(verifiedPublicCostEvidence([sample(1),sample(2)],{now,target}).ready,true);
 for(const bad of [{sellerKey:'jd:shop1'},{sellerIdentityKey:'seller1'},{url:sample(1).url,canonicalUrl:sample(1).url},{shippingKnown:false},{shippingCNY:undefined},{unitCNY:0},{landedCNY:999},{checkedAt:'2026-09-30T01:00:00Z'},{checkedAt:'2026-10-03T01:00:00Z'},{target:{...target,accountId:'other'}},{identity:{accepted:true,primaryImageScore:NaN,titleScore:1}},{currency:'JPY'}])assert.equal(verifiedPublicCostEvidence([sample(1),sample(2,bad)],{now,target}).ready,false,JSON.stringify(bad));
 assert.equal(verifiedPublicCostEvidence([sample(1),sample(2,{unitCNY:999,landedCNY:999,price:999})],{now,target}).ready,false);
});
test('fallback executes public detail sources independently and never reads X cooldown',async()=>{
 const at=new Date().toISOString();let searchCalls=0,detailCalls=0;
 const run=await alternativeProcurementCost(item,{search:async()=>{searchCalls++;return [{url:'https://item.jd.com/1.html'},{url:'https://item.jd.com/2.html'}]},detail:async link=>{detailCalls++;if(link.includes('youzan'))return {status:'incomplete',reason:'test_no_youzan'};return {...sample(link.includes('/1.')?1:2,{checkedAt:at}),status:'quoted'}},fingerprint:async()=>fp});
 assert.equal(run.status,'ok');assert.equal(run.sellerCount,2);assert.ok(searchCalls);assert.ok(detailCalls>=2);assert.equal(run.averageCNY,101.5);
});
test('fallback respects account-scoped corrections, rejects wrong images, and does not invent second seller',async()=>{
 const deps={search:async()=>[{url:'https://item.jd.com/1.html'},{url:'https://item.jd.com/2.html'}],detail:async link=>link.includes('youzan')?{status:'incomplete',reason:'not_supported'}:{...sample(link.includes('/1.')?1:2),status:'quoted'},fingerprint:async()=>fp};
 const blocked=await alternativeProcurementCost(item,{...deps,matchCorrections:{r:{accountId:'owner',itemId:'z1',candidateId:'2',platform:'procurement',deleted:false}}});assert.equal(blocked.status,'incomplete');assert.equal(blocked.averageCNY,null);assert.equal(blocked.sellerCount,1);assert.ok(blocked.diagnostics.some(d=>d.reason==='rejected_by_memory'));
 const wrong=await alternativeProcurementCost(item,{...deps,fingerprint:async url=>url===item.image?fp:{...fp,dHash:'ffffffffffffffff',aHash:'ffffffffffffffff',centerHash:'ffffffffffffffff'}});assert.equal(wrong.sellerCount,0);assert.equal(wrong.averageCNY,null);
});
test('deadlines and all-source errors never report a completed cost reference',async()=>{
 const deadline=await alternativeProcurementCost(item,{deadline:Date.now()-1,fingerprint:async()=>fp});assert.equal(deadline.status,'deferred');assert.equal(deadline.averageCNY,null);
 const error=await alternativeProcurementCost({...item,title:'精确商品 白色'},{fingerprint:async()=>fp,search:async()=>{throw Error('search_challenge')}});assert.equal(error.status,'unavailable');assert.equal(error.averageCNY,null);assert.equal(error.reviewedAt,undefined);
});

test('successful search plus blocked detail does not mark a completed procurement review',async()=>{
 const result=await alternativeProcurementCost(item,{fingerprint:async()=>fp,search:async()=>[{url:'https://item.jd.com/1.html'}],detail:async()=>({status:'unavailable',reason:'source_challenge'})});assert.equal(result.status,'unavailable');assert.equal(result.reviewedAt,undefined);assert.equal(result.averageCNY,null);
});

async function checkOriginalIdentity(sourceItem,quoteOverrides={}){
 return alternativeProcurementCost(sourceItem,{fingerprint:async()=>fp,search:async()=>[{url:'https://item.jd.com/1.html'},{url:'https://item.jd.com/2.html'}],detail:async link=>link.includes('youzan')?{status:'incomplete',reason:'not_supported'}:{...sample(link.includes('/1.')?1:2),status:'quoted',detailTitle:sourceItem.title.replace(/新品未開封 |新品 |未開封 /g,''),detailDescription:'商品说明',selectedVariant:'红色',condition:'retail_unspecified',...quoteOverrides}});
}
test('original new/sealed constraint survives search title cleanup for every shop account',async()=>{
 for(const accountId of ['老板雅虎','メロン','third-managed-shop']){
  const sourceItem={...item,accountId,title:'新品未開封 Anker AeroClip 2 張凌赫 レッド ギフトボックス',description:'商品说明'};
  const result=await checkOriginalIdentity(sourceItem);assert.equal(result.sellerCount,0);assert.equal(result.averageCNY,null);assert.ok(result.diagnostics.some(d=>d.reason==='sealed_condition_unconfirmed'));
  const schemaNew=await checkOriginalIdentity(sourceItem,{condition:'new',conditionEvidence:'https://schema.org/NewCondition'});assert.equal(schemaNew.sellerCount,0);
  const plainNew=await checkOriginalIdentity({...sourceItem,title:sourceItem.title.replace('新品未開封','新品')},{condition:'new',conditionEvidence:'https://schema.org/NewCondition'});assert.equal(plainNew.status,'ok');
  const sealedNew=await checkOriginalIdentity(sourceItem,{detailDescription:'全新未拆封完整礼盒',conditionEvidence:'https://schema.org/NewCondition'});assert.equal(sealedNew.status,'ok');
  const contradictory=await checkOriginalIdentity(sourceItem,{detailDescription:'全新未拆封，已开封验货',conditionEvidence:'https://schema.org/NewCondition'});assert.equal(contradictory.sellerCount,0);
  const fakeNew=await checkOriginalIdentity(sourceItem,{condition:'new'});assert.equal(fakeNew.sellerCount,0);
 }
});
test('full source detail condition and description remain hard constraints',async()=>{
 const sourceItem={...item,title:'Anker AeroClip 2 張凌赫 レッド ギフトボックス',description:'商品说明',sourceDetail:{condition:{name:'新品、未使用'},description:'红色完整礼盒'}};
 const result=await checkOriginalIdentity(sourceItem);assert.equal(result.sellerCount,0);assert.ok(result.diagnostics.some(d=>d.reason==='condition_or_packaging_mismatch'));
 const used=await checkOriginalIdentity(sourceItem,{detailDescription:'已开封 二手',conditionEvidence:'https://schema.org/NewCondition'});assert.equal(used.sellerCount,0);
});
test('quantity and version at the end of long original titles are never replaced by truncated search words',async()=>{
 const base='Anker AeroClip 2 張凌赫 レッド ギフトボックス '+ '記念商品 '.repeat(25);
 for(const [suffix,wrong,reason]of [['2点セット','1点','sale_unit_mismatch'],['A版','B版','explicit_variant_mismatch']]){
  const result=await checkOriginalIdentity({...item,title:base+suffix,description:'商品说明'},{detailTitle:base+wrong});assert.equal(result.sellerCount,0);assert.ok(result.diagnostics.some(d=>['sale_unit_mismatch','explicit_variant_mismatch'].includes(d.reason)),JSON.stringify(result.diagnostics));
  const same=await checkOriginalIdentity({...item,title:base+suffix,description:'商品说明'},{detailTitle:base+suffix});assert.equal(same.status,'ok',JSON.stringify(same.diagnostics));
 }
});
test('structured national currency does not make regional shipping universally applicable',()=>{
 const parsed=JSON.parse(ld().replace(/^.*?>/,'').replace(/<\/script>$/,''));
 for(const restriction of [{addressRegion:'广东省'},{addressLocality:'广州市'},{postalCode:'510000'},{postalCodeRange:{postalCodeBegin:'510000',postalCodeEnd:'519999'}}]){
  const offers={...parsed.offers,shippingDetails:{...parsed.offers.shippingDetails,shippingDestination:{addressCountry:'CN',...restriction}}};assert.equal(parsePublicProcurementDetail(ld({offers}),'https://item.jd.com/123.html').reason,'shipping_destination_unconfirmed');
 }
});

test('Chinese recall aliases do not require removing Japanese hard condition or colour constraints',async()=>{
 const sourceItem={...item,title:'新品未開封 Anker AeroClip 2 張凌赫 レッド ギフトボックス',description:'商品说明'};
 const result=await checkOriginalIdentity(sourceItem,{detailTitle:'Anker AeroClip 2 张凌赫 联名 红色 礼盒',detailDescription:'全新未拆封完整礼盒',conditionEvidence:'https://schema.org/NewCondition'});assert.equal(result.status,'ok',JSON.stringify(result.diagnostics));
 const wrong=await checkOriginalIdentity(sourceItem,{detailTitle:'Anker AeroClip 2 张凌赫 联名 白色 礼盒',selectedVariant:'白色',detailDescription:'全新未拆封完整礼盒',conditionEvidence:'https://schema.org/NewCondition'});assert.equal(wrong.sellerCount,0);
});

test('same Anker official business across marketplaces cannot supply two independent seller votes',()=>{
 const officialNames=['Anker安克官方商城','安克官方旗舰店','Anker天猫官方旗舰店','安克京东自营官方旗舰店'];
 for(const name of officialNames)assert.equal(procurementSellerIdentity(name),'brand_official:anker');
 const a=sample(1,{sellerName:officialNames[0],sellerIdentityKey:procurementSellerIdentity(officialNames[0])});
 const b=sample(2,{source:'tmall',url:'https://detail.tmall.com/item.htm?id=2',canonicalUrl:'https://detail.tmall.com/item.htm?id=2',sellerKey:'tmall:shop2',sellerName:officialNames[1],sellerIdentityKey:procurementSellerIdentity(officialNames[1])});
 assert.equal(verifiedPublicCostEvidence([a,b],{now,target}).sellerCount,1);assert.equal(verifiedPublicCostEvidence([a,b],{now,target}).ready,false);
 const parsed=JSON.parse(ld().replace(/^.*?>/,'').replace(/<\/script>$/,''));
 const jd=parsePublicProcurementDetail(ld({offers:{...parsed.offers,seller:{'@id':'https://item.jd.com/shop/anker',name:officialNames[1]}}}),'https://item.jd.com/123.html');
 assert.equal(jd.sellerIdentityKey,youzanQuoteFromPublicState(youzan,item,url,chosen).sellerIdentityKey);
});
test('ordinary stores selling Anker stay independent and raw old quote identity keys are recomputed',async()=>{
 assert.notEqual(procurementSellerIdentity('小明数码店 Anker专区'),procurementSellerIdentity('老王数码店 Anker专区'));
 assert.notEqual(procurementSellerIdentity('非官方安克数码店'),'brand_official:anker');
 const run=async names=>alternativeProcurementCost(item,{fingerprint:async()=>fp,search:async()=>[{url:'https://item.jd.com/1.html'},{url:'https://item.jd.com/2.html'}],detail:async link=>{if(link.includes('youzan'))return {status:'incomplete',reason:'fixture'};const n=link.includes('/1.')?1:2;return {...sample(n),status:'quoted',sellerName:names[n-1],sellerIdentityKey:'stale_raw_name_'+n}}});
 const official=await run(['Anker安克官方商城','安克官方旗舰店']);assert.equal(official.sellerCount,1);assert.equal(official.averageCNY,null);
 const retail=await run(['小明数码店 Anker专区','老王数码店 Anker专区']);assert.equal(retail.sellerCount,2);assert.equal(retail.status,'ok');
});


test('Youzan detail reader ignores hidden stale SKU sheets in both waits and final quote',async()=>{
 const html='<script>window._global = '+JSON.stringify(youzan)+';</script><div class="goods-title__main-text">'+title+'</div><div style="display:none"><div class="sku-container"><div class="sku-row__item--active"><span class="sku-row__item-name-text">红色旧弹层</span></div></div></div><div class="sku-container"><div class="sku-header">剩余 84 件</div><div class="sku__price-num">999</div><div class="sku-row__item--active"><span class="sku-row__item-name-text">'+chosen.variant+'</span><span class="sku-row__item-price">¥999</span></div><input value="1"></div>';
 const dom=new JSDOM(html,{runScripts:'outside-only'});
 Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent}});
 dom.window.HTMLElement.prototype.getBoundingClientRect=()=>({width:100,height:100});
 let closed=false,waits=0;
 const page={goto:async()=>{},url:()=>url,evaluate:async fn=>dom.window.eval('('+fn.toString()+')()'),locator:selector=>{assert.ok(selector.includes(':visible'));return {allTextContents:async()=>[chosen.variant]};},waitForFunction:async(fn,arg)=>{assert.equal(Boolean(dom.window.eval('('+fn.toString()+')('+JSON.stringify(arg)+')')),true);waits++;},waitForTimeout:async()=>{},close:async()=>{closed=true}};
 const result=await readPublicProcurementDetail(url,{item,context:{newPage:async()=>page}});
 assert.equal(result.status,'quoted');assert.equal(result.unitCNY,999);assert.equal(result.skuId,'15099721490');assert.equal(waits,2);assert.equal(closed,true);
 dom.window.close();
});

const selectionSnapshot=(patch={})=>({blocked:false,login:false,selected:{visible:true,labels:[chosen.variant],rowPrices:[999],price:999,stock:84,quantity:1,...patch}});
function observationPage(snapshots){let reads=0,waits=0;return {evaluate:async()=>structuredClone(snapshots[Math.min(reads++,snapshots.length-1)]),waitForTimeout:async()=>{waits++;},counts:()=>({reads,waits})};}
test('Youzan selected quote waits for dynamic price to agree with selected row and stabilize',async()=>{
 const page=observationPage([selectionSnapshot({price:1199}),selectionSnapshot(),selectionSnapshot()]);
 const result=await settleYouzanSelection(page,chooseYouzanSku(youzan.goodsData,item));
 assert.equal(result.ok,true);assert.equal(result.dom.selected.price,999);assert.deepEqual(page.counts(),{reads:3,waits:2});
});

test('Youzan unsettled or mismatched SKU price returns only safe public diagnostics',async()=>{
 for(const snapshots of [[selectionSnapshot({price:1199})],[selectionSnapshot({price:999,rowPrices:[]}),selectionSnapshot({price:1099,rowPrices:[]}),selectionSnapshot({price:1199,rowPrices:[]})],[selectionSnapshot({labels:['红色'],stock:0})]]){
  const page=observationPage(snapshots),result=await settleYouzanSelection(page,chooseYouzanSku(youzan.goodsData,item));
  assert.equal(result.ok,false);assert.equal(result.reason,'selected_sku_unsettled');assert.equal(result.status,'incomplete');
  assert.deepEqual(Object.keys(result.diagnostic).sort(),['stage','expectedLabels','visibleLabels','visiblePrice','visibleStock','quantity','visibleRowPrices'].sort());
  assert.deepEqual(result.diagnostic.expectedLabels,[chosen.variant]);assert.equal(page.counts().reads,3);
 }
});

test('Youzan selection observations stop on login or challenge without retrying the access barrier',async()=>{
 for(const blocked of ['blocked','login']){
  const page=observationPage([{...selectionSnapshot(),[blocked]:true},selectionSnapshot()]);
  const result=await settleYouzanSelection(page,chooseYouzanSku(youzan.goodsData,item));
  assert.equal(result.ok,false);assert.equal(result.status,'unavailable');assert.equal(result.reason,blocked==='blocked'?'source_challenge':'source_login_required');assert.deepEqual(page.counts(),{reads:1,waits:0});
 }
});
