import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createOwnSourceLoader} from '../scripts/lib/own-source.mjs';
import {createFingerprintLoader} from '../scripts/lib/image-fingerprint-cache.mjs';

const T=Date.parse('2026-10-18T06:00:00Z'),url=id=>`https://paypayfleamarket.yahoo.co.jp/item/${id}`;
const hash=value=>createHash('sha256').update(value).digest('hex');
function bundle(id='z1',at=T+1){
 const detail={id,title:'APEX フィギュア',description:'新品 未開封 1点',seller:{id:'seller'},price:10000,status:'OPEN',
  images:['https://fixture.invalid/image'],condition:{name:'未使用'},categoryList:[{id:'figure',name:'フィギュア'}]};
 const shipping={shippingKnown:true,currency:'JPY',shippingJPY:0,shippingSource:'target_price_area'};
 return {detail,shipping,sourceUrl:url(id),fromCache:false,observedAt:at,originalObservation:{version:1,kind:'original_yahoo_detail_body',
  url:url(id),status:200,redirected:false,observedAt:at,bodySha256:hash('actual fixture body'),bodySha256Scope:'decoded_response_html_utf8',
  parsedSha256:hash(JSON.stringify({detail,shipping}))}};
}
const options=()=>({startedAt:T,deadlineAt:T+60_000});

test('completed original peek never initiates or awaits reads and isolates full parsed detail from caller mutation',async()=>{
 let time=T+100,reads=0,resolve;
 const loader=createOwnSourceLoader({now:()=>time,retainYahooOriginals:options(),fetchYahooBundle:()=>{reads++;return new Promise(value=>{resolve=value});}});
 assert.equal(loader.peekYahooBundle('z1'),null);assert.equal(reads,0);
 const request=loader.yahooBundle('z1');assert.equal(loader.peekYahooBundle('z1'),null);assert.equal(reads,1);
 const original=bundle();resolve(original);await request;const first=loader.peekYahooBundle('z1');
 assert.deepEqual(first,original);assert.equal(first.observedAt,T+1);
 original.detail.condition.name='mutated';first.detail.description='mutated too';
 assert.equal(loader.peekYahooBundle('z1').detail.condition.name,'未使用');assert.equal(loader.peekYahooBundle('z1').detail.description,'新品 未開封 1点');
 assert.strictEqual(loader.yahooBundle('z1'),request);assert.equal(reads,1);
 time=T+60_000;assert.equal(loader.peekYahooBundle('z1'),null);assert.equal(reads,1);assert.equal(loader.yahooOriginalStats().retainedBytes,0);
});

test('original peek rejects unbound, old, future, redirected, wrong-ID or mutated parsed inputs and pending failures',async()=>{
 const changes=[value=>delete value.originalObservation,value=>value.originalObservation.status=302,value=>value.originalObservation.redirected=true,
  value=>value.originalObservation.bodySha256='bad',value=>value.detail.id='z2',value=>value.detail.description+='changed',
  value=>value.fromCache=true,value=>{value.observedAt=value.originalObservation.observedAt=T-1;},value=>{value.observedAt=value.originalObservation.observedAt=T+1000;}];
 for(const change of changes){const value=bundle();change(value);let reads=0;
  const loader=createOwnSourceLoader({now:()=>T+100,retainYahooOriginals:options(),fetchYahooBundle:async()=>{reads++;return value;}});
  await loader.yahooBundle('z1');assert.equal(loader.peekYahooBundle('z1'),null);assert.equal(reads,1);
 }
 const loader=createOwnSourceLoader({now:()=>T+100,retainYahooOriginals:options(),fetchYahooBundle:async()=>{throw Error('fixture failure');}});
 await assert.rejects(loader.yahooBundle('z1'));assert.equal(loader.peekYahooBundle('z1'),null);
});

test('real Yahoo collector issues source/parsed receipts from the one already-read body with original time',async t=>{
 let time=T,reads=0;const value=bundle();
 const next={props:{initialState:{itemsState:{items:{item:value.detail}}}}};
 const html=`<h1>${value.detail.title}</h1><div><span class="ItemPrice__Component">10,000円</span><span class="ItemDetail__ShippingFreeLabel">送料無料</span></div><script id="__NEXT_DATA__">${JSON.stringify(next)}</script>`+' '.repeat(10000);
 t.mock.method(Date,'now',()=>time);t.mock.method(globalThis,'fetch',async requested=>{reads++;const response=new Response(html);
  Object.defineProperty(response,'url',{value:requested});Object.defineProperty(response,'text',{value:async()=>{time=T+1;return html;}});return response;});
 const {fetchYahooItemBundle}=await import('../scripts/lib/yahoo.mjs?shared-original='+crypto.randomUUID());
 const loader=createOwnSourceLoader({now:()=>time,retainYahooOriginals:options(),fetchYahooBundle:id=>fetchYahooItemBundle(id,{attempts:1,yahooRetainSharedOriginals:true})});
 await loader.yahooBundle('z1');const original=loader.peekYahooBundle('z1');
 assert.equal(reads,1);assert.equal(original.originalObservation.bodySha256,hash(html));assert.equal(original.originalObservation.observedAt,T+1);
 assert.equal(original.originalObservation.parsedSha256,hash(JSON.stringify({detail:original.detail,shipping:original.shipping})));
 assert.deepEqual(original.detail.condition,{name:'未使用'});assert.equal(original.shipping.shippingSource,'target_price_area');
});

test('cache-only fingerprint peeks preserve HTTP expiry and original time without transport, computation or cache writes',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'shared-fingerprint-peek-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 let time=T,reads=0,computes=0,header='public, max-age=10';
 const setup={directory,now:()=>time,fetchImage:async()=>{reads++;return {buffer:Buffer.from('original bytes'),cacheControl:header};},
  fingerprint:async()=>{computes++;return {dHash:'ffffffffffffffff'};}};
 const first=createFingerprintLoader(setup);assert.equal(await first.peek('https://fixture.invalid/image'),null);assert.equal(reads,0);
 const observed=await first.get('https://fixture.invalid/image');const counts={...first.stats};time++;
 observed.dHash='changed returned value';const memory=await first.peek('https://fixture.invalid/image');assert.equal(memory.dHash,'ffffffffffffffff');
 const second=createFingerprintLoader({...setup,fetchImage:()=>{throw Error('No transport from peek');},fingerprint:()=>{throw Error('No computation from peek');}});
 const restored=await second.peek('https://fixture.invalid/image');assert.equal(restored.imageObservedAt,new Date(T).toISOString());
 assert.equal(restored.imageCacheExpiresAt,T+10_000);assert.equal(await second.peek('https://fixture.invalid/image?w=2'),null);
 assert.deepEqual(first.stats,counts);assert.equal(reads,1);assert.equal(computes,1);assert.equal(second.stats.imageFetches,0);assert.equal(second.stats.writes,0);
 time=T+10_001;assert.equal(await second.peek('https://fixture.invalid/image'),null);assert.equal(reads,1);
 for(const directive of ['private,max-age=100','no-store','public,no-cache,max-age=100']){header=directive;
  await first.get('https://fixture.invalid/'+encodeURIComponent(directive));assert.equal(await first.peek('https://fixture.invalid/'+encodeURIComponent(directive)),null);}
});

test('original storage bounds exact serialized bytes and entries, while final read-only receipt preserves source time after scan admission closes',async()=>{
 let time=T+100;
 const loader=createOwnSourceLoader({now:()=>time,retainYahooOriginals:{...options(),maxEntries:2,maxBytes:4000},fetchYahooBundle:async id=>bundle(id,T+1)});
 for(const id of ['z1','z2','z3'])await loader.yahooBundle(id);
 assert.equal(loader.peekYahooBundle('z1'),null);assert.ok(loader.peekYahooBundle('z2'));assert.ok(loader.yahooOriginalStats().retainedBytes<=4000);
 time=T+60_001;
 const receipt=loader.yahooOriginalReceipt('z3');assert.equal(receipt.observedAt,T+1);receipt.observedAt=time;
 assert.equal(loader.yahooOriginalReceipt('z3').observedAt,T+1);assert.equal(loader.peekYahooBundle('z2'),null);
 time=T+20*60_000+1;assert.equal(loader.yahooOriginalReceipt('z3'),null);
});
