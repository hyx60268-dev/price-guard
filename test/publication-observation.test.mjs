import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {observePublication} from '../scripts/lib/publication-observation.mjs';

const expected={codeSha:'a'.repeat(40),dataRevision:'2026-10-16T17:57:36.481Z',cycleCoverage:{finishedAt:'2026-10-16T17:57:36.481Z'}};
function fixture(sequence){
 let ms=Date.parse('2026-10-16T18:00:00.000Z'),calls=0;const waits=[],requests=[];
 return {options:{url:'https://dashboard.example/status.json',expected,now:()=>ms,monotonic:()=>ms,sleep:async n=>{waits.push(n);ms+=n;},fetchImpl:async(url,options)=>{requests.push({url,options});const value=sequence[calls++];if(typeof value==='function')return value(n=>ms+=n);if(value instanceof Error)throw value;return value;}},get calls(){return calls;},waits,requests};
}
const response=value=>new Response(JSON.stringify(value),{status:200});
test('exact first observation does not wait or alter source timestamps',async()=>{
 const before=JSON.stringify(expected),f=fixture([response(expected)]),r=await observePublication(f.options);
 assert.equal(r.observedAt,'2026-10-16T18:00:00.000Z');assert.equal(f.calls,1);assert.deepEqual(f.waits,[]);assert.equal(JSON.stringify(expected),before);
 assert.equal(f.requests[0].options.redirect,'error');assert.equal(f.requests[0].options.cache,'no-store');
});
test('old published revision then exact revision is bounded and classified',async()=>{
 const old={...expected,dataRevision:'2026-10-16T17:37:31.949Z'},f=fixture([response(old),response(expected)]),r=await observePublication(f.options);
 assert.equal(f.calls,2);assert.deepEqual(f.waits,[2000]);assert.deepEqual(r.attempts[0].mismatches,['dataRevision']);assert.equal(r.attempts[1].reason,'observed');assert.equal(r.observedAt,'2026-10-16T18:00:02.000Z');
});
test('three stale observations remain operational failure, not refreshed evidence',async()=>{
 const wrong={...expected,codeSha:'b'.repeat(40),cycleCoverage:{finishedAt:'2026-10-16T17:37:31.949Z'}},f=fixture([response(wrong),response(wrong),response(wrong)]),r=await observePublication(f.options);
 assert.equal(f.calls,3);assert.equal(r.observedAt,null);assert.deepEqual(r.attempts[2].mismatches,['codeSha','finishedAt']);assert.deepEqual(f.waits,[2000,2000]);
});
for(const status of [301,401,403,404,429])test(`HTTP ${status} stops read retries`,async()=>{
 const f=fixture([new Response('',{status,headers:{'retry-after':'3600'}})]),r=await observePublication(f.options);
 assert.equal(f.calls,1);assert.deepEqual(f.waits,[]);assert.equal(r.observedAt,null);assert.equal(r.attempts[0].httpStatus,status);assert.equal(r.attempts[0].retryAt,'2026-10-16T19:00:00.000Z');
});
test('malformed huge Retry-After cannot turn denial into a retry or leak raw content',async()=>{
 const f=fixture([new Response('',{status:429,headers:{'retry-after':'9'.repeat(400)}})]),r=await observePublication(f.options);
 assert.equal(f.calls,1);assert.equal(r.attempts[0].httpStatus,429);assert.equal(r.attempts[0].retryAt,undefined);assert.equal(JSON.stringify(r).includes('999999'),false);
});
test('a denied response cleanup cannot stall the bounded observer',async()=>{
 const body=new ReadableStream({cancel(){return new Promise(()=>{});}}),f=fixture([new Response(body,{status:429})]);
 const result=await Promise.race([observePublication(f.options),new Promise((_,reject)=>setTimeout(()=>reject(Error('cleanup blocked observer')),100))]);
 assert.equal(result.attempts[0].httpStatus,429);assert.equal(f.calls,1);
});
test('server retry-after is respected even on a transient server response',async()=>{
 const f=fixture([new Response('',{status:503,headers:{'retry-after':'Fri, 16 Oct 2026 18:02:00 GMT'}})]),r=await observePublication(f.options);
 assert.equal(f.calls,1);assert.equal(r.attempts[0].retryAt,'2026-10-16T18:02:00.000Z');
});
test('unparseable Retry-After and a Retry-After on stale successful JSON both stop conservatively',async()=>{
 for(const first of [new Response('',{status:503,headers:{'retry-after':'unknown PRIVATE value'}}),new Response(JSON.stringify({...expected,dataRevision:'2026-10-16T17:37:31.949Z'}),{headers:{'retry-after':'60'}})]){
  const f=fixture([first]),r=await observePublication(f.options);assert.equal(f.calls,1);assert.equal(r.observedAt,null);assert.deepEqual(f.waits,[]);assert.doesNotMatch(JSON.stringify(r),/PRIVATE/);
 }
});
test('network and JSON diagnostics are allowlisted, and never expose error/body text',async()=>{
 const error=Object.assign(new Error('PRIVATE address/token'),{cause:{code:'UND_ERR_CONNECT_TIMEOUT'},observationReason:'PRIVATE body'}),f=fixture([error,new Response('PRIVATE bad json'),response(expected)]),r=await observePublication(f.options);
 assert.equal(r.attempts[0].reason,'timeout');assert.equal(r.attempts[0].code,'UND_ERR_CONNECT_TIMEOUT');assert.equal(r.attempts[1].reason,'invalid_json');assert.equal(r.attempts[1].httpStatus,200);assert.ok(r.observedAt);assert.doesNotMatch(JSON.stringify(r),/PRIVATE|token|address/);
});
test('monotonic total deadline caps retries independently of wall clock',async()=>{
 const f=fixture([advance=>{advance(29000);throw Error('network');},response(expected)]),r=await observePublication(f.options);
 assert.equal(f.calls,1);assert.deepEqual(f.waits,[]);assert.equal(r.observedAt,null);assert.equal(r.attempts[0].elapsedMs,29000);assert.equal(r.attempts[0].reason,'deadline_exceeded');
});
test('fractional monotonic milliseconds still allow the final bounded request',async()=>{
 const f=fixture([advance=>{advance(9000.25);throw Error('first');},advance=>{advance(9000.25);throw Error('second');},response(expected)]),r=await observePublication(f.options);
 assert.equal(f.calls,3);assert.ok(r.observedAt);assert.equal(r.attempts[2].reason,'observed');
});
test('a late exact result is not accepted and real elapsed time is not truncated',async()=>{
 for(const milliseconds of [10001,31000]){const f=fixture([advance=>{advance(milliseconds);return response(expected);}]),r=await observePublication(f.options);assert.equal(r.observedAt,null);assert.equal(f.calls,1);assert.equal(r.attempts[0].reason,'deadline_exceeded');assert.equal(r.attempts[0].elapsedMs,milliseconds);}
});
test('oversize body is bounded and cannot be parsed as accepted status',async()=>{
 const f=fixture([new Response('x'.repeat(256001)),new Response('x'.repeat(256001)),new Response('x'.repeat(256001))]),r=await observePublication(f.options);
 assert.equal(r.observedAt,null);assert.ok(r.attempts.every(x=>x.reason==='body_too_large'));
});
test('invalid expected revision or credential-bearing URL performs no request',async()=>{
 for(const extra of [{expected:{...expected,dataRevision:undefined}},{url:'https://user:secret@dashboard.example/status.json'},{url:'http://dashboard.example/status.json'}]){
  const f=fixture([]),r=await observePublication({...f.options,...extra});assert.equal(f.calls,0);assert.equal(r.observedAt,null);assert.doesNotMatch(JSON.stringify(r),/secret/);
 }
});
test('real checker preserves product failure and input clocks after exact readback',async t=>{
 const source=fileURLToPath(new URL('../',import.meta.url)),root=await fs.mkdtemp(path.join(os.tmpdir(),'publication-checker-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 for(const name of ['scripts','public'])await fs.cp(path.join(source,name),path.join(root,name),{recursive:true,filter:p=>!p.includes(path.sep+'data'+path.sep)});
 await fs.mkdir(path.join(root,'public/data'),{recursive:true});await fs.writeFile(path.join(root,'package.json'),'{"type":"module"}');
 const status={...expected,total:1,checkedAt:expected.dataRevision,cycleCoverage:{...expected.cycleCoverage,total:1,priceComplete:0,costVerified:0,completeItems:0,accounts:[]}},bytes=JSON.stringify(status),statusPath=path.join(root,'public/data/status.json');await fs.writeFile(statusPath,bytes);
 await fs.writeFile(path.join(root,'mock-fetch.mjs'),`globalThis.fetch=async url=>{if(url!=='https://dashboard.example/status.json')throw Error('Unexpected source request');return new Response(${JSON.stringify(bytes)});};`);
 const resultPath=path.join(root,'result.json'),env={...process.env,PUBLISHED_STATUS_URL:'https://dashboard.example/status.json',GITHUB_SHA:expected.codeSha,ACCEPTANCE_RESULT_PATH:resultPath};delete env.NODE_TEST_CONTEXT;delete env.GITHUB_STEP_SUMMARY;
 let result;try{result=await promisify(execFile)(process.execPath,['--import',path.join(root,'mock-fetch.mjs'),'scripts/check-cycle-coverage.mjs'],{cwd:root,env});}catch(error){assert.equal(error.code,1);result=error;}
 const outcome=JSON.parse(await fs.readFile(resultPath,'utf8'));assert.equal(outcome.kind,'product');assert.equal(outcome.accepted,false);assert.equal(await fs.readFile(statusPath,'utf8'),bytes);assert.match(result.stdout,/"reason":"observed"/);assert.doesNotMatch(result.stdout,/current_publication_not_observed/);
});
