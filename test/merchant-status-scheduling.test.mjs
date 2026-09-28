import test from 'node:test';
import assert from 'node:assert/strict';
import { merchantMonitorStatus } from '../public/merchant-status.js';
import { merchantRetryDelay,merchantBudget } from '../scripts/lib/merchant-scheduling.mjs';
import { acknowledgePublishedSync,syncDigest } from '../scripts/lib/sync-receipts.mjs';
const record={key:'yahoo:p59959877',enabled:true,updatedAt:'2026-09-28T11:00:00Z'};
test('merchant row distinguishes saved configuration from completed, partial and failed observations',()=>{
 assert.match(merchantMonitorStatus(record,[],{}),/待提交/);
 assert.match(merchantMonitorStatus(record,[record],null),/等待首次/);
 const result={checkedAt:'2026-09-28T12:00:00Z',merchants:[{key:record.key,status:'ok',cards:123}]};
 assert.match(merchantMonitorStatus(record,[record],result),/本轮监控完成.*123/);
 result.merchants[0].status='partial';result.merchants[0].pendingDetails=20;
 assert.match(merchantMonitorStatus(record,[record],result),/部分结果.*20/);
 result.merchants[0].status='error';assert.match(merchantMonitorStatus(record,[record],result),/读取失败/);
 result.checkedAt='2026-09-27T12:00:00Z';assert.match(merchantMonitorStatus(record,[record],result),/等待首次/);
});
test('partial monitor continues in 20 minutes while completed monitor retains daily schedule',()=>{
 assert.equal(merchantRetryDelay({merchants:[{status:'partial'}]}),1200000);
 assert.equal(merchantRetryDelay({merchants:[{status:'ok'}]}),86400000);
 const first=merchantBudget({now:0,deadline:720000,remainingMerchants:2,remainingDetails:100});
 assert.equal(first.deadline,360000);assert.equal(first.detailLimit,50);
 const next=merchantBudget({now:360000,deadline:720000,remainingMerchants:1,remainingDetails:50});assert.equal(next.detailLimit,50);assert.equal(next.deadline,720000);
});
test('published merchant-only sync dispatches merchant workflow instead of full price scan',async()=>{
 const issue={number:1,title:'[Price Guard Sync:admin]',body:'encrypted',user:{login:'owner'}};
 const state={appliedSyncIssues:{1:{digest:syncDigest(issue),needsMerchantScan:true,needsScan:false}}};
 const calls=[];await acknowledgePublishedSync({state,listIssues:async()=>[issue],closeIssue:async()=>calls.push('closed'),requestScan:async()=>calls.push('price'),requestMerchantScan:async()=>calls.push('merchant')});
 assert.deepEqual(calls,['merchant','closed']);
 await assert.rejects(acknowledgePublishedSync({state,listIssues:async()=>[issue],closeIssue:async()=>{throw Error('must not close')},requestMerchantScan:async()=>{throw Error('dispatch failed')}}),/dispatch failed/);
});
