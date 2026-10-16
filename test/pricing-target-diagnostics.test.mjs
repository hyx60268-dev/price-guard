import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {encrypt} from '../scripts/lib/crypto.mjs';
import {pricingTargetDiagnostics,VIOLET_TARGETS} from '../scripts/lib/pricing-target-diagnostics.mjs';

const at='2026-10-16T10:17:18.597Z',attempt='2026-10-16T14:18:27.523Z';
const item=()=>({id:'z705310958',accountId:'melon',platform:'yahoo',title:VIOLET_TARGETS[1].title,ownPrice:28499,
  description:'PRIVATE_DESCRIPTION',manualCost:{purchaseCNY:12345},yahoo:{status:'cached',evidenceStatus:'incomplete',checkedAt:at,lastAttemptAt:attempt,
    cacheReason:'request_error',deferredReason:'request_cooldown_deadline',cardCount:188,competitorCount:0,lowestPrice:28499,
    rejected:[{id:'fixture28k',price:28000,reason:'collectible_variant_image_unconfirmed',description:'PRIVATE_CANDIDATE'}]}});
test('target diagnostics preserve actual evidence and attempt clocks without converting own fallback into a quote',()=>{
  const value=item(),before=structuredClone(value),result=pricingTargetDiagnostics({checkedAt:attempt,items:[value]});
  assert.deepEqual(value,before);assert.equal(result.readOnly,true);const row=result.targets[0];
  assert.equal(row.clocks.checkedAt,at);assert.equal(row.clocks.lastAttemptAt,attempt);assert.equal(row.counts.cardCount,188);
  assert.equal(row.counts.competitorCount,0);assert.equal(row.recorded28000.rejected[0].id,'fixture28k');
  assert.match(row.evidenceLimit,/Absence does not prove/);assert.match(row.evidenceLimit,/fallback own price/);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|purchaseCNY|12345/);
});
test('all managed accounts and IDs are used for exclusion without dumping unrelated inventory',()=>{
  const source=item();source.yahoo.candidates=[{id:'fixture28k',sellerId:'other-managed',price:28000}];
  const state={accounts:[{id:'melon',platform:'yahoo',items:[source]},{id:'second',platform:'yahoo',sellerId:'other-managed',items:[{id:'unrelated',title:'PRIVATE_INVENTORY',ownPrice:92345}]}],items:[source]};
  const result=pricingTargetDiagnostics(state);assert.equal(result.targets.length,1);assert.equal(result.targets[0].recorded28000.candidates[0].matchesSavedManagedIndex,true);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_INVENTORY|92345|other-managed/);
});
test('missing target and missing rejection history are unknown, not absence from the live market',()=>{
  const source=item();source.yahoo.rejected=[];const result=pricingTargetDiagnostics({items:[source]});
  assert.deepEqual(result.missingTargets,['suitcase']);assert.deepEqual(result.targets[0].recorded28000,{candidates:[],rejected:[]});
  assert.match(result.targets[0].evidenceLimit,/bounded/);
});
test('title location finds suitcase ID from saved inventory and keeps differing state copies separate',()=>{
  const source={...item(),id:'fixtureSuitcase',title:VIOLET_TARGETS[0].title};
  const result=pricingTargetDiagnostics({items:[source],accounts:[{id:'melon',items:[{...source,yahoo:{...source.yahoo,checkedAt:'2026-10-15T00:00:00Z'}}]}]});
  assert.equal(result.targets.length,2);assert.equal(result.targets[0].id,'fixtureSuitcase');assert.equal(result.targets[0].target,'suitcase');
  assert.equal(result.targets[1].clocks.checkedAt,'2026-10-15T00:00:00Z');
});
test('CLI reads encrypted restored state and emits only bounded target data, without touching its input',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'pricing-target-diagnostic-'));
 try{
  for(const folder of ['scripts/lib','public','state'])await fs.mkdir(path.join(temp,folder),{recursive:true});
  for(const file of ['scripts/pricing-target-diagnostics.mjs','scripts/lib/pricing-target-diagnostics.mjs','scripts/lib/crypto.mjs','public/owned-offers.js'])await fs.copyFile(new URL('../'+file,import.meta.url),path.join(temp,file));
  await fs.writeFile(path.join(temp,'package.json'),'{"type":"module"}');
  const password='test-only-key',bytes=encrypt(Buffer.from(JSON.stringify({items:[item()]})),password),input=path.join(temp,'state/latest.json.enc');await fs.writeFile(input,bytes);
  const {stdout}=await promisify(execFile)(process.execPath,['scripts/pricing-target-diagnostics.mjs'],{cwd:temp,env:{...process.env,DASHBOARD_PASSWORD:password}});
  assert.match(stdout,/z705310958/);assert.doesNotMatch(stdout,/PRIVATE_|test-only-key/);assert.deepEqual(await fs.readFile(input),bytes);
 }finally{await fs.rm(temp,{recursive:true,force:true});}
});

test('priority keys only include saved OPEN targets with live inventory and no explicit closed-own evidence',()=>{
 const current={...item(),id:'z99999999',itemStatus:'OPEN'},closed={...item(),id:'z99999998',itemStatus:'SOLD'},notOpen={...item(),itemStatus:'OPEN',yahoo:{...item().yahoo,knownRefresh:{reason:'own_not_open'}}};
 const state={accounts:[{id:'melon',profileStatus:'live'}],items:[current,closed,notOpen]};
 assert.deepEqual(pricingTargetDiagnostics(state).savedOpenTargetKeys,['melon:z99999999']);
 assert.deepEqual(pricingTargetDiagnostics({...state,accounts:[{id:'melon',profileStatus:'cached'}]}).savedOpenTargetKeys,[]);
});


test('protected transaction reports targeted saved evidence before and after its existing scan',async()=>{
 const workflow=await fs.readFile(new URL('../.github/workflows/price-scan-transaction.yml',import.meta.url),'utf8');
 const script='run: node scripts/pricing-target-diagnostics.mjs';
 assert.equal(workflow.split(script).length-1,2);
 assert.ok(workflow.indexOf('node scripts/scan-admission.mjs admit')<workflow.indexOf(script));
 assert.ok(workflow.indexOf(script)<workflow.indexOf('run: npm run scan'));
 assert.ok(workflow.lastIndexOf(script)>workflow.indexOf('run: npm run scan'));
 for(const section of workflow.split('      - name: ').filter(value=>value.includes(script)))assert.match(section,/steps.admission.outputs.admitted == 'true'/);
});
