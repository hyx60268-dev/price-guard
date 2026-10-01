import test from 'node:test';
import assert from 'node:assert/strict';
import { runPublicProcurement } from '../scripts/lib/procurement-runner.mjs';
const now=Date.parse('2026-10-01T17:00:00Z');
const make=(accountId,id)=>({item:{accountId,id,title:'同款测试',image:'https://photos.test/'+id},prior:{}});
test('public procurement runs during Xianyu cooldown with bounded concurrency and fair account admission',async()=>{
 const buckets=[[make('a','1'),make('a','2')],[make('b','3'),make('b','4')]],seen=[];let active=0,peak=0;
 const values=await runPublicProcurement(buckets,{now:()=>now,deadline:now+60000,limit:3,lookup:async item=>{active++;peak=Math.max(peak,active);seen.push(item.accountId+':'+item.id);await new Promise(r=>setImmediate(r));active--;return {status:'incomplete',samples:[],averageCNY:null}}});
 assert.deepEqual(seen,['a:1','b:3','a:2']);assert.equal(peak,2);assert.equal(values.get('b:4').attempted,false);assert.equal(values.get('a:1').attempted,true);
});
test('changed item identity cannot inherit a prior failed lookup retry window or evidence',async()=>{
 const task=make('a','1');task.prior.procurementSource={status:'incomplete',checkedAt:new Date(now-1000).toISOString(),target:{...task.item,title:'不同型号'}};
 let reads=0;const run=()=>runPublicProcurement([[task]],{now:()=>now,deadline:now+60000,lookup:async()=>{reads++;return {status:'incomplete',samples:[]}}});
 await run();assert.equal(reads,1);task.prior.procurementSource.target={...task.item};const skipped=await run();assert.equal(reads,1);assert.equal(skipped.get('a:1').cacheStatus,'awaiting_retry');
});
test('a failed public source is retained as failure while another account can continue',async()=>{
 const values=await runPublicProcurement([[make('a','1')],[make('b','2')]],{now:()=>now,deadline:now+60000,lookup:async item=>{if(item.id==='1')throw Error('HTTP 503');return {status:'incomplete',samples:[]}}});
 assert.equal(values.get('a:1').status,'error');assert.equal(values.get('a:1').averageCNY,null);assert.equal(values.get('b:2').attempted,true);
});
