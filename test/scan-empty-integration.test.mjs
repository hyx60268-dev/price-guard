import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { encrypt,decrypt } from '../scripts/lib/crypto.mjs';

test('full scan publishes an empty inventory while retaining costs, aliases and acknowledged inputs',async()=>{
  const source=fileURLToPath(new URL('../',import.meta.url));
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'price-guard-scan-'));
  const envKeys=['DASHBOARD_PASSWORD','PORTAL_USERS_JSON','XIANYU_AUTH_PART_1','XIANYU_AUTH_PART_2','XIANYU_AUTH_PART_3','XIANYU_STORAGE_STATE_GZIP_B64','XIANYU_STORAGE_STATE_B64'];
  const saved=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
  const password='isolated-test-password';
  try{
    await fs.cp(path.join(source,'scripts'),path.join(root,'scripts'),{recursive:true});
    await fs.mkdir(path.join(root,'public'),{recursive:true});
    for(const name of ['match-memory.js','shop-profile.js','durable-state.js','build-version.js'])await fs.copyFile(path.join(source,'public',name),path.join(root,'public',name));
    for(const name of ['state','config'])await fs.mkdir(path.join(root,name));
    await fs.writeFile(path.join(root,'package.json'),' {"type":"module"}');
    await fs.symlink(await fs.realpath(path.join(source,'node_modules')),path.join(root,'node_modules'),process.platform==='win32'?'junction':'dir');
    await fs.writeFile(path.join(root,'config/accounts.json'),JSON.stringify({accounts:[]}));
    await fs.writeFile(path.join(root,'config/settings.json'),JSON.stringify({exchangeRate:20,costMultiplier:1.05,profitWarningJPY:1500}));
    const previous={items:[{id:'sold',accountId:'a',title:'商品 A'}],accounts:[],manualCosts:{c:{accountId:'a',itemId:'sold',purchaseCNY:80}},relistAliases:{'a:sold':'original'},appliedSyncIssues:{42:{digest:'fixture'}}};
    await fs.writeFile(path.join(root,'state/latest.json.enc'),encrypt(Buffer.from(JSON.stringify(previous)),password));
    for(const key of envKeys)process.env[key]='';process.env.DASHBOARD_PASSWORD=password;
    await import(pathToFileURL(path.join(root,'scripts/scan.mjs')));
    const result=JSON.parse(decrypt(await fs.readFile(path.join(root,'state/latest.json.enc')),password));
    const phone=JSON.parse(decrypt(await fs.readFile(path.join(root,'public/data/latest.json.enc')),password));
    assert.deepEqual(result.items,[]);
    assert.equal(result.manualCosts.c.purchaseCNY,80);
    assert.equal(result.listingHistory['a:sold'].title,'商品 A');
    assert.equal(result.relistAliases['a:sold'],'original');
    assert.equal(result.appliedSyncIssues[42].digest,'fixture');
    assert.equal(phone.appliedSyncIssues,undefined);
    assert.equal(phone.listingHistory,undefined);
  }finally{
    for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;
    await fs.rm(root,{recursive:true,force:true});
  }
});
