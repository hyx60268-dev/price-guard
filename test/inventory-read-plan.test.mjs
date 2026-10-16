import test from 'node:test';
import assert from 'node:assert/strict';
import {inventoryReadPlan} from '../scripts/lib/inventory-read-plan.mjs';

const title='新品 中国限定 fixture-PRIVATE-title アクリルスタンド';
const row=id=>({id,platform:'yahoo',comparisonMode:'same_platform',title,url:'https://paypayfleamarket.yahoo.co.jp/item/'+id});
const context=(id,rows,prior=[])=>({account:{id,platform:'yahoo'},profileStatus:'live',profileDiscovery:{pages:2},activeItems:rows,previousById:new Map(prior.map(item=>[item.id,item]))});
test('inventory counts use exact collector queries without claiming repeated queries are same SKUs',()=>{
 const input=[context('a',[row('own-a')]),context('b',[row('own-b'),{...row('own-c'),title:title+' 2個セット'}])];
 const result=inventoryReadPlan(input);
 assert.equal(result.items,3);assert.equal(result.platforms.yahoo.items,3);assert.equal(result.platforms.yahoo.uniquePrimarySearchQueries,1);
 assert.equal(result.platforms.yahoo.repeatedPrimaryQueryItems,2);assert.equal(result.platforms.yahoo.uniqueOwnDetailPages,3);assert.equal(result.canonicalSkuGroups,null);
 assert.deepEqual(result.accounts.map(x=>x.items),[1,2]);assert.equal(result.platforms.rakuma.items,0);
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE|https:|own-a|own-b|own-c/);
});
test('stored source links and seller page lower bounds are deduplicated without granting quote acceptance',()=>{
 const candidate={id:'outside',url:'https://paypayfleamarket.yahoo.co.jp/item/outside',sellerId:'PRIVATE-seller'};
 const prior=['own-a','own-b'].map(id=>({id,yahoo:{candidates:[candidate,candidate]},xianyu:{samples:[{url:'https://www.goofish.com/item?id=123'}]},procurementSource:{samples:[{url:'https://supplier.example/detail/1'}]},nativeSupplierQuotes:[{url:'javascript:invalid'}]}));
 const result=inventoryReadPlan([context('a',[row('own-a'),row('own-b')],prior)]);
 assert.equal(result.platforms.yahoo.itemsWithStoredCandidates,2);assert.equal(result.platforms.yahoo.uniqueStoredCandidatePages,1);
 assert.equal(result.platforms.yahoo.storedCandidateSellers,1);assert.equal(result.platforms.yahoo.linkedOffersOnlySellerPageLowerBound,1);
 assert.deepEqual(result.supplierLinks,{itemsWithStoredLinks:2,uniqueStoredDetailUrls:2});
 assert.match(result.limits,/need binding and current detail verification/);assert.doesNotMatch(JSON.stringify(result),/PRIVATE|https:|outside|123/);
});
test('cross-platform planning retains all required searches and distinguishes failed inventory observations',()=>{
 const input=context('a',[{...row('own-a'),comparisonMode:'cross_platform'}]);input.profileStatus='error';delete input.profileDiscovery;
 const result=inventoryReadPlan([input]);
 assert.deepEqual(Object.values(result.platforms).map(x=>x.items),[1,1,1]);assert.equal(result.platforms.rakuma.uniqueOwnDetailPages,0);
 assert.equal(result.accounts[0].inventoryObservation,'error');assert.equal(result.accounts[0].observedProfilePages,null);
 assert.equal(inventoryReadPlan().items,0);
});

test('malformed optional restored evidence cannot make nonessential planning diagnostics abort a scan',()=>{
 for(const value of [{},null,'malformed',[null,{}]]){
  const prior={id:'own-a',yahoo:{candidates:value},xianyu:{samples:value},procurementSource:{samples:value},nativeSupplierQuotes:value};
  const result=inventoryReadPlan([null,context('a',[row('own-a'),null],[prior])]);
  assert.equal(result.items,1);assert.equal(result.platforms.yahoo.uniqueStoredCandidatePages,0);assert.equal(result.supplierLinks.uniqueStoredDetailUrls,0);
 }
 const result=inventoryReadPlan([context('a',[{...row('own-a'),title:null}])]);
 assert.equal(result.missingTitles,1);assert.equal(result.platforms.yahoo.itemsWithPrimaryQuery,0);assert.equal(result.platforms.yahoo.repeatedPrimaryQueryItems,0);
});
