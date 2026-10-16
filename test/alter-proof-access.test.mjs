import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {encrypt} from '../scripts/lib/crypto.mjs';
import {requireRestoredYahooProofAccess} from '../scripts/lib/procurement-proof-access.mjs';
const password='fixture-only-password',now=Date.parse('2026-10-16T12:00:00Z');
test('full proof requires explicitly restored, decryptable shared source state before initializing or requesting sources',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'alter-proof-access-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'state'));
 const file=path.join(root,'state/latest.json.enc');let calls=0;
 const initialize=async options=>{calls++;return options.initial};
 const options={root,password,now,initialize,restored:true};
 await assert.rejects(requireRestoredYahooProofAccess({...options,restored:false}),/not_restored/);
 await assert.rejects(requireRestoredYahooProofAccess(options),/unverifiable/);
 await fs.writeFile(file,'corrupt');await assert.rejects(requireRestoredYahooProofAccess(options),/unverifiable/);
 await fs.writeFile(file,encrypt(Buffer.from('{}'),password));await assert.rejects(requireRestoredYahooProofAccess(options),/record_missing/);
 assert.equal(calls,0);
 await fs.writeFile(file,encrypt(Buffer.from(JSON.stringify({yahooRequestAccess:{reason:'http_429',retryAt:now+60000}})),password));
 await assert.rejects(requireRestoredYahooProofAccess(options),/hold_active/);
 await fs.writeFile(file,encrypt(Buffer.from(JSON.stringify({yahooRequestAccess:{}})),password));
 await assert.rejects(requireRestoredYahooProofAccess({...options,initialize:async()=>({reason:'http_429',retryAt:'indefinite'})}),/hold_active/);
 assert.deepEqual(await requireRestoredYahooProofAccess(options),{restored:true,source:'yahoo'});
});
test('default standalone ALTER proof fails before any fetch, while PR source mode cannot enter Yahoo inventory path',async()=>{
 const script=new URL('../scripts/prove-alter-procurement.mjs',import.meta.url).href;
 let output='';
 try{execFileSync(process.execPath,['--input-type=module','-e',`globalThis.fetch=()=>{throw Error('FORBIDDEN_SOURCE_REQUEST')};await import(${JSON.stringify(script)})`],{encoding:'utf8',env:{PATH:process.env.PATH},stdio:'pipe'})}catch(error){assert.equal(error.status,1);output=String(error.stdout)+String(error.stderr)}
 assert.match(output,/shared_source_state_not_restored/);assert.doesNotMatch(output,/FORBIDDEN_SOURCE_REQUEST/);
 const workflow=await fs.readFile(new URL('../.github/workflows/alter-procurement-proof.yml',import.meta.url),'utf8');
 assert.match(workflow,/prove-alter-procurement\.mjs --source-only/);assert.doesNotMatch(workflow,/DASHBOARD_PASSWORD|\$\{\{\s*secrets\.|playwright install/);
 const source=await fs.readFile(new URL('../scripts/prove-alter-procurement.mjs',import.meta.url),'utf8');
 assert.ok(source.indexOf('if(!sourceOnly)await requireRestoredYahooProofAccess')<source.indexOf('await readPublicProcurementDetail'));
 assert.ok(source.indexOf('}else{')<source.indexOf('await discoverYahooProfile'));
 assert.match(source,/currentInventoryVerified:false,automaticCostAccepted:false,inventoryProof:'not_run'/);
});
test('source-only executable performs only the independent ALTER request and never claims current inventory completion',()=>{
 const script=new URL('../scripts/prove-alter-procurement.mjs',import.meta.url).href;let output='';
 const mock=`process.argv=[process.execPath,'proof','--source-only'];let calls=0;globalThis.fetch=async url=>{calls++;if(url!=='https://www.alter-shanghai.cn/m/spotPage/298.html')throw Error('FORBIDDEN_SOURCE_REQUEST');return new Response('',{status:503})};await import(${JSON.stringify(script)});console.log('SOURCE_FETCH_COUNT='+calls)`;
 try{execFileSync(process.execPath,['--input-type=module','-e',mock],{encoding:'utf8',env:{PATH:process.env.PATH},stdio:'pipe'})}catch(error){assert.equal(error.status,1);output=String(error.stdout)+String(error.stderr)}
 assert.match(output,/SOURCE_FETCH_COUNT=1/);assert.match(output,/"inventoryProof":"not_run"/);assert.match(output,/"automaticCostAccepted":false/);assert.doesNotMatch(output,/FORBIDDEN_SOURCE_REQUEST|公开同款全流程实测/);
});
