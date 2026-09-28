import test from 'node:test';
import assert from 'node:assert/strict';
import { merchantProfile,qualifiesMerchantItem,recordMerchantObservation,merchantProducts,merchantListingDraft } from '../scripts/lib/merchant-monitor.mjs';
const merchant=merchantProfile('https://paypayfleamarket.yahoo.co.jp/user/example'),now=Date.parse('2026-09-28T01:00:00Z');
test('merchant filter is either regional keyword AND strictly more than 4999 yen',()=>{
 for(const word of ['中国限定','海外限定']){assert.equal(qualifiesMerchantItem({title:word,price:5000}),true);assert.equal(qualifiesMerchantItem({description:word,price:4999}),false);assert.equal(qualifiesMerchantItem({description:word,price:5000}),true)}
 assert.equal(qualifiesMerchantItem({title:'中国製 日本限定',price:50000}),false);
});
test('missing listing or failed scan cannot become a sale; actual transition preserves uncertainty interval',()=>{
 const first=recordMerchantObservation({},merchant,[{id:'a',status:'OPEN',title:'海外限定 cup',price:5000}],now);
 const absent=recordMerchantObservation(first,merchant,[],now+3600000);assert.equal(absent['yahoo:example:a'].status,'OPEN');
 const sold=recordMerchantObservation(absent,merchant,[{id:'a',status:'SOLD',title:'海外限定 cup',price:5000}],now+7200000);
 assert.equal(sold['yahoo:example:a'].soldAt,null);assert.equal(sold['yahoo:example:a'].soldWindowStart,new Date(now).toISOString());assert.equal(merchantProducts(sold,now+7200000)[0].event,'observed_sold');
});
test('first scan never invents today as an old SOLD listing sale date',()=>{
 const records=recordMerchantObservation({},merchant,[{id:'s',status:'SOLD',title:'中国限定 toy',price:5000}],now);
 const p=merchantProducts(records,now)[0];assert.equal(p.event,'undated_sold');assert.equal(p.soldAt,null);assert.equal(p.soldObservedAt,null);
});
test('merchant identity prevents same IDs from overwriting another seller; old dated records age out',()=>{
 const item={id:'same',status:'OPEN',title:'中国限定',price:5000};let r=recordMerchantObservation({},merchant,[item],now-31*86400000);
 r=recordMerchantObservation(r,merchantProfile('https://fril.jp/shop/another'),[item],now);assert.equal(Object.keys(r).length,2);assert.equal(merchantProducts(r,now).length,1);
});
test('configured homepages exclude arbitrary hosts and preserve template without invented authenticity or shipping',()=>{
 assert.throws(()=>merchantProfile('https://evil.test/user/example'));assert.throws(()=>merchantProfile('https://jp.mercari.com/item/m123'));
 const copy=merchantListingDraft({title:'中国限定 HIRONO マグカップ'});assert.match(copy.proposedDescription,/【商品内容】[\s\S]*【状態】/);assert.match(copy.translatedDescription,/中文翻译/);assert.doesNotMatch(copy.proposedDescription,/正規品|匿名配送|即購入OK/);
});
