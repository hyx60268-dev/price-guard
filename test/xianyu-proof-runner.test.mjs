import test from 'node:test';
import assert from 'node:assert/strict';
import { runXianyuProof } from '../scripts/lib/xianyu-proof-runner.mjs';
const items=[0,1,2,3].map(id=>({id:String(id)}));
const own=async()=>({detail:{description:'新品',images:[]}});
test('proof skips removed Yahoo links, continues live items, and counts only multi-seller costs',async()=>{
  const verified=[],saved=[];
  const result=await runXianyuProof({items,fetchOwn:async item=>{if(item.id==='0')throw Error('HTTP 404');return own()},verify:async item=>{verified.push(item.id);return {status:'ok',averageCNY:90,sellerCount:item.id==='1'?1:2}},persist:async r=>saved.push(r),log:()=>{}});
  assert.deepEqual(verified,['1','2','3']);assert.equal(saved.length,3);
  assert.deepEqual(result,{selected:4,tested:3,accepted:2,sourceUnavailable:1});
});
test('proof respects access challenges and never continues to another target',async()=>{
  let requests=0;const result=await runXianyuProof({items,fetchOwn:own,verify:async()=>{requests++;return {status:'blocked'}},persist:async()=>{},log:()=>{}});
  assert.equal(requests,1);assert.equal(result.accepted,0);
});
test('missing descriptions cannot use stale catalog text as detail proof',async()=>{
  const result=await runXianyuProof({items,fetchOwn:async()=>({detail:{}}),verify:async()=>assert.fail('must not scan'),persist:async()=>{},log:()=>{}});
  assert.equal(result.tested,0);assert.equal(result.sourceUnavailable,4);
});

test('an explicit current listing gets title and translated query from its live source detail',async()=>{
  let item;await runXianyuProof({items:[{id:'z1'}],fetchOwn:async()=>({detail:{title:'鬼滅の刃 時透無一郎 アクリルスタンド',description:'新品',images:['image']}}),verify:async value=>{item=value;return {status:'manual_review'}},persist:async()=>{},log:()=>{}});
  assert.equal(item.title,'鬼滅の刃 時透無一郎 アクリルスタンド');assert.ok(item.xianyuQuery);assert.deepEqual(item.yahoo.ownImages,['image']);
});
