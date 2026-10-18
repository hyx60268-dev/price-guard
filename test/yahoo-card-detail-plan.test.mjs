import test from 'node:test';
import assert from 'node:assert/strict';
import {planYahooCardDetailOrder} from '../scripts/lib/yahoo-card-detail-plan.mjs';
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
