import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {loadXianyuSession} from '../scripts/lib/xianyu-session.mjs';

const state=value=>({cookies:[{name:'fixture',value,domain:'.goofish.com',path:'/',expires:-1}],origins:[]});
const seed=state('fixture-initial-not-real'),raw=Buffer.from(JSON.stringify(seed)).toString('base64');
test('session survives a new cloud run, but blocked results cannot replace verified state',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'session-')),messages=[];
 const options={env:{XIANYU_STORAGE_STATE_B64:raw},log:value=>messages.push(value)};
 try{
  const manager=await loadXianyuSession(root,options);
  assert.equal(manager.source,'base64');
  const updated=state('fixture-refreshed-not-real');
  let called=0;const context={storageState:async settings=>{called++;assert.equal(settings.indexedDB,true);return updated}};
  assert.equal(await manager.persist(context,{status:'manual_review',cardCount:30,accessibleDetailCount:0}),false);
  assert.equal(await manager.persist(context,{status:'blocked',accessibleDetailCount:1}),false);
  assert.equal(called,0);
  assert.equal(await manager.persist(context,{status:'manual_review',accessibleDetailCount:1}),true);
  const sealed=await fs.readFile(path.join(root,'state/xianyu-session.json.enc'));
  assert.equal(sealed.includes(Buffer.from('fixture-refreshed')),false);
  assert.equal(await manager.persist(context,{status:'login_required',accessibleDetailCount:1}),false);
  const next=await loadXianyuSession(root,options);
  assert.equal(next.source,'refreshed');assert.deepEqual(JSON.parse(await fs.readFile(next.file)),updated);
  assert.equal(messages.join().includes('fixture-initial'),false);assert.equal(messages.join().includes('fixture-refreshed'),false);
  await assert.rejects(fs.access(path.join(root,'public/data/xianyu-session.json.enc')));
  // Reauthorizing/replacing repository secrets invalidates a previous cache.
  const replacement=state('different-seed');
  const changed=await loadXianyuSession(root,{env:{XIANYU_STORAGE_STATE_B64:Buffer.from(JSON.stringify(replacement)).toString('base64')},log:()=>{}});
  assert.equal(changed.source,'base64');assert.deepEqual(JSON.parse(await fs.readFile(changed.file)),replacement);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
test('all supported secret formats work; corrupt state never logs credentials',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'session-')),logs=[];
 try{
  const encoded=zlib.gzipSync(Buffer.from(JSON.stringify(seed))).toString('base64'),split=Math.ceil(encoded.length/3);
  for(const env of [
   {XIANYU_AUTH_PART_1:encoded.slice(0,split),XIANYU_AUTH_PART_2:encoded.slice(split,split*2),XIANYU_AUTH_PART_3:encoded.slice(split*2)},
   {XIANYU_STORAGE_STATE_GZIP_B64:encoded},
   {XIANYU_AUTH_PART_1:'malformed-secret',XIANYU_STORAGE_STATE_B64:raw}
  ]){
   const manager=await loadXianyuSession(root,{env,log:value=>logs.push(value)});
   assert.deepEqual(JSON.parse(await fs.readFile(manager.file)),seed);
  }
  const missing=await loadXianyuSession(root,{env:{XIANYU_STORAGE_STATE_B64:Buffer.from('{}').toString('base64')},log:value=>logs.push(value)});
  assert.equal(missing.source,'anonymous');assert.equal(await missing.persist({},{}),false);
  assert.equal(logs.join().includes('malformed-secret'),false);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
