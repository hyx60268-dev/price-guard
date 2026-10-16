import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {encrypt} from '../scripts/lib/crypto.mjs';

test('mocked collector tests remain isolated when the production checkout has restored encrypted state',async t=>{
 const source=fileURLToPath(new URL('../',import.meta.url)),root=await fs.mkdtemp(path.join(os.tmpdir(),'rakuma-restored-test-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 for(const name of ['scripts','public'])await fs.cp(path.join(source,name),path.join(root,name),{recursive:true,filter:file=>!file.includes(path.sep+'data'+path.sep)});
 await fs.mkdir(path.join(root,'test'),{recursive:true});await fs.mkdir(path.join(root,'state'),{recursive:true});
 await fs.copyFile(path.join(source,'test/rakuma-profile-pagination-proof.test.mjs'),path.join(root,'test/rakuma-profile-pagination-proof.test.mjs'));
 await fs.writeFile(path.join(root,'package.json'),'{"type":"module"}');
 await fs.symlink(await fs.realpath(path.join(source,'node_modules')),path.join(root,'node_modules'));
 const bytes=encrypt(Buffer.from(JSON.stringify({items:[{id:'PRIVATE_FIXTURE_ITEM'}],rakumaRequestAccess:{httpStatus:403,retryAfter:null,observedAt:'2026-01-01T00:00:00.000Z',retryAt:Date.parse('2099-01-01T00:00:00Z'),holdReason:'internal_fallback'}})),'unavailable-test-key');
 const latest=path.join(root,'state/latest.json.enc');await fs.writeFile(latest,bytes);
 await fs.writeFile(path.join(root,'no-network.mjs'),"globalThis.fetch=async()=>{throw Error('Unexpected live request in isolated test')}" );
 const env={...process.env};delete env.DASHBOARD_PASSWORD;delete env.NODE_TEST_CONTEXT;
 const {stdout}=await promisify(execFile)(process.execPath,['--import',path.join(root,'no-network.mjs'),'--test','--test-reporter=tap','test/rakuma-profile-pagination-proof.test.mjs'],{cwd:root,env,timeout:60000,maxBuffer:2_000_000});
 assert.match(stdout,/fail 0/);assert.doesNotMatch(stdout,/PRIVATE_FIXTURE_ITEM|unavailable-test-key/);
 assert.deepEqual(await fs.readFile(latest),bytes,'production state must never be rewritten by test mocks');
 assert.deepEqual(await fs.readdir(path.join(root,'state')),['latest.json.enc']);
});
