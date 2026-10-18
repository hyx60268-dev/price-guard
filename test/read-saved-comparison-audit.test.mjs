import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {encrypt} from '../scripts/lib/crypto.mjs';
import {readSavedComparisonAudit,runSavedAuditDiagnosticCli,savedAuditDiagnosticContext,MAX_SAVED_AUDIT_BYTES} from '../scripts/read-saved-comparison-audit.mjs';
import {createSavedComparisonAuditFixture} from './fixtures/saved-comparison-audit.fixture.mjs';
const NOW=Date.parse('2026-10-18T02:50:00.000Z'),password='synthetic-unit-test-key';
const env={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'pull_request',GITHUB_REPOSITORY:'hyx60268-dev/price-guard',GITHUB_HEAD_REF:'fix/read-saved-audit-matrix',AUDIT_HEAD_REPOSITORY:'hyx60268-dev/price-guard',AUDIT_BASE_REF:'main',GITHUB_RUN_ATTEMPT:'1',AUDIT_HEAD_SHA:'a'.repeat(40),CHECKED_OUT_SHA:'a'.repeat(40),DASHBOARD_PASSWORD:password};
const bytes=state=>encrypt(Buffer.from(JSON.stringify(state)),password);
function fetchFor(body,options={}){
 const calls=[];
 return {calls,fetchImpl:async (url,request)=>{calls.push({url,request});return new Response(body,{status:200,headers:{'content-length':String(body.length)},...options});}};
}
const run=(mock,options={})=>readSavedComparisonAudit({env,password,now:()=>NOW,...mock,...options});

test('readback decrypts one fixed Pages observation and emits only the allowlisted saved summary',async()=>{
 const state=await createSavedComparisonAuditFixture(),before=structuredClone(state),raw=bytes(state),mock=fetchFor(raw);
 const result=await run(mock,{maxBytes:raw.length});
 assert.equal(result.valid,true);assert.equal(result.networkRequests,1);assert.equal(result.marketplaceRequests,0);assert.equal(result.stateWrites,0);
 assert.equal(mock.calls.length,1);assert.equal(mock.calls[0].url,'https://hyx60268-dev.github.io/price-guard/data/state.json.enc');
 assert.equal(mock.calls[0].request.method,'GET');assert.equal(mock.calls[0].request.redirect,'error');assert.equal(mock.calls[0].request.credentials,'omit');
 assert.equal(JSON.stringify(mock.calls[0]).includes(password),false);assert.deepEqual(state,before);
 assert.equal(result.summary.source.requestId,'lp-card-20261018-once-v1');
});

test('fork, arbitrary branch, cron, main push, rerun and checkout mismatch never receive the key or fetch data',async()=>{
 const patches=[{GITHUB_ACTIONS:'false'},{GITHUB_EVENT_NAME:'push'},{GITHUB_EVENT_NAME:'schedule'},{GITHUB_REPOSITORY:'foreign/repo'},{AUDIT_HEAD_REPOSITORY:'foreign/repo'},{GITHUB_HEAD_REF:'other'},{AUDIT_BASE_REF:'other'},{GITHUB_RUN_ATTEMPT:'2'},{CHECKED_OUT_SHA:'b'.repeat(40)},{AUDIT_HEAD_SHA:'not-a-sha'}];
 for(const change of patches){let calls=0;const result=await readSavedComparisonAudit({env:{...env,...change},password,now:()=>NOW,fetchImpl:async()=>{calls++;throw Error('must not fetch');}});assert.equal(result.reason,'untrusted_execution_context');assert.equal(calls,0);assert.equal(result.networkRequests,0);}
 assert.equal(savedAuditDiagnosticContext(env),true);assert.equal(savedAuditDiagnosticContext(),false);
});

test('missing key, oversized options and arbitrary CLI arguments are rejected without a request',async()=>{
 let calls=0;const mock={fetchImpl:async()=>{calls++;throw Error('must not fetch');}};
 assert.equal((await run(mock,{password:''})).reason,'missing_dashboard_key');
 for(const maxBytes of [0,MAX_SAVED_AUDIT_BYTES+1,Infinity])assert.equal((await run(mock,{maxBytes})).reason,'invalid_options');
 for(const timeoutMs of [0,10_001])assert.equal((await run(mock,{timeoutMs})).reason,'invalid_options');
 const output=[];assert.equal(await runSavedAuditDiagnosticCli({args:['https://example.invalid'],env,write:line=>output.push(line),...mock}),1);
 assert.equal(calls,0);assert.equal(output.length,1);assert.ok(!output[0].includes(password));
});

test('actual streamed bytes enforce the exact bound despite a misleading Content-Length',async()=>{
 const raw=bytes(await createSavedComparisonAuditFixture());
 const exact=await run(fetchFor(raw),{maxBytes:raw.length});assert.equal(exact.valid,true);
 const over=Buffer.concat([raw,Buffer.from('x')]);
 const response=new Response(new ReadableStream({start(controller){controller.enqueue(over.subarray(0,20));controller.enqueue(over.subarray(20));controller.close();}}),{headers:{'content-length':'1'}});
 const result=await run({fetchImpl:async()=>response},{maxBytes:raw.length});assert.equal(result.reason,'published_body_too_large');assert.equal(result.networkRequests,1);
 const header=await run(fetchFor(raw,{headers:{'content-length':'9999999999999999999999999999'}}));assert.equal(header.reason,'published_body_too_large');
});

test('denial, redirect, network, body and cryptographic errors never leak their response or exception',async()=>{
 const secret='PRIVATE_RESPONSE_AND_CREDENTIAL_VALUE';
 for(const status of [401,403,429,500]){const result=await run(fetchFor(secret,{status}));assert.equal(result.valid,false);assert.ok(!JSON.stringify(result).includes(secret));assert.equal(result.networkRequests,1);}
 const redirected={ok:true,status:200,redirected:true,url:'https://example.invalid/?secret='+secret,body:{cancel:async()=>{}}};
 assert.equal((await run({fetchImpl:async()=>redirected})).reason,'published_redirect');
 const network=await run({fetchImpl:async()=>{throw Error(secret);}});assert.equal(network.reason,'published_network');assert.ok(!JSON.stringify(network).includes(secret));
 const corrupt=await run(fetchFor(Buffer.from(secret)));assert.equal(corrupt.reason,'state_decryption_failed');
 const invalid=await run(fetchFor(encrypt(Buffer.from('{'+secret),password)));assert.equal(invalid.reason,'state_json_invalid');
 const broken=new Response(new ReadableStream({start(c){c.error(Error(secret));}}));const body=await run({fetchImpl:async()=>broken});assert.equal(body.valid,false);assert.ok(!JSON.stringify(body).includes(secret));
});

test('one bounded read times out without retry or reporting unfinished body as a result',async()=>{
 let calls=0;const result=await run({fetchImpl:async()=>{calls++;return new Response(new ReadableStream({pull(){return new Promise(()=>{});}}));}},{timeoutMs:5});
 assert.equal(result.reason,'published_timeout');assert.equal(calls,1);assert.equal(result.networkRequests,1);assert.equal(result.summary,undefined);
});

test('pinned snapshot disagreement yields no raw state or summary payload',async()=>{
 const state=await createSavedComparisonAuditFixture();state.scanMeta.codeSha='b'.repeat(40);state.privateDescription='PRIVATE_STORED_DESCRIPTION';
 const result=await run(fetchFor(bytes(state)));assert.equal(result.reason,'summary_invalid');assert.equal(result.summaryReason,'state_metadata_invalid');assert.equal(result.summary,undefined);assert.ok(!JSON.stringify(result).includes(state.privateDescription));
});

test('only the same-repository readback PR job gets the existing key after tests, never scan or ledger operations',async()=>{
 const workflow=await fs.readFile(new URL('../.github/workflows/tests.yml',import.meta.url),'utf8');
 assert.match(workflow.slice(0,workflow.indexOf('  saved-audit-readback:')),/ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
 const job=workflow.slice(workflow.indexOf('  saved-audit-readback:'));
 assert.match(job,/needs: test/);assert.match(job,/github\.event_name == 'pull_request'/);
 assert.match(job,/head\.repo\.full_name == github\.repository/);assert.match(job,/github\.repository == 'hyx60268-dev\/price-guard'/);
 assert.match(job,/github\.head_ref == 'fix\/read-saved-audit-matrix'/);assert.match(job,/base\.ref == 'main'/);assert.match(job,/github\.run_attempt == 1/);
 assert.match(job,/ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);assert.match(job,/persist-credentials: false/);
 assert.match(job,/contents: read/);assert.match(job,/node scripts\/read-saved-comparison-audit\.mjs/);
 assert.equal((job.match(/secrets\./g)||[]).length,1);assert.match(job,/secrets\.DASHBOARD_PASSWORD/);
 assert.doesNotMatch(job,/pull_request_target\s*:|secrets:\s*inherit|scan\.mjs|npm run scan|id-token:\s*write|contents:\s*write|workflow_dispatch\s*:/);
 const cli=await fs.readFile(new URL('../scripts/read-saved-comparison-audit.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(cli,/from ['"].*(?:scan|comparison-audit-state|fs)/);assert.doesNotMatch(cli,/writeFile|consumeReceipt|claimComparisonAudit/);
});


test('saved-validation failures expose only their fixed stage code without failed values',async()=>{
 const cases=[['receipt_invalid',state=>{state.comparisonAuditReceipt.revision=9;}],['audit_metadata_invalid',state=>{state.comparisonAudit.flowMode='SECRET_VALUE';}],['audit_targets_invalid',state=>{state.comparisonAudit.targets=[];}],['audit_time_invalid',state=>{state.comparisonAudit.frozenAt='SECRET_VALUE';}],['audit_counts_inconsistent',state=>{state.comparisonAudit.counts.paired++;}],['audit_controller_inconsistent',state=>{state.comparisonAudit.controller.counts.cacheReuses++;}],['audit_source_inconsistent',state=>{state.comparisonAudit.targets[0].recommendationReceipt.sourceUrl='https://example.invalid/SECRET_VALUE';}]];
 for(const [expected,mutate] of cases){const state=await createSavedComparisonAuditFixture();mutate(state);const result=await run(fetchFor(bytes(state)));assert.equal(result.reason,'summary_invalid');assert.equal(result.summaryReason,expected);assert.equal(result.summary,undefined);assert.ok(!JSON.stringify(result).includes('SECRET_VALUE'));assert.equal(result.networkRequests,1);}
});
