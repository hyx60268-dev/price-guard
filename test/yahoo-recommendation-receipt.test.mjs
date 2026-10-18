import test from 'node:test';
import assert from 'node:assert/strict';
import {yahooRecommendationReceipt} from '../scripts/lib/yahoo-recommendation-receipt.mjs';
const at=Date.parse('2026-10-16T21:00:00Z'),url='https://paypayfleamarket.yahoo.co.jp/item/own';
const raw=(id)=>({itemId:id,title:'fixture title',price:28000,image:{url:'https://example.invalid/'+id},seller:{id:'p123'},log:{rctype:'vector',rcsm:.99}});
const data={props:{initialState:{itemsState:{items:{item:{id:'own'}}},recommendsState:{recommends:{recommends:{
 similar:{recommendItems:{items:[raw('a')]}},viewed:{recommendItems:{items:[{...raw('b'),status:'SOLD',arbitrary:{secret:'never copied'}}]}}
}}}}}};

test('zero-request receipt preserves both rails and original clocks without inventing status or retaining arbitrary payload',()=>{
 const receipt=yahooRecommendationReceipt(data,{requestedItemId:'own',sourceUrl:url,observedAt:at,now:at+100});
 assert.equal(receipt.cards.length,2);assert.equal(receipt.observedAt,new Date(at).toISOString());
 assert.deepEqual(receipt.cards.map(row=>row.recommendationSection),['similar','viewed']);
 assert.ok(receipt.cards.every(row=>row.itemStatus===null&&row.availabilityEvidence===null));
 assert.deepEqual(receipt.shape[1].fields.status,['string']);assert.deepEqual(receipt.shape[1].fields.arbitrary,['object']);
 assert.equal(JSON.stringify(receipt).includes('never copied'),false);assert.equal(receipt.identityVerified,false);
});

test('receipt requires source-bound original transport observation and makes truncation explicit',()=>{
 for(const options of [{observedAt:null},{observedAt:at+1},{sourceUrl:'https://untrusted.invalid/item/own'},{requestedItemId:'different'}])
  assert.throws(()=>yahooRecommendationReceipt(data,{requestedItemId:'own',sourceUrl:url,observedAt:at,now:at,...options}));
 const receipt=yahooRecommendationReceipt(data,{requestedItemId:'own',sourceUrl:url,observedAt:at,now:at,limit:1});
 assert.equal(receipt.cards.length,1);assert.equal(receipt.totalCards,2);assert.equal(receipt.truncated,true);assert.equal(receipt.fullCoverage,false);
});

test('nested data in allowlisted-looking fields is never retained when the raw shape changes',()=>{
 const changed=structuredClone(data),rows=changed.props.initialState.recommendsState.recommends.recommends.similar.recommendItems.items;
 rows[0]={...raw('a'),image:{url:{cookie:'nested-cookie-sentinel'}},seller:{id:{authToken:'nested-auth-sentinel'}},
  genreCategoryIds:[{secret:'nested-category-sentinel'},1,'2'],log:{rctype:{token:'nested-log-sentinel'},rcsm:{secret:'nested-score-sentinel'}}};
 rows.push({...raw('bad-title'),title:{secret:'nested-title-sentinel'}});
 const receipt=yahooRecommendationReceipt(changed,{requestedItemId:'own',sourceUrl:url,observedAt:at,now:at});
 assert.equal(receipt.cards[0].image,'');assert.equal(receipt.cards[0].sellerId,'');assert.deepEqual(receipt.cards[0].categoryIds,[1,'2']);
 assert.equal(receipt.invalidCards,1);assert.equal(receipt.totalCards,3);
 assert.equal(JSON.stringify(receipt).includes('-sentinel'),false);
});

test('image URLs with embedded credentials or token queries are not persisted',()=>{
 for(const imageUrl of ['https://user:password@example.invalid/a','https://example.invalid/a?authToken=secret']){
  const changed=structuredClone(data);changed.props.initialState.recommendsState.recommends.recommends.similar.recommendItems.items[0].image.url=imageUrl;
  const receipt=yahooRecommendationReceipt(changed,{requestedItemId:'own',sourceUrl:url,observedAt:at,now:at});
  assert.equal(receipt.cards[0].image,'');assert.equal(JSON.stringify(receipt).includes('password'),false);
 }
});
