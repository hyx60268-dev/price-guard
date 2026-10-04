import test from 'node:test';
import assert from 'node:assert/strict';
import {planYahooDetailQueue,yahooQueueOwnKey} from '../scripts/lib/yahoo-detail-queue.mjs';
import {yahooCompare} from '../scripts/lib/yahoo.mjs';
import {ownTitle,title,ownDescription,description} from './fixtures/yahoo-known-pikachu.mjs';
import {MATCHING_RULES_VERSION} from '../scripts/lib/rules.mjs';

const now=Date.parse('2026-10-04T17:00:00Z');
const item={accountId:'owner',id:'own',platform:'yahoo',title:ownTitle,ownPrice:41989,image:'own-primary'};
const detail={id:'own',seller:{id:'owner-seller'},title:ownTitle,description:ownDescription,status:'OPEN',price:41989,images:['own-primary'],condition:'未使用'};
const card=n=>({id:'c'+n,title:'候选 '+n,image:'image-'+n,sellerId:'seller-'+n,price:100+n});
function queue(candidates,prior,options={}){return planYahooDetailQueue({item,detail,candidates,prior,now,...options})}

test('eight-slot detail queue advances unread candidates while reserving current cheapest',()=>{
 const cards=Array.from({length:20},(_,n)=>card(n));
 const first=queue(cards);first.cards.slice(0,8).forEach(value=>first.record(value,new Date(now-1000).toISOString()));
 const second=queue(cards,first.snapshot());
 assert.deepEqual(second.cards.slice(0,8).map(value=>value.id),['c0','c8','c9','c10','c11','c12','c13','c14']);
 second.cards.slice(0,8).forEach(value=>second.record(value,new Date(now).toISOString()));
 const third=queue(cards,second.snapshot());
 assert.deepEqual(third.cards.slice(0,6).map(value=>value.id),['c0','c15','c16','c17','c18','c19']);
 assert.equal(third.snapshot().lastSelection.length,0);
});

test('known verified portion and at least six other slots survive rotation at default eight',()=>{
 const cards=Array.from({length:14},(_,n)=>card(n)),knownIds=new Set(['c10','c11','c12']);
 const first=queue(cards,null,{knownIds,knownLimit:2});
 assert.deepEqual(first.cards.slice(0,8).map(value=>value.id),['c10','c11','c0','c1','c2','c3','c4','c5']);
 first.cards.slice(0,8).forEach(value=>first.record(value,new Date(now-1000).toISOString()));
 const next=queue(cards,first.snapshot(),{knownIds,knownLimit:2});
 assert.deepEqual(next.cards.slice(0,8).map(value=>value.id),['c10','c11','c0','c6','c7','c8','c9','c13']);
});

test('changed account, listing, raw sale specifications or images revoke old ordering',()=>{
 const cards=Array.from({length:10},(_,n)=>card(n)),first=queue(cards);
 first.cards.slice(0,8).forEach(value=>first.record(value,new Date(now).toISOString()));
 const prior=first.snapshot();
 for(const changes of [
  {item:{...item,accountId:'other'}},{item:{...item,id:'relisted'},detail:{...detail,id:'relisted'}},
  {item:{...item,title:ownTitle+' changed'}},{detail:{...detail,description:ownDescription+' 新しい仕様'}},
  {detail:{...detail,condition:'傷や汚れあり'}},{detail:{...detail,images:['new-photo']}}
 ]){
  const next=queue(cards,prior,changes);
  assert.deepEqual(next.cards.slice(0,8).map(value=>value.id),cards.slice(0,8).map(value=>value.id));
 }
 for(const value of [null,{...detail,id:'different'},{...detail,description:''},{...detail,seller:null},{...detail,images:[]}]){
  assert.equal(yahooQueueOwnKey(item,value),null);
  assert.equal(queue(cards,prior,{detail:value}).snapshot(),undefined);
 }
});

test('candidate ID, title, image, seller and a changed price all revoke its old ordering penalty',()=>{
 const cards=Array.from({length:10},(_,n)=>card(n)),first=queue(cards);
 cards.slice(0,8).forEach(value=>first.record(value,new Date(now).toISOString()));
 for(const changed of [{title:'新しいタイトル'},{image:'new-photo'},{sellerId:'new-seller'},{price:90},{id:'relisted-c1'}]){
  const nextCards=cards.map(value=>value.id==='c1'?{...value,...changed}:value);
  const next=queue(nextCards,first.snapshot());
  assert.equal(next.cards[1].id,changed.id||'c1');
 }
});

test('queue persistence has no price timestamp; absent or unread cards are not recorded',()=>{
 const cards=[card(0),card(1),card(2)],first=queue(cards);
 first.record(cards[0],new Date(now).toISOString());first.record(card(999),new Date(now).toISOString());
 const saved=first.snapshot();assert.deepEqual(saved.lastSelection,['c0']);assert.equal(saved.remaining,2);
 assert.equal(saved.checkedAt,undefined);assert.equal(saved.lastAttemptAt,undefined);
 const next=queue([cards[1],cards[2]],saved).snapshot();assert.equal(next.attempts.length,0);
});

const fp={dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[100,100,100],colorGrid:Array(768).fill(100)};
const rival={id:'fixture-rival',title,image:'candidate-primary',price:40990,sellerId:'competitor'};
const fillers=Array.from({length:10},(_,n)=>({...rival,id:'wrong-'+n,price:10000+n}));
const realOwn={...item,sellerId:'owner-seller'};
const deps=(reads,{failId}={})=>({
 fetchYahooItemBundle:async id=>{
  reads.push(id);if(id===failId)throw new Error('fixture network failure');
  return id===item.id?{detail,recommendations:[...fillers,rival]}:{detail:{id,title,description:id===rival.id?description:description+'\n箱なし、フィギュア12体セットです。',price:id===rival.id?40990:10000,status:'OPEN',seller:{id:'competitor'},images:['candidate-primary']}};
 },
 fetchYahooResult:async()=>({items:[]}),
 imageFingerprints:async()=>fp
});

test('two normal Yahoo cycles find candidate eleven without raising the eight-detail limit',async()=>{
 // Historical source prose and controlled fingerprints isolate queue behavior.
 // This test is not evidence that any current live listing still has this content.
 const reads1=[],first=await yahooCompare(null,realOwn,{},deps(reads1));
 assert.equal(first.detailCheckedCount,8);assert.equal(reads1.includes(rival.id),false);assert.equal(first.candidates.length,0);
 assert.equal(first.detailQueue.attempts.length,8);
 const reads2=[],second=await yahooCompare(null,{...realOwn,yahoo:first},{},deps(reads2));
 assert.equal(second.detailCheckedCount,8);assert.ok(reads2.includes(rival.id));assert.equal(second.candidates[0].id,rival.id);
 assert.equal(second.candidates[0].price,40990);
 const queueIds=second.detailQueue.lastSelection;assert.ok(queueIds.includes(rival.id));assert.equal(new Set(queueIds).size,8);
});

test('network or unknown target data cannot be marked as inspected for future ordering',async()=>{
 const result=await yahooCompare(null,realOwn,{},deps([],{failId:'wrong-1'}));
 assert.equal(result.detailQueue.attempts.some(value=>value.id==='wrong-1'),false);
 assert.equal(result.rejected.find(value=>value.id==='wrong-1').reason,'detail_error');
 const incomplete=deps([]);const read=incomplete.fetchYahooItemBundle;
 incomplete.fetchYahooItemBundle=async id=>{const bundle=await read(id);if(id==='wrong-2')bundle.detail.description='';return bundle};
 const missing=await yahooCompare(null,realOwn,{},incomplete);
 assert.equal(missing.detailQueue.attempts.some(value=>value.id==='wrong-2'),false);
});

test('known-only recheck carries old normal queue without inventing attempts or search time',async()=>{
 const normal=await yahooCompare(null,realOwn,{},deps([])),saved=normal.detailQueue;
 const prior={...normal,candidates:[{...rival,matchMethod:'same_sealed_single_box_primary'}],audit:{accountId:realOwn.accountId,ownItemId:realOwn.id},rulesVersion:MATCHING_RULES_VERSION,status:'incomplete',checkedAt:new Date(now).toISOString()};
 const dependencies=deps([]),read=dependencies.fetchYahooItemBundle;
 dependencies.fetchYahooItemBundle=async id=>({...await read(id),shipping:{shippingKnown:true,shippingJPY:0,currency:'JPY',shippingSource:'target_price_area'}});
 const fresh=await yahooCompare(null,{...realOwn,yahoo:prior},{yahooKnownOnly:true},dependencies);
 assert.equal(fresh.candidates.length,1);assert.deepEqual(fresh.detailQueue,saved);assert.equal(fresh.searchCheckedAt,prior.searchCheckedAt);
});

test('finite primary-image mismatch rotates but missing image evidence never counts as inspected',async()=>{
 const make=imageAvailable=>{
  const dependency=deps([]),read=dependency.fetchYahooItemBundle;
  dependency.fetchYahooItemBundle=async id=>{
   const bundle=await read(id);
   if(id!==item.id){bundle.detail.description=description;bundle.detail.images=['image-'+id]}
   return bundle;
  };
  dependency.imageFingerprints=async url=>url.startsWith('image-wrong-')?(imageAvailable?{...fp,color:[200,200,200],colorGrid:Array(768).fill(200)}:null):fp;
  return dependency;
 };
 const first=await yahooCompare(null,realOwn,{},make(true));
 assert.equal(first.candidates.length,0);assert.equal(first.recommendedPrice,realOwn.ownPrice);
 assert.equal(first.detailQueue.attempts.length,8);assert.equal(first.detailQueue.checkedAt,undefined);
 assert.ok(first.rejected.every(row=>row.reason==='collectible_variant_image_unconfirmed'&&Number.isFinite(row.primaryImageScore)));
 const second=await yahooCompare(null,{...realOwn,yahoo:first},{},make(true));
 assert.equal(second.detailCheckedCount,8);assert.equal(second.candidates[0].id,rival.id);
 const missing=await yahooCompare(null,realOwn,{},make(false));
 assert.equal(missing.candidates.length,0);assert.equal(missing.detailQueue.attempts.length,0);
 assert.ok(missing.rejected.every(row=>row.primaryImageScore==null));
});
