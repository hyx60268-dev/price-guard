import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {encrypt} from '../scripts/lib/crypto.mjs';
import {readSharedQuotePublication,runSharedQuoteDiagnosticCli,MAX_SHARED_QUOTE_BYTES} from '../scripts/read-shared-quote-publication.mjs';
import {sharedPublicationFixture} from './fixtures/shared-quote-publication.fixture.mjs';
const password='synthetic-readback-password',now=()=>Date.parse('2026-10-18T08:00:00.000Z');
const env={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'pull_request',GITHUB_REPOSITORY:'hyx60268-dev/price-guard',GITHUB_HEAD_REF:'diagnostic/shared-607-counts',AUDIT_HEAD_REPOSITORY:'hyx60268-dev/price-guard',AUDIT_BASE_REF:'main',GITHUB_RUN_ATTEMPT:'1',AUDIT_HEAD_SHA:'a'.repeat(40),CHECKED_OUT_SHA:'a'.repeat(40),DASHBOARD_PASSWORD:password};
const encoded=state=>encrypt(Buffer.from(JSON.stringify(state)),password);
const call=(fetchImpl,extra={})=>readSharedQuotePublication({password,env,now,fetchImpl,...extra});
test('one fixed authenticated-state read never transmits key or returns private data',async()=>{
 const calls=[],body=encoded(sharedPublicationFixture());
 const result=await call(async(url,opts)=>{calls.push({url,opts});return new Response(body);},{maxBytes:body.length});
 assert.equal(result.valid,true);assert.equal(result.summary.storedSharedOffers,9);assert.equal(result.summary.validSharedPairsAtDiagnostic,0);
 assert.equal(calls.length,1);assert.equal(calls[0].url,'https://hyx60268-dev.github.io/price-guard/data/state.json.enc');assert.equal(calls[0].opts.redirect,'error');assert.equal(calls[0].opts.credentials,'omit');assert.equal(calls[0].opts.method,'GET');
 assert.equal(result.marketplaceRequests,0);assert.equal(result.stateWrites,0);assert.doesNotMatch(JSON.stringify({result,calls}),/PRIVATE|synthetic-readback-password|own-0|external-0/);
});
test('untrusted PR, fork, arbitrary branch, checkout mismatch, cron and rerun perform zero network',async()=>{
 for(const change of [{GITHUB_ACTIONS:'false'},{GITHUB_EVENT_NAME:'schedule'},{GITHUB_EVENT_NAME:'push'},{GITHUB_REPOSITORY:'other/repo'},{AUDIT_HEAD_REPOSITORY:'other/repo'},{AUDIT_BASE_REF:'other'},{GITHUB_HEAD_REF:'main'},{GITHUB_RUN_ATTEMPT:'2'},{AUDIT_HEAD_SHA:'bad'},{CHECKED_OUT_SHA:'b'.repeat(40)}]){
  let n=0;const r=await call(async()=>{n++;throw Error('PRIVATE');},{env:{...env,...change}});assert.equal(r.reason,'untrusted_execution_context');assert.equal(n,0);
 }
});
test('size guard accepts exact cap and rejects actual excess despite dishonest header',async()=>{
 const body=encoded(sharedPublicationFixture());assert.equal((await call(async()=>new Response(body),{maxBytes:body.length})).valid,true);
 const over=await call(async()=>new Response(Buffer.concat([body,Buffer.from('x')]),{headers:{'content-length':'1'}}),{maxBytes:body.length});assert.equal(over.reason,'published_body_too_large');
 const header=await call(async()=>new Response(body,{headers:{'content-length':'99999999999999999999999'}}));assert.equal(header.reason,'published_body_too_large');
 for(const maxBytes of [0,MAX_SHARED_QUOTE_BYTES+1,Infinity]){let n=0;const r=await call(async()=>{n++;},{maxBytes});assert.equal(r.reason,'invalid_options');assert.equal(n,0);}
});
test('network denial, redirect, corruption, timeout and invalid JSON expose only fixed reasons',async()=>{
 for(const status of [401,403,429,500]){const r=await call(async()=>new Response('PRIVATE',{status}));assert.equal(r.valid,false);assert.doesNotMatch(JSON.stringify(r),/PRIVATE/);}
 assert.equal((await call(async()=>({ok:true,redirected:true,url:'https://private.invalid'}))).reason,'published_redirect');
 assert.equal((await call(async()=>{throw Error('PRIVATE');})).reason,'published_network');
 assert.equal((await call(async()=>new Response('PRIVATE'))).reason,'state_decryption_failed');
 assert.equal((await call(async()=>new Response(encrypt(Buffer.from('{PRIVATE'),password)))).reason,'state_json_invalid');
 let n=0;const timeout=await call(async()=>{n++;return new Response(new ReadableStream({pull(){return new Promise(()=>{});}}));},{timeoutMs:5});assert.equal(timeout.reason,'published_timeout');assert.equal(n,1);
});
test('snapshot mismatch fails without result, values or a second request',async()=>{
 const state=sharedPublicationFixture();state.checkedAt='PRIVATE';let n=0;const r=await call(async()=>{n++;return new Response(encoded(state));});assert.equal(r.valid,false);assert.equal(r.summaryReason,'state_metadata_invalid');assert.equal(r.summary,undefined);assert.equal(n,1);assert.doesNotMatch(JSON.stringify(r),/PRIVATE/);
});
test('CLI arguments and missing password cause zero requests and never echo arguments',async()=>{
 let n=0;const out=[];const fetchImpl=async()=>{n++;throw Error('PRIVATE');};
 assert.equal(await runSharedQuoteDiagnosticCli({args:['PRIVATE'],env,write:x=>out.push(x),fetchImpl,now}),1);
 assert.equal((await call(fetchImpl,{password:''})).reason,'missing_dashboard_key');assert.equal(n,0);assert.doesNotMatch(out.join(''),/PRIVATE|synthetic-readback-password/);
});
test('isolated workflow tests exact head before one same-repo read-only job with only existing key',async()=>{
 const w=await fs.readFile(new URL('../.github/workflows/tests.yml',import.meta.url),'utf8'),job=w.slice(w.indexOf('  saved-shared-quote-readback:'));
 assert.match(w.slice(0,w.indexOf('  saved-shared-quote-readback:')),/ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
 for(const pattern of [/needs: test/,/github\.event_name == 'pull_request'/,/head\.repo\.full_name == github\.repository/,/github\.repository == 'hyx60268-dev\/price-guard'/,/github\.head_ref == 'diagnostic\/shared-607-counts'/,/base\.ref == 'main'/,/github\.run_attempt == 1/,/ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/,/persist-credentials: false/,/contents: read/,/node scripts\/read-shared-quote-publication\.mjs/])assert.match(job,pattern);
 assert.equal((job.match(/secrets\./g)||[]).length,1);assert.match(job,/secrets\.DASHBOARD_PASSWORD/);assert.doesNotMatch(job,/pull_request_target|scan\.mjs|npm run scan|contents:\s*write|id-token:\s*write|workflow_dispatch/);
 const cli=await fs.readFile(new URL('../scripts/read-shared-quote-publication.mjs',import.meta.url),'utf8');assert.doesNotMatch(cli,/writeFile|claimComparisonAudit|consumeReceipt|from ['"].*(?:scan|comparison-audit-state|fs)/);
});
