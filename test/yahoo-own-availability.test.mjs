import test from 'node:test';
import assert from 'node:assert/strict';
import {yahooCompare} from '../scripts/lib/yahoo.mjs';
import {MATCHING_RULES_VERSION} from '../scripts/lib/rules.mjs';
import {pricingDecision} from '../public/pricing-policy.js';
import {pricingCoverage} from '../scripts/lib/pricing-coverage.mjs';
import {violetReports} from './fixtures/yahoo-violet-reports.mjs';
const report=violetReports[0],at='2026-10-16T06:43:56.817Z';
async function replay(status){
 const own={id:report.historicalOwnId,title:report.ownTitle,status,description:'controlled description',images:['controlled-image'],seller:{id:'controlled-managed'},price:28499};
 const prior={status:'ok',checkedAt:at,searchCheckedAt:at,rulesVersion:MATCHING_RULES_VERSION,candidates:[{id:'z704300094',price:28500,url:'https://paypayfleamarket.yahoo.co.jp/item/z704300094',matchMethod:'exact_bidirectional_title_identity'}]};
 const item={id:own.id,accountId:'melon',platform:'yahoo',comparisonMode:'same_platform',title:own.title,ownPrice:28499,itemStatus:'OPEN',yahoo:prior},original=structuredClone(item),reads=[];
 const result=await yahooCompare(null,item,{forceYahooBroadSearch:true},{fetchYahooItemBundle:async id=>{reads.push(id);return {detail:own,recommendations:[]}},fetchYahooResult:async()=>{reads.push('search');return {items:[]}},imageFingerprints:async()=>null});
 return {result,reads,item,original};
}
for(const status of ['SOLD','CLOSED'])test(`explicit ${status} own listing cannot proceed to broad comparison or acquire fresh evidence`,async()=>{
 const {result,reads,item,original}=await replay(status);assert.deepEqual(reads,[report.historicalOwnId]);
 assert.equal(result.status,'own_not_open');assert.equal(result.checkedAt,at);assert.equal(result.searchCheckedAt,at);assert.equal(result.detailCheckedCount,0);
 assert.equal(result.lowestPrice,null);assert.deepEqual(item,original,'one detail read does not delete or rewrite the saved inventory');
 const verdict=pricingDecision({...item,yahoo:result},{now:Date.parse('2026-10-16T07:00:00Z')});assert.equal(verdict.complete,false);assert.equal(verdict.canRecommend,false);
 assert.equal(pricingCoverage([{...item,yahoo:result}],[{profileStatus:'live'}]).platforms.yahoo.checked,0);
});
for(const status of ['UNKNOWN',null])test(`explicit ${String(status)} availability is unconfirmed, never a proven closed or OPEN listing`,async()=>{
 const {result,reads}=await replay(status);assert.deepEqual(reads,[report.historicalOwnId]);assert.equal(result.status,'own_availability_unconfirmed');assert.equal(result.checkedAt,at);
});
test('OPEN remains eligible for normal discovery',async()=>{
 const {result,reads}=await replay('OPEN');assert.ok(reads.includes('search'));assert.notEqual(result.status,'own_not_open');
});
