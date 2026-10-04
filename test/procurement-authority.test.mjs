import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedProcurementAuthority,matchesReviewedProcurementAuthority } from '../scripts/lib/procurement-authority.mjs';
import { PUBLIC_PROCUREMENT_VERIFICATION,verifiedPublicCostEvidence } from '../scripts/lib/procurement-evidence.mjs';
import { verifiedPublicProcurementCache,chooseProcurementReference } from '../scripts/lib/procurement-reference.mjs';
import { publicProcurementItem } from './fixtures/procurement-reference.mjs';
const now=Date.parse('2026-10-04T15:00:00Z');
const url='https://detail.youzan.com/show/goods?alias=2osy35s5abbdhtd';
const reviewed=()=>{
 const template=publicProcurementItem(now),target={...template.procurementSource.target,title:'Anker AeroClip 2 张凌赫 联名 白色礼盒',description:'白色完整礼盒一套',condition:''};
 return {...template.procurementSource.samples[0],source:'youzan',id:'2osy35s5abbdhtd',skuId:'15099721490',
  url,canonicalUrl:url,sellerKey:'youzan:41125317',sellerIdentityKey:'brand_official:anker',sellerName:'Anker安克官方商城',
  selectedVariant:'【凌赫同款白】「声声有赫」限定礼盒',unitCNY:999,shippingCNY:0,landedCNY:999,price:999,
  detailTitle:target.title,detailDescription:target.description,stock:84,quantity:1,target};
};
function cached(sample){
 const evidence=verifiedPublicCostEvidence([sample],{now,target:sample.target});
 return {...sample.target,sourceDetail:{description:sample.target.description,condition:sample.target.condition},averageCNY:evidence.referenceCNY,
  procurementSource:{status:'ok',averageCNY:evidence.referenceCNY,checkedAt:sample.checkedAt,
   verification:PUBLIC_PROCUREMENT_VERIFICATION,target:sample.target,samples:[sample],selectedQuote:evidence.selectedQuote,selectionMode:evidence.selectionMode}};
}

test('a specifically reviewed supplier quote qualifies without inventing a second seller or official-brand status',()=>{
 const quote=reviewed(),evidence=verifiedPublicCostEvidence([quote],{now,target:quote.target});
 assert.equal(evidence.ready,true);assert.equal(evidence.sellerCount,1);assert.equal(evidence.referenceCNY,999);
 assert.equal(evidence.selectedQuote.canonicalUrl,url);assert.equal(evidence.selectedQuote.skuId,'15099721490');
 assert.equal(evidence.selectionMode,'reviewed_supplier_offer');assert.equal(evidence.selectedQuote.authority.type,'reviewed_retailer');
 assert.equal(chooseProcurementReference(cached(quote),{now}).averageCNY,999);
 // Supplier review is not a hardcoded price approval: each observed payable price is retained.
 Object.assign(quote,{unitCNY:899,landedCNY:899,price:899});
 assert.equal(verifiedPublicCostEvidence([quote],{now}).referenceCNY,899);
});

test('self-claimed official names and copied supplier metadata never grant another store or SKU approval',()=>{
 const quote=reviewed();
 for(const patch of [{sellerKey:'youzan:41317485'},{skuId:'15099721489'},{selectedVariant:'【凌赫红】「声声有赫」限定礼盒'},
  {canonicalUrl:'https://detail.youzan.com/show/goods?alias=other',url:'https://detail.youzan.com/show/goods?alias=other'},
  {source:'jd',url:'https://item.jd.com/123.html',canonicalUrl:'https://item.jd.com/123.html'}]){
  const changed={...quote,...patch,authority:verifiedProcurementAuthority(quote),official:true};
  assert.equal(verifiedProcurementAuthority(changed),null,JSON.stringify(patch));
  assert.equal(verifiedPublicCostEvidence([changed],{now}).ready,false);
 }
 const ordinary={...publicProcurementItem(now).procurementSource.samples[0],sellerName:'Anker官方旗舰直营店',official:true,authority:{type:'verified_official_store'}};
 assert.equal(verifiedPublicCostEvidence([ordinary],{now}).ready,false);
});

test('reviewed supplier still requires live SKU, target identity, stock, freight and exact amount',()=>{
 for(const patch of [{skuVerified:false},{inStock:false},{shippingKnown:false},{shippingCNY:undefined},
  {identity:{accepted:true,titleScore:.9,primaryImageScore:.5}},{identity:{accepted:false,titleScore:1,primaryImageScore:1}},
  {landedCNY:1},{price:1},{checkedAt:new Date(now-86400001).toISOString()},{currency:'JPY'}]){
  assert.equal(verifiedPublicCostEvidence([{...reviewed(),...patch}],{now}).ready,false,JSON.stringify(patch));
 }
 const quote=reviewed();assert.equal(verifiedPublicCostEvidence([quote],{now,target:{...quote.target,accountId:'another-account'}}).ready,false);
});

test('comparison selects the actual lowest verified offer rather than a median no seller quotes',()=>{
 const item=publicProcurementItem(now),evidence=verifiedPublicCostEvidence(item.procurementSource.samples,{now});
 assert.equal(evidence.median,105);assert.equal(evidence.referenceCNY,100);assert.equal(evidence.selectedSample.price,100);
 assert.equal(evidence.selectionMode,'compared_seller_offer');
 const outdated=structuredClone(item);outdated.procurementSource.averageCNY=105;
 assert.equal(verifiedPublicProcurementCache(outdated,{now}),null);
 outdated.procurementSource.verification='public_procurement_detail_v2';
 assert.equal(verifiedPublicProcurementCache(outdated,{now}),null);
});

test('a conflicting unreviewed outlier does not replace the reviewed supplier or invent a blended price',()=>{
 const quote=reviewed(),other={...quote,source:'jd',url:'https://item.jd.com/42.html',canonicalUrl:'https://item.jd.com/42.html',
  sellerKey:'jd:another',sellerIdentityKey:'another',skuId:'42',unitCNY:10,landedCNY:10,price:10};
 const evidence=verifiedPublicCostEvidence([other,quote],{now});
 assert.equal(evidence.ready,true);assert.equal(evidence.referenceCNY,999);assert.equal(evidence.selectedQuote.sellerKey,'youzan:41125317');
});

test('cached selected supplier, SKU, price and evidence time cannot drift from the accepted offer',()=>{
 for(const mutate of [item=>item.procurementSource.selectedQuote.sellerKey='youzan:other',
  item=>item.procurementSource.selectedQuote.skuId='other',item=>item.procurementSource.selectedQuote.landedCNY=998,
  item=>item.procurementSource.selectedQuote.authority.type='verified_official_store',
  item=>item.procurementSource.checkedAt=new Date(now+1000).toISOString(),
  item=>item.procurementSource.selectionMode='compared_seller_offer',item=>delete item.procurementSource.selectedQuote]){
  const item=cached(reviewed());mutate(item);assert.equal(verifiedPublicProcurementCache(item,{now}),null);
 }
 const prior=cached(reviewed());prior.procurementSource.status='unavailable';prior.procurementSource.lastAttemptAt=new Date(now+1000).toISOString();
 assert.equal(verifiedPublicProcurementCache(prior,{now:now+1000}).checkedAt,new Date(now).toISOString());
 assert.equal(verifiedPublicProcurementCache(prior,{now:now+86400000}),null);
});

test('official-brand authority requires an independent brand relationship beyond platform supplier review',()=>{
 const quote=reviewed(),record={id:'future-official-record',type:'verified_official_store',source:quote.source,
  canonicalUrl:quote.canonicalUrl,sellerKey:quote.sellerKey,skuId:quote.skuId,selectedVariant:quote.selectedVariant,
  reviewedAt:'2026-10-04',evidence:{url,observation:'platform-certified supplier'}};
 assert.equal(matchesReviewedProcurementAuthority(quote,record),false);
 const checked={...record,independentEvidence:{url:'https://www.anker.com/',observation:'test-only independently audited brand relationship'}};
 assert.equal(matchesReviewedProcurementAuthority(quote,checked),true);
 // This pure record check never inserts a record into the production review list.
 assert.equal(verifiedProcurementAuthority(quote).type,'reviewed_retailer');
});
