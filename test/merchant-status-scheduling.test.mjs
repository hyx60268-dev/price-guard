import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { merchantMonitorStatus } from '../public/merchant-status.js';
import { merchantRetryDelay,merchantMonitorDue,merchantBudget } from '../scripts/lib/merchant-scheduling.mjs';
import { acknowledgePublishedSync,syncDigest } from '../scripts/lib/sync-receipts.mjs';
import { encrypt } from '../scripts/lib/crypto.mjs';
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
test('inline daily catch-up does not retry partial, failed or incomplete image work every pricing cycle',()=>{
 const checked=Date.parse('2026-10-15T00:00:00Z'),configDigest='same-config';
 for(const fields of [
  {merchants:[{status:'partial',pendingDetails:20}]},
  {merchants:[{status:'error'}]},
  {merchants:[{status:'deferred'}]},
  {merchants:[{status:'ok'}],products:[{webImageStatus:'error',webImageRetryAt:new Date(checked+20*60000).toISOString()}]},
  {merchants:[{status:'ok'}],products:[{webImageStatus:'partial',webImages:[]}]}
 ]){
  const result={mode:'merchant_monitor',configDigest,checkedAt:new Date(checked).toISOString(),...fields},before=structuredClone(result);
  assert.equal(merchantMonitorDue(result,{configDigest,now:checked+25*60000}),true,'ordinary retry eligibility remains unchanged');
  assert.equal(merchantMonitorDue(result,{configDigest,now:checked+25*60000,dailyCatchup:true}),false);
  assert.equal(merchantMonitorDue(result,{configDigest,now:checked+24*3600000-1,dailyCatchup:true}),false);
  assert.equal(merchantMonitorDue(result,{configDigest,now:checked+24*3600000,dailyCatchup:true}),true);
  assert.deepEqual(result,before,'due checks preserve partial observations and image evidence');
 }
});
test('inline daily catch-up immediately handles new configurations and missing or invalid observation time',()=>{
 const now=Date.parse('2026-10-15T12:00:00Z'),configDigest='current';
 const saved={mode:'merchant_monitor',configDigest,checkedAt:new Date(now-60000).toISOString(),merchants:[{status:'partial'}]};
 assert.equal(merchantMonitorDue(saved,{configDigest,now,dailyCatchup:true}),false);
 for(const result of [{},{...saved,mode:'other'},{...saved,configDigest:'old'},{...saved,checkedAt:null},{...saved,checkedAt:'invalid'},{...saved,checkedAt:new Date(now+1000).toISOString()}]){
  assert.equal(merchantMonitorDue(result,{configDigest,now,dailyCatchup:true}),true);
 }
});
test('skipped inline merchant catch-up makes no requests and preserves encrypted evidence byte-for-byte',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'price-guard-merchant-daily-'));
 const sourceRoot=fileURLToPath(new URL('../',import.meta.url)),password='merchant-daily-test-password';
 try{
  for(const dir of ['config','state','public/data','scripts'])await fs.mkdir(path.join(root,dir),{recursive:true});
  const cfg={merchants:[],budgetMinutes:12},monitorVersion=22;
  const configDigest=crypto.createHash('sha256').update(JSON.stringify({cfg,monitorVersion})).digest('hex');
  const discovery={mode:'merchant_monitor',configDigest,checkedAt:new Date(Date.now()-25*60000).toISOString(),merchants:[{status:'partial'}],merchantListings:{saved:{description:'Preserved detail',webImages:[{url:'https://brand.test/photo.jpg'}]}},products:[{webImageStatus:'error'}]};
  const dashboard={manualCosts:{saved:100},matchCorrections:{saved:{deleted:true}},managedAccounts:[{id:'keep'}]};
  const encoded=value=>encrypt(Buffer.from(JSON.stringify(value)),password);
  const protectedFiles={
   'state/discovery.json.enc':encoded(discovery),
   'state/latest.json.enc':encoded(dashboard),
   'state/discovery-status.json':Buffer.from(JSON.stringify({checkedAt:discovery.checkedAt,trace:'preserved'})),
   'public/data/discovery.json.enc':encoded(discovery),
   'public/data/discovery-status.json':Buffer.from(JSON.stringify({checkedAt:discovery.checkedAt,trace:'published'}))
  };
  for(const [name,bytes] of Object.entries(protectedFiles))await fs.writeFile(path.join(root,name),bytes);
  await fs.writeFile(path.join(root,'config/merchant-monitor.json'),JSON.stringify(cfg));
  await fs.writeFile(path.join(root,'config/settings.json'),'{}');
  await fs.copyFile(path.join(sourceRoot,'scripts/merchant-monitor.mjs'),path.join(root,'scripts/merchant-monitor.mjs'));
  await fs.symlink(path.join(sourceRoot,'scripts/lib'),path.join(root,'scripts/lib'),process.platform==='win32'?'junction':'dir');
  for(const name of ['merchant-records.js','merchant-config.js'])await fs.symlink(path.join(sourceRoot,'public',name),path.join(root,'public',name),'file');
  await fs.writeFile(path.join(root,'no-network.mjs'),'globalThis.fetch=()=>{throw Error("Unexpected request during skipped daily catch-up")};');
  const {stdout}=await promisify(execFile)(process.execPath,['--import',pathToFileURL(path.join(root,'no-network.mjs')).href,path.join(root,'scripts/merchant-monitor.mjs')],{
   env:{...process.env,DASHBOARD_PASSWORD:password,MERCHANT_MONITOR_DAILY_CATCHUP:'1',MERCHANT_MONITOR_IF_DUE:''}
  });
  assert.match(stdout,/商家监控未到下次更新时间/);
  for(const [name,bytes] of Object.entries(protectedFiles))assert.deepEqual(await fs.readFile(path.join(root,name)),bytes,name+' must remain unchanged');
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
test('published merchant-only sync dispatches merchant workflow instead of full price scan',async()=>{
 const issue={number:1,title:'[Price Guard Sync:admin]',body:'encrypted',user:{login:'owner'}};
 const state={appliedSyncIssues:{1:{digest:syncDigest(issue),needsMerchantScan:true,needsScan:false}}};
 const calls=[];await acknowledgePublishedSync({state,listIssues:async()=>[issue],closeIssue:async()=>calls.push('closed'),requestScan:async()=>calls.push('price'),requestMerchantScan:async()=>calls.push('merchant')});
 assert.deepEqual(calls,['merchant','closed']);
 await assert.rejects(acknowledgePublishedSync({state,listIssues:async()=>[issue],closeIssue:async()=>{throw Error('must not close')},requestMerchantScan:async()=>{throw Error('dispatch failed')}}),/dispatch failed/);
});
