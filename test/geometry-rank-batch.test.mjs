import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createBoundedGeometryRanker,executeGeometryBatch,GEOMETRY_LIMITS} from '../scripts/lib/geometry-rank-batch.mjs';
const observation=text=>{const buffer=Buffer.from(text);return {buffer,url:'fixture:'+text,contentSha256:createHash('sha256').update(buffer).digest('hex'),imageObservedAt:'2026-10-18T00:00:00Z'}};
const own=observation('own'),candidate=observation('candidate');
const args={own,candidates:[{id:'real-card-id',observation:candidate}]};
const good={scope:'candidate_ranking_only',version:'harris_affine_rank_v1_offline',pairs:[{queryId:'own',candidateId:'c0',status:'visual_metrics_only',rankHint:'same_artwork_candidate',identityVerified:false,canRecommend:false,queryContentSha256:own.contentSha256,candidateContentSha256:candidate.contentSha256,metrics:{inliers:79,inlierFraction:.96,sourceCoverage:.5,targetCoverage:.6,alignedPixelFraction:.9,alignedRgbMae:.02}}]};
test('one batch binds exact successful body hashes and returns priority only',async()=>{
 let input;const ranker=createBoundedGeometryRanker({execute:async value=>{input=value;return {value:structuredClone(good)}}});
 const output=await ranker.rank(args);assert.deepEqual(output,{status:'observed',priorityIds:['real-card-id'],paired:1,identityVerified:false,canRecommend:false});
 assert.deepEqual(input.pairs,[['own','c0']]);assert.equal(input.images.length,2);assert.equal(JSON.stringify(input).includes('fixture:'),false);
 assert.equal(ranker.stats.batches,1);assert.equal(ranker.stats.inputBytes,12);
});
test('missing bytes, wrong content, oversize or expired scope starts no process',async()=>{
 let calls=0;const ranker=createBoundedGeometryRanker({execute:async()=>{calls++;return {value:good}},now:()=>100});
 for(const input of [{...args,own:null},{...args,own:{...own,contentSha256:'0'.repeat(64)}},{...args,own:{...own,buffer:Buffer.alloc(12_000_001)}},{...args,deadlineAt:99},{...args,candidates:[...args.candidates,...args.candidates]}])assert.equal((await ranker.rank(input)).status,'unavailable');
 assert.equal(calls,0);
});
test('runtime, incomplete, borrowed hash, NaN and false verification output all fall back',async()=>{
 for(const mutate of [x=>x.pairs.pop(),x=>x.pairs.push(x.pairs[0]),x=>x.pairs[0].queryContentSha256='0'.repeat(64),x=>x.pairs[0].candidateContentSha256='0'.repeat(64),x=>x.pairs[0].canRecommend=true,x=>x.pairs[0].metrics.inlierFraction=NaN,x=>x.pairs[0].metrics.alignedRgbMae=.5,x=>x.pairs[0].candidateId='alien']){
  const value=structuredClone(good);mutate(value);assert.deepEqual((await createBoundedGeometryRanker({execute:async()=>({value})}).rank(args)).priorityIds,[]);
 }
 for(const execute of [async()=>{throw Error('private path')},async()=>({reason:'timeout'}),async()=>({reason:'private error'})])assert.equal((await createBoundedGeometryRanker({execute}).rank(args)).status,'unavailable');
});
test('three batches maximum, busy and global elapsed cap never spawn a fourth',async()=>{
 let calls=0,now=0;const ranker=createBoundedGeometryRanker({execute:async()=>{calls++;now+=10_001;return {value:good}},now:()=>now});
 for(let n=0;n<4;n++)await ranker.rank(args);assert.equal(calls,3);assert.ok(ranker.stats.elapsedMs>=30_000);
 let release;const serial=createBoundedGeometryRanker({execute:()=>new Promise(resolve=>{release=resolve})});const pending=serial.rank(args);
 assert.equal((await serial.rank(args)).reason,'compute_budget');release({value:good});await pending;
});
function fakeChild({output,code=0,hang=false}={}){
 const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.killed=false;child.kill=()=>{child.killed=true};
 child.stdin.on('finish',()=>{if(hang)return;queueMicrotask(()=>{if(output)child.stdout.write(output);child.emit('close',code)})});return child;
}
test('fixed local Python path, isolated environment, resource caps and one complete output',async()=>{
 let invoked;const result=await executeGeometryBatch({images:[],pairs:[]},{spawnProcess:(...input)=>{invoked=input;return fakeChild({output:'{"scope":"test"}\n'})}});
 assert.equal(result.value.scope,'test');assert.equal(invoked[0],'python3');assert.deepEqual(invoked[1].slice(0,4),['-I','-B','-u','-c']);assert.match(invoked[1][4],/RLIMIT_AS/);assert.match(invoked[1][4],/RLIMIT_CPU/);
 assert.deepEqual(Object.keys(invoked[2].env).sort(),['LANG','MKL_NUM_THREADS','OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','PATH'].sort());
 assert.equal(invoked[2].env.OPENBLAS_NUM_THREADS,'1');assert.ok(invoked[1].at(-1).endsWith('/scripts/visual/batch_rank.py'));
 for(const output of ['not-json\n','{}\n{}\n','x'.repeat(GEOMETRY_LIMITS.outputBytes+1)])assert.equal((await executeGeometryBatch({}, {spawnProcess:()=>fakeChild({output})})).value,undefined);
 const child=fakeChild({hang:true});assert.equal((await executeGeometryBatch({}, {timeoutMs:5,spawnProcess:()=>child})).reason,'timeout');assert.equal(child.killed,true);
});

test('unavailable statistics include invalid outputs and missing bytes without double counting',async()=>{
 const ranker=createBoundedGeometryRanker({execute:async()=>({value:{}})});
 assert.equal((await ranker.rank({...args,own:null})).status,'unavailable');
 assert.equal((await ranker.rank(args)).reason,'invalid_output');
 assert.equal(ranker.stats.unavailable,2);assert.equal(ranker.stats.batches,1);
 assert.deepEqual(ranker.stats.unavailableReasons,{bytes_unavailable:1,invalid_output:1});
 assert.equal(ranker.stats.observedBatches,0);
});

test('aggregate reasons preserve bounded failures without exposing callback errors or source data',async()=>{
 const ranker=createBoundedGeometryRanker({execute:async()=>({reason:'private-key https://secret.invalid raw_body'})});
 await ranker.rank(args);
 assert.deepEqual(ranker.stats.unavailableReasons,{runtime_failed:1});
 assert.doesNotMatch(JSON.stringify(ranker.stats),/private-key|secret\.invalid|raw_body/);
 const observed=createBoundedGeometryRanker({execute:async()=>({value:structuredClone(good)})});
 await observed.rank(args);assert.equal(observed.stats.observedBatches,1);assert.equal(observed.stats.unavailable,0);
});
