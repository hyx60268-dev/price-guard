import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { encrypt,decrypt } from '../scripts/lib/crypto.mjs';
import { createYahooRequestAccess,loadYahooRequestAccess,mergeYahooRequestAccess,yahooRetryAt } from '../scripts/lib/yahoo-request-access.mjs';
import { RequestDeferredError } from '../scripts/lib/request-cooldown.mjs';
import { deferredYahooComparison,pricingCoverage } from '../scripts/lib/pricing-coverage.mjs';
import { pricingDecision,PRICING_RULES_VERSION } from '../public/pricing-policy.js';
import { cycleCoverage } from '../scripts/lib/cycle-coverage.mjs';
import { compactDashboardResult } from '../scripts/lib/publish.mjs';
import { reconcileDurableState } from '../scripts/lib/state.mjs';
import { yahooCompare } from '../scripts/lib/yahoo.mjs';
import { runKnownYahooRefresh } from '../scripts/lib/yahoo-known-refresh.mjs';

const START=Date.parse('2026-10-16T00:00:00Z'),password='fixture-only-password';
const hold=retryAt=>({retryAt,reason:'http_429'});
const execute=promisify(execFile);
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'yahoo-access-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'state'));return root}
const save=(root,name,value)=>fs.writeFile(path.join(root,'state',name),encrypt(Buffer.from(JSON.stringify(value)),password));

test('only canonical Yahoo access fields survive and maximum/indefinite holds never shrink',()=>{
 assert.deepEqual(mergeYahooRequestAccess(hold(START+60000),{...hold(START+3600000),url:'private',html:'discard'},hold(START+1000)),hold(START+3600000));
 assert.deepEqual(mergeYahooRequestAccess(hold('indefinite'),hold(Number.MAX_VALUE)),hold('indefinite'));
 assert.deepEqual(mergeYahooRequestAccess(undefined,{}),{});
 for(const invalid of [null,[],hold(null),hold(-1),hold('123'),hold('Infinity'),{retryAt:START,reason:'unknown'},hold(Infinity)])assert.throws(()=>mergeYahooRequestAccess(invalid),/停止以免重置冷却/);
 assert.equal(yahooRetryAt(hold('indefinite')),Infinity);
});

test('encrypted cache and both published snapshots are merged without shortening or renewing the hold',async t=>{
 const root=await fixture(t);
 await save(root,'yahoo-request-access.json.enc',hold(START+3600000));
 await save(root,'latest.json.enc',{yahooRequestAccess:hold(START+1000)});
 await save(root,'discovery.json.enc',{yahooRequestAccess:hold(START+2000)});
 const access=await loadYahooRequestAccess({root,password,initial:hold(START+3000)});
 assert.deepEqual(access.snapshot(),hold(START+3600000));await access.block(START+5000);
 const stored=JSON.parse(decrypt(await fs.readFile(path.join(root,'state/yahoo-request-access.json.enc')),password));
 assert.deepEqual(stored,hold(START+3600000));
 assert.deepEqual(reconcileDurableState({yahooRequestAccess:stored},{yahooRequestAccess:hold(START+1000)}).yahooRequestAccess,stored);
 await access.block(Infinity);const next=await loadYahooRequestAccess({root,password});assert.deepEqual(next.snapshot(),hold('indefinite'));
});

test('published full-state alone restores the hold after a workflow cache miss',async t=>{
 const root=await fixture(t);await save(root,'latest.json.enc',{yahooRequestAccess:hold(START+3600000)});
 const next=await loadYahooRequestAccess({root,password});assert.deepEqual(next.snapshot(),hold(START+3600000));
});

test('corrupt encrypted hold fails closed instead of enabling requests',async t=>{
 const root=await fixture(t);await fs.writeFile(path.join(root,'state/yahoo-request-access.json.enc'),'broken');
 await assert.rejects(loadYahooRequestAccess({root,password}),/停止以免重置冷却/);
});

test('separate workflow processes inherit an indefinite server hold and make zero requests',async t=>{
 const root=await fixture(t);
 const moduleUrl=new URL('../scripts/lib/yahoo.mjs',import.meta.url).href;
 const code=`const {initializeYahooRequestAccess,fetchYahooResult,yahooRequestAccessSnapshot}=await import(${JSON.stringify(moduleUrl)});let requests=0;globalThis.fetch=async()=>{requests++;return new Response('',{status:429,headers:{'retry-after':'9'.repeat(400)}})};await initializeYahooRequestAccess({root:process.argv[1],password:process.argv[2]});let reason;try{await fetchYahooResult('https://fixture.invalid',{yahooRequestDeadline:Date.now()+720000})}catch(error){reason=error.reason}console.log(JSON.stringify({requests,reason,state:yahooRequestAccessSnapshot()}))`;
 const first=JSON.parse((await execute(process.execPath,['--input-type=module','-e',code,root,password])).stdout);
 const second=JSON.parse((await execute(process.execPath,['--input-type=module','-e',code,root,password])).stdout);
 assert.equal(first.requests,1);assert.equal(second.requests,0);assert.equal(second.reason,'request_cooldown_deadline');assert.deepEqual(second.state,first.state);assert.deepEqual(second.state,hold('indefinite'));
});

test('concurrent checkpoint writes keep the longest observed hold',async()=>{
 const saved=[];const access=createYahooRequestAccess({persist:async value=>{await new Promise(resolve=>setImmediate(resolve));saved.push(value);return value}});
 await Promise.all([access.block(START+1000),access.block(START+3600000),access.block(START+2000)]);
 assert.deepEqual(access.snapshot(),hold(START+3600000));assert.ok(saved.every(row=>row.retryAt===START+3600000));
});

test('deferred publication preserves evidence clocks and fails coverage even if the old quote is in this cycle',()=>{
 const checkedAt=new Date(START+1000).toISOString(),searchCheckedAt=new Date(START-3600000).toISOString();
 const prior={status:'ok',rulesVersion:PRICING_RULES_VERSION,checkedAt,searchCheckedAt,candidates:[{id:'competitor',sellerId:'other',price:1000,url:'https://fixture.invalid/competitor',matchMethod:'verified'}]};
 const value=deferredYahooComparison(prior,new RequestDeferredError('request_cooldown_deadline',START+3600000));
 assert.equal(value.checkedAt,checkedAt);assert.equal(value.searchCheckedAt,searchCheckedAt);assert.deepEqual(value.candidates,prior.candidates);
 const item={id:'own',accountId:'a',platform:'yahoo',comparisonMode:'same_platform',ownPrice:2000,yahoo:value},accounts=[{id:'a',profileStatus:'live'}];
 const decision=pricingDecision(item,{now:START+120000});assert.equal(decision.complete,false);assert.equal(decision.canRecommend,false);
 assert.equal(pricingCoverage([item],accounts).complete,false);
 const coverage=cycleCoverage([item],accounts,{startedAt:START,finishedAt:START+120000});assert.equal(coverage.accepted,false);assert.equal(coverage.priceObserved,0);
 const compact=compactDashboardResult({items:[item],accounts},{now:START+120000});assert.equal(compact.items[0].yahoo.checkedAt,checkedAt);assert.equal(compact.items[0].yahoo.deferredReason,'request_cooldown_deadline');assert.equal(compact.items[0].yahoo.retryAt,START+3600000);
 const missing=deferredYahooComparison(undefined,new RequestDeferredError('request_deadline'));assert.equal(missing.checkedAt,null);assert.equal(missing.status,'deferred_budget');
});

test('Yahoo comparison propagates deferral instead of treating a failed own read as newly checked evidence',async()=>{
 const error=new RequestDeferredError('request_cooldown_deadline',START+3600000);let searchRequests=0;
 await assert.rejects(yahooCompare(null,{id:'own',title:'商品',ownPrice:2000},{},{fetchYahooItemBundle:async()=>{throw error},fetchYahooResult:async()=>{searchRequests++;return {items:[]}}}),value=>value===error);
 assert.equal(searchRequests,0);
});

test('known refresh preserves accepted timestamps and reports the explicit deferred reason',async()=>{
 const prior={status:'ok',checkedAt:new Date(START-60000).toISOString(),searchCheckedAt:new Date(START-120000).toISOString()};
 const task={context:{account:{id:'a'}},item:{id:'own'},prior:{yahoo:prior}};
 const outcomes=await runKnownYahooRefresh([task],{deadline:START+720000,now:()=>START,lookup:async()=>{throw new RequestDeferredError('request_cooldown_deadline',START+3600000)}});
 const value=outcomes.get('a:own').value;assert.equal(value.checkedAt,prior.checkedAt);assert.equal(value.searchCheckedAt,prior.searchCheckedAt);assert.equal(value.deferredReason,'request_cooldown_deadline');assert.equal(value.knownRefresh.reason,'request_cooldown_deadline');assert.equal(value.cacheReason,'request_error');
});

test('scan applies the original startedAt budget before profile discovery and checkpoints before publication',async()=>{
 const scan=await fs.readFile(new URL('../scripts/scan.mjs',import.meta.url),'utf8');
 assert.ok(scan.indexOf('const deadline=startedAt+')<scan.indexOf('const contexts=await mapLimit'));
 assert.ok(scan.indexOf('await initializeYahooRequestAccess')<scan.indexOf('const contexts=await mapLimit'));
 assert.match(scan,/settings\.yahooRequestDeadline=deadline/);assert.match(scan,/fetchYahooItemBundle\(id,settings\)/);assert.match(scan,/fetchYahooResult\(url,settings\)/);
 const workflow=await fs.readFile(new URL('../.github/workflows/price-guard.yml',import.meta.url),'utf8');
 assert.match(workflow,/保存扫描访问冷却与当前加密基准\n\s+if: always\(\)/);
 assert.ok(workflow.indexOf('price-guard-state-scan-')<workflow.indexOf('node scripts/prepare-publication.mjs'));
});

test('search and competitor-detail deferrals cannot become a fresh partial comparison',async()=>{
 const {ownTitle,title,ownDescription}=await import('./fixtures/yahoo-known-pikachu.mjs');
 const own={id:'own',accountId:'owner',sellerId:'own-seller',platform:'yahoo',title:ownTitle,image:'own-primary',ownPrice:44499};
 const card={id:'other',sellerId:'other-seller',title,image:'other-primary',price:41999,matchMethod:'same_sealed_single_box_primary'};
 own.yahoo={status:'ok',checkedAt:new Date(START-60000).toISOString(),searchCheckedAt:new Date(START-120000).toISOString(),rulesVersion:PRICING_RULES_VERSION,audit:{accountId:own.accountId,ownItemId:own.id},candidates:[card]};
 const bundle={detail:{...own,price:own.ownPrice,status:'OPEN',description:ownDescription,images:['own-primary']},recommendations:[],shipping:{shippingKnown:true,currency:'JPY',shippingJPY:0}};
 const fp={dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[100,100,100],colorGrid:Array(768).fill(100)};
 for(const stage of ['search','competitor']){
  const error=new RequestDeferredError('request_cooldown_deadline',START+3600000),requests=[];
  await assert.rejects(yahooCompare(null,own,{yahooKnownOnly:stage==='competitor',forceYahooBroadSearch:stage==='search'},{
   fetchYahooItemBundle:async id=>{requests.push(id);if(id!==own.id)throw error;return bundle},
   fetchYahooResult:async()=>{requests.push('search');throw error},imageFingerprints:async()=>fp
  }),value=>value===error);
  assert.deepEqual(requests,stage==='search'?['own','search']:['own','other']);
  assert.equal(own.yahoo.checkedAt,new Date(START-60000).toISOString());
 }
});

test('expired persisted holds do not renew and allow a later process to read once',async t=>{
 const root=await fixture(t),past=Date.now()-60000;await save(root,'yahoo-request-access.json.enc',hold(past));
 const moduleUrl=new URL('../scripts/lib/yahoo.mjs',import.meta.url).href;
 const code=`const {initializeYahooRequestAccess,fetchYahooResult,yahooRequestAccessSnapshot}=await import(${JSON.stringify(moduleUrl)});let requests=0;globalThis.fetch=async()=>{requests++;return new Response('<script id="__NEXT_DATA__">'+JSON.stringify({props:{initialState:{searchState:{search:{result:{items:[],totalResultsAvailable:0}}}}}})+'</script>'+' '.repeat(10000))};await initializeYahooRequestAccess({root:process.argv[1],password:process.argv[2]});await fetchYahooResult('https://fixture.invalid',{yahooRequestDeadline:Date.now()+720000});console.log(JSON.stringify({requests,state:yahooRequestAccessSnapshot()}))`;
 const value=JSON.parse((await execute(process.execPath,['--input-type=module','-e',code,root,password])).stdout);
 assert.equal(value.requests,1);assert.deepEqual(value.state,hold(past));
});


test('decryptable malformed stored or published holds fail closed instead of appearing absent',async t=>{
 const root=await fixture(t);
 for(const malformed of [hold(null),hold('Infinity'),[],hold(-1),null]){
  await save(root,'yahoo-request-access.json.enc',malformed);
  await assert.rejects(loadYahooRequestAccess({root,password}),/停止以免重置冷却/);
  await save(root,'yahoo-request-access.json.enc',{});
  await save(root,'latest.json.enc',{yahooRequestAccess:malformed});
  await assert.rejects(loadYahooRequestAccess({root,password}),/停止以免重置冷却/);
  assert.throws(()=>reconcileDurableState({yahooRequestAccess:hold(START+1000)},{yahooRequestAccess:malformed}),/停止以免重置冷却/);
  await save(root,'latest.json.enc',{});
 }
 const legacy=await loadYahooRequestAccess({root,password});assert.deepEqual(legacy.snapshot(),{});
});
