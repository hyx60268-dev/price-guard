import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import sharp from 'sharp';
import {createBoundedGeometryRanker} from './lib/geometry-rank-batch.mjs';

// A generated, non-product image exercises the real bounded local worker.
// No source fetch, state, credentials or marketplace configuration is needed.
export async function checkGeometryRuntime({ranker=createBoundedGeometryRanker()}={}){
 try{
  const side=128,raw=Buffer.alloc(side*side*3);
  let seed=20261018;
  for(let index=0;index<raw.length;index++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;raw[index]=seed>>>24}
  const buffer=await sharp(raw,{raw:{width:side,height:side,channels:3}}).png().toBuffer();
  const observation={buffer,contentSha256:createHash('sha256').update(buffer).digest('hex'),imageObservedAt:'2026-10-18T00:00:00.000Z'};
  const result=await ranker.rank({own:observation,candidates:[{id:'generated-self-check',observation}],deadlineAt:Date.now()+10_000});
  const ready=result?.status==='observed'&&result?.paired===1&&result?.identityVerified===false&&result?.canRecommend===false&&result?.priorityIds?.length===1&&result.priorityIds[0]==='generated-self-check';
  return {ready,scope:'local_generated_image_only',marketRequests:0,identityVerified:false,canRecommend:false};
 }catch{return {ready:false,scope:'local_generated_image_only',marketRequests:0,identityVerified:false,canRecommend:false}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const result=await checkGeometryRuntime();console.log(JSON.stringify(result));process.exitCode=result.ready?0:1;
}
