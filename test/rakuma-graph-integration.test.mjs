import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {planFullCycle,runFullCycle} from '../scripts/lib/full-cycle-graph.mjs';
import {createRakumaGraphAdapter,rakumaGraphSearchSpec} from '../scripts/lib/rakuma-graph-adapter.mjs';
import {configureImageFingerprintCache,imageFingerprints} from '../scripts/lib/image.mjs';
import {fixtureTitle,ownId,candidateId,otherId,itemUrl,imageUrl,searchHtml,detailHtml,targetFixture,
  fixtureOwnedOffers} from './fixtures/rakuma-graph-observed-layout.mjs';
// Synthetic observed-layout HTML + real image pipeline through the scheduler.
// This is neither a captured live payload nor a marketplace capacity claim.
const at=Date.parse('2026-10-15T00:00:00.000Z');
const clock={now:()=>at,sleep:(ms,signal)=>new Promise((resolve,reject)=>{
  const timer=setTimeout(resolve,ms);signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('aborted'))},{once:true});
})};
let originalFetch,imageReads=0;
test.before(async()=>{
  const image=await sharp(Buffer.from('<svg width="96" height="96"><rect width="96" height="96" fill="white"/><path d="M8 6L65 11L84 84L24 74Z" fill="#367bd4"/><circle cx="41" cy="38" r="12" fill="#e6a223"/></svg>')).png().toBuffer();
  originalFetch=globalThis.fetch;globalThis.fetch=async url=>{
    assert.match(String(url),/^https:\/\/img\.fril\.jp\/img\/\d+\/l\/product\.png$/);imageReads++;
    return new Response(image,{headers:{'content-type':'image/png','cache-control':'public,max-age=3600'}});
  };configureImageFingerprintCache({now:()=>at});
});
test.after(()=>{globalThis.fetch=originalFetch;configureImageFingerprintCache()});
async function run({targets=[targetFixture()],search=searchHtml(),detail=detailHtml(),own=detailHtml({sellerId:'100',image:imageUrl(1)}),settings={},readPage,query}={}){
  const cycleId='rakuma-graph-fixture',reads=[];
  const planned=targets.map(target=>({...target,pricing:{rakuma:{...rakumaGraphSearchSpec(target.title),...(query?{query}:{})}}}));
  const accounts=[...new Set(targets.map(target=>target.accountId))].map(id=>({id,expectedCount:targets.filter(target=>target.accountId===id).length,status:'live',cycleId,observedAt:at,paginationComplete:true}));
  const graph=planFullCycle({cycleId,startedAt:at,accounts,targets:planned});
  const adapter=createRakumaGraphAdapter({now:()=>at,imageFingerprints,settings:{ownedOffers:fixtureOwnedOffers(),...settings},
    fetchPage:async url=>{reads.push(url);if(readPage)return readPage(url);
      return {html:url.startsWith('https://fril.jp/s?')?search:url===itemUrl(ownId)?own:detail,observedAt:at,fromCache:false,httpStatus:200};}});
  const report=await runFullCycle(graph,{...adapter,clock,maxConcurrency:4,sourceLimits:{rakuma:{maxConcurrent:2,minIntervalMs:0}},
    assessInventoryCoverage:()=>({complete:true,scope:'all_configured_accounts',cycleId,proofRef:'fixture-declared-accounts',accounts:accounts.map(({id,expectedCount})=>({id,expectedCount}))})});
  return {graph,report,reads};
}
const scopeOf=graph=>[...graph.nodes.values()].find(node=>node.kind==='scope');

test('shared current own/search/detail reads preserve per-account correction and acceptance',async()=>{
  const correction={accountId:'a',itemId:ownId,platform:'rakuma',candidateId,deleted:false,updatedAt:new Date(at).toISOString()};
  const {graph,report,reads}=await run({targets:[targetFixture({accountId:'a'}),targetFixture({accountId:'b'})],settings:{matchCorrections:{one:correction}},
    search:searchHtml({cards:[{},{id:otherId,title:fixtureTitle.replace('ブルー','ブラウン')}]})});
  assert.equal(report.priceComplete,2);assert.equal(report.ownIdentityVerified,2);
  assert.equal(report.complete,false);assert.equal(report.costVerified,0); // No procurement adapter configured.
  assert.equal(report.productionAccepted,false);assert.equal(report.marketWideCoverageProven,false);
  assert.equal(reads.length,3);assert.equal(reads.filter(url=>url===itemUrl(candidateId)).length,1);assert.ok(!reads.includes(itemUrl(otherId)));
  const scopes=[...graph.nodes.values()].filter(node=>node.kind==='scope');
  assert.equal(scopes.find(node=>node.targetKey.startsWith('a:')).result.quotes.length,0);
  const quote=scopes.find(node=>node.targetKey.startsWith('b:')).result.quotes[0];
  assert.equal(quote.price,7800);assert.equal(quote.observedAt,at);assert.equal(quote.targetKey,'b:'+ownId);
});
test('proven cheap exclusions avoid candidate detail and image work',async()=>{
  const before=imageReads,{report,reads}=await run({search:searchHtml({cards:[{title:fixtureTitle.replace('ブルー','ブラウン')},{id:otherId,sellerId:'100'}]})});
  assert.equal(report.priceComplete,1);assert.equal(reads.length,2);assert.equal(imageReads,before);
});
test('source denial during pagination prevents complete price coverage',async()=>{
  const query=rakumaGraphSearchSpec(fixtureTitle).query.url,next=new URL(query);next.searchParams.set('page','2');
  const {report,reads}=await run({readPage:async url=>{
    if(url===next.href)throw Object.assign(new Error('fixture denial'),{code:'RAKUMA_SOURCE_ACCESS_DENIED'});
    return {html:url.startsWith('https://fril.jp/s?')?searchHtml({nextUrl:next.href}):detailHtml({sellerId:url===itemUrl(ownId)?'100':'200'}),observedAt:at,fromCache:false,httpStatus:200};
  }});
  assert.equal(report.priceComplete,0);assert.equal(report.execution.sources.rakuma.closed,'source_denied');assert.equal(reads.filter(url=>url===next.href).length,1);
});
test('missing current own description blocks candidate detail admission despite stale fallback fields',async()=>{
  const {report,reads}=await run({own:detailHtml({description:'',sellerId:'100'}),targets:[targetFixture({description:'cached',sourceDetail:{description:'cached'}})]});
  assert.equal(report.ownIdentityVerified,0);assert.equal(report.priceComplete,0);assert.ok(!reads.includes(itemUrl(candidateId)));
});
test('unknown currency stays incomplete; a confirmed sold offer is a completed rejection',async()=>{
  assert.equal((await run({detail:detailHtml({currency:''})})).report.priceComplete,0);
  const sold=await run({detail:detailHtml({availability:'OutOfStock'})});assert.equal(sold.report.priceComplete,1);assert.equal(scopeOf(sold.graph).result.quotes.length,0);
});
test('abbreviated weak-anchor card reaches exact accepted full detail',async()=>{
  const {graph,report,reads}=await run({search:searchHtml({cards:[{title:'ブルー 370ml'}]})});
  assert.ok(reads.includes(itemUrl(candidateId)));assert.equal(report.priceComplete,1);assert.equal(scopeOf(graph).result.quotes[0].price,7800);
});
for(const [label,transport,denied] of [
  ['HTTP500',{httpStatus:500},false],['status403',{status:403},true],['HTTP302',{httpStatus:302},false],
  ['wrong final URL',{httpStatus:200,finalURL:itemUrl(otherId)},false],['challenge',{httpStatus:200,challenge:true},true],['missing status',{httpStatus:undefined},false]
])test(`scheduler rejects valid-looking HTML from ${label}`,async()=>{
  const {graph,report,reads}=await run({readPage:async url=>{
    const candidate=url===itemUrl(candidateId);return {html:url.startsWith('https://fril.jp/s?')?searchHtml():detailHtml({sellerId:candidate?'200':'100'})+
      (candidate&&transport.challenge?'<div>captcha</div>':''),observedAt:at,fromCache:false,httpStatus:200,...(candidate?transport:{})};
  }});
  assert.equal(report.priceComplete,0);assert.equal(reads.filter(url=>url===itemUrl(candidateId)).length,1);assert.equal(scopeOf(graph).result.quotes.length,0);
  if(denied)assert.equal(report.execution.sources.rakuma.closed,'source_denied');
});
test('page-one to page-three cannot skip page two and certify complete coverage',async()=>{
  const query=rakumaGraphSearchSpec(fixtureTitle).query.url,page3=new URL(query);page3.searchParams.set('page','3');
  const {report,reads}=await run({readPage:async url=>({html:url===query?searchHtml({nextUrl:page3.href}):url===page3.href?searchHtml({cards:[]}):detailHtml({sellerId:url===itemUrl(ownId)?'100':'200'}),observedAt:at,fromCache:false,httpStatus:200})});
  assert.equal(report.priceComplete,0);assert.ok(!reads.includes(page3.href));
});
test('starting discovery at page two cannot certify the original query',async()=>{
  const page2=new URL(rakumaGraphSearchSpec(fixtureTitle).query.url);page2.searchParams.set('page','2');
  assert.equal((await run({query:{url:page2.href},search:searchHtml({cards:[]})})).report.priceComplete,0);
});
test('contiguous page-one/page-two observations retain valid quote and complete query scope',async()=>{
  const query=rakumaGraphSearchSpec(fixtureTitle).query.url,page2=new URL(query);page2.searchParams.set('page','2');
  const {graph,report,reads}=await run({readPage:async url=>({html:url===query?searchHtml({nextUrl:page2.href}):url===page2.href?searchHtml({cards:[]}):detailHtml({sellerId:url===itemUrl(ownId)?'100':'200'}),observedAt:at,fromCache:false,httpStatus:200})});
  assert.equal(report.priceComplete,1);assert.ok(reads.includes(page2.href));assert.equal(scopeOf(graph).result.quotes[0].price,7800);
});
