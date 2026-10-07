import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const workflowsDir=new URL('../.github/workflows/',import.meta.url);
const readWorkflow=name=>fs.readFile(new URL(name,workflowsDir),'utf8');
const eventBlock=text=>text.match(/^on:\r?\n([\s\S]*?)(?=^\S)/m)?.[1]||'';

// GitHub keeps only one pending job per concurrency group. Several push
// writers can replace the core scan even with cancel-in-progress: false.
test('a main push starts exactly one shared-pages writer',async()=>{
  const pushWriters=[];
  for(const name of await fs.readdir(workflowsDir)){
    if(!/\.ya?ml$/.test(name))continue;
    const workflow=await readWorkflow(name);
    if(/^\s+group: pages\s*$/m.test(workflow)&&/^  push:/m.test(eventBlock(workflow)))pushWriters.push(name);
  }
  assert.deepEqual(pushWriters.sort(),['price-guard.yml']);
});

test('the primary push writer covers quick dashboard publication, core scan and merchant refresh',async()=>{
  const workflow=await readWorkflow('price-guard.yml');
  const events=eventBlock(workflow);
  assert.match(events,/^  push:\r?\n    branches: \[main\]/m);
  assert.doesNotMatch(events,/^    paths(?:-ignore)?:/m);
  const steps=workflow.split(/^  scan-and-publish:\s*$/m)[1];
  assert.ok(steps,'primary writer job exists');
  const repack=steps.indexOf('run: node scripts/repack-dashboard.mjs');
  const deploy=steps.indexOf('uses: actions/deploy-pages@');
  const scan=steps.indexOf('run: npm run scan');
  const merchant=steps.indexOf('run: node scripts/merchant-monitor.mjs');
  assert.ok(repack>=0&&repack<deploy&&deploy<scan&&scan<merchant,'one transaction publishes the interface before scanning, then refreshes merchants');
  assert.match(steps.slice(0,repack),/if: github.event_name == 'push'/);
  assert.match(steps.slice(merchant),/MERCHANT_MONITOR_IF_DUE: '1'/);
  assert.ok(steps.indexOf('uses: actions/deploy-pages@',merchant)>merchant,'merchant output is published');
});

test('manual repair and independent daily merchant monitoring remain available',async()=>{
  const dashboard=eventBlock(await readWorkflow('dashboard-repair.yml'));
  const merchant=eventBlock(await readWorkflow('merchant-monitor.yml'));
  assert.match(dashboard,/^  workflow_dispatch:/m);
  assert.match(merchant,/^  workflow_dispatch:/m);
  assert.match(merchant,/^  schedule:\r?\n    - cron: '15 0 \* \* \*'/m);
});
