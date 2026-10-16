import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {encrypt,decrypt} from '../scripts/lib/crypto.mjs';
import {restoreCadenceState,mergeXianyuAccess} from '../scripts/lib/cadence-state.mjs';
import {xianyuAccessKey} from '../scripts/lib/xianyu-session.mjs';
import {loadXianyuAccess} from '../scripts/lib/xianyu-access.mjs';
const NOW=Date.parse('2026-10-16T12:00:00Z'),password='fixture-password',key=xianyuAccessKey({});
const receipt=offset=>({version:1,runKey:'100:1',codeSha:'a'.repeat(40),slotKey:'',claimedAt:new Date(NOW+offset).toISOString()});
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'cadence-state-')),staged=path.join(root,'.cadence-state');await fs.mkdir(path.join(root,'state'));await fs.mkdir(staged);t.after(()=>fs.rm(root,{recursive:true,force:true}));return {root,staged}}
async function save(dir,name,value,key){await fs.writeFile(path.join(dir,name),key?encrypt(Buffer.from(JSON.stringify(value)),key):JSON.stringify(value))}
async function read(dir,name,key){const bytes=await fs.readFile(path.join(dir,name));return JSON.parse(key?decrypt(bytes,key):bytes)}
test('artifact restore merges newer failed-writer holds and original receipt without overwriting evidence',async t=>{
 const {root,staged}=await fixture(t),state=path.join(root,'state');
 const old={checkedAt:'2026-10-15T12:00:00Z',items:[{id:'p',accountId:'a',checkedAt:'2026-10-15T12:00:00Z'}],manualCosts:{x:{purchaseCNY:8}},scanAdmission:receipt(-60000)};
 await save(staged,'latest.json.enc',old,password);await save(state,'latest.json.enc',old,password);
 await save(staged,'yahoo-request-access.json.enc',{reason:'http_429',retryAt:NOW+60000},password);
 await save(state,'yahoo-request-access.json.enc',{reason:'http_429',retryAt:NOW+3600000},password);
 await save(staged,'scan-admission.json',receipt(-60000));await save(state,'scan-admission.json',receipt(0));
 await restoreCadenceState({root,staged,password,env:{}});
 assert.equal((await read(state,'yahoo-request-access.json.enc',password)).retryAt,NOW+3600000);
 assert.deepEqual(await read(state,'scan-admission.json'),receipt(0));
 const latest=await read(state,'latest.json.enc',password);assert.equal(latest.items[0].checkedAt,old.items[0].checkedAt);assert.equal(latest.manualCosts.x.purchaseCNY,8);
});
test('artifact-only Xianyu and Rakuma cooldowns survive without copying session credentials',async t=>{
 const {root,staged}=await fixture(t),state=path.join(root,'state');await save(staged,'latest.json.enc',{},password);
 const hold={reason:'login_required',failures:1,failedAt:new Date(NOW).toISOString(),retryAt:new Date(NOW+3600000).toISOString()};
 await save(staged,'xianyu-access.json.enc',hold,key);
 const rakuma={httpStatus:429,retryAfter:'3600',observedAt:new Date(NOW).toISOString(),retryAt:NOW+3600000,holdReason:'retry_after'};
 await save(staged,'rakuma-request-access.json',{version:1,source:'rakuma',hold:rakuma});await fs.writeFile(path.join(staged,'rakuma-request-access.json.pending'),'pending');
 await restoreCadenceState({root,staged,password,env:{}});
 assert.equal((await loadXianyuAccess(root,key,{clock:()=>NOW+1000})).access().allowed,false);
 assert.deepEqual((await read(state,'rakuma-request-access.json')).hold,rakuma);assert.equal(await fs.readFile(path.join(state,'rakuma-request-access.json.pending'),'utf8'),'pending');
 assert.rejects(fs.access(path.join(state,'xianyu-session.json.enc')));
});
test('corrupt, mismatched-key and missing artifacts stop restoration instead of clearing holds',async t=>{
 const {root,staged}=await fixture(t);await assert.rejects(restoreCadenceState({root,staged,password,env:{}}),/Missing/);
 await save(staged,'latest.json.enc',{},password);await fs.writeFile(path.join(staged,'xianyu-access.json.enc'),'bad');
 await assert.rejects(restoreCadenceState({root,staged,password,env:{}}),/Cannot validate/);
 assert.throws(()=>mergeXianyuAccess({reason:'login_required',retryAt:'bad'}));
});
