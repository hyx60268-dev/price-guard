import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnSourceLoader } from '../scripts/lib/own-source.mjs';
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
