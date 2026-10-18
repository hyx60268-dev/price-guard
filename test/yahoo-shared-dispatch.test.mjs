import test from 'node:test';
import assert from 'node:assert/strict';
import {runSharedYahooDispatch} from '../scripts/lib/yahoo-shared-dispatch.mjs';
const task=(account,id)=>({context:{account:{id:account}},item:{accountId:account,id}});
const key=value=>`${value.context.account.id}:${value.item.id}`;
function planFor(tasks,{noHit=new Set(),roots=null}={}){
 const claimed=new Set(),pending=roots||tasks.filter(row=>Number(row.item.id.slice(1))>=4),requests=[];
 return {requests,hasRecall:value=>noHit.has(value)?false:true,claim(account,{blockedTargetKeys}){
  requests.push({account,blocked:[...blockedTargetKeys]});
  if([...claimed].filter(value=>value.startsWith(account+':')).length>=2||claimed.size>=6)return null;
  const row=pending.find(value=>value.context.account.id===account&&!claimed.has(key(value))&&!blockedTargetKeys.has(key(value)));
  if(!row)return null;claimed.add(key(row));return {item:row.item,recall:{id:'external'}};
 }};
}
test('D,D,S keeps all original obligations, rotates accounts, and does not expose shared outcomes as ordinary results',async()=>{
 const tasks=['melon','boss','momoka'].flatMap(account=>Array.from({length:6},(_,i)=>task(account,'i'+i))),plan=planFor(tasks),events=[];
 const result=await runSharedYahooDispatch(tasks,{accountOrder:['melon','boss','momoka'],plan,
  ordinary:async row=>{events.push('D:'+key(row));return {sourceInputObserved:true,normal:key(row)};},
  shared:async row=>{events.push('S:'+row.item.accountId+':'+row.item.id);return {sourceInputObserved:true,normal:'cannot_replace'};}});
 assert.deepEqual(events.slice(0,9),['D:melon:i0','D:boss:i0','D:momoka:i0','D:melon:i1','D:boss:i1','D:momoka:i1','S:melon:i4','S:boss:i4','S:momoka:i4']);
 assert.equal(events.filter(value=>value.startsWith('S:')).length,6);
 assert.deepEqual(result.outputs.map(value=>value.normal),tasks.map(key));assert.equal(result.statistics.ordinaryClaims,18);
 for(const {ordinal,...row} of result.statistics.accountTurns)assert.deepEqual(row,{ordinaryClaims:6,ordinaryObserved:6,noHitDiscoveryClaims:0,noHitDiscoveryObserved:0,sharedClaims:2});
 for(const id of ['melon','boss','momoka'])assert.equal(JSON.stringify(result.statistics).includes(id),false);
});
test('no source input means no shared credit; fully mapped no-hit receives every second ordinary turn before recalled rows',async()=>{
 const tasks=Array.from({length:5},(_,i)=>task('melon','i'+i)),events=[],plan=planFor(tasks,{noHit:new Set(['melon:i4'])});
 await runSharedYahooDispatch(tasks,{plan,ordinary:async row=>{events.push(row.item.id);return {sourceInputObserved:row.item.id!=='i0'};},shared:async()=>events.push('shared')});
 assert.deepEqual(events.slice(0,3),['i0','i4','i1']);
 const never=planFor(tasks);let shared=0;
 const result=await runSharedYahooDispatch(tasks,{plan:never,ordinary:async()=>undefined,shared:async()=>shared++});
 assert.equal(shared,0);assert.equal(result.statistics.ordinaryObserved,0);assert.equal(never.requests.length,0);
});
test('concurrent dispatch permits one shared action, excludes all active targets, and drains locked ordinary work after shared completion',async()=>{
 const tasks=['melon','boss','momoka'].flatMap(account=>Array.from({length:8},(_,i)=>task(account,'i'+i))),plan=planFor(tasks),active=new Set();let shared=0,maxShared=0;
 const delay=()=>new Promise(resolve=>setTimeout(resolve,1));
 const result=await runSharedYahooDispatch(tasks,{plan,concurrency:4,ordinary:async row=>{
  assert.equal(active.has(key(row)),false);active.add(key(row));await delay();active.delete(key(row));return {sourceInputObserved:true};
 },shared:async row=>{const id=row.item.accountId+':'+row.item.id;assert.equal(active.has(id),false);active.add(id);maxShared=Math.max(maxShared,++shared);await delay();shared--;active.delete(id);}});
 assert.equal(maxShared,1);assert.equal(result.statistics.sharedClaims,6);assert.equal(result.statistics.ordinaryClaims,24);
 assert.equal(result.outputs.length,24);assert.ok(result.outputs.every(row=>row.sourceInputObserved));assert.equal(active.size,0);
});
test('deadline prevents new shared claims; failed shared work preserves ordinary queue and original error object',async()=>{
 const tasks=Array.from({length:6},(_,i)=>task('melon','i'+i)),plan=planFor(tasks),error=Object.freeze(Object.assign(new Error('hold'),{status:429}));let permitted=true;
 const result=await runSharedYahooDispatch(tasks,{plan,canStartShared:()=>permitted,ordinary:async()=>({sourceInputObserved:true}),shared:async()=>{permitted=false;throw error;}});
 assert.equal(result.statistics.sharedClaims,1);assert.equal(result.statistics.sharedFailures,1);assert.equal(result.statistics.ordinaryClaims,6);
 assert.deepEqual(Object.keys(error),['status']);
 const held=await runSharedYahooDispatch(tasks,{plan:planFor(tasks),canStartShared:()=>false,ordinary:async()=>undefined,shared:async()=>assert.fail('held')});
 assert.equal(held.statistics.sharedClaims,0);assert.equal(held.statistics.ordinaryClaims,6);
});
test('ordinary failure still propagates rather than being reported as an accepted partial scan',async()=>{
 const error=Object.freeze(new Error('ordinary failed')),tasks=[task('melon','i0')];
 await assert.rejects(runSharedYahooDispatch(tasks,{plan:planFor(tasks),ordinary:async()=>{throw error;},shared:async()=>{}}),value=>value===error);
});

test('parallel claims reserve no-hit positions before any ordinary response completes',async()=>{
 const tasks=Array.from({length:6},(_,i)=>task('melon','i'+i)),plan=planFor(tasks,{noHit:new Set(['melon:i4','melon:i5'])}),events=[];let release;
 const blocked=new Promise(resolve=>release=resolve);
 const result=runSharedYahooDispatch(tasks,{plan,concurrency:4,ordinary:async row=>{events.push(row.item.id);await blocked;return {sourceInputObserved:true};},shared:async()=>{}});
 assert.deepEqual(events,['i0','i4','i1','i5']);release();
 const completed=await result;assert.equal(completed.statistics.noHitDiscoveryClaims,2);assert.equal(completed.statistics.noHitDiscoveryObserved,2);
 assert.equal(completed.statistics.ordinaryClaims,6);
});
