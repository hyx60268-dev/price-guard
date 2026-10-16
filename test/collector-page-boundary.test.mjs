import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequestCooldown} from '../scripts/lib/request-cooldown.mjs';
import {encrypt,decrypt} from '../scripts/lib/crypto.mjs';
import {isolateRakumaAccess} from './fixtures/rakuma-access-fixture.mjs';

// Recovery tests use the deployed parsers directly; no experimental adapter is
// required to validate the real collector boundary and its original timestamps.
const START=Date.parse('2026-10-16T00:00:00Z');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const fresh=source=>import(`../scripts/lib/${source}.mjs?collector-boundary=${crypto.randomUUID()}`);
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}};
const pad=html=>html+' '.repeat(10000);
const yahooHtml=(items=[],total=items.length)=>pad('<script id="__NEXT_DATA__">'+JSON.stringify({props:{initialState:{searchState:{search:{result:{items,totalResultsAvailable:total}}}}}})+'</script>');
const yahooDetail=()=>pad('<script id="__NEXT_DATA__">'+JSON.stringify({props:{initialState:{itemsState:{items:{item:{id:'own',title:'商品',description:'新品 1個',price:1000,status:'OPEN',sellerId:'seller'}}}}}})+'</script>');
const rakumaDetail=()=>pad('<script type="application/ld+json">'+JSON.stringify({'@type':'Product',name:'商品',description:'新品 1個',offers:{price:1000,priceCurrency:'JPY',availability:'https://schema.org/InStock'}})+'</script>');
const rakumaCard=(id,sold=false)=>`<a class="link_shop_image" href="https://item.fril.jp/${id}" data-rat-item_name="商品${id}" data-rat-itemid="123/99" data-rat-price="1000">${sold?'SOLD OUT':''}</a>`;
function response(html,{status=200,url='',body,headers={}}={}){
  return {status,ok:status>=200&&status<300,headers:new Headers(headers),url,redirected:false,text:body||(async()=>html)};
}
async function clockFixture(t,source){
  const module=await fresh(source);
  if(source==='rakuma')await isolateRakumaAccess(t,module);
  t.mock.timers.enable({apis:['Date','setTimeout'],now:START});
  t.mock.method(console,'warn',()=>{});
  return {module,read:module[source==='yahoo'?'fetchYahooPage':'fetchRakumaPage'],
    advance:async ms=>{t.mock.timers.tick(ms);await flush()}};
}
const requestUrl=source=>source==='yahoo'?'https://paypayfleamarket.yahoo.co.jp/item/own':'https://item.fril.jp/aabb';
const bodyFor=source=>source==='yahoo'?yahooDetail():rakumaDetail();

for(const source of ['yahoo','rakuma'])test(`${source}: actual body observation survives detail parsing unchanged`,async t=>{
  const {module,read,advance}=await clockFixture(t,source),body=deferred();let receivedSignal;
  const url=requestUrl(source),dependencies={fetchImpl:async(requested,options)=>{assert.equal(requested,url);receivedSignal=options.signal;return response('',{url,body:()=>body.promise})}};
  const pending=read(url,{deadlineAt:START+10000},dependencies);
  await flush();await advance(123);body.resolve(bodyFor(source));const page=await pending;
  const detail=source==='yahoo'?module.extractItemData(module.extractNextData(page.html)):module.extractRakumaDetail(page.html,url);
  assert.equal(page.observedAt,START+123);assert.equal(page.fromCache,false);assert.equal(page.status,200);assert.equal(page.url,url);assert.equal(page.finalUrl,url);
  assert.equal(page.html,bodyFor(source));assert.equal(detail.price,1000);assert.equal(receivedSignal.aborted,true,'completed body releases its transport');
  await advance(500);assert.equal(page.observedAt,START+123,'parsing and later consumers do not re-date evidence');
});
for(const source of ['yahoo','rakuma'])test(`${source}: reported final redirects remain visible to callers`,async t=>{
  const {read}=await clockFixture(t,source),url=requestUrl(source),finalUrl=url+'?redirected=1';
  const page=await read(url,{}, {fetchImpl:async()=>response(bodyFor(source),{url:finalUrl})});
  assert.equal(page.finalUrl,finalUrl);assert.equal(page.url,finalUrl);assert.notEqual(page.url,url);
});
for(const source of ['yahoo','rakuma'])test(`${source}: omitted response URL is not fabricated and status is the actual HTTP status`,async t=>{
  const {read}=await clockFixture(t,source);
  const page=await read(requestUrl(source),{}, {fetchImpl:async()=>response(bodyFor(source),{status:201})});
  assert.equal(page.status,201);assert.equal(Object.hasOwn(page,'url'),false);assert.equal(Object.hasOwn(page,'finalUrl'),false);
});
for(const source of ['yahoo','rakuma'])for(const stage of ['fetch','body'])test(`${source}: ${stage} deadline aborts a noncooperative transport without retry or late evidence`,async t=>{
  const {read,advance}=await clockFixture(t,source),hung=deferred();let requests=0,transportSignal;
  const pending=assert.rejects(read(requestUrl(source),{deadlineAt:START+50},{fetchImpl:async(_url,{signal})=>{
    requests++;transportSignal=signal;return stage==='fetch'?hung.promise:response('',{body:()=>hung.promise});
  }}),error=>error.code==='request_deferred'&&error.reason==='request_deadline');
  await flush();await advance(50);await pending;assert.equal(transportSignal.aborted,true);assert.equal(requests,1);
  hung.resolve(stage==='fetch'?response(bodyFor(source)):bodyFor(source));await advance(60000);assert.equal(requests,1);
});
for(const source of ['yahoo','rakuma'])for(const stage of ['fetch','body','retry'])test(`${source}: caller cancellation during ${stage} ends this operation without another request`,async t=>{
  const {read,advance}=await clockFixture(t,source),controller=new AbortController(),hung=deferred();let requests=0,transportSignal;
  const pending=assert.rejects(read(requestUrl(source),{signal:controller.signal},{fetchImpl:async(_url,{signal})=>{
    requests++;transportSignal=signal;if(stage==='retry')throw Error('temporary failure');
    return stage==='fetch'?hung.promise:response('',{body:()=>hung.promise});
  }}),error=>error.name==='AbortError');
  await flush();controller.abort();await pending;assert.equal(transportSignal.aborted,true);await advance(60000);assert.equal(requests,1);
});
for(const source of ['yahoo','rakuma'])test(`${source}: aborted queued calls never reserve a later slot or fetch`,async t=>{
  const {read,advance}=await clockFixture(t,source),starts=[],dependencies={fetchImpl:async()=>{starts.push(Date.now());return response(bodyFor(source))}};
  await read(requestUrl(source),{},dependencies);
  const controller=new AbortController(),queued=assert.rejects(read(requestUrl(source),{signal:controller.signal},dependencies),error=>error.name==='AbortError');
  await flush();controller.abort();await queued;
  const later=read(requestUrl(source),{},dependencies);await flush();await advance(source==='yahoo'?5500:1200);await later;
  assert.deepEqual(starts,[START,START+(source==='yahoo'?5500:1200)]);
});
for(const source of ['yahoo','rakuma'])test(`${source}: queue spacing beyond caller deadline never starts a request`,async t=>{
  const {read,advance}=await clockFixture(t,source);let requests=0;
  const dependencies={fetchImpl:async()=>{requests++;return response(bodyFor(source))}};
  await read(requestUrl(source),{},dependencies);
  await assert.rejects(read(requestUrl(source),{deadlineAt:START+50},dependencies),error=>error.code==='request_deferred');
  await advance(60000);assert.equal(requests,1);
});
for(const source of ['yahoo','rakuma'])test(`${source}: retries retain existing spacing and cannot outlive the original deadline`,async t=>{
  const {read,advance}=await clockFixture(t,source),starts=[];
  const pending=assert.rejects(read(requestUrl(source),{deadlineAt:START+1100},{fetchImpl:async()=>{starts.push(Date.now());throw Error('temporary failure')}}),error=>error.code==='request_deferred');
  await flush();await advance(1000);await pending;await advance(60000);assert.deepEqual(starts,[START]);
});
test('Yahoo active and queued cancellation drains a held gate without shortening or admitting the server hold',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:START});
  const gate=createRequestCooldown(),a=new AbortController(),b=new AbortController();gate.deferUntil(Infinity);
  const first=assert.rejects(gate.turn({signal:a.signal}),error=>error.name==='AbortError');
  const second=assert.rejects(gate.turn({signal:b.signal}),error=>error.name==='AbortError');
  await flush();b.abort();await second;a.abort();await first;await flush();
  assert.equal(gate.stats().turns,0);assert.equal(gate.stats().nextRequestAt,Infinity);
  await assert.rejects(gate.turn({deadline:START+1000}),error=>error.reason==='request_cooldown_deadline');
});
test('Yahoo restored indefinite requestAccess holds and cancellation stay enforced by the actual collector',async t=>{
  const {module,read}=await clockFixture(t,'yahoo');let requests=0;
  await module.initializeYahooRequestAccess({initial:{reason:'http_429',retryAt:'indefinite'}});
  const dependencies={fetchImpl:async()=>{requests++;return response(yahooDetail())}};
  await assert.rejects(read(requestUrl('yahoo'),{deadlineAt:START+1000},dependencies),error=>error.code==='request_deferred'&&error.httpStatus===429&&error.retryAt==='indefinite');
  const controller=new AbortController(),pending=assert.rejects(read(requestUrl('yahoo'),{signal:controller.signal},dependencies),error=>error.name==='AbortError');
  await flush();controller.abort();await pending;assert.equal(requests,0);assert.equal(module.yahooRequestStats().nextRequestAt,Infinity);
});
test('Yahoo persisted longer holds discovered during checkpoint also extend the collector gate',async t=>{
  const {module,read}=await clockFixture(t,'yahoo'),root=await fs.mkdtemp(path.join(os.tmpdir(),'collector-hold-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));const password='fixture-only-password';
  await module.initializeYahooRequestAccess({root,password});await fs.mkdir(path.join(root,'state'),{recursive:true});
  const filename=path.join(root,'state/yahoo-request-access.json.enc'),persisted={reason:'http_429',retryAt:START+3600000};
  await fs.writeFile(filename,encrypt(Buffer.from(JSON.stringify(persisted)),password));let requests=0;
  const dependencies={fetchImpl:async()=>{requests++;return response('',{status:429,headers:{'retry-after':'60'}})}};
  await assert.rejects(read(requestUrl('yahoo'),{deadlineAt:START+100000},dependencies),error=>error.code==='request_deferred'&&error.httpStatus===429&&error.retryAt===persisted.retryAt);
  assert.equal(module.yahooRequestStats().nextRequestAt,persisted.retryAt);
  assert.deepEqual(JSON.parse(decrypt(await fs.readFile(filename),password)),persisted);
  const restored=await fresh('yahoo');await restored.initializeYahooRequestAccess({root,password});
  await assert.rejects(restored.fetchYahooPage(requestUrl('yahoo'),{deadlineAt:START+100000},dependencies),error=>error.httpStatus===429&&error.retryAfter==='3600');
  assert.equal(requests,1);
});
for(const source of ['yahoo','rakuma'])for(const status of [401,403,429])test(`${source}: actual access errors preserve HTTP ${status} and Retry-After`,async t=>{
  const {read}=await clockFixture(t,source);
  await assert.rejects(read(requestUrl(source),{attempts:1},{fetchImpl:async()=>response('',{status,headers:{'retry-after':'180'}})}),error=>error.httpStatus===status&&error.retryAfter==='180');
});
for(const source of ['yahoo','rakuma'])test(`${source}: full profile pagination uses the earliest body time, never completion time`,async t=>{
  const {module,advance}=await clockFixture(t,source);let requests=0;const profile=source==='yahoo'?'https://paypayfleamarket.yahoo.co.jp/user/p123':'https://fril.jp/shop/testshop';
  const pages=source==='yahoo'?[yahooHtml(Array.from({length:100},(_,i)=>({id:'item'+i,itemStatus:'OPEN',sellerId:'p123'})),101),yahooHtml([{id:'last',itemStatus:'SOLD',sellerId:'p123'}],101)]:
    [pad('<div class="item-list">'+rakumaCard('aa')+'<link rel="next" href="/shop/testshop/page/2"></div>'),pad('<div class="item-list">'+rakumaCard('bb')+rakumaCard('cc',true)+'</div>')];
  const dependencies={fetchImpl:async url=>{const index=requests++;return response(pages[index],{url,body:async()=>{t.mock.timers.setTime(Date.now()+10);return pages[index]}})}};
  const pending=source==='yahoo'?module.discoverYahooProfile(null,profile,{},dependencies):module.discoverRakumaProfile(profile,{},dependencies);
  await flush();await advance(source==='yahoo'?5500:1200);const result=await pending;
  assert.equal(result.pages,2);assert.equal(result.complete,true);assert.equal(requests,2);assert.equal(result.observedAt,START+10);assert.equal(result.fromCache,false);
  assert.equal(result.items.length,source==='yahoo'?100:2);if(source==='yahoo')assert.equal(result.listedItems.length,101);
  assert.ok(Date.now()>result.observedAt);
});
for(const source of ['yahoo','rakuma'])test(`${source}: legacy injected profile results without observations do not acquire freshness`,async()=>{
  const module=await fresh(source),result=source==='yahoo'?await module.discoverYahooProfile(null,'https://paypayfleamarket.yahoo.co.jp/user/p123',{}, {fetchYahooResult:async()=>({items:[],totalResultsAvailable:0})}):
    await module.discoverRakumaProfile('https://fril.jp/shop/testshop',{}, {fetchHtml:async()=>'<div class="item-list">商品はありません</div>'});
  assert.equal(result.complete,true);assert.equal(Object.hasOwn(result,'observedAt'),false);assert.equal(Object.hasOwn(result,'fromCache'),false);
});
for(const source of ['yahoo','rakuma'])test(`${source}: one unproven page prevents whole-inventory freshness and any page failure rejects the inventory`,async()=>{
  const module=await fresh(source),profile=source==='yahoo'?'https://paypayfleamarket.yahoo.co.jp/user/p123':'https://fril.jp/shop/testshop';
  const first=source==='yahoo'?yahooHtml(Array.from({length:100},(_,i)=>({id:'item'+i,itemStatus:'OPEN'})),101):pad('<div class="item-list">'+rakumaCard('aa')+'<link rel="next" href="/shop/testshop/page/2"></div>');
  const second=source==='yahoo'?yahooHtml([{id:'last',itemStatus:'OPEN'}],101):pad('<div class="item-list">'+rakumaCard('bb')+'</div>');
  const discover=dependencies=>source==='yahoo'?module.discoverYahooProfile(null,profile,{},dependencies):module.discoverRakumaProfile(profile,{},dependencies);
  let requests=0;const result=await discover({fetchPage:async()=>++requests===1?{html:first,observedAt:START,fromCache:false}:{html:second}});
  assert.equal(result.pages,2);assert.equal(result.complete,true);assert.equal(Object.hasOwn(result,'observedAt'),false);assert.equal(Object.hasOwn(result,'fromCache'),false);
  requests=0;await assert.rejects(discover({fetchPage:async()=>{if(++requests===2)throw Error('page failed');return {html:first,observedAt:START,fromCache:false}}}),/page failed/);
});
for(const source of ['yahoo','rakuma'])test(`${source}: denial headers at the deadline still establish the source hold`,async t=>{
  const {module,read}=await clockFixture(t,source);let requests=0;
  const dependencies={fetchImpl:async()=>{requests++;t.mock.timers.setTime(START+50);return response('',{status:429,headers:{'retry-after':'180'}})}};
  await assert.rejects(read(requestUrl(source),{deadlineAt:START+50},dependencies));
  await flush();await assert.rejects(read(requestUrl(source),{deadlineAt:START+1000},dependencies),error=>error.httpStatus===429);
  assert.equal(requests,1);
  if(source==='yahoo')assert.equal(module.yahooRequestStats().nextRequestAt,START+180050);
  else assert.equal(module.rakumaAccessDiagnostic().httpStatus,429);
});
for(const source of ['yahoo','rakuma'])test(`${source}: a late denial from a noncooperative aborted transport cannot remove future holds`,async t=>{
  const {module,read,advance}=await clockFixture(t,source),headers=deferred();let requests=0;
  const dependencies={fetchImpl:async()=>{requests++;return headers.promise}};
  const pending=assert.rejects(read(requestUrl(source),{deadlineAt:START+50},dependencies),error=>error.code==='request_deferred');
  await flush();await advance(50);await pending;
  headers.resolve(response('',{status:429,headers:{'retry-after':'180'}}));await flush();
  await assert.rejects(read(requestUrl(source),{deadlineAt:START+1000},dependencies),error=>error.httpStatus===429);
  assert.equal(requests,1);
  if(source==='yahoo')assert.equal(module.yahooRequestStats().nextRequestAt,START+180050);
  else assert.equal(module.rakumaAccessDiagnostic().httpStatus,429);
});
for(const status of [401,403])test(`Yahoo HTTP ${status} retains denial metadata when its retry cannot fit the budget`,async t=>{
  const {read}=await clockFixture(t,'yahoo');
  await assert.rejects(read(requestUrl('yahoo'),{deadlineAt:START+50},{fetchImpl:async()=>response('',{status,headers:{'retry-after':'180'}})}),error=>error.httpStatus===status&&error.retryAfter==='180');
});
for(const source of ['yahoo','rakuma'])test(`${source}: real collector search pages retain observations through parsing`,async t=>{
  const {module,read}=await clockFixture(t,source),url=source==='yahoo'?'https://paypayfleamarket.yahoo.co.jp/search/fixture?open=1':'https://fril.jp/s?query=fixture&transaction=selling&sort=sell_price&order=asc';
  const page=await read(url,{deadlineAt:START+1000},{fetchImpl:async()=>response(source==='yahoo'?yahooHtml():pad('商品が見つかりません'),{url})});
  const items=source==='yahoo'?module.extractNextData(page.html).props.initialState.searchState.search.result.items:module.extractRakumaSearchCards(page.html);
  assert.equal(page.observedAt,START);assert.equal(page.fromCache,false);assert.deepEqual(items,[]);
});
for(const source of ['yahoo','rakuma'])test(`${source}: a body timeout aborts its attempt before a permitted retry`,async t=>{
  const {read,advance}=await clockFixture(t,source),signals=[],starts=[],timeout=source==='yahoo'?15000:20000;
  const pending=read(requestUrl(source),{deadlineAt:START+30000},{fetchImpl:async(_url,{signal})=>{
    signals.push(signal);starts.push(Date.now());return response(bodyFor(source),signals.length===1?{body:()=>new Promise(()=>{})}:{});
  }});
  await flush();await advance(timeout);assert.equal(signals[0].aborted,true);assert.equal(starts.length,1);
  await advance(source==='yahoo'?1000:900);const page=await pending;assert.equal(starts.length,2);assert.equal(page.observedAt,starts[1]);
  assert.equal(page.fromCache,false);assert.equal(signals[1].aborted,true);
});
