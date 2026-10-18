import test from 'node:test';
import assert from 'node:assert/strict';
import {planYahooCardDetailOrder,summarizeYahooCardTitleGates} from '../scripts/lib/yahoo-card-detail-plan.mjs';
const ownTitle='APEX ヴァイオレット・エヴァーガーデン 自動手記人形Ver. 1/7 フィギュア 新品 1点';
const item=(id,title,priceJPY)=>({id,title,priceJPY});
test('related ordinary-price candidates get detail slots while cheap uncertain candidates retain bounded exploration',()=>{
 const rows=[...Array.from({length:20},(_,i)=>item('weak'+i,'キャラクター グッズ',500+i)),
  ...Array.from({length:8},(_,i)=>item('strong'+i,ownTitle,28000+i))];
 const before=structuredClone(rows),plan=planYahooCardDetailOrder({ownTitle,ownPriceJPY:28499,rows});
 assert.deepEqual(rows,before);assert.equal(plan.canRecommend,false);assert.equal(plan.allInputRowsRetained,true);
 assert.deepEqual(plan.rows.slice(0,8).map(row=>row.id),['strong0','strong1','strong2','weak0','strong3','strong4','strong5','weak1']);
 assert.equal(new Set(plan.rows.map(row=>row.id)).size,rows.length);assert.equal(plan.rows.length,rows.length);
});
test('price alone, brand alone, unknown prices and extreme discounts never establish identity or disappear',()=>{
 const rows=[item('brand','APEX フィギュア',28000),item('cheap',ownTitle,500),item('no-price',ownTitle,null),item('missing','',undefined)];
 const plan=planYahooCardDetailOrder({ownTitle,ownPriceJPY:28499,rows});
 assert.equal(plan.rows.find(row=>row.id==='brand').tier,'unknown_identity');
 assert.equal(plan.rows.find(row=>row.id==='cheap').tier,'related_other_price');
 assert.equal(plan.rows.find(row=>row.id==='no-price').tier,'related_other_price');
 assert.deepEqual(new Set(plan.rows.map(row=>row.id)),new Set(rows.map(row=>row.id)));
});
test('all-unknown queues preserve lowest-price exploration and do not drop missing price',()=>{
 const rows=[item('unknown','unknown',null),item('high','unknown',2000),item('low','unknown',500)];
 assert.deepEqual(planYahooCardDetailOrder({ownTitle,ownPriceJPY:28499,rows}).rows.map(row=>row.id),['low','high','unknown']);
});
test('malformed and duplicate queue identities fail instead of merging or inventing candidates',()=>{
 for(const rows of [null,[{}],[item('same','a',1),item('same','b',2)],Array.from({length:201},(_,i)=>item('a'+i,'a',1))])
  assert.throws(()=>planYahooCardDetailOrder({ownTitle,ownPriceJPY:28499,rows}),/invalid_card_plan/);
});
test('one long exact Japanese identity can pass coverage yet fail the unchanged two-token ordering gates',()=>{
 const title='ヴァイオレットエヴァーガーデン フィギュア',rows=[item('PRIVATE_ID',title,28000)];
 const result=summarizeYahooCardTitleGates({ownTitle:title,ownPriceJPY:28499,rows});
 assert.equal(result.all.longSingleAnchorBlocked,1);assert.equal(result.all.unknown,1);
 assert.equal(result.all.scoreBuckets.one,1);assert.equal(result.all.failedGateCounts.matched_count_below_2,1);
 assert.equal(result.all.failedGateCounts.token_count_below_2,1);assert.equal(result.all.failedGateCounts.matched_length_below_6,0);
 assert.equal(result.nearPrice.rows,1);assert.equal(result.nearPrice.anonymousFeatureCombinations[0].score,1);
 assert.equal(planYahooCardDetailOrder({ownTitle:title,ownPriceJPY:28499,rows}).rows[0].tier,'unknown_identity');
 assert.ok(!JSON.stringify(result).includes(title));assert.ok(!JSON.stringify(result).includes('PRIVATE_ID'));
});
test('missing own type, missing candidate type and actual type differences remain separate gates',()=>{
 const rows=[item('no-type','ヴァイオレット・エヴァーガーデン',28000),item('other-type','ヴァイオレット・エヴァーガーデン カード',28000),item('same-type',ownTitle,28000)];
 const result=summarizeYahooCardTitleGates({ownTitle,ownPriceJPY:28499,rows});
 assert.deepEqual(result.all.familyRelation,{own_missing:0,candidate_missing:1,different:1,same:1});
 assert.equal(result.all.failedGateCounts.candidate_family_missing,1);assert.equal(result.all.failedGateCounts.family_different,1);
 const missing=summarizeYahooCardTitleGates({ownTitle:'ヴァイオレット',ownPriceJPY:28499,rows});
 assert.equal(missing.all.failedGateCounts.own_family_missing,3);
});
test('numeric gate histograms explain all retained rows and the near-price slice without exposing text or tokens',()=>{
 const rows=[item('a',ownTitle,28000),item('b','APEX フィギュア',28000),item('c','別作品 フィギュア',500),item('d','PRIVATE_BODY',null)];
 const before=structuredClone(rows),out=summarizeYahooCardTitleGates({ownTitle,ownPriceJPY:28499,rows});
 assert.deepEqual(rows,before);assert.equal(out.all.rows,4);assert.equal(out.nearPrice.rows,2);
 assert.equal(out.all.related,1);assert.equal(out.all.unknown,3);assert.equal(out.all.anonymousFeatureCombinations,undefined);
 for(const key of ['firstFailedGate','familyRelation','scoreBuckets','matchedCountBuckets','matchedLengthBuckets','tokenCountBuckets'])
  assert.equal(Object.values(out.all[key]).reduce((sum,count)=>sum+count,0),4,key);
 assert.equal(out.nearPrice.anonymousFeatureCombinations.reduce((sum,row)=>sum+row.rows,0),2);
 assert.equal(out.canRecommend,false);assert.doesNotMatch(JSON.stringify(out),/PRIVATE_BODY|APEX|tokens|url|priceJPY/);
});
test('gate summaries reject malformed inputs rather than emitting arbitrary values',()=>{
 for(const input of [{ownTitle:null},{rows:null},{rows:[{}]},{rows:Array.from({length:201},()=>({title:'a'}))}])
  assert.throws(()=>summarizeYahooCardTitleGates(input),/invalid_card_gate_summary/);
});
