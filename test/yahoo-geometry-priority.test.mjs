import test from 'node:test';
import assert from 'node:assert/strict';
import {planYahooDetailQueue} from '../scripts/lib/yahoo-detail-queue.mjs';
const now=Date.parse('2026-10-18T03:00:00Z');
const item={accountId:'melon',id:'own',platform:'yahoo',title:'fixture figure'};
const detail={id:'own',status:'OPEN',title:item.title,description:'fixture full description',seller:{id:'managed'},images:['fixture-own']};
const cards=Array.from({length:20},(_,n)=>({id:'c'+n,title:'fixture',sellerId:'s',image:'fixture-'+n,price:100+n}));
const base={item,detail,candidates:cards,limit:8,now};
test('one geometric slot preserves two known, lowest, due retry and unknown exploration',()=>{
 const knownIds=new Set(['c1','c2']),first=planYahooDetailQueue({...base,knownIds});
 first.recordSchedulingAttempt(cards[3],'sale_description_unavailable',new Date(now-30*60_000).toISOString());
 const result=planYahooDetailQueue({...base,knownIds,prior:first.snapshot(),geometryPriorityIds:new Set(['c18','c19'])});
 assert.deepEqual(result.cards.slice(0,8).map(row=>row.id),['c1','c2','c0','c3','c18','c4','c5','c6']);
 assert.equal(result.geometryPriorityCount,1);assert.equal(result.cards.length,20);assert.equal(new Set(result.cards.map(c=>c.id)).size,20);
 assert.deepEqual(result.snapshot().attempts,[]);assert.equal(result.snapshot().schedulingAttempts.length,1);
});
test('geometry cannot override finite backoff and reserves no slot on tiny budgets',()=>{
 const first=planYahooDetailQueue(base);first.recordSchedulingAttempt(cards[18],'physical_product_type_unconfirmed',new Date(now).toISOString());
 const result=planYahooDetailQueue({...base,prior:first.snapshot(),geometryPriorityIds:new Set(['c18'])});assert.equal(result.cards.some(c=>c.id==='c18'),false);assert.equal(result.geometryPriorityCount,0);
 for(const limit of [1,2]){const result=planYahooDetailQueue({...base,limit,geometryPriorityIds:new Set(['c18'])});assert.deepEqual(result.cards.slice(0,limit),cards.slice(0,limit));}
});
test('absent and empty hints exactly preserve prior queue, all low geometry remains reachable',()=>{
 const prior=planYahooDetailQueue(base).snapshot();
 const before=planYahooDetailQueue({...base,prior}),after=planYahooDetailQueue({...base,prior,geometryPriorityIds:new Set()});
 assert.deepEqual(after.cards,before.cards);assert.deepEqual(after.snapshot(),before.snapshot());
});

test('many geometric-only recalls cannot take ordinary low or unknown slots',()=>{
 const geometric=Array.from({length:10},(_,n)=>({id:'g'+n,title:'unknown',sellerId:'s',image:'g'+n,price:n+1}));
 const geometryOnlyIds=new Set(geometric.map(c=>c.id));
 const result=planYahooDetailQueue({...base,candidates:[...geometric,...cards],geometryPriorityIds:geometryOnlyIds,geometryOnlyIds});
 assert.deepEqual(result.cards.slice(0,8).map(c=>c.id),['c0','g0','c1','c2','c3','c4','c5','c6']);
 assert.equal(result.cards.filter(c=>geometryOnlyIds.has(c.id)).length,1);
 assert.equal(result.snapshot().remaining,30,'all unselected hints stay unresolved in coverage denominator');
});
