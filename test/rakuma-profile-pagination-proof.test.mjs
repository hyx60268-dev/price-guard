import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {discoverRakumaProfile} from '../scripts/lib/rakuma.mjs';
import {discoverYahooProfile} from '../scripts/lib/yahoo.mjs';
import {encrypt,decrypt} from '../scripts/lib/crypto.mjs';

const profile='https://fril.jp/shop/test',stamp=Date.parse('2026-01-01T00:00:00Z');
const card=(id,sold=false)=>`<a class="link_shop_image" href="https://item.fril.jp/${id}" data-rat-item_name="fixture ${id}" data-rat-price="9000" data-rat-itemid="100/x">${sold?'SOLD OUT':''}</a>`;
const html=(id,nav='')=>`<div class="item-list">${card(id)}</div>${nav}`;
const page=(body,offset=0)=>({html:body,status:200,fromCache:false,observedAt:stamp+offset});
const yahooProfile='https://paypayfleamarket.yahoo.co.jp/user/p123';
const yahooHtml=(items=[],total=items.length)=>'<script id="__NEXT_DATA__">'+JSON.stringify({props:{initialState:{searchState:{search:{result:{items,totalResultsAvailable:total}}}}}})+'</script>';
const next=href=>`<link rel="next" href="${href}">`;
async function discover(pages){
  const requests=[];
  const pending=discoverRakumaProfile(profile,{}, {fetchPage:async url=>{requests.push(url);assert.ok(pages.has(url),'unexpected pagination request '+url);return pages.get(url)}});
  return {result:await pending,requests};
}

test('contiguous same-shop pages retain every active item and the original earliest observation',async()=>{
  const pages=new Map([
    [profile,page(html('aa',next('/shop/test/page/2')))],
    [profile+'/page/2',page(html('bb','<a rel="NEXT" href="3">次へ</a>'),100)],
    [profile+'/page/3',page(html('cc','<a href="/shop/test/page/2">2</a>')+card('dd',true),200)]
  ]);
  const {result,requests}=await discover(pages);
  assert.deepEqual(requests,[profile,profile+'/page/2',profile+'/page/3']);
  assert.deepEqual(result.items.map(item=>item.id),['aa','bb','cc']);
  assert.equal(result.pages,3);assert.equal(result.complete,true);assert.equal(result.fromCache,false);assert.equal(result.observedAt,stamp);
});

test('duplicate matching next references are one page, including tokenized rel values',async()=>{
  const {result,requests}=await discover(new Map([
    [profile,page(html('aa',next('/shop/test/page/2')+'<a rel="nofollow next" href="https://fril.jp/shop/test/page/2">次へ</a>'))],
    [profile+'/page/2',page(html('bb'),100)]
  ]));
  assert.equal(result.pages,2);assert.equal(requests.length,2);
});

for(const [label,navigation] of [
  ['skipped second page',next('/shop/test/page/3')],
  ['cross-shop continuation',next('/shop/other/page/2')],
  ['shop-prefix collision',next('/shop/test_other/page/2')],
  ['cross-origin continuation',next('https://example.invalid/shop/test/page/2')],
  ['insecure continuation',next('http://fril.jp/shop/test/page/2')],
  ['credential-bearing continuation',next('https://user:secret@fril.jp/shop/test/page/2')],
  ['unexpected port',next('https://fril.jp:444/shop/test/page/2')],
  ['unknown page name',next('/shop/test/page/unknown')],
  ['zero page number',next('/shop/test/page/0')],
  ['leading-zero page alias',next('/shop/test/page/02')],
  ['extra path suffix',next('/shop/test/page/2/more')],
  ['unverified trailing-slash alias',next('/shop/test/page/2/')],
  ['query pagination',next('/shop/test?page=2')],
  ['unexpected page query',next('/shop/test/page/2?sort=new')],
  ['fragment alias',next('/shop/test/page/2#items')],
  ['cycle to first page',next('/shop/test')],
  ['conflicting next links',next('/shop/test/page/2')+next('/shop/test/page/3')],
  ['missing next destination','<link rel="next">'],
  ['unreadable next destination','<link rel="next" href="https://[invalid">'],
  ['unquoted unknown markup','<link rel=next href=/shop/test/page/2>'],
  ['unverified next control','<a aria-label="Next page" href="/shop/test/page/2">2</a>'],
  ['unverified numbered forward link','<a href="/shop/test/page/2">2</a>'],
  ['unverified next button','<button class="next">次へ</button>'],
  ['spoofed data-href','<link rel="next" data-href="/shop/test/page/2">']
])test(`profile fails closed before fetching ${label}`,async()=>{
  let requests=0;
  await assert.rejects(discoverRakumaProfile(profile,{}, {fetchPage:async()=>{requests++;return page(html('aa',navigation))}}),error=>error.code==='RAKUMA_PROFILE_PAGINATION_UNPROVEN');
  assert.equal(requests,1);
});

for(const href of ['/shop/test/page/2','/shop/test/page/1','/shop/test/page/4'])test(`second-page self/backward/skipped next ${href} cannot produce an inventory`,async()=>{
  const requests=[];
  await assert.rejects(discoverRakumaProfile(profile,{}, {fetchPage:async url=>{
    requests.push(url);return page(html(url===profile?'aa':'bb',next(url===profile?'/shop/test/page/2':href)));
  }}),error=>error.code==='RAKUMA_PROFILE_PAGINATION_UNPROVEN');
  assert.deepEqual(requests,[profile,profile+'/page/2']);
});

test('actual collector HTTP body cannot turn a skipped page into a current complete profile',async t=>{
  const {discoverRakumaProfile:discoverActual}=await import('../scripts/lib/rakuma.mjs?pagination-proof='+crypto.randomUUID());
  const requests=[];
  t.mock.method(globalThis,'fetch',async url=>{
    requests.push(url);const response=new Response(html('aa',next('/shop/test/page/3'))+' '.repeat(10000));
    Object.defineProperty(response,'url',{value:url});return response;
  });
  await assert.rejects(discoverActual(profile,{deadlineAt:Date.now()+500}),error=>error.code==='RAKUMA_PROFILE_PAGINATION_UNPROVEN');
  assert.deepEqual(requests,[profile]);
});

for(const scenario of ['pagination_gap','rakuma_redirect','yahoo_redirect'])test(`existing scan preserves inventory and freshness after ${scenario}`,async t=>{
  const source=fileURLToPath(new URL('../',import.meta.url)),root=await fs.mkdtemp(path.join(os.tmpdir(),'rakuma-pagination-scan-'));
  const isYahoo=scenario==='yahoo_redirect',market=isYahoo?'yahoo':'rakuma',platform=isYahoo?'yahoo_fleamarket':'rakuma';
  const profileUrl=isYahoo?yahooProfile:profile,requestedUrl=isYahoo?profileUrl+'?page=1':profileUrl;
  const password='fixture-pagination-only-password',accountId=isYahoo?'account-p123':'account-rakuma-test',oldIds=isYahoo?['zSavedOne','zSavedTwo']:['a'.repeat(32),'b'.repeat(32)];
  const checkedAt='2026-01-01T00:00:00.000Z',requests=[];
  const previous={items:oldIds.map(id=>({id,accountId,platform,title:'saved fixture '+id,ownPrice:9000,url:(isYahoo?'https://paypayfleamarket.yahoo.co.jp/item/':'https://item.fril.jp/')+id,
    [market]:{status:'ok',checkedAt,candidates:[]}})),manualCosts:{keep:{accountId,itemId:oldIds[0],purchaseCNY:100}},
    matchCorrections:{tombstone:{accountId,itemId:oldIds[0],platform:market,candidateId:'old',deleted:true,updatedAt:checkedAt}}};
  const keys=['PRICE_SCAN_ENGINE','FULL_PRICE_AUDIT','FORCE_FULL_SCAN','PRICE_AUDIT_ITEM_IDS','DASHBOARD_PASSWORD','PORTAL_USERS_JSON',
    'XIANYU_AUTH_PART_1','XIANYU_AUTH_PART_2','XIANYU_AUTH_PART_3','XIANYU_STORAGE_STATE_GZIP_B64','XIANYU_STORAGE_STATE_B64'];
  const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  try{
    await fs.cp(path.join(source,'scripts'),path.join(root,'scripts'),{recursive:true});
    await fs.mkdir(path.join(root,'public'),{recursive:true});
    for(const name of ['native-supplier-quotes.js','match-memory.js','shop-profile.js','durable-state.js','build-version.js','pricing-policy.js','owned-offers.js','merchant-config.js','merchant-records.js','merchant-image-evidence.js'])await fs.copyFile(path.join(source,'public',name),path.join(root,'public',name));
    for(const name of ['state','config'])await fs.mkdir(path.join(root,name));
    await fs.writeFile(path.join(root,'package.json'),'{"type":"module"}');
    await fs.symlink(await fs.realpath(path.join(source,'node_modules')),path.join(root,'node_modules'));
    await fs.writeFile(path.join(root,'config/accounts.json'),JSON.stringify({accounts:[{id:accountId,name:'fixture',platform,profileUrl}]}));
    // The first profile fits; the next existing 1.2-second gate slot does not.
    await fs.writeFile(path.join(root,'config/settings.json'),JSON.stringify({comparisonMode:'same_platform',scanBudgetMinutes:0.015,exchangeRate:20,costMultiplier:1.05,profitWarningJPY:1500}));
    await fs.writeFile(path.join(root,'state/latest.json.enc'),encrypt(Buffer.from(JSON.stringify(previous)),password));
    for(const key of keys)process.env[key]='';process.env.DASHBOARD_PASSWORD=password;process.env.PRICE_SCAN_ENGINE='full_inventory_graph';
    t.mock.method(globalThis,'fetch',async url=>{
      requests.push(url);assert.equal(url,requestedUrl,'no alternate or skipped endpoint may be requested');
      const body=isYahoo?yahooHtml([{id:'zForeign',title:'foreign',price:9000,itemStatus:'OPEN',sellerId:'foreign'}]):html(oldIds[0],scenario==='pagination_gap'?next('/shop/test/page/3'):'');
      const result=new Response(body+' '.repeat(10000));
      Object.defineProperty(result,'url',{value:scenario==='pagination_gap'?url:isYahoo?'https://paypayfleamarket.yahoo.co.jp/user/another?page=1':'https://fril.jp/shop/another'});
      Object.defineProperty(result,'redirected',{value:scenario!=='pagination_gap'});return result;
    });
    await import(pathToFileURL(path.join(root,'scripts/scan.mjs')));
    const read=async filename=>JSON.parse(decrypt(await fs.readFile(path.join(root,filename)),password));
    for(const state of [await read('state/latest.json.enc'),await read('public/data/latest.json.enc')]){
      assert.deepEqual(state.items.map(item=>item.id).sort(),oldIds);
      assert.equal(state.accounts[0].profileStatus,'error');assert.match(state.accounts[0].profileError,/分页|响应来源/);
      assert.equal(state.accounts[0].inventoryObservation.complete,false);assert.equal(state.accounts[0].inventoryObservation.fromCache,true);
      assert.equal(state.accounts[0].inventoryObservation.observedAt,null);assert.equal(state.pricingCoverage.inventoryComplete,false);
      assert.deepEqual(state.manualCosts,previous.manualCosts);assert.deepEqual(state.matchCorrections,previous.matchCorrections);
    }
    assert.deepEqual(requests,[requestedUrl]);
  }finally{
    for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;
    await fs.rm(root,{recursive:true,force:true});
  }
});

function transportFixture(source){
  const requestedUrl=source==='yahoo'?yahooProfile+'?page=1':profile;
  const body=source==='yahoo'?yahooHtml([{id:'own',title:'fixture',price:9000,itemStatus:'OPEN',sellerId:'p123'}]):html('aa');
  const discover=dependencies=>source==='yahoo'?discoverYahooProfile(null,yahooProfile,{},dependencies):discoverRakumaProfile(profile,{},dependencies);
  const foreignUrl=source==='yahoo'?'https://paypayfleamarket.yahoo.co.jp/user/another?page=1':'https://fril.jp/shop/another';
  const code=source.toUpperCase()+'_PROFILE_RESPONSE_MISMATCH';
  return {requestedUrl,body,discover,foreignUrl,code};
}
for(const source of ['rakuma','yahoo'])for(const field of ['url','finalUrl','finalURL','responseUrl','responseURL','redirectedUrl','redirectedURL'])test(`${source} profile rejects cross-account ${field} before accepting inventory`,async()=>{
  const {body,discover,foreignUrl,code}=transportFixture(source);
  await assert.rejects(discover({fetchPage:async()=>({...page(body),[field]:foreignUrl})}),error=>error.code===code);
});
for(const source of ['rakuma','yahoo'])for(const value of ['',null,'not an absolute URL','https://example.invalid/profile'])test(`${source} profile rejects malformed or foreign final URL ${String(value)}`,async()=>{
  const {body,discover,code}=transportFixture(source);
  await assert.rejects(discover({fetchPage:async()=>({...page(body),finalUrl:value})}),error=>error.code===code);
});
for(const source of ['rakuma','yahoo'])test(`${source} profile rejects an explicit redirect even back to the original URL`,async()=>{
  const {requestedUrl,body,discover,code}=transportFixture(source);
  await assert.rejects(discover({fetchPage:async()=>({...page(body),url:requestedUrl,redirected:true})}),error=>error.code===code);
});
for(const source of ['rakuma','yahoo'])test(`${source} profile checks every exposed URL alias`,async()=>{
  const {requestedUrl,body,discover,foreignUrl,code}=transportFixture(source);
  await assert.rejects(discover({fetchPage:async()=>({...page(body),url:requestedUrl,finalUrl:foreignUrl})}),error=>error.code===code);
});
for(const source of ['rakuma','yahoo'])test(`${source} profile accepts exact current-page routing without changing source observation`,async()=>{
  const {requestedUrl,body,discover}=transportFixture(source);
  const result=await discover({fetchPage:async()=>({...page(body),url:requestedUrl,finalUrl:requestedUrl,redirected:false})});
  assert.equal(result.items.length,1);assert.equal(result.complete,true);assert.equal(result.observedAt,stamp);assert.equal(result.fromCache,false);
});
for(const source of ['rakuma','yahoo'])test(`${source} page-two response cannot silently replay page one`,async()=>{
  const {requestedUrl,discover,code}=transportFixture(source);let requests=0;
  const first=source==='yahoo'?yahooHtml(Array.from({length:100},(_,i)=>({id:'own'+i,title:'fixture',price:9000,itemStatus:'OPEN',sellerId:'p123'})),101):html('aa',next('/shop/test/page/2'));
  const second=source==='yahoo'?yahooHtml([{id:'last',title:'fixture',price:9000,itemStatus:'OPEN',sellerId:'p123'}],101):html('bb');
  await assert.rejects(discover({fetchPage:async()=>({...page(++requests===1?first:second),url:requestedUrl})}),error=>error.code===code);
  assert.equal(requests,2);
});
for(const source of ['rakuma','yahoo'])for(const scenario of ['foreign_final','foreign_redirect','same_url_redirect'])test(`${source} actual collector rejects ${scenario} profile transport`,async t=>{
  const {requestedUrl,body,foreignUrl,code}=transportFixture(source),module=await import(`../scripts/lib/${source}.mjs?profile-transport=${crypto.randomUUID()}`),requests=[];
  t.mock.method(globalThis,'fetch',async url=>{
    requests.push(url);const response=new Response(body+' '.repeat(10000));
    Object.defineProperty(response,'url',{value:scenario==='same_url_redirect'?requestedUrl:foreignUrl});
    Object.defineProperty(response,'redirected',{value:scenario!=='foreign_final'});return response;
  });
  const settings={deadlineAt:Date.now()+1000};
  await assert.rejects(source==='yahoo'?module.discoverYahooProfile(null,yahooProfile,settings):module.discoverRakumaProfile(profile,settings),error=>error.code===code);
  assert.deepEqual(requests,[requestedUrl]);
});
test('legacy Yahoo result injection cannot override a contradictory explicit source URL',async()=>{
  await assert.rejects(discoverYahooProfile(null,yahooProfile,{}, {fetchYahooResult:async()=>({items:[],totalResultsAvailable:0,url:'https://paypayfleamarket.yahoo.co.jp/user/foreign?page=1'})}),error=>error.code==='YAHOO_PROFILE_RESPONSE_MISMATCH');
});
