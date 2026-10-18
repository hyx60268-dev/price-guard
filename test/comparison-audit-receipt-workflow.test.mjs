import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {comparisonAuditRequested} from '../scripts/lib/comparison-audit-scan.mjs';

const workflow=await fs.readFile(new URL('../.github/workflows/price-scan-transaction.yml',import.meta.url),'utf8');
function step(id){const at=workflow.indexOf(`        id: ${id}\n`);assert.ok(at>=0,id);const start=workflow.lastIndexOf('      - ',at),end=workflow.indexOf('\n      - ',at);return workflow.slice(start,end<0?undefined:end);}
test('receipt checks are inside the existing admitted writer and bracket normal scan/publication',()=>{
 const restored=step('audit_receipt_restored'),published=step('audit_receipt_published');
 assert.ok(workflow.indexOf('scripts/restore-published-state.mjs')<workflow.indexOf('id: audit_receipt_restored'));
 assert.ok(workflow.indexOf('id: admission')<workflow.indexOf('id: audit_receipt_restored'));
 assert.ok(workflow.indexOf('id: audit_receipt_restored')<workflow.indexOf('id: scan\n'));
 assert.ok(workflow.indexOf('id: deployment')<workflow.indexOf('id: audit_receipt_published'));
 for(const check of [restored,published]){assert.match(check,/steps\.admission\.outputs\.admitted == 'true'/);assert.doesNotMatch(check,/continue-on-error/);assert.match(check,/DASHBOARD_PASSWORD: \$\{\{ secrets\.DASHBOARD_PASSWORD }}/);assert.doesNotMatch(check,/XIANYU_|GITHUB_TOKEN|npm run scan|secrets\.(?!DASHBOARD_PASSWORD)/);}
 assert.match(restored,/if node scripts\/check-comparison-audit-receipt\.mjs; then/);
 assert.match(published,/steps\.deployment\.outcome == 'success'/);
 assert.match(published,/if node scripts\/check-comparison-audit-receipt\.mjs --published; then/);
 assert.equal((workflow.match(/group: pages/g)||[]).length,1);
 assert.match(workflow,/group: pages\n      cancel-in-progress: false/);
});
test('readiness requires explicit valid outputs and successful execution, and never changes acceptance',()=>{
 const readiness=step('audit_receipt_readiness');
 assert.match(readiness,/always\(\) && steps\.admission\.outputs\.admitted == 'true'/);
 assert.match(readiness,/steps\.audit_receipt_restored\.outcome/);assert.match(readiness,/steps\.audit_receipt_published\.outcome/);
 assert.match(readiness,/steps\.audit_receipt_restored\.outputs\.valid/);assert.match(readiness,/steps\.audit_receipt_published\.outputs\.valid/);
 assert.doesNotMatch(readiness,/\.conclusion|scripts\/scan|GITHUB_TOKEN|DASHBOARD_PASSWORD|\.enc|rm |curl |fetch|enable/);
 assert.match(workflow,/audit_receipt_ready:\n        value: \$\{\{ jobs\.scan-and-publish\.outputs\.audit_receipt_ready }}/);
 for(const id of ['cost','coverage'])assert.doesNotMatch(step(id),/audit_receipt/);
 assert.doesNotMatch(step('scan'),/audit_receipt/);
});
test('failed, skipped, cancelled or missing diagnostic outcomes keep readiness false but normal workflow alive',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'audit-readiness-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const script=step('audit_receipt_readiness').split('        run: |\n')[1].split('\n').map(line=>line.replace(/^          /,'')).join('\n');
 for(const left of ['success','failure','skipped','cancelled',''])for(const right of ['success','failure','skipped','cancelled',''])for(const leftValid of ['true','false',''])for(const rightValid of ['true','false','']){
  const output=path.join(root,'output');await fs.writeFile(output,'');
  const result=spawnSync('bash',['-e','-c',script],{encoding:'utf8',env:{PATH:process.env.PATH,GITHUB_OUTPUT:output,RESTORED_OUTCOME:left,PUBLISHED_OUTCOME:right,RESTORED_VALID:leftValid,PUBLISHED_VALID:rightValid}});
  assert.equal(result.status,0,result.stderr);const ready=left==='success'&&right==='success'&&leftValid==='true'&&rightValid==='true';
  assert.equal((await fs.readFile(output,'utf8')).trim(),`ready=${ready}`);assert.match(result.stdout,new RegExp(`READINESS\\] ready=${ready};`));
  assert.equal(result.stdout.includes('::warning'),!ready);
 }
});
test('diagnostic command exits become explicit false readiness inputs without masking shell output failure',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'audit-diagnostic-shell-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'node'),'#!/bin/sh\nexit "$FAKE_NODE_EXIT"\n',{mode:0o755});
 for(const id of ['audit_receipt_restored','audit_receipt_published']){
  const script=step(id).split('        run: |\n')[1].split('        env:')[0].split('\n').map(line=>line.replace(/^          /,'')).join('\n');
  for(const code of [0,1,2,127]){
   const output=path.join(root,'output');await fs.writeFile(output,'');
   const result=spawnSync('bash',['-e','-c',script],{encoding:'utf8',env:{PATH:root+':'+process.env.PATH,GITHUB_OUTPUT:output,FAKE_NODE_EXIT:String(code)}});
   assert.equal(result.status,0,result.stderr);assert.equal((await fs.readFile(output,'utf8')).trim(),`valid=${code===0}`);
  }
  const failed=spawnSync('bash',['-e','-c',script],{encoding:'utf8',env:{PATH:root+':'+process.env.PATH,GITHUB_OUTPUT:root,FAKE_NODE_EXIT:'0'}});assert.notEqual(failed.status,0);
 }
});
test('diagnostic integration cannot activate a comparison and adds no separate workflow or marker',async()=>{
 const config=JSON.parse(await fs.readFile(new URL('../config/comparison-audit.json',import.meta.url),'utf8'));
 assert.equal(comparisonAuditRequested(config,{head_commit:{message:'ordinary receipt maintenance'}}),false);
 const checker=await fs.readFile(new URL('../scripts/check-comparison-audit-receipt.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(checker,/\b(?:writeFile|appendFile|consumeReceipt|claimComparisonAudit|prepareComparisonAuditState)\s*\(/);
 assert.doesNotMatch(workflow,/price-guard-audit-receipt-only|price-guard-yahoo-comparison-audit:/);
 assert.match(workflow,/timeout-minutes: \$\{\{ inputs\.full_audit && 360 \|\| 25 }}/);
 assert.match(workflow,/permissions:\n  contents: read\n  issues: write\n  pages: write\n  id-token: write/);
});
