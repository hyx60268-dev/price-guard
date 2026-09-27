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
