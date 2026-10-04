const writers=new Set(['price-guard.yml','cloud-sync.yml','dashboard-repair.yml','merchant-monitor.yml','xianyu-proof.yml']);
export const UPDATE_MAX_AGE_MS=90*60_000;

export function publishedUpdateHealth(status,{now=Date.now(),maxAgeMs=UPDATE_MAX_AGE_MS}={}){
  const checkedAt=typeof status?.checkedAt==='string'?status.checkedAt:null;
  const timestamp=checkedAt?Date.parse(checkedAt):NaN;
  if(!Number.isFinite(timestamp))return {healthy:false,reason:'invalid_checked_at',checkedAt};
  if(timestamp>now+5*60_000)return {healthy:false,reason:'future_checked_at',checkedAt};
  const ageMinutes=Math.max(0,Math.floor((now-timestamp)/60_000));
  return {healthy:now-timestamp<=maxAgeMs,reason:now-timestamp>maxAgeMs?'published_data_stale':'fresh',checkedAt,ageMinutes};
}

export function describeWriterRun(run,jobs,pendingDeployments,repository){
  const active=(Array.isArray(jobs)?jobs:[]).filter(job=>job.status!=='completed');
  const zeroStep=active.some(job=>Array.isArray(job.steps)&&job.steps.length===0);
  const reason=Array.isArray(pendingDeployments)&&pendingDeployments.length?'deployment_review_pending'
    :run.status==='pending'?'shared_lock_pending'
    :zeroStep&&(run.status==='queued'||run.status==='waiting')?'job_not_started'
    :active.some(job=>job.status==='in_progress')?'job_running':'run_state_unconfirmed';
  return {runId:run.id,status:run.status,reason,createdAt:run.created_at,
    url:'https://github.com/'+repository+'/actions/runs/'+run.id};
}

async function getJson(fetchImpl,url,headers={}){
  const response=await fetchImpl(url,{headers,redirect:'error',signal:AbortSignal.timeout(10_000)});
  if(!response.ok)throw Error('HTTP '+response.status);
  return response.json();
}

export async function inspectUpdateHealth({fetchImpl=fetch,baseUrl,repository,token,runId,now=Date.now(),maxAgeMs=UPDATE_MAX_AGE_MS}){
  if(!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository||''))throw Error('Invalid repository');
  const publishedUrl=new URL('status.json',baseUrl.endsWith('/')?baseUrl:baseUrl+'/');
  if(publishedUrl.protocol!=='https:'||publishedUrl.username||publishedUrl.password)throw Error('Invalid public data URL');
  publishedUrl.searchParams.set('healthcheck',String(now));
  let publication;
  try{
    publication=publishedUpdateHealth(await getJson(fetchImpl,publishedUrl.toString(),{'cache-control':'no-cache'}),{now,maxAgeMs});
  }catch{
    publication={healthy:false,reason:'published_status_unavailable',checkedAt:null};
  }
  const report={...publication,queueDiagnostics:[],diagnosticsIncomplete:false};
  if(report.healthy)return report;
  const api='https://api.github.com/repos/'+repository;
  const headers={accept:'application/vnd.github+json','x-github-api-version':'2022-11-28',...(token?{authorization:'Bearer '+token}:{})};
  const runs=new Map();
  const lists=await Promise.allSettled(['queued','pending','waiting','in_progress'].map(async status=>{
    const result=await getJson(fetchImpl,api+'/actions/runs?status='+status+'&per_page=100',headers);
    if(!Array.isArray(result.workflow_runs))throw Error('Invalid runs');
    if(result.total_count>result.workflow_runs.length)report.diagnosticsIncomplete=true;
    return result.workflow_runs;
  }));
  for(const list of lists){
    if(list.status!=='fulfilled'){report.diagnosticsIncomplete=true;continue}
    for(const run of list.value){
      const filename=String(run.path||'').split('@')[0].split('/').pop();
      if(writers.has(filename)&&Number.isSafeInteger(run.id)&&String(run.id)!==String(runId))runs.set(run.id,run);
    }
  }
  // The oldest waiting writer is most useful. Bound diagnostic work even when
  // many scheduled runs accumulated; diagnosis must never mutate that queue.
  const ordered=[...runs.values()].sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at));
  if(ordered.length>5)report.diagnosticsIncomplete=true;
  report.queueDiagnostics=await Promise.all(ordered.slice(0,5).map(async run=>{
    const results=await Promise.allSettled([
      getJson(fetchImpl,api+'/actions/runs/'+run.id+'/jobs?per_page=100',headers),
      getJson(fetchImpl,api+'/actions/runs/'+run.id+'/pending_deployments',headers)
    ]);
    if(results.some(r=>r.status!=='fulfilled'))report.diagnosticsIncomplete=true;
    return describeWriterRun(run,results[0].status==='fulfilled'?results[0].value.jobs:null,
      results[1].status==='fulfilled'?results[1].value:null,repository);
  }));
  return report;
}
