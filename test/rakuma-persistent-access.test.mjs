import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createPersistentSourceAccessHold,mergeSourceAccessHolds} from '../scripts/lib/source-access-hold.mjs';
import {reconcileDurableState} from '../scripts/lib/state.mjs';
import {encrypt} from '../scripts/lib/crypto.mjs';
import {isolateRakumaAccess} from './fixtures/rakuma-access-fixture.mjs';

const START=Date.parse('2026-10-16T00:00:00Z'),url='https://item.fril.jp/aabb',password='fixture-only-password';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}};
const fresh=()=>import('../scripts/lib/rakuma.mjs?persistent-test='+crypto.randomUUID());
const response=(status=200,header='180')=>new Response(status===200?'body '.repeat(3000):'private denial body',{status,headers:header===null?{}:{'retry-after':header}});
const rootFixture=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'rakuma-persistent-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root};
const filename=root=>path.join(root,'state','rakuma-request-access.json');
const readHold=root=>JSON.parse(fs.readFileSync(filename(root))).hold;
function seed(root,header='3600',observedAt=START){return createPersistentSourceAccessHold({filename:filename(root),source:'rakuma',fallbackMs:3600000,now:()=>observedAt}).block({httpStatus:429,retryAfter:header})}
function published(root,hold,name='latest.json.enc'){
 fs.mkdirSync(path.join(root,'state'),{recursive:true});fs.writeFileSync(path.join(root,'state',name),encrypt(Buffer.from(JSON.stringify({rakumaRequestAccess:hold})),password));
}
async function fixture(t){const module=await fresh(),root=await isolateRakumaAccess(t,module);t.mock.timers.enable({apis:['Date','setTimeout'],now:START});return {module,root,advance:async ms=>{t.mock.timers.tick(ms);await flush()}}}
const held=error=>error.code==='RAKUMA_SOURCE_ACCESS_DENIED';

test('fresh processes automatically restore the checkout hold even from another cwd, then allow only actual expiry',t=>{
 const root=rootFixture(t),source=fileURLToPath(new URL('../',import.meta.url));
 fs.cpSync(path.join(source,'scripts'),path.join(root,'scripts'),{recursive:true});fs.cpSync(path.join(source,'public'),path.join(root,'public'),{recursive:true});
 fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');fs.symlinkSync(fs.realpathSync(path.join(source,'node_modules')),path.join(root,'node_modules'),'dir');
 const run=(at,deny=false)=>JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',`
  Date.now=()=>${at};const module=await import(${JSON.stringify(pathToFileURL(path.join(root,'scripts/lib/rakuma.mjs')).href)});let requests=0;
  globalThis.fetch=async()=>{requests++;return new Response(${deny?"'private body'":"'body '.repeat(3000)"},{status:${deny?429:200},headers:{'retry-after':'180'}})};
  const results=[];
  const operations=[()=>module.fetchRakumaPage('${url}'),()=>module.fetchRakumaHtml('${url}'),()=>module.fetchRakumaItem({url:'${url}'}),
   ()=>module.discoverRakumaProfile('https://fril.jp/shop/fixture'),()=>module.rakumaCompare({id:'aabb',title:'fixture',ownPrice:1000})];
  for(const operation of ${deny||at>=START+180000?'operations.slice(0,1)':'operations'}){try{const page=await operation();results.push({ok:true,observedAt:page.observedAt})}catch(error){results.push({code:error.code,retryAfter:error.retryAfter,observedAt:error.observedAt})}}
  console.log(JSON.stringify({requests,results,snapshot:module.rakumaRequestAccessSnapshot(),diagnostic:module.rakumaAccessDiagnostic()}));
 `],{cwd:os.tmpdir(),env:{},encoding:'utf8',timeout:15000}));
 const first=run(START,true);assert.equal(first.requests,1);assert.equal(first.snapshot.observedAt,new Date(START).toISOString());
 const restart=run(START+10000);assert.equal(restart.requests,0);assert.equal(restart.results.length,5);
 assert.ok(restart.results.every(result=>result.code==='RAKUMA_SOURCE_ACCESS_DENIED'&&result.retryAfter==='180'&&result.observedAt===first.snapshot.observedAt));
 assert.deepEqual(restart.snapshot,first.snapshot);
 const final=run(START+180000);assert.equal(final.requests,1);assert.equal(final.results[0].observedAt,START+180000);assert.equal(final.diagnostic,null);
 assert.deepEqual(final.snapshot,first.snapshot,'expiry does not rewrite the original denial or its timestamp');
});

for(const atDeadline of [true,false])test(`late 429 ${atDeadline?'at':'after'} caller expiry is checkpointed for the next process`,async t=>{
 const {module,root,advance}=await fixture(t),headers=deferred();let requests=0;
 const dependencies={fetchImpl:async()=>{requests++;if(atDeadline){t.mock.timers.setTime(START+50);return response(429)}return headers.promise}};
 const pending=assert.rejects(module.fetchRakumaPage(url,{deadlineAt:START+50},dependencies));await flush();
 if(!atDeadline){await advance(50);await pending;headers.resolve(response(429));await flush()}else await pending;
 const observed=readHold(root);assert.equal(observed.observedAt,new Date(START+50).toISOString());assert.equal(observed.retryAt,START+180050);
 const restart=await fresh();restart.initializeRakumaRequestAccess({root});
 await assert.rejects(restart.fetchRakumaPage(url,{},dependencies),held);assert.equal(requests,1);assert.deepEqual(restart.rakumaRequestAccessSnapshot(),observed);
});

test('already queued reads and a shorter later in-flight denial preserve the first longer hold',async t=>{
 const {module,root,advance}=await fixture(t),first=deferred(),second=deferred();let requests=0,alternate=0;
 const deps={fetchImpl:async()=>{requests++;return requests===1?first.promise:second.promise},readerFetchImpl:async()=>{alternate++;throw Error('forbidden alternate route')}};
 const all=Promise.allSettled([module.fetchRakumaPage(url,{},deps),module.fetchRakumaPage(url,{},deps),module.fetchRakumaPage(url,{},deps)]);
 await flush();await advance(1200);assert.equal(requests,2);
 await advance(50);first.resolve(response(429,'3600'));await flush();const original=readHold(root);
 await advance(50);second.resolve(response(403,'60'));await flush();await advance(1100);
 const outcomes=await all;assert.ok(outcomes.every(row=>row.status==='rejected'&&held(row.reason)));
 assert.equal(requests,2);assert.equal(alternate,0);assert.deepEqual(readHold(root),original);assert.deepEqual(module.rakumaRequestAccessSnapshot(),original);
});

test('a later successful in-flight response cannot clear a source hold or its observation',async t=>{
 const {module,root,advance}=await fixture(t),first=deferred(),second=deferred();let requests=0;
 const deps={fetchImpl:async()=>++requests===1?first.promise:second.promise};
 const denied=assert.rejects(module.fetchRakumaPage(url,{},deps),held),success=module.fetchRakumaPage(url,{},deps);
 await flush();await advance(1200);first.resolve(response(429));await denied;const original=readHold(root);
 second.resolve(response());await success;assert.deepEqual(readHold(root),original);await assert.rejects(module.fetchRakumaPage(url,{},deps),held);assert.equal(requests,2);
});

for(const name of ['latest.json.enc','discovery.json.enc'])test(`cache-miss restoration from ${name} preserves full original hold without a request`,async t=>{
 const root=rootFixture(t),hold=seed(root);fs.unlinkSync(filename(root));published(root,hold,name);
 const module=await fresh();module.initializeRakumaRequestAccess({root,password});t.mock.timers.enable({apis:['Date','setTimeout'],now:START+5000});let reads=0;
 await assert.rejects(module.fetchRakumaPage(url,{}, {fetchImpl:async()=>{reads++;return response()}}),error=>held(error)&&error.observedAt===hold.observedAt&&error.retryAfter===hold.retryAfter);
 assert.equal(reads,0);assert.deepEqual(module.rakumaRequestAccessSnapshot(),hold);
});

test('full-state reconciliation merges the longest hold independent of snapshot age and never clears unknown state',async t=>{
 const {mergeRakumaRequestAccess}=await fresh();
 const root=rootFixture(t),long=seed(root),short={...long,retryAfter:'60',retryAt:START+60000};
 for(const [a,b] of [[long,short],[short,long],[long,null],[null,long]])assert.deepEqual(reconcileDurableState({rakumaRequestAccess:a},{rakumaRequestAccess:b}).rakumaRequestAccess,long);
 assert.deepEqual(mergeSourceAccessHolds(long,{stateUnavailable:true}),{...long,stateUnavailable:true});
 assert.deepEqual(mergeRakumaRequestAccess(long,short),long);
 assert.deepEqual(mergeRakumaRequestAccess(null,{stateUnavailable:true},long),{...long,stateUnavailable:true});
 assert.deepEqual(mergeSourceAccessHolds({stateUnavailable:true},long),{...long,stateUnavailable:true});
 assert.throws(()=>reconcileDurableState({rakumaRequestAccess:long},{rakumaRequestAccess:{retryAt:0}}),/Invalid source access hold/);
});

for(const mode of ['bad-file','bad-published','missing-key','pending-marker','unknown-published'])test(`unverifiable ${mode} state latches Rakuma closed and publishes a durable unavailable snapshot`,async t=>{
 const root=rootFixture(t),module=await fresh();fs.mkdirSync(path.join(root,'state'),{recursive:true});
 if(mode==='bad-file')fs.writeFileSync(filename(root),'not-json');
 if(mode==='bad-published')fs.writeFileSync(path.join(root,'state','latest.json.enc'),'not-encrypted');
 if(mode==='missing-key')published(root,null);
 if(mode==='pending-marker')fs.writeFileSync(filename(root)+'.pending','');
 if(mode==='unknown-published')published(root,{stateUnavailable:true});
 const snapshot=module.initializeRakumaRequestAccess({root,password:mode==='missing-key'?'':password});
 assert.equal(snapshot.stateUnavailable,true);let reads=0;
 await assert.rejects(module.fetchRakumaPage(url,{}, {fetchImpl:async()=>{reads++;return response()}}),error=>held(error)&&error.reason==='rakuma_access_state_unavailable');
 assert.equal(reads,0);assert.equal(module.rakumaRequestAccessSnapshot().stateUnavailable,true);
 const target=rootFixture(t);published(target,module.rakumaRequestAccessSnapshot());const restart=await fresh();restart.initializeRakumaRequestAccess({root:target,password});
 await assert.rejects(restart.fetchRakumaPage(url,{}, {fetchImpl:async()=>{reads++;return response()}}),held);assert.equal(reads,0);
});

test('checkpoint failure blocks queued and restarted callers and preserves original diagnostic timestamps in publication',async t=>{
 const {module,root,advance}=await fixture(t);let requests=0;
 t.mock.method(fs,'renameSync',()=>{throw Error('fixture checkpoint failure')});
 const deps={fetchImpl:async()=>{requests++;return response(429,'3600')}};
 const all=Promise.allSettled([module.fetchRakumaPage(url,{},deps),module.fetchRakumaPage(url,{},deps)]);await flush();await advance(1200);
 assert.ok((await all).every(row=>row.status==='rejected'&&row.reason.reason==='rakuma_access_state_unavailable'));assert.equal(requests,1);
 const saved=module.rakumaRequestAccessSnapshot();assert.equal(saved.stateUnavailable,true);assert.equal(saved.retryAfter,'3600');assert.equal(saved.observedAt,new Date(START).toISOString());
 assert.equal(fs.statSync(filename(root)+'.pending').isFile(),true);
 const restart=await fresh();restart.initializeRakumaRequestAccess({root});await assert.rejects(restart.fetchRakumaPage(url,{},deps),held);assert.equal(requests,1);
 const target=rootFixture(t);published(target,saved);const restored=await fresh();restored.initializeRakumaRequestAccess({root:target,password});
 await assert.rejects(restored.fetchRakumaPage(url,{},deps),held);assert.deepEqual(restored.rakumaRequestAccessSnapshot(),saved);
});

test('a proof with no restored shared state fails closed, while a verified empty published record can admit',async t=>{
 const root=rootFixture(t),module=await fresh();module.initializeRakumaRequestAccess({root,password,requireRestoredState:true});let requests=0;
 const deps={fetchImpl:async()=>{requests++;return response()}};
 await assert.rejects(module.fetchRakumaPage(url,{},deps),error=>held(error)&&error.reason==='rakuma_access_state_unavailable');assert.equal(requests,0);
 published(root,null);const restored=await fresh();restored.initializeRakumaRequestAccess({root,password,requireRestoredState:true});
 await restored.fetchRakumaPage(url,{},deps);assert.equal(requests,1);
 assert.throws(()=>restored.initializeRakumaRequestAccess({root:rootFixture(t)}),/already in use/);
});
