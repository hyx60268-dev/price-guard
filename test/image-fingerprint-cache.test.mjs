import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createFingerprintLoader } from '../scripts/lib/image-fingerprint-cache.mjs';

async function fixture(run){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'image-fingerprint-test-'));
 try{await run(directory)}finally{await fs.rm(directory,{recursive:true,force:true})}
}
test('source-declared fresh image survives restart without re-downloading or renewing observation time',()=>fixture(async directory=>{
 let time=1000,reads=0,computes=0;
 const options={directory,now:()=>time,fetchImage:async()=>{reads++;return {buffer:Buffer.from('image bytes'),cacheControl:'public, max-age=3600'}},fingerprint:async()=>{computes++;return {dHash:'computed'}}};
 const first=await createFingerprintLoader(options).get('https://fixture.test/image');
 time=2000;const warm=createFingerprintLoader(options),second=await warm.get('https://fixture.test/image');
 assert.equal(reads,1);assert.equal(computes,1);assert.equal(second.imageObservedAt,first.imageObservedAt);assert.equal(second.imageCacheSource,'http_fresh');
 time=3601_001;const expired=createFingerprintLoader(options),third=await expired.get('https://fixture.test/image');
 assert.equal(reads,2);assert.equal(computes,1);assert.equal(expired.stats.contentReuses,1);assert.equal(third.imageObservedAt,new Date(time).toISOString());
}));
test('changed actual image bytes recompute; no-store never persists and no-cache always revalidates body',()=>fixture(async directory=>{
 let time=1000,body='first',header='public, max-age=1',reads=0,computes=0;
 const options={directory,now:()=>time,fetchImage:async()=>{reads++;return {buffer:Buffer.from(body),cacheControl:header}},fingerprint:async buffer=>{computes++;return {dHash:buffer.toString()}}};
 const first=await createFingerprintLoader(options).get('https://fixture.test/image');time+=2000;body='changed';
 const changed=await createFingerprintLoader(options).get('https://fixture.test/image');assert.notEqual(changed.contentSha256,first.contentSha256);assert.equal(computes,2);
 header='public, no-cache, max-age=3600';await createFingerprintLoader(options).get('https://fixture.test/no-cache');await createFingerprintLoader(options).get('https://fixture.test/no-cache');assert.equal(reads,4);
 header='no-store';await createFingerprintLoader(options).get('https://fixture.test/no-store');await createFingerprintLoader(options).get('https://fixture.test/no-store');assert.equal(computes,4);
}));
test('corrupted content, future records and failed refresh cannot become valid current fingerprints',()=>fixture(async directory=>{
 let time=1000,available=true,reads=0;
 const url='https://fixture.test/image',options={directory,now:()=>time,fetchImage:async()=>{reads++;return available?{buffer:Buffer.from('body'),cacheControl:'public, max-age=3600'}:null},fingerprint:async()=>({dHash:'real'})};
 const value=await createFingerprintLoader(options).get(url);
 await fs.writeFile(path.join(directory,'body-'+value.contentSha256+'.json'),JSON.stringify({version:1,fingerprint:{contentSha256:value.contentSha256,dHash:'forged'},checksum:'wrong'}));
 const corrected=await createFingerprintLoader(options).get(url);assert.equal(corrected.dHash,'real');assert.equal(reads,2);
 const file=path.join(directory,'url-'+createHash('sha256').update(url).digest('hex')+'.json');
 const record=JSON.parse(await fs.readFile(file,'utf8'));record.observedAt=time+1000;record.expiresAt=time+2000;await fs.writeFile(file,JSON.stringify(record));
 available=false;assert.equal(await createFingerprintLoader(options).get(url),null);
}));
test('query variants stay separate, actual identical bytes share computation, and source Age shortens freshness',()=>fixture(async directory=>{
 let time=1000,reads=0,computes=0;
 const options={directory,now:()=>time,fetchImage:async()=>{reads++;return {buffer:Buffer.from('same bytes'),cacheControl:'public, max-age=10',cacheAge:'9'}},fingerprint:async()=>{computes++;return {dHash:'real'}}};
 await createFingerprintLoader(options).get('https://fixture.test/image?w=298');
 await createFingerprintLoader(options).get('https://fixture.test/image?w=1200');assert.equal(reads,2);assert.equal(computes,1);
 time=2001;await createFingerprintLoader(options).get('https://fixture.test/image?w=298');assert.equal(reads,3);
}));
test('unreadable/partial image bodies are not saved and derived cache growth is bounded',()=>fixture(async directory=>{
 let readable=false;
 const loader=createFingerprintLoader({directory,maxEntries:2,fetchImage:async url=>({buffer:Buffer.from(url),cacheControl:'public, max-age=0'}),fingerprint:async()=>readable?{dHash:'complete'}:null});
 assert.equal(await loader.get('partial'),null);assert.equal((await fs.readdir(directory)).length,0);
 readable=true;for(let i=0;i<8;i++)await loader.get('https://fixture.test/'+i);
 await fs.writeFile(path.join(directory,'url-'+'a'.repeat(64)+'.json.1234-abcd.tmp'),'interrupted');
 await loader.prune();assert.ok((await fs.readdir(directory)).length<=4);assert.ok(loader.stats.pruned>0);
 assert.equal((await fs.readdir(directory)).some(name=>name.endsWith('.tmp')),false);
}));
test('conflicting or malformed cache directives never authorize a network-free reuse',()=>fixture(async directory=>{
 for(const [i,cacheControl] of ['public, private, max-age=60','public, max-age=60, max-age=120','public, max-age=60junk','public, max-age="60','public, max-age=-1'].entries()){
  let reads=0;const options={directory,now:()=>1000,fetchImage:async()=>{reads++;return {buffer:Buffer.from('body'),cacheControl}},fingerprint:async()=>({dHash:'real'})};
  await createFingerprintLoader(options).get('https://fixture.test/'+i);await createFingerprintLoader(options).get('https://fixture.test/'+i);
  assert.equal(reads,2,cacheControl);
 }
}));
test('persisted timestamp strings or invalid types cannot renew or authorize image reuse',()=>fixture(async directory=>{
 let reads=0;const url='https://fixture.test/image',options={directory,now:()=>1000,fetchImage:async()=>{reads++;return {buffer:Buffer.from('body'),cacheControl:'public, max-age=3600'}},fingerprint:async()=>({dHash:'real'})};
 await createFingerprintLoader(options).get(url);
 const file=path.join(directory,'url-'+createHash('sha256').update(url).digest('hex')+'.json');
 const record=JSON.parse(await fs.readFile(file,'utf8'));record.observedAt=String(record.observedAt);await fs.writeFile(file,JSON.stringify(record));
 await createFingerprintLoader(options).get(url);assert.equal(reads,2);
}));
