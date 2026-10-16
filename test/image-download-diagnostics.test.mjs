import test from 'node:test';
import assert from 'node:assert/strict';
import {configureImageFingerprintCache,imageFingerprints,imageFingerprintDiagnostic} from '../scripts/lib/image.mjs';

async function fixture(fetcher,run){
 const original=globalThis.fetch;globalThis.fetch=fetcher;configureImageFingerprintCache();
 try{await run()}finally{globalThis.fetch=original;configureImageFingerprintCache()}
}
test('image access denials stop retries and preserve only bounded status provenance',async()=>{
 for(const status of [401,403,429]){
  let reads=0;const url='https://fixture.test/source-image?private=never-log';
  await fixture(async()=>{reads++;return new Response('secret response body',{status,headers:{'retry-after':'120'}})},async()=>{
   assert.equal(await imageFingerprints(url),null);assert.equal(reads,1);
   const result=imageFingerprintDiagnostic(url);assert.equal(result.httpStatus,status);assert.equal(result.reason,'http_error');assert.equal(result.retryAfter,'120');assert.equal(result.attempt,1);
   assert.ok(Number.isFinite(Date.parse(result.checkedAt)));assert.ok(result.elapsedMs>=0);
   assert.doesNotMatch(JSON.stringify(result),/secret|private|fixture/);
   result.reason='forged';assert.equal(imageFingerprintDiagnostic(url).reason,'http_error');
  });
 }
});
test('image diagnostics distinguish timeout, network, truncated body and decode errors',async()=>{
 const url='https://fixture.test/image';
 for(const [reason,fetcher,stage] of [
  ['timeout',async()=>{throw new DOMException('private error','TimeoutError')},'download'],
  ['network_error',async()=>{throw new Error('private network text')},'download'],
  ['body_length_mismatch',async()=>new Response('partial',{headers:{'content-length':'20'}}),'download'],
  ['decode_error',async()=>new Response('not an image'),'fingerprint']
 ])await fixture(fetcher,async()=>{
  assert.equal(await imageFingerprints(url),null);
  const result=imageFingerprintDiagnostic(url);assert.equal(result.reason,reason);assert.equal(result.stage,stage);assert.doesNotMatch(JSON.stringify(result),/private|not an image/);
 });
});
test('failed image remains unverified; a later real observation replaces failure provenance',async()=>{
 const url='https://fixture.test/image';let fail=true,reads=0;
 await fixture(async()=>{reads++;return new Response(fail?'unavailable':'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>',{status:fail?503:200})},async()=>{
  assert.equal(await imageFingerprints(url),null);assert.equal(reads,2);assert.equal(imageFingerprintDiagnostic(url).httpStatus,503);
  fail=false;assert.ok((await imageFingerprints(url))?.contentSha256);assert.equal(reads,3);assert.equal(imageFingerprintDiagnostic(url).reason,'body_received');assert.equal(imageFingerprintDiagnostic(url).httpStatus,200);
 });
});

test('untrusted Retry-After is omitted and diagnostic memory is bounded',async()=>{
 await fixture(async()=>new Response('blocked',{status:429,headers:{'retry-after':'Wed, 21 Oct 2015 07:28:00 GMT (private comment)'}}),async()=>{
  assert.equal(await imageFingerprints('https://fixture.test/date'),null);
  assert.equal(imageFingerprintDiagnostic('https://fixture.test/date').retryAfter,'Wed, 21 Oct 2015 07:28:00 GMT');
 });
 await fixture(async()=>new Response('blocked',{status:429,headers:{'retry-after':'private arbitrary data'}}),async()=>{
  for(let i=0;i<501;i++)assert.equal(await imageFingerprints('https://fixture.test/'+i),null);
  assert.equal(imageFingerprintDiagnostic('https://fixture.test/0'),null);
  assert.equal(imageFingerprintDiagnostic('https://fixture.test/500').retryAfter,null);
 });
});
