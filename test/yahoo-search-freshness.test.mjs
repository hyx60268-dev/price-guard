import test from 'node:test';
import assert from 'node:assert/strict';
import {yahooCompare} from '../scripts/lib/yahoo.mjs';
import {MATCHING_RULES_VERSION} from '../scripts/lib/rules.mjs';
import {ownTitle,title,ownDescription,description} from './fixtures/yahoo-known-pikachu.mjs';
const fp={dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[100,100,100],colorGrid:Array(768).fill(100)};
const current=()=>new Date().toISOString(),ago=minutes=>new Date(Date.now()-minutes*60_000).toISOString();
const own={id:'fixture-own',accountId:'owner',platform:'yahoo',sellerId:'owner-seller',title:ownTitle,image:'own',ownPrice:41989};
const candidate={id:'fixture-competitor',sellerId:'competitor',title,image:'other',price:40990,matchMethod:'same_sealed_single_box_primary'};
const prior=()=>({rulesVersion:MATCHING_RULES_VERSION,status:'incomplete',checkedAt:current(),audit:{accountId:own.accountId,ownItemId:own.id},candidates:[]});
async function compare(previous, {searchFails=false,knownOnly=false}={}){
 let searches=0;
 const result=await yahooCompare(null,{...own,yahoo:previous},{yahooBroadSearchHours:1,yahooFreshMinutes:20,yahooKnownOnly:knownOnly},{
  fetchYahooItemBundle:async id=>({detail:id===own.id?{...own,status:'OPEN',price:own.ownPrice,description:ownDescription,images:['own']}:{...candidate,id,status:'OPEN',description,images:['other']},recommendations:[],shipping:{shippingKnown:true,currency:'JPY',shippingJPY:0}}),
  fetchYahooResult:async()=>{searches++;if(searchFails)throw new Error('fixture source unavailable');return {items:[]}},
  imageFingerprints:async()=>fp
 });
 return {result,searches};
}
test('a fresh recommendation check cannot substitute for missing real broad-search time',async()=>{
 const {result,searches}=await compare(prior());
 assert.equal(searches,1);assert.equal(result.sourceStatus.search,'ok');assert.ok(Date.parse(result.searchCheckedAt)>Date.now()-10_000);
});
test('failed broad search preserves its previous actual time and never copies quote checkedAt',async()=>{
 for(const searchCheckedAt of [undefined,ago(30)]){
  const before={...prior(),searchCheckedAt},out=await compare(before,{searchFails:true});
  assert.equal(out.searches,1);assert.equal(out.result.searchCheckedAt,searchCheckedAt||null);
  assert.equal(out.result.sourceStatus.search,'error');assert.equal(out.result.status,'incomplete');
 }
});
test('no matched competitor searches at twenty-minute eligibility, with no early repetition',async()=>{
 const old=ago(21),oldResult=await compare({...prior(),searchCheckedAt:old});
 assert.equal(oldResult.searches,1);
 const fresh=ago(10),freshResult=await compare({...prior(),searchCheckedAt:fresh});
 assert.equal(freshResult.searches,0);assert.equal(freshResult.result.searchCheckedAt,fresh);
 const next=await compare({...freshResult.result,checkedAt:current()});
 assert.equal(next.searches,0);assert.equal(next.result.searchCheckedAt,fresh);
});
test('valid known competitors keep configured broad interval; stale/error or foreign-account evidence cannot postpone discovery',async()=>{
 const searchCheckedAt=ago(21),base={...prior(),searchCheckedAt,candidates:[candidate]};
 const known=await compare(base);assert.equal(known.searches,0);assert.equal(known.result.searchCheckedAt,searchCheckedAt);
 for(const changes of [{checkedAt:ago(7*60)},{cacheReason:'request_error'},{audit:{accountId:'other',ownItemId:own.id}},{rulesVersion:0},{candidates:[]}]){
  const output=await compare({...base,...changes});assert.equal(output.searches,1,JSON.stringify(changes));
 }
 const expired=await compare({...base,searchCheckedAt:ago(61)});assert.equal(expired.searches,1);
});
test('known detail-only recheck never performs or timestamps a broad search',async()=>{
 const before={...prior(),searchCheckedAt:ago(180),candidates:[candidate]};
 const {result,searches}=await compare(before,{knownOnly:true});
 assert.equal(searches,0);assert.equal(result.searchCheckedAt,before.searchCheckedAt);
 assert.equal(result.candidates.length,1);assert.equal(result.searchComplete,false);
});

test('search timestamp is captured when search returns, before later detail processing',async t=>{
 const started=Date.parse('2026-10-04T15:00:00.000Z');
 t.mock.timers.enable({apis:['Date'],now:started});
 let searchFinished=null;
 const result=await yahooCompare(null,{...own,yahoo:prior()},{yahooFreshMinutes:20},{
  fetchYahooItemBundle:async id=>{
   if(id!==own.id)t.mock.timers.tick(8*60_000);
   return {detail:id===own.id?{...own,status:'OPEN',price:own.ownPrice,description:ownDescription,images:['own']}:
    {...candidate,id,status:'OPEN',description,images:['other']},recommendations:id===own.id?[candidate]:[]};
  },
  fetchYahooResult:async()=>{searchFinished=new Date().toISOString();return {items:[]}},
  imageFingerprints:async()=>fp
 });
 assert.equal(result.searchCheckedAt,searchFinished);
 assert.equal(result.searchCheckedAt,'2026-10-04T15:00:00.000Z');
 assert.equal(result.checkedAt,'2026-10-04T15:08:00.000Z');
 assert.equal(result.candidates.length,1);
});
