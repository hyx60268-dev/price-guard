import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { PUBLIC_PROCUREMENT_VERIFICATION,procurementSource,canonicalProcurementUrl,embeddedPublicJSON,chooseYouzanSku,youzanQuoteFromPublicState,parsePublicProcurementDetail,readYouzanPublicDOM,verifiedPublicCostEvidence,alternativeProcurementCost } from '../scripts/lib/procurement-sources.mjs';
const url='https://detail.youzan.com/show/goods?alias=2osy35s5abbdhtd';
const title='Anker AeroClip 2 张凌赫 联名 礼盒 白色';
const target={accountId:'owner',id:'z1',title,image:'https://images.example.org/own.jpg'};
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
