import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { appliedSyncIssue,syncDigest,acknowledgePublishedSync } from '../scripts/lib/sync-receipts.mjs';

test('cancelled publication keeps input replayable; confirmed publication requests scan before closing',async()=>{
  const issue={number:42,title:'[Price Guard Sync:admin]',body:'encrypted',user:{login:'owner'}};
  assert.equal(appliedSyncIssue({},issue),false);
  const state={appliedSyncIssues:{42:{digest:syncDigest(issue),needsScan:true}}};
  assert.equal(appliedSyncIssue(state,issue),true);
  assert.equal(appliedSyncIssue(state,{...issue,body:'changed'}),false);
  const calls=[];
  const options={state,listIssues:async()=>[issue],closeIssue:async number=>calls.push(number)};
  await assert.rejects(acknowledgePublishedSync({...options,requestScan:async()=>{throw Error('dispatch failed')}}));
  assert.deepEqual(calls,[]);
  assert.equal(await acknowledgePublishedSync({...options,requestScan:async()=>calls.push('scan')}),1);
  assert.deepEqual(calls,['scan',42]);
  assert.equal(await acknowledgePublishedSync({...options,listIssues:async()=>[{...issue,body:'changed'}]}),0);
});

test('all publishers serialize, retain full state, and acknowledge only after deployment',async()=>{
  for(const file of ['price-guard','cloud-sync','dashboard-repair']){
    const workflow=await fs.readFile(new URL(`../.github/workflows/${file}.yml`,import.meta.url),'utf8');
    assert.match(workflow,/group: pages/);
    assert.match(workflow,/cancel-in-progress: false/);
    assert.doesNotMatch(workflow,/cp public\/data\/latest.json.enc state\/latest.json.enc/);
    assert.match(workflow,/npm test/);
    if(file!=='dashboard-repair')assert.ok(workflow.indexOf('scripts/ack-sync-queue.mjs')>workflow.indexOf('actions/deploy-pages@'));
  }
});


test('all five state/session writers keep the whole job serialized while health runs outside the lock',async()=>{
  const files=['price-guard','cloud-sync','dashboard-repair','merchant-monitor','xianyu-proof'];
  for(const file of files){
    const workflow=await fs.readFile(new URL('../.github/workflows/'+file+'.yml',import.meta.url),'utf8');
    assert.doesNotMatch(workflow,/^concurrency:/m);
    assert.equal((workflow.match(/^    concurrency:/gm)||[]).length,1);
    assert.match(workflow,/^    concurrency:\r?\n      group: pages\r?\n      cancel-in-progress: false/m);
    if(file!=='xianyu-proof')assert.match(workflow,/^    environment:\r?\n      name: github-pages/m);
    assert.ok(workflow.indexOf('    concurrency:')<workflow.indexOf('    steps:')||file==='price-guard');
  }
  const pricing=await fs.readFile(new URL('../.github/workflows/price-guard.yml',import.meta.url),'utf8');
  const health=pricing.split('  update-health:')[1].split('  scan-and-publish:')[0];
  assert.match(health,/scripts\/check-update-health\.mjs/);
  assert.doesNotMatch(health,/concurrency:|environment:|needs:|DASHBOARD_PASSWORD|XIANYU_/);
  const writer=pricing.split('  scan-and-publish:')[1];
  assert.doesNotMatch(writer,/^\s+needs:/m);
  assert.equal((pricing.match(/cron:/g)||[]).length,1);
});

test('replaced sync trigger does not acknowledge an unmerged second request',async()=>{
  const one={number:41,title:'[Price Guard Sync:admin]',body:'first',user:{login:'owner'}};
  const two={number:42,title:'[Price Guard Sync:admin]',body:'second',user:{login:'owner'}};
  const closed=[];
  const state={appliedSyncIssues:{41:{digest:syncDigest(one),needsScan:false}}};
  const inputs={state,listIssues:async()=>[one,two],closeIssue:async number=>closed.push(number)};
  assert.equal(await acknowledgePublishedSync(inputs),1);
  assert.deepEqual(closed,[41]);
  state.appliedSyncIssues[42]={digest:syncDigest(two),needsScan:false};
  assert.equal(await acknowledgePublishedSync({...inputs,listIssues:async()=>[two]}),1);
  assert.deepEqual(closed,[41,42]);
  const source=await fs.readFile(new URL('../scripts/process-sync-queue.mjs',import.meta.url),'utf8');
  assert.match(source,/issues\?state=open&per_page=100/);
  assert.match(source,/for\(const issue of issues\)/);
});
