import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {ALTER_NARBERAL_URL} from '../scripts/lib/alter-procurement.mjs';
import {readAlterPublicHTTP} from '../scripts/lib/alter-public-http.mjs';
import {alternativeProcurementCost,readPublicProcurementDetail,safeProcurementDiagnostic} from '../scripts/lib/procurement-sources.mjs';
import {runPublicProcurement} from '../scripts/lib/procurement-runner.mjs';
import {observedAlterOwn} from './fixtures/alter-procurement.mjs';

const item=()=>structuredClone(observedAlterOwn);
const networkError=(code='UND_ERR_CONNECT_TIMEOUT')=>Object.assign(new TypeError('fetch failed https://private.invalid/?token=SECRET'),{cause:{code,address:'private-address',headers:{authorization:'SECRET'},message:'SECRET'}});
const timing=diagnostic=>{
 assert.ok(Number.isInteger(diagnostic.elapsedMs)&&diagnostic.elapsedMs>=0);
 assert.ok(Number.isInteger(diagnostic.timeoutMs)&&diagnostic.timeoutMs>=1&&diagnostic.timeoutMs<=15000);
};

test('ALTER fetch failure preserves only allowlisted cause and actual timeout, without inventing HTTP status',async t=>{
 const original=AbortSignal.timeout;let actualTimeout,calls=0;
 t.mock.method(AbortSignal,'timeout',ms=>{actualTimeout=ms;return original(ms)});
 const failed=await readAlterPublicHTTP(ALTER_NARBERAL_URL,{item:item(),deadline:Date.now()+1000,request:async(_url,options)=>{
  calls++;assert.equal(options.redirect,'manual');assert.deepEqual(options.headers,{accept:'text/html'});throw networkError();
 }});
 assert.equal(calls,1);assert.equal(failed.reason,'detail_read_error');assert.equal(failed.nativeObservation,undefined);
 assert.equal(failed.diagnostic.stage,'fetch_headers');assert.equal(failed.diagnostic.failureKind,'timeout');
 assert.equal(failed.diagnostic.causeCode,'UND_ERR_CONNECT_TIMEOUT');assert.equal(failed.diagnostic.httpStatus,undefined);assert.equal(failed.diagnostic.finalHost,undefined);
 assert.equal(failed.diagnostic.timeoutMs,actualTimeout);assert.ok(actualTimeout<=1000);timing(failed.diagnostic);
 assert.doesNotMatch(JSON.stringify(failed),/SECRET|private-address|private\.invalid|"headers"|authorization/);
});

test('ALTER body failure records known HTTP status and received bytes at the body stage',async()=>{
 let calls=0;
 const failed=await readAlterPublicHTTP(ALTER_NARBERAL_URL,{item:item(),request:async()=>{
  calls++;return {status:200,url:ALTER_NARBERAL_URL,headers:new Headers({'content-type':'text/html'}),body:(async function*(){yield Buffer.from('123');throw networkError('UND_ERR_BODY_TIMEOUT')})()};
 }});
 assert.equal(calls,1);assert.equal(failed.diagnostic.stage,'body_read');assert.equal(failed.diagnostic.httpStatus,200);
 assert.equal(failed.diagnostic.responseBytes,3);assert.equal(failed.diagnostic.failureKind,'timeout');assert.equal(failed.diagnostic.causeCode,'UND_ERR_BODY_TIMEOUT');timing(failed.diagnostic);
});

test('ALTER parse errors cannot be reported as transport failures and keep no raw exception',async()=>{
 let received=false;
 const target=new Proxy(item(),{get(object,key){if(received&&key==='title')throw Error('SECRET parser input failure');return object[key]}});
 const failed=await readAlterPublicHTTP(ALTER_NARBERAL_URL,{item:target,request:async()=>{received=true;return new Response('<html></html>',{headers:{'content-type':'text/html'}})}});
 assert.equal(failed.reason,'detail_read_error');assert.equal(failed.diagnostic.stage,'parse');assert.equal(failed.diagnostic.failureKind,'reader_error');
 assert.equal(failed.diagnostic.httpStatus,200);assert.equal(failed.diagnostic.responseBytes,13);timing(failed.diagnostic);assert.doesNotMatch(JSON.stringify(failed),/SECRET/);
 const invalid=await readAlterPublicHTTP(ALTER_NARBERAL_URL,{item:item(),request:async()=>new Response(Buffer.from([255]),{headers:{'content-type':'text/html'}})});
 assert.equal(invalid.reason,'public_response_invalid_encoding');assert.equal(invalid.diagnostic.stage,'parse');assert.equal(invalid.diagnostic.httpStatus,200);
});

test('raw reader diagnostics are bounded before standalone proof logging',async t=>{
 let clockReads=0,elapsed=9e9;t.mock.method(performance,'now',()=>clockReads++?elapsed:0);
 const failed=await readAlterPublicHTTP(ALTER_NARBERAL_URL,{item:item(),request:async()=>{throw networkError()}});
 assert.equal(failed.diagnostic.elapsedMs,1_000_000);
 clockReads=0;elapsed=NaN;
 const unknown=await readAlterPublicHTTP(ALTER_NARBERAL_URL,{item:item(),request:async()=>{throw networkError()}});
 assert.equal(unknown.diagnostic.elapsedMs,undefined);
});

test('ALTER HTTP denials retain observed status even if body cancellation fails, without retry',async()=>{
 for(const status of [302,401,403,412,429,502]){
  let calls=0;
  const failed=await readAlterPublicHTTP(ALTER_NARBERAL_URL,{item:item(),request:async()=>{calls++;return {status,body:{cancel:async()=>{throw Error('SECRET cleanup')}}}}});
  assert.equal(calls,1);assert.equal(failed.reason,status===302?'target_redirect_mismatch':'source_http_'+status);
  assert.equal(failed.diagnostic.stage,'fetch_headers');assert.equal(failed.diagnostic.httpStatus,status);timing(failed.diagnostic);
  assert.equal(failed.nativeObservation,undefined);assert.doesNotMatch(JSON.stringify(failed),/SECRET/);
 }
});

test('unknown error data is omitted and persisted diagnostic numbers are finite and bounded',async()=>{
 const unknown=await readAlterPublicHTTP(ALTER_NARBERAL_URL,{item:item(),request:async()=>{throw networkError('SECRET')}});
 assert.equal(unknown.diagnostic.failureKind,'network');assert.equal(unknown.diagnostic.causeCode,undefined);assert.doesNotMatch(JSON.stringify(unknown),/SECRET/);
 const known=await readAlterPublicHTTP(ALTER_NARBERAL_URL,{item:item(),request:async()=>{throw Object.assign(Error('SECRET'),{code:'ECONNRESET'})}});
 assert.equal(known.diagnostic.errorCode,'ECONNRESET');assert.equal(known.diagnostic.failureKind,'network');
 const safe=safeProcurementDiagnostic({errorCode:'SECRET',causeCode:'UND_ERR_CONNECT_TIMEOUT',elapsedMs:Infinity,timeoutMs:-1,rawError:{message:'SECRET'}});
 assert.deepEqual(safe,{causeCode:'UND_ERR_CONNECT_TIMEOUT'});
 assert.deepEqual(safeProcurementDiagnostic({elapsedMs:9e9,timeoutMs:9e9}),{elapsedMs:1_000_000,timeoutMs:1_000_000});
});

test('one failed prefetched ALTER request produces one persisted runner diagnostic even after consume',async()=>{
 for(const failure of ['timeout','http','throw']){
  const target=item();let reads=0;const logs=[];
  const results=await runPublicProcurement([[{item:target,prior:{}}]],{deadline:Date.now()+30000,log:row=>logs.push(row),lookup:(current,options)=>alternativeProcurementCost(current,{...options,
   fingerprint:async()=>({}),search:async()=>[],detail:async(url,opts)=>{
    if(failure==='throw'){reads++;throw Error('SECRET')}
    return readPublicProcurementDetail(url,{...opts,request:async()=>{reads++;if(failure==='timeout')throw networkError();return new Response('',{status:502})}});
   }
  })});
  const reference=results.get(target.accountId+':'+target.id);
  assert.equal(reads,1);assert.equal(reference.detailCheckedCount,1);assert.equal(reference.diagnostics.length,1);assert.equal(reference.reason,'source_unavailable');
  assert.equal(reference.nativeSupplierQuotes.length,0);assert.equal(reference.averageCNY,null);assert.equal(logs.length,1);assert.equal(logs[0].diagnostics.length,1);
  const stored=JSON.parse(JSON.stringify(logs[0]));assert.doesNotMatch(JSON.stringify(stored),/SECRET|private-address|private\.invalid/);
  if(failure==='timeout'){assert.equal(stored.diagnostics[0].detail.causeCode,'UND_ERR_CONNECT_TIMEOUT');assert.equal(stored.diagnostics[0].detail.stage,'fetch_headers');timing(stored.diagnostics[0].detail)}
  if(failure==='http')assert.equal(stored.diagnostics[0].detail.httpStatus,502);
 }
});

test('independent ALTER proof uses the same Node major as production',async()=>{
 const source=await fs.readFile(new URL('../.github/workflows/alter-procurement-proof.yml',import.meta.url),'utf8');
 const production=await fs.readFile(new URL('../.github/workflows/price-scan-transaction.yml',import.meta.url),'utf8');
 assert.match(source,/node-version:\s*'20'/);assert.match(production,/node-version:\s*'20'/);
 assert.match(source,/prove-alter-procurement\.mjs --source-only/);assert.doesNotMatch(source,/\$\{\{\s*secrets\.|playwright install/);
});
