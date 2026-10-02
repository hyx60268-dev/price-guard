import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { encrypt,decrypt } from '../scripts/lib/crypto.mjs';
import { createSearchAccess,loadSearchAccess,mergeExternalSearchAccess } from '../scripts/lib/search-access.mjs';
import { reconcileDurableState } from '../scripts/lib/state.mjs';
import { initializeExternalSearchAccess,externalSearchAccessSnapshot,searchExternalImages } from '../scripts/lib/external-images.mjs';
const now=Date.parse('2026-10-02T08:53:35Z'),password='fixture-passphrase';
const row=(minutes,reason='search_challenge')=>({retryUntil:new Date(now+minutes*60000).toISOString(),reason});
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function workspace(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'price-guard-search-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'state'));return root;}
async function sealed(root,name,value){await fs.writeFile(path.join(root,'state',name),encrypt(Buffer.from(JSON.stringify(value)),password));}

test('search access state merges only allowed service records using the longest deadline',()=>{
 const result=mergeExternalSearchAccess({duckduckgo:{...row(20),query:'secret',cookie:'secret'},bing:row(5)},{duckduckgo:row(10),bing:row(25,'search_response_unavailable'),xianyu:row(999),other:row(5)});
 assert.deepEqual(result,{duckduckgo:row(20),bing:row(25,'search_response_unavailable')});assert.equal(JSON.stringify(result).includes('secret'),false);
 assert.deepEqual(mergeExternalSearchAccess({bing:{retryUntil:'invalid',reason:'search_challenge'},duckduckgo:{...row(20),reason:'skip'}}),{});
});

test('Bing endpoints share a gate and cooldown while the independent DuckDuckGo service continues',async()=>{
 const access=createSearchAccess({now:()=>now});await access.block('bing','search_challenge');let blocked=0,independent=0;
 for(const provider of ['bing','bing_web'])await assert.rejects(access.request(provider,'q',async()=>{blocked++;return 'html'}),/search_provider_cooldown/);
 assert.equal(await access.request('duckduckgo','q',async()=>{independent++;return 'html'}),'html');assert.equal(blocked,0);assert.equal(independent,1);
});

test('queued requests recheck a newly observed challenge before admission without blocking another service',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve),events=[];const access=createSearchAccess({now:()=>now});
 const first=access.request('duckduckgo','first',async()=>{events.push('ddg-first');await gate;await access.block('duckduckgo','search_challenge');throw Error('search_challenge')});
 const second=access.request('duckduckgo','second',async()=>{events.push('ddg-second');return 'html'});
 const outcomes=Promise.allSettled([first,second]);await turn();await access.request('bing','third',async()=>{events.push('bing-independent');return 'rss'});release();
 const result=await outcomes;assert.deepEqual(events,['ddg-first','bing-independent']);assert.match(result[0].reason.message,/^search_challenge$/);assert.match(result[1].reason.message,/search_provider_cooldown/);
});

test('queued requests recheck their deadline at admission and same-service network requests never overlap',async()=>{
 let clock=now,release,active=0,peak=0;const gate=new Promise(resolve=>release=resolve),access=createSearchAccess({now:()=>clock});
 const first=access.request('bing','first',async()=>{active++;peak=Math.max(peak,active);await gate;active--;return 'rss'});
 const second=access.request('bing_web','second',async()=>{throw Error('expired queued request reached network')},{deadline:now+10});const outcomes=Promise.allSettled([first,second]);
 await turn();clock+=11;release();const result=await outcomes;assert.equal(result[0].status,'fulfilled');assert.match(result[1].reason.message,/lookup_deadline/);assert.equal(peak,1);
});

test('ordinary cooldown skips and duplicate block observations do not renew or rewrite the deadline',async()=>{
 let clock=now,writes=0;const access=createSearchAccess({now:()=>clock,persist:async value=>{writes++;return value}});await access.block('duckduckgo','search_challenge');const initial=access.snapshot();clock+=60000;
 await assert.rejects(access.request('duckduckgo','other',async()=>{throw Error('must not request')}),/search_provider_cooldown/);await access.block('duckduckgo','search_challenge');assert.deepEqual(access.snapshot(),initial);assert.equal(writes,1);
 clock=now+20*60000;assert.equal(await access.request('duckduckgo','after',async()=> 'normal public result'),'normal public result');
});

test('two real Node stages restore the encrypted challenge record and make no request before expiry',async t=>{
 const root=await workspace(t),moduleUrl=new URL('../scripts/lib/search-access.mjs',import.meta.url).href;
 const code='import {loadSearchAccess} from '+JSON.stringify(moduleUrl)+'; const [root,mode]=process.argv.slice(1);const access=await loadSearchAccess({root,password:"fixture-passphrase",now:()=>'+now+'});let requested=0,result;if(mode==="scan"){await access.block("duckduckgo","search_challenge");result="stored"}else{try{await access.request("duckduckgo","private product query",async()=>{requested++;return "html"});result="requested"}catch(e){result=e.message}}process.stdout.write(JSON.stringify({requested,result,state:access.snapshot()}));';
 const execute=promisify(execFile);
 const first=JSON.parse((await execute(process.execPath,['--input-type=module','-e',code,root,'scan'])).stdout);assert.equal(first.result,'stored');
 const second=JSON.parse((await execute(process.execPath,['--input-type=module','-e',code,root,'merchant'])).stdout);assert.equal(second.result,'search_provider_cooldown');assert.equal(second.requested,0);assert.deepEqual(second.state,first.state);
 const bytes=await fs.readFile(path.join(root,'state/search-access.json.enc'));assert.equal(bytes.subarray(0,4).toString(),'PG01');assert.deepEqual(JSON.parse(decrypt(bytes,password)),{duckduckgo:row(20)});assert.equal(bytes.includes(Buffer.from('private product query')),false);
 assert.deepEqual(await fs.readdir(path.join(root,'state')),['search-access.json.enc']);
});

test('restored latest and discovery snapshots cannot shorten a longer encrypted local service deadline',async t=>{
 const root=await workspace(t);await sealed(root,'search-access.json.enc',{duckduckgo:row(25)});await sealed(root,'latest.json.enc',{externalSearchAccess:{duckduckgo:row(10),bing:row(12)}});await sealed(root,'discovery.json.enc',{externalSearchAccess:{duckduckgo:row(15),bing:row(18)}});
 const access=await loadSearchAccess({root,password,now:()=>now,initial:{duckduckgo:row(5)}});assert.deepEqual(access.snapshot(),{duckduckgo:row(25),bing:row(18)});
 const disk=JSON.parse(decrypt(await fs.readFile(path.join(root,'state/search-access.json.enc')),password));assert.deepEqual(disk,access.snapshot());
 const restored=reconcileDurableState({checkedAt:'2026-10-02T09:00:00Z',externalSearchAccess:{duckduckgo:row(25)}},{checkedAt:'2026-10-02T10:00:00Z',externalSearchAccess:{duckduckgo:row(1),bing:row(18)}});assert.deepEqual(restored.externalSearchAccess,{duckduckgo:row(25),bing:row(18)});
});

test('an unreadable encrypted service record fails closed instead of resetting access',async t=>{
 const root=await workspace(t);await fs.writeFile(path.join(root,'state/search-access.json.enc'),'broken');await assert.rejects(loadSearchAccess({root,password,now:()=>now}),/无法校验/);
});

test('same-provider query coalesces raw HTML but each caller applies its own selector and receives independent rows',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});await initializeExternalSearchAccess();let requests=0,release;const gate=new Promise(resolve=>release=resolve);
 globalThis.fetch=async()=>{requests++;await gate;return new Response('<rss><channel><item><title>Exact Product ABC123 White</title><link>https://public.example.org/item/1</link></item><item><title>Exact Product ABC123 White</title><link>https://public.example.org/item/2</link></item></channel></rss>')};
 const selectors=[];const a=searchExternalImages('Exact Product ABC123 White',{provider:'bing',candidateSelector:rows=>{selectors.push('a');rows[0].title='mutated only for a';return rows.filter(row=>row.url.endsWith('/1'))}}),b=searchExternalImages('Exact Product ABC123 White',{provider:'bing',candidateSelector:rows=>{selectors.push('b');return rows.filter(row=>row.url.endsWith('/2'))}});
 await turn();release();const [first,second]=await Promise.all([a,b]);assert.equal(requests,1);assert.deepEqual(selectors.sort(),['a','b']);assert.ok(first.candidates[0].url.endsWith('/1'));assert.ok(second.candidates[0].url.endsWith('/2'));assert.equal(second.candidates[0].title,'Exact Product ABC123 White');
 const third=await searchExternalImages('Exact Product ABC123 White',{provider:'bing'});assert.equal(requests,1);assert.equal(third.candidates[0].title,'Exact Product ABC123 White');assert.deepEqual(externalSearchAccessSnapshot(),{});
});

test('short public response caching expires and never caches a failed request or bypasses a challenge',async()=>{
 let clock=now,requests=0;const access=createSearchAccess({now:()=>clock,cacheMs:10});const load=async()=>{requests++;return 'html'};
 await access.request('bing','q',load);await access.request('bing','q',load);assert.equal(requests,1);clock+=11;await access.request('bing','q',load);assert.equal(requests,2);await access.block('bing_web','search_challenge');await assert.rejects(access.request('bing','q',load),/search_provider_cooldown/);assert.equal(requests,2);
 const fresh=createSearchAccess({now:()=>now});for(let i=0;i<2;i++)await assert.rejects(fresh.request('duckduckgo','q',async()=>{requests++;throw Error('network')}),/network/);assert.equal(requests,4);
});


test('unexpected Bing web markup cools only web while a real Bing challenge blocks both endpoints',async()=>{
 const access=createSearchAccess({now:()=>now});await access.block('bing_web','search_response_unavailable');let rss=0;
 await assert.rejects(access.request('bing_web','q',async()=>{throw Error('must not request')}),/search_provider_cooldown/);
 assert.equal(await access.request('bing','q',async()=>{rss++;return 'rss'}),'rss');assert.equal(rss,1);
 const challenged=createSearchAccess({now:()=>now});await challenged.block('bing_web','search_challenge');assert.deepEqual(challenged.snapshot(),{bing:row(20)});
 for(const provider of ['bing','bing_web'])await assert.rejects(challenged.request(provider,'q',async()=>{throw Error('must not request')}),/search_provider_cooldown/);
});

test('unexpected Bing RSS markup does not cool the independent web endpoint and an observed web challenge upgrades the barrier',async()=>{
 const access=createSearchAccess({now:()=>now});await access.block('bing','search_response_unavailable');assert.equal(await access.request('bing_web','q',async()=> 'web'),'web');
 await access.block('bing_web','search_challenge');assert.equal(access.snapshot().bing.reason,'search_challenge');await assert.rejects(access.request('bing_web','other',async()=>{throw Error('must not request')}),/search_provider_cooldown/);
});

test('each follower keeps its own deadline while a shared raw request and longer-lived caller continue',async()=>{
 let clock=now,release,requests=0;const gate=new Promise(resolve=>release=resolve),access=createSearchAccess({now:()=>clock});
 const leader=access.request('bing','same',async()=>{requests++;await gate;return 'rss'},{deadline:now+100});
 const follower=access.request('bing','same',async()=>{throw Error('must coalesce')},{deadline:now+5});const outcomes=Promise.allSettled([leader,follower]);
 await turn();clock=now+10;release();const result=await outcomes;assert.equal(requests,1);assert.equal(result[0].value,'rss');assert.match(result[1].reason.message,/lookup_deadline/);
});


test('a short follower exits on its real deadline while the longer shared request remains active',async()=>{
 let release,requests=0,leaderFinished=false;const gate=new Promise(resolve=>release=resolve),access=createSearchAccess();const start=Date.now();
 const leader=access.request('bing','real timer',async()=>{requests++;await gate;leaderFinished=true;return 'rss'},{deadline:start+500});
 const follower=access.request('bing','real timer',async()=>{throw Error('must share leader')},{deadline:start+20});
 const outcome=follower.then(()=> 'unexpected success',error=>error.message);await new Promise(resolve=>setTimeout(resolve,60));
 assert.equal(await Promise.race([outcome,Promise.resolve('still pending')]),'lookup_deadline');assert.equal(leaderFinished,false);assert.equal(requests,1);
 release();assert.equal(await leader,'rss');
});

test('a short leader timeout does not consume a longer follower budget and recovery re-enters the service gate',async()=>{
 const access=createSearchAccess(),start=Date.now();let first=0,second=0,active=0,peak=0;
 const leader=access.request('bing','short leader',async()=>{first++;active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,35));active--;throw Error('lookup_deadline')},{deadline:start+20});
 const follower=access.request('bing','short leader',async()=>{second++;active++;peak=Math.max(peak,active);active--;return 'rss'},{deadline:start+500});
 const result=await Promise.allSettled([leader,follower]);assert.match(result[0].reason.message,/lookup_deadline/);assert.equal(result[1].value,'rss');assert.equal(first,1);assert.equal(second,1);assert.equal(peak,1);
});

test('a longer queued follower reuses a successful short leader response but cannot follow a challenge with another request',async()=>{
 for(const challenge of [false,true]){
  const access=createSearchAccess(),start=Date.now();let requests=0;
  const leader=access.request('bing','queued same query',async()=>{requests++;await new Promise(resolve=>setTimeout(resolve,10));if(challenge){await access.block('bing','search_challenge');throw Error('search_challenge')}return 'rss'},{deadline:start+100});
  const follower=access.request('bing','queued same query',async()=>{requests++;return 'wrong extra request'},{deadline:start+500});
  const result=await Promise.allSettled([leader,follower]);assert.equal(requests,1);if(challenge){assert.match(result[0].reason.message,/search_challenge/);assert.match(result[1].reason.message,/search_provider_cooldown/)}else assert.deepEqual(result.map(row=>row.value),['rss','rss']);
 }
});
