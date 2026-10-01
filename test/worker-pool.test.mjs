import test from 'node:test';
import assert from 'node:assert/strict';
import { mapLimit } from '../scripts/lib/worker-pool.mjs';
test('product workers overlap while keeping a strict bound and one task per browser slot',async()=>{
 let active=0,peak=0;const slots=new Set(),seen=[];
 const result=await mapLimit([0,1,2,3,4,5,6],3,async(value,index,slot)=>{
  assert.equal(slots.has(slot),false);slots.add(slot);active++;peak=Math.max(peak,active);
  await new Promise(resolve=>setImmediate(resolve));seen.push(value);slots.delete(slot);active--;return value*2;
 });
 assert.equal(peak,3);assert.deepEqual(result,[0,2,4,6,8,10,12]);assert.deepEqual(seen.sort((a,b)=>a-b),[0,1,2,3,4,5,6]);assert.equal(active,0);
});
test('a failed slot drains other in-flight tasks before caller closes shared browser',async()=>{
 let finished=false;
 await assert.rejects(mapLimit([0,1],2,async value=>{if(value===0)throw Error('fixture failure');await new Promise(resolve=>setImmediate(resolve));finished=true}),/fixture failure/);
 assert.equal(finished,true);
});
test('empty input never launches requests and zero limit is bounded',async()=>{
 assert.deepEqual(await mapLimit([],3,()=>{throw Error('unexpected request')}),[]);
 assert.deepEqual(await mapLimit([1,2],0,async value=>value),[1,2]);
});
