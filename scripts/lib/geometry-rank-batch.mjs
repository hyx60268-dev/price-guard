import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

// Routing evidence only. No downloader, source credentials, state write or model.
export const GEOMETRY_LIMITS=Object.freeze({images:21,pairs:20,imageBytes:12_000_000,totalBytes:16*1024*1024,
 outputBytes:128*1024,batchMs:10_000,totalMs:30_000,batches:3,addressSpaceBytes:768*1024*1024,cpuSeconds:30});
const worker=fileURLToPath(new URL('../visual/batch_rank.py',import.meta.url));
const bootstrap=`import os,sys,resource,runpy\nresource.setrlimit(resource.RLIMIT_AS,(${GEOMETRY_LIMITS.addressSpaceBytes},${GEOMETRY_LIMITS.addressSpaceBytes}))\nresource.setrlimit(resource.RLIMIT_CPU,(${GEOMETRY_LIMITS.cpuSeconds},${GEOMETRY_LIMITS.cpuSeconds}))\np=sys.argv[1];sys.path.insert(0,os.path.dirname(p));sys.argv=[p,'--image-root',os.path.dirname(p)];runpy.run_path(p,run_name='__main__')`;
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
const validObservation=row=>Buffer.isBuffer(row?.buffer)&&row.buffer.length>0&&row.buffer.length<=GEOMETRY_LIMITS.imageBytes&&
 /^[a-f0-9]{64}$/.test(row.contentSha256||'')&&hash(row.buffer)===row.contentSha256&&typeof row.imageObservedAt==='string'&&Number.isFinite(Date.parse(row.imageObservedAt));
const failure=reason=>({status:'unavailable',reason,priorityIds:[],identityVerified:false,canRecommend:false});
const FAILURE_REASONS=new Set(['runtime_unavailable','deadline','compute_budget','bytes_unavailable','invalid_inputs','input_limit','timeout','cancelled','output_limit','invalid_output','runtime_failed']);
export const geometryFailureReason=reason=>FAILURE_REASONS.has(reason)?reason:'runtime_failed';

// One local process for the complete batch, never one process per candidate.
export async function executeGeometryBatch(input,{timeoutMs=GEOMETRY_LIMITS.batchMs,signal,spawnProcess=spawn}={}){
 return new Promise(resolve=>{
  let child,timer,done=false,output='',outputBytes=0;
  const finish=result=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(child&&!child.killed)child.kill('SIGKILL');resolve(result)};
  const abort=()=>finish({reason:'cancelled'});
  if(signal?.aborted){resolve({reason:'cancelled'});return}
  try{
   child=spawnProcess('python3',['-I','-B','-u','-c',bootstrap,worker],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH||'/usr/bin:/bin',LANG:'C.UTF-8',OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1'}});
   timer=setTimeout(()=>finish({reason:'timeout'}),Math.max(1,Math.min(GEOMETRY_LIMITS.batchMs,timeoutMs)));
   signal?.addEventListener('abort',abort,{once:true});
   child.on('error',()=>finish({reason:'runtime_unavailable'}));
   child.stdin.on('error',()=>finish({reason:'runtime_failed'}));
   child.stderr.on('data',()=>{}); // Do not propagate dependency paths, raw bytes or environment.
   child.stdout.on('data',chunk=>{outputBytes+=chunk.length;if(outputBytes>GEOMETRY_LIMITS.outputBytes)return finish({reason:'output_limit'});output+=chunk.toString('utf8')});
   child.on('close',code=>{
    if(code!==0)return finish({reason:'runtime_failed'});
    try{const lines=output.trim().split('\n');if(lines.length!==1)throw new Error();finish({value:JSON.parse(lines[0])})}catch{finish({reason:'invalid_output'})}
   });
   child.stdin.end(JSON.stringify(input)+'\n');
  }catch{finish({reason:'runtime_unavailable'})}
 });
}

export function createBoundedGeometryRanker({execute=executeGeometryBatch,now=Date.now,runtimeReady=true}={}){
 let busy=false,batches=0,totalMs=0;
 const stats={batches:0,observedBatches:0,inputImages:0,inputBytes:0,pairs:0,elapsedMs:0,unavailable:0,unavailableReasons:{}};
 const unavailable=reason=>{reason=geometryFailureReason(reason);stats.unavailable++;stats.unavailableReasons[reason]=(stats.unavailableReasons[reason]||0)+1;return failure(reason)};
 function canRun({deadlineAt,signal}={}){return runtimeReady===true&&!busy&&batches<GEOMETRY_LIMITS.batches&&totalMs<GEOMETRY_LIMITS.totalMs&&!signal?.aborted&&(!Number.isFinite(deadlineAt)||deadlineAt-now()>=250)}
 async function rank({own,candidates=[],deadlineAt,signal}={}){
  const stopped=()=>signal?.aborted||(Number.isFinite(deadlineAt)&&now()>=deadlineAt);
  if(runtimeReady!==true)return unavailable('runtime_unavailable');
  if(stopped())return unavailable('deadline');
  if(busy||batches>=GEOMETRY_LIMITS.batches||totalMs>=GEOMETRY_LIMITS.totalMs)return unavailable('compute_budget');
  if(!validObservation(own)||!Array.isArray(candidates))return unavailable('bytes_unavailable');
  const eligible=candidates.filter(row=>typeof row?.id==='string'&&row.id.length<=100&&validObservation(row.observation));
  if(eligible.length!==candidates.length||!eligible.length||eligible.length>GEOMETRY_LIMITS.pairs||new Set(eligible.map(row=>row.id)).size!==eligible.length)return unavailable('invalid_inputs');
  const byteCount=own.buffer.length+eligible.reduce((sum,row)=>sum+row.observation.buffer.length,0);
  if(byteCount>GEOMETRY_LIMITS.totalBytes)return unavailable('input_limit');
  const timeoutMs=Math.min(GEOMETRY_LIMITS.batchMs,GEOMETRY_LIMITS.totalMs-totalMs,Number.isFinite(deadlineAt)?deadlineAt-now():Infinity);
  if(timeoutMs<250)return unavailable('deadline');
  const expected=new Map(eligible.map((row,index)=>['c'+index,row]));
  const input={images:[{id:'own',base64:own.buffer.toString('base64')},...eligible.map((row,index)=>({id:'c'+index,base64:row.observation.buffer.toString('base64')}))],pairs:[...expected.keys()].map(id=>['own',id])};
  busy=true;batches++;stats.batches++;stats.inputImages+=input.images.length;stats.inputBytes+=byteCount;stats.pairs+=eligible.length;
  const start=now();
  try{
   const result=await execute(input,{timeoutMs,signal});
   if(stopped())return unavailable('deadline');
   if(!result?.value){return unavailable(['timeout','cancelled','output_limit','invalid_output','runtime_unavailable','runtime_failed'].includes(result?.reason)?result.reason:'runtime_failed')}
   const value=result.value;
   if(value.scope!=='candidate_ranking_only'||value.version!=='harris_affine_rank_v1_offline'||!Array.isArray(value.pairs)||value.pairs.length!==expected.size)return unavailable('invalid_output');
   const found=new Set(),priorityIds=[];
   for(const row of value.pairs){
    const candidate=expected.get(row?.candidateId);
    if(!candidate||found.has(row.candidateId)||row.queryId!=='own'||row.identityVerified!==false||row.canRecommend!==false||!['same_artwork_candidate','unresolved'].includes(row.rankHint))return unavailable('invalid_output');
    found.add(row.candidateId);
    if(row.status==='unknown'){if(row.rankHint!=='unresolved')return unavailable('invalid_output');continue}
    const metrics=row.metrics;
    if(row.status!=='visual_metrics_only'||row.queryContentSha256!==own.contentSha256||row.candidateContentSha256!==candidate.observation.contentSha256||!metrics||
     !Number.isSafeInteger(metrics.inliers)||metrics.inliers<0||metrics.inliers>500||
     !['inlierFraction','sourceCoverage','targetCoverage','alignedPixelFraction'].every(key=>metrics[key]==null&&key==='alignedPixelFraction'||Number.isFinite(metrics[key])&&metrics[key]>=0&&metrics[key]<=1)||
     !(metrics.alignedRgbMae===null||Number.isFinite(metrics.alignedRgbMae)&&metrics.alignedRgbMae>=0&&metrics.alignedRgbMae<=1))return unavailable('invalid_output');
    if(row.rankHint==='same_artwork_candidate'){
     if(metrics.inliers<12||metrics.inlierFraction<.45||Math.min(metrics.sourceCoverage,metrics.targetCoverage)<.15||metrics.alignedRgbMae===null||metrics.alignedRgbMae>.15)return unavailable('invalid_output');
     priorityIds.push(candidate.id);
    }
   }
   stats.observedBatches++;
   return {status:'observed',priorityIds,paired:found.size,identityVerified:false,canRecommend:false};
  }catch{return unavailable('runtime_failed')}
  finally{const elapsed=Math.max(0,now()-start);totalMs+=elapsed;stats.elapsedMs+=elapsed;busy=false}
 }
 return {rank,canRun,stats};
}
export const defaultGeometryRanker=createBoundedGeometryRanker({runtimeReady:process.env.PRICE_GUARD_GEOMETRY_READY==='1'});
