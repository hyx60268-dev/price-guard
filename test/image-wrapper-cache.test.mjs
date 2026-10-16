import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { configureImageFingerprintCache,imageFingerprints } from '../scripts/lib/image.mjs';

test('process-level image wrapper obeys source expiry/no-cache/no-store and deduplicates only eligible reads',async()=>{
 const original=globalThis.fetch;
 const first=await sharp({create:{width:64,height:64,channels:3,background:'#125ab8'}}).png().toBuffer();
 const changed=await sharp({create:{width:64,height:64,channels:3,background:'#e81298'}}).png().toBuffer();
 let time=1000,body=first,reads=0,header='public, max-age=1';
 globalThis.fetch=async()=>{reads++;return new Response(body,{headers:{'cache-control':header,'content-type':'image/png'}})};
 try{
  configureImageFingerprintCache({now:()=>time});
  const [a,b]=await Promise.all([imageFingerprints('https://fixture.test/image'),imageFingerprints('https://fixture.test/image')]);
  assert.equal(reads,1);assert.equal(a.contentSha256,b.contentSha256);
  time=3000;body=changed;const c=await imageFingerprints('https://fixture.test/image');
  assert.equal(reads,2);assert.notEqual(c.contentSha256,a.contentSha256);assert.equal(c.imageObservedAt,new Date(time).toISOString());
  for(const directive of ['public, no-cache, max-age=3600','no-store']){
   header=directive;const before=reads;
   await imageFingerprints('https://fixture.test/'+directive);await imageFingerprints('https://fixture.test/'+directive);assert.equal(reads-before,2);
  }
 }finally{globalThis.fetch=original;configureImageFingerprintCache()}
});
