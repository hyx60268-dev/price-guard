import test from 'node:test';
import assert from 'node:assert/strict';
import { publicProcurementItem } from './fixtures/procurement-reference.mjs';
import { procurementTarget } from '../scripts/lib/procurement-evidence.mjs';
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
 await run();assert.equal(reads,1);task.prior.procurementSource.target=procurementTarget(task.item);const skipped=await run();assert.equal(reads,1);assert.equal(skipped.get('a:1').cacheStatus,'awaiting_retry');
});
test('a failed public source is retained as failure while another account can continue',async()=>{
 const values=await runPublicProcurement([[make('a','1')],[make('b','2')]],{now:()=>now,deadline:now+60000,lookup:async item=>{if(item.id==='1')throw Error('HTTP 503');return {status:'incomplete',samples:[]}}});
 assert.equal(values.get('a:1').status,'error');assert.equal(values.get('a:1').averageCNY,null);assert.equal(values.get('b:2').attempted,true);
});

test('public lookup binds the hydrated description rather than an unobserved listing card',async()=>{
 const task=make('a','1'),detail={description:'2セットまとめ売り',condition:'未使用'};
 const values=await runPublicProcurement([[task]],{now:()=>now,deadline:now+60000,hydrate:async item=>({...item,sourceDetail:detail}),lookup:async item=>({status:'incomplete',samples:[],target:procurementTarget(item)})});
 assert.deepEqual(values.get('a:1').target,procurementTarget({...task.item,sourceDetail:detail}));
 assert.equal(values.get('a:1').target.description,detail.description);
});


test('public procurement cloud log includes top-level cause and bounded query/detail accounting',async()=>{
 const logged=[];
 const reference={status:'incomplete',reason:'no_verified_detail',samples:[],sellerCount:0,searched:2,detailCheckedCount:0,unsupportedTargets:9,duplicateUrls:3,searchResults:Array.from({length:8},()=>({provider:'bing',query:'商品 购买 现货',returned:10,rejected:2,accepted:0})),diagnostics:Array.from({length:30},()=>({reason:'fixture'}))};
 await runPublicProcurement([[make('a','1')]],{now:()=>now,deadline:now+60000,lookup:async()=>reference,log:row=>logged.push(row)});
 const row=logged[0];assert.equal(row.reason,'no_verified_detail');assert.equal(row.searched,2);assert.equal(row.detailCheckedCount,0);assert.equal(row.unsupportedTargets,9);assert.equal(row.duplicateUrls,3);assert.equal(row.searchResults.length,4);assert.equal(row.diagnostics.length,16);
});

test('public procurement logs target identity failures and sanitizes lookup exceptions',async()=>{
 const logged=[];await runPublicProcurement([[make('a','1'),make('a','2')]],{now:()=>now,deadline:now+60000,lookup:async item=>{if(item.id==='1')return {status:'incomplete',reason:'target_identity_missing',samples:[]};throw Error('HTTP 503 https://example.test/login?token=secret <html>cookie=secret</html>');},log:row=>logged.push(row)});
 assert.equal(logged[0].reason,'target_identity_missing');assert.equal(logged[1].reason,'lookup_exception');assert.ok(logged[1].diagnostics[0].message.startsWith('HTTP 503'));const output=JSON.stringify(logged);assert.equal(output.includes('secret'),false);assert.equal(output.includes('/login'),false);assert.equal(output.includes('<html>'),false);
});


test('configured audit IDs move existing public tasks ahead of the fair queue without increasing admission or workers',async()=>{
 const buckets=[Array.from({length:6},(_,n)=>make('a','a'+n)),Array.from({length:6},(_,n)=>make('b','b'+n))],seen=[];let active=0,peak=0;
 const values=await runPublicProcurement(buckets,{priorityItemIds:['b5','a4','not-recorded'],now:()=>now,deadline:now+60000,lookup:async item=>{active++;peak=Math.max(peak,active);seen.push(item.accountId+':'+item.id);await new Promise(r=>setImmediate(r));active--;return {status:'incomplete',samples:[]}}});
 assert.deepEqual(seen,['a:a4','b:b5','a:a0','b:b0','a:a1','b:b1','a:a2','b:b2']);assert.equal(peak,2);assert.equal(values.size,12);assert.equal(values.get('a:a3').cacheStatus,'deferred_budget');assert.equal(seen.some(k=>k.includes('not-recorded')),false);
});

test('public priority preserves verified cache, retry windows, deadline and account-bound evidence',async()=>{
 const cached=publicProcurementItem(now),retry=make('a','retry'),due=make('a','due');
 retry.prior.procurementSource={status:'incomplete',checkedAt:new Date(now-1000).toISOString(),target:procurementTarget(retry.item)};
 const task={item:cached,prior:{procurementSource:cached.procurementSource}},seen=[];
 const values=await runPublicProcurement([[due,retry,task]],{priorityItemIds:[cached.id,'retry'],now:()=>now,deadline:now+60000,limit:1,lookup:async item=>{seen.push(item.id);return {status:'incomplete',samples:[]}}});
 assert.deepEqual(seen,['due']);assert.equal(values.get(cached.accountId+':'+cached.id).cacheStatus,'fresh_verified');assert.equal(values.get('a:retry').cacheStatus,'awaiting_retry');
 const expired=await runPublicProcurement([[due]],{priorityItemIds:['due'],now:()=>now,deadline:now,lookup:async()=>{throw Error('must not run')}});assert.equal(expired.get('a:due').attempted,false);
 const changed={...cached,accountId:'different-account'};let reads=0;await runPublicProcurement([[{item:changed,prior:task.prior}]],{priorityItemIds:[cached.id],now:()=>now,deadline:now+60000,lookup:async()=>{reads++;return {status:'incomplete',samples:[]}}});assert.equal(reads,1);
});
