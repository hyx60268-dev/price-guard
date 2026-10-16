import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {cadenceActivation,cadenceSlotReport,cadenceWindowReport} from '../scripts/lib/cadence-window.mjs';
const execute=promisify(execFile),START=Date.parse('2026-10-16T12:00:00Z'),sha='a'.repeat(40);
test('one-time push requires explicit matching marker and enabled reviewed configuration',()=>{
 const config={enabled:true,requestId:'approved-test-20261016',slots:6},message='repair [price-guard-cadence:approved-test-20261016]';
 assert.equal(cadenceActivation({event:'push',config,message}),true);
 for(const input of [{event:'push',config,message:'ordinary push'},{event:'push',config:{...config,enabled:false},message},{event:'push',config:{...config,requestId:'other-id'},message},{event:'schedule',config,message}])assert.equal(cadenceActivation(input),false);
 assert.throws(()=>cadenceActivation({event:'push',config,message,attempt:'2'}));
 assert.equal(cadenceActivation({event:'workflow_dispatch'}),true);
});
test('slot reports contain actual source timestamps and never treat skipped work as a completion',()=>{
 const status={codeSha:sha,cycleCoverage:{startedAt:new Date(START+60000).toISOString(),finishedAt:new Date(START+12*60000).toISOString(),inventoryComplete:true,total:100,priceComplete:10,costVerified:0,completeItems:0}};
 const row=cadenceSlotReport({admitted:true,slot:'1',status,sha});assert.equal(row.startedAt,status.cycleCoverage.startedAt);assert.equal(row.priceComplete,10);assert.equal(row.costVerified,0);assert.equal(row.inventoryComplete,true);
 assert.deepEqual(cadenceSlotReport({admitted:false,slot:'1',reason:'recent_scan'}),{slot:'1',admitted:false,reason:'recent_scan'});
 assert.throws(()=>cadenceSlotReport({admitted:true,slot:'1',status,sha:'b'.repeat(40)}));
});
function observed(overrides={}){return Object.fromEntries(Array.from({length:6},(_,index)=>[`slot-${index}`,{result:'success',outputs:{cost_exit:'0',coverage_exit:'0',slot_report:JSON.stringify({slot:String(index),admitted:true,startedAt:new Date(START+index*1200000).toISOString(),finishedAt:new Date(START+index*1200000+720000).toISOString(),inventoryComplete:true,inventoryComplete:true,total:100,priceComplete:100,costVerified:100,completeItems:100,...overrides})}}]))}
test('finite acceptance stays failed for zero work, partial coverage, operational failures and late real starts',()=>{
 assert.equal(cadenceWindowReport(observed()).accepted,true);
 assert.equal(cadenceWindowReport({}).accepted,false);
 assert.ok(cadenceWindowReport(observed({completeItems:0,costVerified:0})).reasons.includes('full_inventory_price_cost_incomplete'));
 const failed=observed();failed['slot-2']={result:'failure'};assert.ok(cadenceWindowReport(failed).reasons.includes('operational_slot_failure'));
 const late=observed();const row=JSON.parse(late['slot-3'].outputs.slot_report);row.startedAt=new Date(START+3*1200000+1000).toISOString();late['slot-3'].outputs.slot_report=JSON.stringify(row);assert.ok(cadenceWindowReport(late).reasons.includes('observed_start_cadence_not_20_minutes'));
});
test('real checker wrapper continues only a known product failure; missing/corrupt/wrong-version status stops',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cadence-checker-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'scripts'));await fs.mkdir(path.join(root,'public/data'),{recursive:true});
 for(const name of ['record-product-acceptance.mjs','check-cloud-cost.mjs'])await fs.copyFile(new URL('../scripts/'+name,import.meta.url),path.join(root,'scripts',name));
 const file=path.join(root,'public/data/status.json'),out=path.join(root,'output');const env={...process.env,GITHUB_SHA:sha,GITHUB_OUTPUT:out};
 await fs.writeFile(file,JSON.stringify({codeSha:sha,cloudCost:{accepted:false,verifiedReferences:0,message:'source unavailable'}}));
 await execute(process.execPath,[path.join(root,'scripts/record-product-acceptance.mjs'),'cost'],{env});assert.match(await fs.readFile(out,'utf8'),/exit_code=1/);
 for(const value of ['bad',JSON.stringify({codeSha:'b'.repeat(40),cloudCost:{accepted:false,verifiedReferences:0}}),JSON.stringify({codeSha:sha})]){await fs.writeFile(file,value);await assert.rejects(execute(process.execPath,[path.join(root,'scripts/record-product-acceptance.mjs'),'cost'],{env}));}
 await fs.unlink(file);await assert.rejects(execute(process.execPath,[path.join(root,'scripts/record-product-acceptance.mjs'),'cost'],{env}));
});

test('finite acceptance requires complete inventory, consistent counts and both real checker outcomes',()=>{
 for(const values of [{inventoryComplete:false},{inventoryComplete:undefined},{priceComplete:0},{costVerified:0},{priceComplete:101},{total:'100',completeItems:'100',costVerified:'100',priceComplete:'100'}])assert.equal(cadenceWindowReport(observed(values)).accepted,false);
 for(const key of ['cost_exit','coverage_exit'])for(const value of ['1','',undefined]){const needs=observed();needs['slot-1'].outputs[key]=value;assert.ok(cadenceWindowReport(needs).reasons.includes('slot_product_acceptance_failed_or_missing'));}
 const delayed=observed();const row=JSON.parse(delayed['slot-3'].outputs.slot_report);row.finishedAt=new Date(Date.parse(row.finishedAt)+1000).toISOString();delayed['slot-3'].outputs.slot_report=JSON.stringify(row);assert.ok(cadenceWindowReport(delayed).reasons.includes('observed_completion_cadence_not_20_minutes'));
});
