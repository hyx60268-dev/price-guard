import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encrypt,decrypt } from '../scripts/lib/crypto.mjs';
import { cadenceSlot,claimScanAdmission,decideScanAdmission,mergeScanAdmission,scanAdmissionSnapshot,SCAN_INTERVAL_MS } from '../scripts/lib/scan-admission.mjs';
import { reconcileDurableState } from '../scripts/lib/state.mjs';
import { finiteCadenceWorkflow } from '../scripts/generate-cadence-workflow.mjs';
const START=Date.parse('2026-10-16T12:00:00Z'),sha='a'.repeat(40),password='fixture-not-a-secret';
const options={now:START,runKey:'100:1',codeSha:sha};
const row=(overrides={})=>({version:1,runKey:'99:1',codeSha:sha,slotKey:'',claimedAt:new Date(START-60000).toISOString(),...overrides});
test('six slots are fixed to the same epoch, with no catchup or unbounded slot count',()=>{
 const epoch=new Date(START).toISOString();
 assert.equal(cadenceSlot({epoch,slot:'5',now:START}).dueAt,START+100*60000);
 assert.equal(cadenceSlot({epoch,slot:'0',now:START+300001}).expired,true);
 assert.equal(cadenceSlot({epoch,slot:'1',now:START+300001}).waitMs,899999);
 for(const slot of ['6','-1','0.5','00','foo'])assert.throws(()=>cadenceSlot({epoch,slot}));
});
test('all entrances share previous actual scan and claim deduplication without refreshing evidence',()=>{
 for(const previous of [{cycleCoverage:{startedAt:new Date(START-60000).toISOString()}},{scanAdmission:row()}]){
  const original=structuredClone(previous);
  assert.equal(decideScanAdmission({...options,previous}).reason,'recent_scan');assert.deepEqual(previous,original);
 }
 assert.equal(decideScanAdmission({...options,receipt:row({claimedAt:new Date(START-SCAN_INTERVAL_MS).toISOString()})}).admitted,true);
});
test('obsolete code, early/expired/already claimed slots cannot enter a source scan',()=>{
 const epoch=new Date(START).toISOString(),base={...options,epoch,slot:'0',expectedSha:sha,currentSha:sha};
 assert.equal(decideScanAdmission({...base,currentSha:'b'.repeat(40)}).reason,'obsolete_code');
 assert.equal(decideScanAdmission({...base,slot:'1'}).reason,'slot_not_due');
 assert.equal(decideScanAdmission({...base,now:START+300001}).reason,'slot_expired');
 assert.equal(decideScanAdmission({...base,receipt:row({slotKey:`${epoch}:0`})}).reason,'slot_already_claimed');
});
test('malformed and future receipt fail closed, and merge never chooses a shorter claim',()=>{
 for(const record of [{},[],{...row(),claimedAt:'bad'},{...row(),codeSha:'bad'},false])assert.throws(()=>mergeScanAdmission(record));
 assert.throws(()=>decideScanAdmission({...options,receipt:row({claimedAt:new Date(START+1).toISOString()})}),/Future/);
 assert.deepEqual(mergeScanAdmission(row({claimedAt:new Date(START-120000).toISOString()}),row()),row());
 assert.deepEqual(reconcileDurableState({scanAdmission:row()},{checkedAt:new Date(START).toISOString()}).scanAdmission,row());
});
test('real encrypted state, receipt restart and publication fallback preserve source timestamps and user data',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'admission-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'state'));
 const source={checkedAt:'2026-10-15T12:00:00Z',items:[{id:'own',yahoo:{checkedAt:'2026-10-15T12:00:00Z'}}],manualCosts:{x:{purchaseCNY:7}},matchCorrections:{x:{deleted:true}},yahooRequestAccess:{reason:'http_429',retryAt:START+1000}};
 const file=path.join(root,'state/latest.json.enc');await fs.writeFile(file,encrypt(Buffer.from(JSON.stringify(source)),password));
 assert.equal((await claimScanAdmission({root,password,...options})).admitted,true);
 const stored=JSON.parse(decrypt(await fs.readFile(file),password));assert.deepEqual({...stored,scanAdmission:undefined},{...source,scanAdmission:undefined});
 assert.equal((await claimScanAdmission({root,password,...options,runKey:'101:1',now:START+1000})).reason,'recent_scan');
 await fs.unlink(path.join(root,'state/scan-admission.json'));
 assert.equal(await scanAdmissionSnapshot(root),null);
 assert.equal((await claimScanAdmission({root,password,...options,runKey:'102:1',now:START+2000})).reason,'recent_scan');
 await fs.writeFile(path.join(root,'state/scan-admission.json'),'broken');
 await assert.rejects(claimScanAdmission({root,password,...options}),/Cannot validate/);
});
test('finite workflow is generated deterministically with six operational chains and separate red acceptance',async()=>{
 const text=await fs.readFile(new URL('../.github/workflows/cadence-validation.yml',import.meta.url),'utf8');assert.equal(text,finiteCadenceWorkflow());
 assert.equal((text.match(/^  slot-\d:/gm)||[]).length,6);
 assert.equal((text.match(/^  acceptance-\d:/gm)||[]).length,6);
 assert.ok(text.includes("needs.anchor.result == 'success'"));assert.match(text,/workflow_dispatch:/);assert.doesNotMatch(text,/schedule:|actions: write|workflow_run:|while true|repository_dispatch/);
 assert.match(text,/group: price-guard-finite-cadence/);assert.doesNotMatch(text,/group: pages/);
 for(let i=1;i<6;i++){assert.match(text,new RegExp(`slot-${i}:[\\s\\S]*?needs: \\[anchor, slot-${i-1}\\]`));assert.ok(text.includes(`needs.slot-${i-1}.result == 'success'`));}
});
test('normal writer keeps gates inside pages, uniquely names every cycle artifact and keeps acceptance visible',async()=>{
 const text=await fs.readFile(new URL('../.github/workflows/price-scan-transaction.yml',import.meta.url),'utf8');
 const writer=text.split('  scan-and-publish:')[1].split('  acceptance:')[0];
 assert.ok(writer.indexOf('group: pages')<writer.indexOf('node scripts/restore-published-state.mjs'));
 assert.ok(writer.indexOf('node scripts/restore-published-state.mjs')<writer.indexOf('node scripts/scan-admission.mjs admit'));
 assert.ok(writer.indexOf('node scripts/scan-admission.mjs admit')<writer.indexOf('npm run scan'));
 for(const line of writer.split('\n').filter(line=>/key: price-guard-state|name: github-pages-|artifact_name: github-pages-/.test(line)))assert.match(line,/inputs.cadence_slot/);
 const main=await fs.readFile(new URL('../.github/workflows/price-guard.yml',import.meta.url),'utf8');
 assert.match(main,/needs: scan-and-publish/);assert.match(main,/test "\$COST_EXIT" = 0 && test "\$COVERAGE_EXIT" = 0/);
 // Only the optional, no-source geometry dependency/self-check may fail open.
 // Source reads, state restoration/publication and product acceptance must not.
 const critical=text.split(/(?=      - name:|      - run:|      - uses:)/).filter(step=>!/^      - name: (?:Prepare optional local geometry Python|Verify optional bounded geometry runtime without source reads)\n/.test(step)).join('');
 assert.doesNotMatch(critical,/continue-on-error: true/);assert.ok(text.includes("needs.cadence-wait.result == 'success'"));assert.ok(text.includes("needs.cadence-wait.result == 'skipped'"));
});

test('fixed slots tolerate bounded startup jitter instead of aliasing into40minute cycles',()=>{
 const epoch=new Date(START).toISOString();
 const previous={scanAdmission:row({runKey:options.runKey,claimedAt:new Date(START+20000).toISOString(),slotKey:`${epoch}:0`}),cycleCoverage:{startedAt:new Date(START+80000).toISOString()}};
 assert.equal(decideScanAdmission({...options,now:START+20*60000+20000,epoch,slot:'1',expectedSha:sha,currentSha:sha,previous}).admitted,true);
 assert.equal(decideScanAdmission({...options,now:START+20*60000+20000,previous}).reason,'recent_scan');
 assert.equal(decideScanAdmission({...options,now:START+20*60000,epoch,slot:'1',previous:{scanAdmission:row({claimedAt:new Date(START+6*60000).toISOString()})}}).reason,'recent_scan');
});
test('same-controller jitter exception cannot hide a future actual scan timestamp',()=>{
 const epoch=new Date(START).toISOString();
 assert.throws(()=>decideScanAdmission({...options,now:START+1200000,epoch,slot:'1',previous:{scanAdmission:row({runKey:options.runKey,claimedAt:new Date(START).toISOString(),slotKey:`${epoch}:0`}),cycleCoverage:{startedAt:new Date(START+1200001).toISOString()}}}),/Future/);
});

test('missing or malformed full state is not interpreted as a new empty production scanner',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'admission-missing-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'state'));
 await assert.rejects(claimScanAdmission({root,password,...options}),/Shared full state not restored/);
 for(const value of [null,[],false]){await fs.writeFile(path.join(root,'state/latest.json.enc'),encrypt(Buffer.from(JSON.stringify(value)),password));await assert.rejects(claimScanAdmission({root,password,...options}),/Shared full state not restored/);}
});

test('real activation push cedes scan to exactly one finite slot while ordinary push and cron share admission',async t=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');const execute=promisify(execFile);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'admission-cli-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 for(const dir of ['scripts/lib','state','config'])await fs.mkdir(path.join(root,dir),{recursive:true});
 for(const file of ['scripts/scan-admission.mjs','scripts/lib/scan-admission.mjs','scripts/lib/cadence-window.mjs','scripts/lib/crypto.mjs'])await fs.copyFile(new URL('../'+file,import.meta.url),path.join(root,file));
 const config={enabled:true,requestId:'approved-test-20261016',slots:6},event={head_commit:{message:'repair [price-guard-cadence:approved-test-20261016]'}};
 const eventFile=path.join(root,'event.json'),mock=path.join(root,'mock.mjs'),output=path.join(root,'output');
 await fs.writeFile(path.join(root,'config/cadence-validation.json'),JSON.stringify(config));await fs.writeFile(eventFile,JSON.stringify(event));
 await fs.writeFile(mock,`globalThis.fetch=async url=>{if(!String(url).endsWith('/branches/main'))throw Error('Unexpected network');return new Response(JSON.stringify({commit:{sha:'${sha}'}}))}`);
 const env={...process.env,GITHUB_REPOSITORY:'owner/repo',GITHUB_SHA:sha,GITHUB_EVENT_NAME:'push',GITHUB_EVENT_PATH:eventFile,GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_ID:'100',GITHUB_OUTPUT:output,DASHBOARD_PASSWORD:password};
 const run=async extra=>{await fs.writeFile(output,'');await execute(process.execPath,['--import',mock,path.join(root,'scripts/scan-admission.mjs'),'admit'],{env:{...env,...extra}});return fs.readFile(output,'utf8')};
 assert.match(await run({}),/reason=finite_controller_owns_push/);assert.equal(await scanAdmissionSnapshot(root),null);
 await fs.writeFile(path.join(root,'state/latest.json.enc'),encrypt(Buffer.from(JSON.stringify({items:[],yahooRequestAccess:null})),password));
 const epoch=new Date(Date.now()-1000).toISOString();
 assert.match(await run({CADENCE_EPOCH:epoch,CADENCE_SLOT:'0',CADENCE_EXPECTED_SHA:sha,GITHUB_RUN_ID:'101'}),/admitted=true/);
 assert.match(await run({CADENCE_EPOCH:epoch,CADENCE_SLOT:'0',CADENCE_EXPECTED_SHA:sha,GITHUB_RUN_ID:'101'}),/reason=slot_already_claimed/);
 await fs.writeFile(eventFile,JSON.stringify({head_commit:{message:'ordinary repair'}}));
 assert.match(await run({}),/reason=recent_scan/);assert.match(await run({GITHUB_EVENT_NAME:'schedule'}),/reason=recent_scan/);
});


test('finite sample priorities apply only to slot zero and preserve the normal scan entry',()=>{
 const workflow=finiteCadenceWorkflow();
 assert.match(workflow,/slot-0:[\s\S]*?priority_item_ids: \$\{\{ needs.anchor.outputs.priority_item_ids \}\}/);
 assert.equal((workflow.match(/priority_item_ids: \$\{\{ needs.anchor.outputs.priority_item_ids \}\}/g)||[]).length,1);
 assert.equal((workflow.match(/uses: \.\/.github\/workflows\/price-scan-transaction.yml/g)||[]).length,6);
});
