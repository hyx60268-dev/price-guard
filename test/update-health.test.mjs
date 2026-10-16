import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { publishedUpdateHealth,describeWriterRun,inspectUpdateHealth } from '../scripts/lib/update-health.mjs';

const now=Date.parse('2026-10-04T13:51:00Z'),repository='example/price-guard';
const options={repository,baseUrl:'https://example.github.io/price-guard/data',now,runId:99,token:'secret-test-token'};
const old={checkedAt:'2026-10-02T13:28:00Z'};
const queued={id:42,path:'.github/workflows/price-guard.yml@main',status:'queued',created_at:'2026-10-02T13:34:45Z'};
const response=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const schedulerResponse=url=>url.endsWith('/actions/workflows/price-guard.yml')?response({state:'active'})
  :url.includes('/actions/workflows/price-guard.yml/runs?')?response({total_count:0,workflow_runs:[]}):null;

test('fresh data passes; 90-minute staleness, missing and future timestamps fail honestly',()=>{
  assert.equal(publishedUpdateHealth({checkedAt:'2026-10-04T13:31:00Z'},{now}).healthy,true);
  assert.equal(publishedUpdateHealth({checkedAt:'2026-10-04T12:21:00Z'},{now}).healthy,true);
  assert.equal(publishedUpdateHealth({checkedAt:'2026-10-04T12:20:59Z'},{now}).healthy,false);
  assert.equal(publishedUpdateHealth(old,{now}).reason,'published_data_stale');
  assert.equal(publishedUpdateHealth({}, {now}).reason,'invalid_checked_at');
  assert.equal(publishedUpdateHealth({checkedAt:'2026-10-04T14:51:00Z'},{now}).reason,'future_checked_at');
});

test('fresh publication still reads workflow state and one bounded scheduled-run count without a queue lookup',async()=>{
  const calls=[];
  const result=await inspectUpdateHealth({...options,fetchImpl:async(url,request)=>{
    calls.push(url);assert.equal(request.method,undefined);assert.equal(request.redirect,'error');
    assert.ok(request.signal instanceof AbortSignal);
    if(url.includes('/data/')){
      assert.equal(request.headers.authorization,undefined);
      return response({checkedAt:'2026-10-04T13:40:00Z'});
    }
    assert.equal(request.headers.authorization,'Bearer secret-test-token');
    if(url.includes('/runs?')){
      const query=new URL(url).searchParams;
      assert.equal(query.get('event'),'schedule');assert.equal(query.get('per_page'),'1');
      assert.equal(query.get('created'),'2026-10-04T12:51:00.000Z..2026-10-04T13:51:00.000Z');
      assert.equal(query.get('page'),null);assert.equal(query.get('status'),null);
    }
    const reply=schedulerResponse(url);assert.ok(reply,'unexpected request '+url);return reply;
  }});
  assert.equal(calls.length,3);assert.equal(result.healthy,true);
  assert.deepEqual(result.schedulerDiagnostics,{
    workflowState:'active',recentWindowMinutes:60,recentScheduledRunCount:0,
    runRecordEvidence:'no_recent_schedule_run_records',incomplete:false
  });
  assert.deepEqual(result.queueDiagnostics,[]);
  assert.equal(result.diagnosticsIncomplete,false);
});

test('scheduled-run evidence retains only total_count and does not fetch more pages or equate records with completed cycles',async()=>{
  const calls=[];
  const result=await inspectUpdateHealth({...options,fetchImpl:async url=>{
    calls.push(url);
    if(url.includes('/data/'))return response({checkedAt:new Date(now).toISOString()});
    if(url.includes('/runs?'))return response({total_count:7,workflow_runs:[{id:999,status:'pending',actor:{login:'do-not-log'}}]});
    return response({state:'active'});
  }});
  assert.equal(calls.length,3);assert.equal(result.healthy,true);
  assert.equal(result.schedulerDiagnostics.recentScheduledRunCount,7);
  assert.equal(result.schedulerDiagnostics.runRecordEvidence,'recent_schedule_run_records');
  assert.equal(result.schedulerDiagnostics.incomplete,false);
  assert.equal(JSON.stringify(result).includes('do-not-log'),false);
  assert.equal('cadenceHealthy' in result.schedulerDiagnostics,false);
});

test('disabled workflow is reported from explicit API state even when publication is fresh',async()=>{
  const result=await inspectUpdateHealth({...options,fetchImpl:async url=>{
    if(url.includes('/data/'))return response({checkedAt:new Date(now).toISOString()});
    if(url.endsWith('/price-guard.yml'))return response({state:'disabled_manually'});
    return response({total_count:0,workflow_runs:[]});
  }});
  assert.equal(result.healthy,true);
  assert.equal(result.schedulerDiagnostics.workflowState,'disabled_manually');
  assert.equal(result.schedulerDiagnostics.incomplete,false);
});

test('workflow read failure is unknown, not disabled, and does not discard independent run-count evidence',async()=>{
  for(const failure of [new Response('',{status:403}),new Response('',{status:404}),new Response('',{status:503}),'timeout']){
    const result=await inspectUpdateHealth({...options,fetchImpl:async url=>{
      if(url.includes('/data/'))return response({checkedAt:new Date(now).toISOString()});
      if(url.endsWith('/price-guard.yml')){
        if(failure==='timeout')throw Error('request timeout');
        return failure;
      }
      return response({total_count:0,workflow_runs:[]});
    }});
    assert.equal(result.healthy,true);
    assert.equal(result.schedulerDiagnostics.workflowState,'unknown');
    assert.equal(result.schedulerDiagnostics.recentScheduledRunCount,0);
    assert.equal(result.schedulerDiagnostics.incomplete,true);
  }
});

test('failed or malformed run evidence remains unknown without hiding known workflow state',async()=>{
  for(const payload of [null,{total_count:'0',workflow_runs:[]},{total_count:-1,workflow_runs:[]},{total_count:0},{total_count:0,workflow_runs:[{id:1}]}]){
    const result=await inspectUpdateHealth({...options,fetchImpl:async url=>{
      if(url.includes('/data/'))return response({checkedAt:new Date(now).toISOString()});
      if(url.endsWith('/price-guard.yml'))return response({state:'active'});
      return payload===null?new Response('',{status:503}):response(payload);
    }});
    assert.equal(result.schedulerDiagnostics.workflowState,'active');
    assert.equal(result.schedulerDiagnostics.recentScheduledRunCount,null);
    assert.equal(result.schedulerDiagnostics.runRecordEvidence,'unknown');
    assert.equal(result.schedulerDiagnostics.incomplete,true);
  }
});

test('missing or unrecognized workflow state is unknown rather than implicitly active',async()=>{
  for(const workflow of [{},{state:'unexpected'},{state:null}]){
    const result=await inspectUpdateHealth({...options,fetchImpl:async url=>{
      if(url.includes('/data/'))return response({checkedAt:new Date(now).toISOString()});
      return url.endsWith('/price-guard.yml')?response(workflow):response({total_count:0,workflow_runs:[]});
    }});
    assert.equal(result.schedulerDiagnostics.workflowState,'unknown');
    assert.equal(result.schedulerDiagnostics.incomplete,true);
  }
});

test('actual queued zero-step incident is diagnosed without inventing approval or modifying tasks',async()=>{
  const calls=[];
  const result=await inspectUpdateHealth({...options,fetchImpl:async(url,request)=>{
    calls.push(url);assert.equal(request.method,undefined);assert.equal(request.redirect,'error');
    if(url.includes('/data/status.json')){
      assert.equal(request.headers.authorization,undefined);return response(old);
    }
    assert.equal(request.headers.authorization,'Bearer secret-test-token');
    const scheduler=schedulerResponse(url);if(scheduler)return scheduler;
    if(url.includes('/actions/runs?')){
      const status=new URL(url).searchParams.get('status');
      return response({workflow_runs:status==='queued'?[queued]:[],total_count:status==='queued'?1:0});
    }
    if(url.endsWith('/jobs?per_page=100'))return response({jobs:[{status:'queued',steps:[]}]});
    if(url.endsWith('/pending_deployments'))return response([]);
    throw Error('unexpected request');
  }});
  assert.equal(result.healthy,false);
  assert.equal(result.queueDiagnostics[0].reason,'job_not_started');
  assert.equal(result.queueDiagnostics[0].url,'https://github.com/example/price-guard/actions/runs/42');
  assert.equal(result.diagnosticsIncomplete,false);
  assert.equal(calls.length,9);
});

test('real environment approval, unknown steps, and active work remain distinct',()=>{
  assert.equal(describeWriterRun(queued,[{status:'queued',steps:[]}],[{environment:{name:'github-pages'}}],repository).reason,'deployment_review_pending');
  assert.equal(describeWriterRun(queued,[{status:'queued',steps:null}],[],repository).reason,'run_state_unconfirmed');
  assert.equal(describeWriterRun({...queued,status:'in_progress'},[{status:'in_progress',steps:[{name:'Scan'}]}],[],repository).reason,'job_running');
  assert.equal(describeWriterRun({...queued,status:'pending'},[],[],repository).reason,'pending_before_jobs');
  assert.equal(describeWriterRun({...queued,status:'pending'},null,[],repository).reason,'pending_cause_unconfirmed');
  assert.equal(describeWriterRun({...queued,status:'pending'},[{status:'queued',steps:[]}],[],repository).reason,'pending_cause_unconfirmed');
});

test('missing published status and unavailable queue APIs never claim fresh data or an empty healthy queue',async()=>{
  const result=await inspectUpdateHealth({...options,fetchImpl:async()=>new Response('',{status:503})});
  assert.equal(result.healthy,false);assert.equal(result.reason,'published_status_unavailable');
  assert.equal(result.diagnosticsIncomplete,true);
  assert.equal(result.schedulerDiagnostics.workflowState,'unknown');
  assert.equal(result.schedulerDiagnostics.recentScheduledRunCount,null);
  assert.equal(result.schedulerDiagnostics.incomplete,true);
});

test('diagnosis excludes its own run and unrelated workflows and bounds oldest-writer lookups',async()=>{
  const many=Array.from({length:7},(_,i)=>({...queued,id:42+i,created_at:new Date(now-(10-i)*60_000).toISOString()}));
  const result=await inspectUpdateHealth({...options,fetchImpl:async url=>{
    if(url.includes('/data/'))return response(old);
    const scheduler=schedulerResponse(url);if(scheduler)return scheduler;
    if(url.includes('/actions/runs?'))return response({total_count:10,workflow_runs:[...many,
      {...queued,id:99},{...queued,id:101,path:'.github/workflows/regression.yml'}]});
    if(url.endsWith('/jobs?per_page=100'))return response({jobs:[]});
    return response([]);
  }});
  assert.deepEqual(result.queueDiagnostics.map(x=>x.runId),[42,43,44,45,46]);
  assert.equal(result.diagnosticsIncomplete,true);
});

test('health job summary separates fresh publication, missing scheduled records, and unproved 20-minute coverage',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'price-guard-health-'));
  const summary=path.join(directory,'summary.md');
  const script=new URL('../scripts/check-update-health.mjs',import.meta.url).href;
  const source=`
    globalThis.fetch=async url=>{
      const value=url.includes('/data/')?{checkedAt:new Date().toISOString()}
        :url.endsWith('/actions/workflows/price-guard.yml')?{state:'active'}
        :url.includes('/actions/workflows/price-guard.yml/runs?')?{total_count:0,workflow_runs:[]}:null;
      if(!value)throw Error('Unexpected request: '+url);
      return new Response(JSON.stringify(value));
    };
    await import(${JSON.stringify(script)});
  `;
  try{
    const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',source],{
      env:{...process.env,GITHUB_REPOSITORY:repository,GITHUB_TOKEN:'secret-test-token',GITHUB_RUN_ID:'99',
        PUBLISHED_BASE_URL:options.baseUrl,GITHUB_STEP_SUMMARY:summary}
    });
    const text=await fs.readFile(summary,'utf8');
    assert.match(text,/已发布数据通过新鲜度检查/);
    assert.match(text,/价格检查工作流状态：active/);
    assert.match(text,/最近 60 分钟 schedule 触发的任务记录数：0/);
    assert.match(text,/不能将缺少记录归因于已有任务的并发锁等待/);
    assert.match(text,/均不能证明每 20 分钟完成全量核验/);
    assert.equal(stdout.includes('secret-test-token'),false);
    assert.equal(text.includes('secret-test-token'),false);
  }finally{await fs.rm(directory,{recursive:true,force:true})}
});

test('untrusted repository or credential-bearing public URL is rejected before requesting',async()=>{
  let calls=0;const fetchImpl=async()=>{calls++;return response(old)};
  await assert.rejects(inspectUpdateHealth({...options,repository:'bad/owner/repo',fetchImpl}));
  await assert.rejects(inspectUpdateHealth({...options,baseUrl:'https://user:password@example.test/data',fetchImpl}));
  assert.equal(calls,0);
});
