import test from 'node:test';
import assert from 'node:assert/strict';
import { publishedUpdateHealth,describeWriterRun,inspectUpdateHealth } from '../scripts/lib/update-health.mjs';

const now=Date.parse('2026-10-04T13:51:00Z'),repository='example/price-guard';
const options={repository,baseUrl:'https://example.github.io/price-guard/data',now,runId:99,token:'secret-test-token'};
const old={checkedAt:'2026-10-02T13:28:00Z'};
const queued={id:42,path:'.github/workflows/price-guard.yml@main',status:'queued',created_at:'2026-10-02T13:34:45Z'};
const response=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});

test('fresh data passes; 90-minute staleness, missing and future timestamps fail honestly',()=>{
  assert.equal(publishedUpdateHealth({checkedAt:'2026-10-04T13:31:00Z'},{now}).healthy,true);
  assert.equal(publishedUpdateHealth({checkedAt:'2026-10-04T12:21:00Z'},{now}).healthy,true);
  assert.equal(publishedUpdateHealth({checkedAt:'2026-10-04T12:20:59Z'},{now}).healthy,false);
  assert.equal(publishedUpdateHealth(old,{now}).reason,'published_data_stale');
  assert.equal(publishedUpdateHealth({}, {now}).reason,'invalid_checked_at');
  assert.equal(publishedUpdateHealth({checkedAt:'2026-10-04T14:51:00Z'},{now}).reason,'future_checked_at');
});

test('fresh publication needs no privileged Actions request',async()=>{
  let count=0;
  const result=await inspectUpdateHealth({...options,fetchImpl:async(url,request)=>{
    count++;assert.equal(request.headers.authorization,undefined);
    return response({checkedAt:'2026-10-04T13:40:00Z'});
  }});
  assert.equal(count,1);assert.equal(result.healthy,true);
});

test('actual queued zero-step incident is diagnosed without inventing approval or modifying tasks',async()=>{
  const calls=[];
  const result=await inspectUpdateHealth({...options,fetchImpl:async(url,request)=>{
    calls.push(url);assert.equal(request.method,undefined);assert.equal(request.redirect,'error');
    if(url.includes('/data/status.json')){
      assert.equal(request.headers.authorization,undefined);return response(old);
    }
    assert.equal(request.headers.authorization,'Bearer secret-test-token');
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
  assert.equal(calls.length,7);
});

test('real environment approval, unknown steps, and active work remain distinct',()=>{
  assert.equal(describeWriterRun(queued,[{status:'queued',steps:[]}],[{environment:{name:'github-pages'}}],repository).reason,'deployment_review_pending');
  assert.equal(describeWriterRun(queued,[{status:'queued',steps:null}],[],repository).reason,'run_state_unconfirmed');
  assert.equal(describeWriterRun({...queued,status:'in_progress'},[{status:'in_progress',steps:[{name:'Scan'}]}],[],repository).reason,'job_running');
  assert.equal(describeWriterRun({...queued,status:'pending'},[],[],repository).reason,'shared_lock_pending');
});

test('missing published status and unavailable queue APIs never claim fresh data or an empty healthy queue',async()=>{
  const result=await inspectUpdateHealth({...options,fetchImpl:async()=>new Response('',{status:503})});
  assert.equal(result.healthy,false);assert.equal(result.reason,'published_status_unavailable');
  assert.equal(result.diagnosticsIncomplete,true);
});

test('diagnosis excludes its own run and unrelated workflows and bounds oldest-writer lookups',async()=>{
  const many=Array.from({length:7},(_,i)=>({...queued,id:42+i,created_at:new Date(now-(10-i)*60_000).toISOString()}));
  const result=await inspectUpdateHealth({...options,fetchImpl:async url=>{
    if(url.includes('/data/'))return response(old);
    if(url.includes('/actions/runs?'))return response({total_count:10,workflow_runs:[...many,
      {...queued,id:99},{...queued,id:101,path:'.github/workflows/regression.yml'}]});
    if(url.endsWith('/jobs?per_page=100'))return response({jobs:[]});
    return response([]);
  }});
  assert.deepEqual(result.queueDiagnostics.map(x=>x.runId),[42,43,44,45,46]);
  assert.equal(result.diagnosticsIncomplete,true);
});

test('untrusted repository or credential-bearing public URL is rejected before requesting',async()=>{
  let calls=0;const fetchImpl=async()=>{calls++;return response(old)};
  await assert.rejects(inspectUpdateHealth({...options,repository:'bad/owner/repo',fetchImpl}));
  await assert.rejects(inspectUpdateHealth({...options,baseUrl:'https://user:password@example.test/data',fetchImpl}));
  assert.equal(calls,0);
});
