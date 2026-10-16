import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {encrypt} from '../scripts/lib/crypto.mjs';
import {requireRestoredSearchProofAccess} from '../scripts/lib/procurement-proof-access.mjs';
const password='fixture-only-password',now=Date.parse('2026-10-16T12:00:00Z');
const hold=offset=>({reason:'search_challenge',retryUntil:new Date(now+offset).toISOString()});
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'proof-search-access-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'state'));return root}
async function save(root,name,value){await fs.writeFile(path.join(root,'state',name),encrypt(Buffer.from(JSON.stringify(value)),password))}
test('search proof requires an explicit restored record and rejects missing, encrypted-corrupt and malformed holds before requests',async t=>{
 const root=await fixture(t);let calls=0;
 const initialize=async({initial})=>{calls++;return initial},options={root,password,restored:true,now,initialize};
 await assert.rejects(requireRestoredSearchProofAccess({...options,restored:false}),/not_restored/);
 await assert.rejects(requireRestoredSearchProofAccess(options),/record_missing/);
 await save(root,'latest.json.enc',{});await assert.rejects(requireRestoredSearchProofAccess(options),/record_missing/);
 for(const value of [null,[],{bing:{reason:'search_challenge',retryUntil:'bad'}},{bing:{reason:'not_a_hold',retryUntil:hold(1000).retryUntil}},{other:hold(1000)}]){
  await save(root,'latest.json.enc',{externalSearchAccess:value});await assert.rejects(requireRestoredSearchProofAccess(options),/record_invalid/);
 }
 await save(root,'latest.json.enc',{externalSearchAccess:{}});
 for(const name of ['search-access.json.enc','discovery.json.enc']){
  await fs.writeFile(path.join(root,'state',name),'corrupt');await assert.rejects(requireRestoredSearchProofAccess(options),/unverifiable/);await fs.unlink(path.join(root,'state',name));
 }
 assert.equal(calls,0);
 await save(root,'search-access.json.enc',{bing:{retryUntil:'invalid'}});await assert.rejects(requireRestoredSearchProofAccess(options),/record_invalid/);
});
test('search proof merges every restored hold without renewing clocks and any active provider prevents a source call',async t=>{
 const root=await fixture(t);let requests=0,observed;
 const options={root,password,restored:true,now,initialize:async({initial})=>{observed=initial;return initial}};
 for(const [name,provider] of [['latest.json.enc','bing'],['discovery.json.enc','bing_web'],['search-access.json.enc','duckduckgo']]){
  await save(root,'latest.json.enc',{externalSearchAccess:{}});await save(root,'discovery.json.enc',{});await save(root,'search-access.json.enc',{});
  const rows={[provider]:hold(60000)};await save(root,name,name==='search-access.json.enc'?rows:{externalSearchAccess:rows});
  await assert.rejects((async()=>{await requireRestoredSearchProofAccess(options);requests++})(),/hold_active/);
  assert.equal(observed[provider].retryUntil,hold(60000).retryUntil);
 }
 assert.equal(requests,0);
 const expired={bing:hold(-1000)};await save(root,'latest.json.enc',{externalSearchAccess:expired});await save(root,'discovery.json.enc',{});await save(root,'search-access.json.enc',{});
 assert.deepEqual(await requireRestoredSearchProofAccess(options),{restored:true,source:'external_search'});assert.deepEqual(observed,expired);
});
test('pricing and image live proof executables stop before any network request without restored shared state',()=>{
 for(const filename of ['pricing-proof.mjs','prove-image-search.mjs']){
  const script=new URL('../scripts/'+filename,import.meta.url).href;let output='';
  try{execFileSync(process.execPath,['--input-type=module','-e',`globalThis.fetch=()=>{throw Error('FORBIDDEN_SOURCE_REQUEST')};await import(${JSON.stringify(script)})`],{encoding:'utf8',env:{PATH:process.env.PATH},stdio:'pipe'})}catch(error){assert.equal(error.status,1);output=String(error.stdout)+String(error.stderr)}
  assert.match(output,/shared_source_state_not_restored/);assert.doesNotMatch(output,/FORBIDDEN_SOURCE_REQUEST/);
 }
});
test('pricing and image CI jobs are explicitly offline and do not acquire source credentials or permissions',async()=>{
 for(const filename of ['pricing-proof.yml','image-source-proof.yml']){
  const workflow=await fs.readFile(new URL('../.github/workflows/'+filename,import.meta.url),'utf8');
  assert.match(workflow,/离线回归/);assert.match(workflow,/run: node --test /);assert.match(workflow,/test\/proof-entry-guards\.test\.mjs/);
  assert.doesNotMatch(workflow,/run: node scripts\/(?:pricing-proof|prove-image-search)\.mjs|DASHBOARD_PASSWORD|\$\{\{\s*secrets\.|playwright install|upload-artifact|actions: write/);
 }
 const pricing=await fs.readFile(new URL('../scripts/pricing-proof.mjs',import.meta.url),'utf8');
 assert.ok(pricing.indexOf('await requireRestoredYahooProofAccess')<pricing.indexOf('await fetchYahooItemBundle'));
 assert.match(pricing,/initializeRakumaRequestAccess\(\{requireRestoredState:true\}\)/);
});
