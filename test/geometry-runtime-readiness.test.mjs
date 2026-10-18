import test from 'node:test';
import assert from 'node:assert/strict';
import {checkGeometryRuntime} from '../scripts/check-geometry-runtime.mjs';
import {createBoundedGeometryRanker} from '../scripts/lib/geometry-rank-batch.mjs';

test('runtime readiness requires complete locally generated pair and never accepts quote evidence',async()=>{
 let calls=0;
 const result=await checkGeometryRuntime({ranker:{rank:async input=>{
  calls++;assert.equal(input.candidates.length,1);assert.ok(Buffer.isBuffer(input.own.buffer));assert.equal(input.own.buffer.equals(input.candidates[0].observation.buffer),true);
  assert.doesNotMatch(JSON.stringify(input),/https?:|DASHBOARD_PASSWORD/);
  return {status:'observed',paired:1,priorityIds:['generated-self-check'],identityVerified:false,canRecommend:false};
 }}});
 assert.deepEqual(result,{ready:true,scope:'local_generated_image_only',marketRequests:0,identityVerified:false,canRecommend:false});assert.equal(calls,1);
});

test('missing, malformed or failed runtime emits only fixed safe readiness fields',async()=>{
 const unsafe='secret_key raw_source path private_body';
 for(const value of [null,{}, {status:'observed',paired:0,priorityIds:['generated-self-check'],identityVerified:false,canRecommend:false},
 {status:'observed',paired:1,priorityIds:['wrong'],identityVerified:false,canRecommend:false},
 {status:'observed',paired:1,priorityIds:['generated-self-check'],identityVerified:true,canRecommend:false},
 {status:'observed',paired:1,priorityIds:['generated-self-check'],identityVerified:false,canRecommend:true}]){
  const result=await checkGeometryRuntime({ranker:{rank:async()=>value}});assert.equal(result.ready,false);assert.doesNotMatch(JSON.stringify(result),/secret_key|raw_source/);
 }
 const failed=await checkGeometryRuntime({ranker:{rank:async()=>{throw Error(unsafe)}}});assert.equal(failed.ready,false);assert.doesNotMatch(JSON.stringify(failed),/secret_key|raw_source|private_body/);
});

test('readiness cannot allocate work with runtime missing, cancelled or near deadline',async()=>{
 let calls=0;const execute=async()=>{calls++;return {reason:'runtime_failed'}};
 assert.equal(createBoundedGeometryRanker({runtimeReady:false,execute}).canRun(),false);
 const ranker=createBoundedGeometryRanker({execute,now:()=>1000});
 assert.equal(ranker.canRun(),true);assert.equal(ranker.canRun({deadlineAt:1249}),false);
 assert.equal(ranker.canRun({deadlineAt:1250}),true);assert.equal(ranker.canRun({signal:AbortSignal.abort()}),false);assert.equal(calls,0);
});
