import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnSourceLoader } from '../scripts/lib/own-source.mjs';
test('identical public query requests coalesce across workers without sharing mutations or inventing observation times',async()=>{
 let calls=0,clock=1000;
 const loader=createOwnSourceLoader({now:()=>clock,fetchYahooResult:async()=>{calls++;await Promise.resolve();return {items:[{id:'external',price:100}]}}});
 const [a,b]=await Promise.all([loader.yahooResult('same-query'),loader.yahooResult('same-query')]);
 assert.equal(calls,1);a.items[0].price=1;assert.equal(b.items[0].price,100);
 clock=9000;const reused=await loader.yahooResult('same-query');assert.equal(reused.observedAt,new Date(1000).toISOString());
 await loader.yahooResult('different-query');assert.equal(calls,2);assert.deepEqual(loader.stats,{yahooResultRequests:2,yahooResultReuses:2,rakumaPageRequests:0,rakumaPageReuses:0,rakumaReadWallMs:0});
});
test('failed public queries can retry but never become a successful cached observation',async()=>{
 let calls=0;const loader=createOwnSourceLoader({fetchYahooResult:async()=>{if(++calls===1)throw Error('HTTP 429');return {items:[]}}});
 await assert.rejects(loader.yahooResult('query'),/429/);const result=await loader.yahooResult('query');
 assert.equal(calls,2);assert.ok(result.observedAt);assert.deepEqual(result.items,[]);
});
test('independent workers get descriptions even when Yahoo comparison is deferred; concurrent reads share one request',async()=>{
 let calls=0;const loader=createOwnSourceLoader({fetchYahooBundle:async()=>{calls++;await Promise.resolve();return {detail:{description:'新品 1個',images:[{url:'image'}]},recommendations:[]}}});
 const item={id:'z1',platform:'yahoo',title:'title',ownPrice:1000};
 const [a,b,c]=await Promise.all([loader.hydrate({...item}),loader.hydrate({...item}),loader.yahooBundle('z1')]);
 assert.equal(calls,1);assert.equal(a.yahoo.ownDescription,'新品 1個');assert.equal(b.yahoo.ownImages[0],'image');assert.equal(c.detail.description,a.sourceDetail.description);
});
test('changed listing, price or stale own description is reread; manual cost stays untouched',async()=>{
 const now=Date.now(),base={id:'z1',platform:'yahoo',title:'title',ownPrice:1000,purchaseCNY:50};
 for(const change of [{}, {ownPrice:900}, {title:'different'}, {id:'z2'}]){
  let calls=0;const loader=createOwnSourceLoader({now:()=>now,fetchYahooBundle:async()=>{calls++;return {detail:{description:'fresh'}}}});
  const prior={...base,sourceDetail:{listingId:'z1',description:'old',checkedAt:new Date(now-1000).toISOString()}};
  const result=await loader.hydrate({...base,...change},prior);
  assert.equal(calls,Object.keys(change).length?1:0);assert.equal(result.purchaseCNY,50);
 }
 let calls=0;const loader=createOwnSourceLoader({now:()=>now,fetchYahooBundle:async()=>{calls++;return {detail:{description:'fresh'}}}});
 await loader.hydrate(base,{...base,sourceDetail:{listingId:'z1',description:'old',checkedAt:new Date(now-7*3600000).toISOString()}});assert.equal(calls,1);
});
test('missing own description and sold own listings are not silently treated as comparable',async()=>{
 for(const detail of [{description:''},{description:'full',status:'SOLD'}]){
  const loader=createOwnSourceLoader({fetchYahooBundle:async()=>({detail})});await assert.rejects(loader.hydrate({id:'z1',platform:'yahoo'}));
 }
});

test('unchanged profile thumbnail reuses details; changed or cleared thumbnail rereads the original image',async()=>{
 const now=Date.now(),prior={id:'z1',platform:'yahoo',title:'title',ownPrice:1000,image:'https://fixture.test/profile-old.jpg',
  sourceDetail:{listingId:'z1',title:'title',description:'old detail',images:[{url:'https://fixture.test/original-old.jpg'}],checkedAt:new Date(now-1000).toISOString()}};
 for(const [image,expectedReads] of [[prior.image,0],['https://fixture.test/profile-new.jpg',1],['',1]]){
  let calls=0;
  const loader=createOwnSourceLoader({now:()=>now,fetchYahooBundle:async()=>{calls++;return {detail:{id:'z1',status:'OPEN',title:'title',description:'new detail',images:[{url:'https://fixture.test/original-new.jpg'}]}}}});
  const current={id:prior.id,platform:prior.platform,title:prior.title,ownPrice:prior.ownPrice,image};
  const hydrated=await loader.hydrate(current,prior);
  assert.equal(calls,expectedReads,image);assert.equal(current.image,image);assert.equal(hydrated.image,image);
  assert.equal(hydrated.yahoo.ownImages[0],expectedReads?'https://fixture.test/original-new.jpg':'https://fixture.test/original-old.jpg');
  assert.equal(hydrated.sourceDetail.description,expectedReads?'new detail':'old detail');
 }
});

test('Rakuma raw HTML coalesces across workers without sliding the source observation or sharing mutations',async()=>{
 let calls=0,clock=1000;
 const loader=createOwnSourceLoader({now:()=>clock,fetchRakumaHtml:async url=>{calls++;await Promise.resolve();return `<html>${url}</html>`}});
 const [a,b]=await Promise.all([loader.rakumaPage('https://fril.jp/s?query=blue'),loader.rakumaPage('https://fril.jp/s?query=blue')]);
 assert.equal(calls,1);a.html='mutated';assert.match(b.html,/query=blue/);
 clock=9000;const reused=await loader.rakumaPage('https://fril.jp/s?query=blue');
 assert.equal(reused.observedAt,new Date(1000).toISOString());assert.match(reused.html,/query=blue/);
 const different=await loader.rakumaPage('https://fril.jp/s?query=red');
 assert.equal(calls,2);assert.match(different.html,/query=red/);assert.equal(different.observedAt,new Date(9000).toISOString());
 assert.equal(loader.stats.rakumaPageRequests,2);assert.equal(loader.stats.rakumaPageReuses,2);assert.ok(loader.stats.rakumaReadWallMs>=0);
});

test('Rakuma shared failures are evicted and the bounded cache rereads evicted observations',async()=>{
 let calls=0,clock=1000;
 const loader=createOwnSourceLoader({now:()=>clock,fetchRakumaHtml:async()=>{if(++calls===1)throw Error('denied');return '<html>valid</html>'}});
 const failed=await Promise.allSettled([loader.rakumaPage('first'),loader.rakumaPage('first')]);
 assert.ok(failed.every(row=>row.status==='rejected'));assert.equal(calls,1);
 clock=2000;assert.equal((await loader.rakumaPage('first')).observedAt,new Date(2000).toISOString());
 for(let i=0;i<256;i++)await loader.rakumaPage('page-'+i);
 clock=3000;assert.equal((await loader.rakumaPage('first')).observedAt,new Date(3000).toISOString());
 assert.equal(calls,259);
});

test('Rakuma own-detail hydration retains the original shared HTML observation time',async()=>{
 const sourceObservedAt='2026-10-15T00:00:00.000Z';
 const loader=createOwnSourceLoader({now:()=>Date.parse('2026-10-16T00:00:00Z'),fetchRakumaItem:async()=>({description:'新品 1個',status:'OPEN',sourceObservedAt})});
 const result=await loader.hydrate({id:'aa',platform:'rakuma',title:'fixture'});
 assert.equal(result.sourceDetail.checkedAt,sourceObservedAt);
});
