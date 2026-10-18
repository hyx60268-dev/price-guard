import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {encrypt} from '../scripts/lib/crypto.mjs';
import {checkComparisonAuditReceipt,runReceiptCheckCli,COMPARISON_AUDIT_RECEIPT_MAX_BYTES} from '../scripts/check-comparison-audit-receipt.mjs';

const password='synthetic-test-password-only',sha='a'.repeat(40),now=Date.parse('2026-10-18T00:52:00.000Z');
const source='https://hyx60268-dev.github.io/price-guard/data/state.json.enc';
const receipt={version:1,revision:1,consumed:[{requestId:'fixture-audit-once',expectedSha:sha,runId:'12345',startedAt:'2026-10-18T00:37:00.000Z',consumedAt:'2026-10-18T00:37:01.000Z',deadlineAt:'2026-10-18T00:49:00.000Z'}]};
const state=()=>({items:[{accountId:'PRIVATE_ACCOUNT_DO_NOT_LOG',description:'PRIVATE_DESCRIPTION_DO_NOT_LOG'}],manualCosts:{private:12345},checkedAt:'2026-10-18T00:49:05.927Z',dataRevision:'2026-10-18T00:49:05.927Z',cycleCoverage:{finishedAt:'2026-10-18T00:49:05.927Z'},scanMeta:{codeSha:sha},comparisonAuditReceipt:structuredClone(receipt)});
const encrypted=value=>encrypt(Buffer.from(JSON.stringify(value)),password);
async function setup(t,value=state()){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'audit-receipt-check-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'state'),{recursive:true});await fs.mkdir(path.join(root,'public/data'),{recursive:true});
 for(const file of ['state/latest.json.enc','public/data/state.json.enc'])await fs.writeFile(path.join(root,file),encrypted(value));
 return root;
}
const opts=root=>({root,password,now:()=>now});
async function unchanged(root,before){for(const [file,bytes]of before)assert.deepEqual(await fs.readFile(path.join(root,file)),bytes);}
async function snapshot(root){return Promise.all(['state/latest.json.enc','public/data/state.json.enc'].map(async file=>[file,await fs.readFile(path.join(root,file))]));}

test('restored readback validates existing receipt without network, writes, consumption or private output',async t=>{
 const root=await setup(t),before=await snapshot(root);
 const result=await checkComparisonAuditReceipt({...opts(root),fetchImpl:()=>assert.fail('network forbidden')});
 assert.deepEqual(result,{version:1,readOnly:true,mode:'restored',valid:true,evidenceScope:'restored_receipt_validation',codeSha:sha,receipt:{version:1,revision:1,consumedCount:1},networkRequests:0,diagnosticObservedAt:new Date(now).toISOString()});
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE|fixture-audit|12345|password/);await unchanged(root,before);
});
test('already prepared empty ledger is valid and remains empty',async t=>{
 const value=state();value.comparisonAuditReceipt={version:1,revision:0,consumed:[]};const root=await setup(t,value),before=await snapshot(root);
 const result=await checkComparisonAuditReceipt(opts(root));assert.equal(result.valid,true);assert.equal(result.receipt.revision,0);await unchanged(root,before);
});
test('missing, null, corrupt and future ledgers fail closed without initializing',async t=>{
 for(const bad of [undefined,null,{version:1,revision:2,consumed:[]},{...receipt,consumed:[{...receipt.consumed[0],consumedAt:'2026-10-18T01:00:00.000Z'}]}]){
  const value=state();value.comparisonAuditReceipt=bad;const root=await setup(t,value),before=await snapshot(root);
  const result=await checkComparisonAuditReceipt(opts(root));assert.equal(result.reason,'receipt_invalid');assert.equal(result.valid,false);await unchanged(root,before);
 }
});
test('unreadable, wrong-key, invalid JSON and invalid metadata are sanitized',async t=>{
 const root=await setup(t);
 assert.equal((await checkComparisonAuditReceipt({...opts(root),password:'wrong-password'})).reason,'state_decryption_failed');
 await fs.writeFile(path.join(root,'state/latest.json.enc'),encrypt(Buffer.from('{ secret invalid JSON'),password));
 assert.equal((await checkComparisonAuditReceipt(opts(root))).reason,'state_json_invalid');
 for(const change of [{items:null},{scanMeta:{codeSha:'bad'}},{checkedAt:'2027-01-01T00:00:00.000Z'},{dataRevision:'bad'}]){
  await fs.writeFile(path.join(root,'state/latest.json.enc'),encrypted({...state(),...change}));assert.equal((await checkComparisonAuditReceipt(opts(root))).reason,'state_metadata_invalid');
 }
 await fs.rm(path.join(root,'state/latest.json.enc'));assert.equal((await checkComparisonAuditReceipt(opts(root))).reason,'state_unreadable');
 assert.equal((await checkComparisonAuditReceipt({...opts(root),password:''})).reason,'missing_dashboard_key');
});
test('published readback compares current revision and exact ledger with one fixed public request',async t=>{
 const root=await setup(t),before=await snapshot(root);let calls=0;
 const result=await checkComparisonAuditReceipt({...opts(root),mode:'published',expectedCodeSha:sha,fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,source);assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');assert.deepEqual(Object.keys(options.headers).sort(),['cache-control','pragma']);assert.doesNotMatch(JSON.stringify(options),/password|Bearer|PRIVATE/);return new Response(encrypted(state()));
 }});
 assert.equal(calls,1);assert.equal(result.valid,true);assert.equal(result.networkRequests,1);await unchanged(root,before);
});
test('published checker never contacts a market or endpoint supplied in diagnostic options',async t=>{
 const root=await setup(t);let requested;
 const result=await checkComparisonAuditReceipt({...opts(root),mode:'published',expectedCodeSha:sha,url:'https://paypayfleamarket.yahoo.co.jp/item/not-a-real-listing',fetchImpl:async url=>{requested=url;return new Response(encrypted(state()));}});
 assert.equal(result.valid,true);assert.equal(requested,source);
});
test('published SHA and all publication revision clocks must match without renewing old evidence',async t=>{
 const root=await setup(t),before=await snapshot(root);
 for(const change of [{scanMeta:{codeSha:'b'.repeat(40)}},{checkedAt:'2026-10-18T00:48:00.000Z'},{dataRevision:'2026-10-18T00:48:00.000Z'},{cycleCoverage:{finishedAt:'2026-10-18T00:48:00.000Z'}}]){
  const result=await checkComparisonAuditReceipt({...opts(root),mode:'published',expectedCodeSha:sha,fetchImpl:async()=>new Response(encrypted({...state(),...change}))});assert.equal(result.reason,'published_revision_mismatch');
 }
 await unchanged(root,before);
});
test('same numeric revision cannot hide different consumed history or a missing published ledger',async t=>{
 const root=await setup(t),value=state();value.comparisonAuditReceipt.consumed[0].requestId='different-fixture';
 const result=await checkComparisonAuditReceipt({...opts(root),mode:'published',expectedCodeSha:sha,fetchImpl:async()=>new Response(encrypted(value))});assert.equal(result.reason,'published_receipt_mismatch');
 delete value.comparisonAuditReceipt;
 assert.equal((await checkComparisonAuditReceipt({...opts(root),mode:'published',expectedCodeSha:sha,fetchImpl:async()=>new Response(encrypted(value))})).reason,'receipt_invalid');
});
test('missing expected SHA or wrong local SHA stops before any network',async t=>{
 const root=await setup(t),fetchImpl=()=>assert.fail('preflight must block network');
 assert.equal((await checkComparisonAuditReceipt({...opts(root),mode:'published',fetchImpl})).reason,'expected_code_sha_required');
 assert.equal((await checkComparisonAuditReceipt({...opts(root),mode:'published',expectedCodeSha:'b'.repeat(40),fetchImpl})).reason,'local_code_sha_mismatch');
});
test('HTTP denials, redirects and server failure never retry or follow another URL',async t=>{
 const root=await setup(t);
 for(const status of [401,403,429,302,503]){let count=0;const result=await checkComparisonAuditReceipt({...opts(root),mode:'published',expectedCodeSha:sha,fetchImpl:async()=>{count++;return new Response('private message',{status,headers:{location:'https://example.com', 'retry-after':'600'}});}});assert.equal(count,1);assert.equal(result.valid,false);assert.equal(result.reason,[401,403,429].includes(status)?'published_http_denied':'published_http_error');}
});
test('published response bytes are bounded with and without content-length',async t=>{
 const root=await setup(t),maxBytes=4096;
 for(const response of [new Response('small',{headers:{'content-length':String(maxBytes+1)}}),new Response(new Uint8Array(maxBytes+1))]){
  const result=await checkComparisonAuditReceipt({...opts(root),mode:'published',expectedCodeSha:sha,maxBytes,fetchImpl:async()=>response});assert.equal(result.reason,'published_body_too_large');
 }
});
test('network and body exceptions never print their private message or cause',async t=>{
 const root=await setup(t);
 const implementations=[async()=>{throw new Error('PRIVATE password='+password);},async()=>({ok:true,status:200,headers:new Headers(),body:{getReader:()=>({read:async()=>{throw new Error('PRIVATE body')},cancel:async()=>{throw new Error('PRIVATE cancel')}})}})];
 for(const fetchImpl of implementations){const result=await checkComparisonAuditReceipt({...opts(root),mode:'published',expectedCodeSha:sha,fetchImpl});assert.equal(result.reason,'published_network');assert.doesNotMatch(JSON.stringify(result),/PRIVATE|password|cause|stack/);}
});
test('one bounded timeout aborts and does not retry a stalled request',async t=>{
 const root=await setup(t);let calls=0,signal;
 const result=await checkComparisonAuditReceipt({...opts(root),mode:'published',expectedCodeSha:sha,timeoutMs:5,fetchImpl:async(_,options)=>{calls++;signal=options.signal;return new Promise(()=>{});}});
 assert.equal(result.reason,'published_timeout');assert.equal(calls,1);assert.equal(signal.aborted,true);
});
test('CLI prints only the receipt projection and nonzero for invalid or missing state',async t=>{
 const root=await setup(t),lines=[];
 assert.equal(await runReceiptCheckCli({root,args:[],env:{DASHBOARD_PASSWORD:password},write:line=>lines.push(line)}),0);
 assert.equal(await runReceiptCheckCli({root,args:['--untrusted='+password],env:{DASHBOARD_PASSWORD:password},write:line=>lines.push(line)}),1);
 assert.equal(await runReceiptCheckCli({root,args:[],env:{},write:line=>lines.push(line)}),1);
 assert.equal(lines.length,3);assert.doesNotMatch(lines.join('\n'),/PRIVATE|fixture-audit|12345|synthetic-test|--untrusted/);
});
test('diagnostic time is verification end, and regressed or invalid clocks fail closed',async t=>{
 const root=await setup(t);
 for(const after of [now+1500,now-1,NaN]){
  let current=now;
  const result=await checkComparisonAuditReceipt({...opts(root),mode:'published',expectedCodeSha:sha,now:()=>current,fetchImpl:async()=>{current=after;return new Response(encrypted(state()));}});
  assert.equal(result.valid,after===now+1500);
  if(result.valid){assert.equal(result.diagnosticObservedAt,new Date(after).toISOString());assert.equal(result.evidenceScope,'local_publication_receipt_parity');}
  else assert.equal(result.reason,'invalid_options');
 }
});

const publication=value=>({codeSha:value.scanMeta.codeSha,checkedAt:value.checkedAt,dataRevision:value.dataRevision,finishedAt:value.cycleCoverage.finishedAt});
test('checker cap is fixed128MiB and cannot be raised through options',async t=>{
 assert.equal(COMPARISON_AUDIT_RECEIPT_MAX_BYTES,128*1024*1024);const root=await setup(t);
 assert.equal((await checkComparisonAuditReceipt({...opts(root),maxBytes:COMPARISON_AUDIT_RECEIPT_MAX_BYTES+1,fetchImpl:()=>assert.fail('network')})).reason,'invalid_options');
});
test('valid local and streamed ciphertext exactly at a chosen bounded limit passes; one extra byte fails',async t=>{
 const value=state(),root=await setup(t,value),bytes=encrypted(value),maxBytes=bytes.length;
 assert.equal((await checkComparisonAuditReceipt({...opts(root),maxBytes})).valid,true);
 const streamed=()=>new Response(new ReadableStream({start(controller){for(let at=0;at<bytes.length;at+=37)controller.enqueue(bytes.subarray(at,at+37));controller.close()}}),{headers:{'content-length':'1'}});
 assert.equal((await checkComparisonAuditReceipt({...opts(root),maxBytes,mode:'published',expectedCodeSha:sha,fetchImpl:async()=>streamed()})).valid,true);
 await fs.appendFile(path.join(root,'state/latest.json.enc'),Buffer.from([1]));
 const local=await checkComparisonAuditReceipt({...opts(root),maxBytes,fetchImpl:()=>assert.fail('network')});assert.equal(local.reason,'state_too_large');
 const overflow=new Response(new ReadableStream({start(controller){controller.enqueue(bytes);controller.enqueue(Buffer.from([1]));controller.close()}}),{headers:{'content-length':'1'}});
 assert.equal((await checkComparisonAuditReceipt({...opts(root),maxBytes,mode:'published',expectedCodeSha:sha,fetchImpl:async()=>overflow})).reason,'published_body_too_large');
});
test('untrusted content length cannot hide cumulative chunks or leak invalid ciphertext',async t=>{
 const root=await setup(t),maxBytes=4096;
 for(const length of [null,'1','-1','abc','999999999999999999999999999999999999']){
  let cancelled=false;
  const response={ok:true,status:200,headers:new Headers(length===null?{}:{'content-length':length}),body:{getReader(){let n=0;return {async read(){return n++<3?{done:false,value:new Uint8Array(2048)}:{done:true}},async cancel(){cancelled=true}}},async cancel(){cancelled=true}}};
  const report=await checkComparisonAuditReceipt({...opts(root),maxBytes,mode:'published',expectedCodeSha:sha,fetchImpl:async()=>response});
  assert.equal(report.reason,'published_body_too_large');assert.equal(cancelled,true);assert.equal(report.networkRequests,1);
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE|password|cause|stack/);
 }
 const report=await checkComparisonAuditReceipt({...opts(root),maxBytes,mode:'published',expectedCodeSha:sha,fetchImpl:async()=>new Response('PRIVATE fake ciphertext password='+password)});
 assert.equal(report.reason,'state_decryption_failed');assert.doesNotMatch(JSON.stringify(report),/PRIVATE|password|cause|stack/);
});
test('valid encrypted state above former32MiB limit remains bounded and readable',async t=>{
 const value=state();value.fixturePadding='x'.repeat(33*1024*1024);const root=await setup(t,value);
 const report=await checkComparisonAuditReceipt({...opts(root),fetchImpl:()=>assert.fail('network')});assert.equal(report.valid,true);assert.equal(report.networkRequests,0);
});
test('pre-claim parity requires pinned previous deployment metadata, not arbitrary matching historical copies',async t=>{
 const value=state(),root=await setup(t,value),before=await snapshot(root),expectedPublication=publication(value);let calls=0;
 const fetchImpl=async()=>{calls++;return new Response(encrypted(value))};
 const report=await checkComparisonAuditReceipt({...opts(root),mode:'prerequisite',expectedPublication,fetchImpl});
 assert.equal(report.valid,true);assert.equal(report.evidenceScope,'pinned_prior_publication_receipt_parity');assert.equal(calls,1);await unchanged(root,before);
 for(const expected of [undefined,{...expectedPublication,codeSha:'b'.repeat(40)},{...expectedPublication,checkedAt:'2026-10-18T00:48:00.000Z'},{...expectedPublication,dataRevision:'2026-10-18T00:50:00.000Z'},{...expectedPublication,finishedAt:'2027-01-01T00:00:00.000Z'}]){
  const result=await checkComparisonAuditReceipt({...opts(root),mode:'prerequisite',expectedPublication:expected,fetchImpl:()=>assert.fail('pin conflict cannot read Pages')});assert.equal(result.valid,false);assert.equal(result.networkRequests,0);
 }
 await unchanged(root,before);
});
