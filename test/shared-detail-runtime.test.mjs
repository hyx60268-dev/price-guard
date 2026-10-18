import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {pipeline,T} from './fixtures/shared-detail-pipeline.mjs';
import {createSharedYahooDetailRuntime} from '../scripts/lib/yahoo-shared-detail-runtime.mjs';
import {peekImageFingerprints,peekKnownImageObservation} from '../scripts/lib/image.mjs';
const setup=(p,extra={})=>createSharedYahooDetailRuntime({startedAt:T,deadlineAt:T+12*60_000,accounts:p.accounts,contexts:p.contexts,
 snapshot:p.observer.snapshot,peekBundle:p.loader.peekYahooBundle,peekFingerprint:peekImageFingerprints,peekFingerprintState:peekKnownImageObservation,now:p.input.now,...extra});
test('normal completed sources are consumed once per exact target/body pair, with original clocks and unchanged source trajectory',async t=>{
 const p=await pipeline(t),before=p.counts(),original=structuredClone(p.item),runtime=setup(p,{minPassGapMs:0});
 await runtime.consume(p.settings);assert.equal(runtime.offersFor(p.item).length,1);assert.equal(runtime.statistics().verifiedPairs,1);
 for(let i=0;i<5;i++)await runtime.consume(p.settings);
 assert.equal(runtime.statistics().passes,3);assert.equal(runtime.statistics().attemptedPairs,1);assert.equal(runtime.offersFor(p.item)[0].checkedAt,new Date(T+7000).toISOString());
 assert.deepEqual(p.counts(),before);assert.deepEqual(p.item,original);
 const copy=runtime.offersFor(p.item);copy[0].price=1;assert.equal(runtime.offersFor(p.item)[0].price,8000);
});
test('runtime missing current complete ownership, deadline, missing original, and observer failure never initiate requests or alter prior quotes',async t=>{
 const p=await pipeline(t),before=p.counts(),original=structuredClone(p.item);
 for(const extra of [{deadlineAt:T+1},{peekBundle:()=>null},{snapshot:()=>{throw Error('private-error-must-not-log')}},
  {contexts:p.contexts.map(context=>({...context,profileStatus:'cached'}))}]){
  const runtime=setup(p,extra);await runtime.consume(p.settings);assert.deepEqual(runtime.offersFor(p.item),[]);assert.equal(runtime.statistics().htmlRequests,0);assert.equal(runtime.statistics().imageRequests,0);
  assert.equal(JSON.stringify(runtime.statistics()).includes('private-error'),false);
 }
 assert.deepEqual(p.counts(),before);assert.deepEqual(p.item,original);
});
test('runtime bounds total local work and concurrent invocations, retaining no partial verification after budget expiry',async t=>{
 const p=await pipeline(t),before=p.counts();let ticks=0;
 const runtime=setup(p,{clock:()=>++ticks*600,minPassGapMs:0});await Promise.all([runtime.consume(p.settings),runtime.consume(p.settings)]);
 assert.equal(runtime.statistics().passes,1);assert.deepEqual(runtime.offersFor(p.item),[]);assert.deepEqual(p.counts(),before);
});

test('one already-read competitor body can be strictly verified for another account without its own search or new candidate/image requests',async t=>{
 const p=await pipeline(t,{secondTarget:true}),before=p.counts(),old=structuredClone(p.second),runtime=setup(p);
 // The second own body is an existing hydration read, never a comparison/search.
 assert.deepEqual(before,{htmlReads:3,imageReads:3});
 await runtime.consume(p.settings);
 assert.equal(runtime.offersFor(p.item).length,1);assert.equal(runtime.offersFor(p.second).length,1);
 assert.equal(runtime.offersFor(p.second)[0].target.accountId,'boss');assert.equal(runtime.offersFor(p.second)[0].id,'external-offer');
 assert.equal(runtime.offersFor(p.second)[0].checkedAt,new Date(T+7000).toISOString());
 assert.equal(runtime.offersFor(p.second)[0].ownObservedAt,new Date(T+13000).toISOString());
 assert.deepEqual(p.counts(),before);assert.deepEqual(p.second,old);assert.equal(runtime.statistics().verifiedTargets,2);
});

for(const change of ['SOLD','price','missing'])test(`newer original ${change} withdraws the previous locally verified quote instead of falling back`,async t=>{
 const p=await pipeline(t);let changed=false;
 const peek=id=>{const row=p.loader.peekYahooBundle(id);if(!changed||id!==p.candidate.id)return row;if(change==='missing')return null;
  if(change==='SOLD')row.detail.status='SOLD';else row.detail.price=8100;
  row.observedAt+=1;row.originalObservation.observedAt+=1;row.originalObservation.parsedSha256=createHash('sha256').update(JSON.stringify({detail:row.detail,shipping:row.shipping})).digest('hex');return row;};
 const runtime=setup(p,{peekBundle:peek,minPassGapMs:0});await runtime.consume(p.settings);assert.equal(runtime.offersFor(p.item)[0].price,8000);
 changed=true;await runtime.consume(p.settings);
 if(change==='price'){assert.equal(runtime.offersFor(p.item)[0].price,8100);assert.equal(runtime.offersFor(p.item)[0].checkedAt,new Date(T+7001).toISOString());}
 else assert.deepEqual(runtime.offersFor(p.item),[]);
});

test('known fingerprint invalidation and a new permanent correction remove prior shared evidence with no downloads',async t=>{
 const p=await pipeline(t);let missing=false;
 const runtime=setup(p,{minPassGapMs:0,peekFingerprint:(...args)=>missing?null:peekImageFingerprints(...args)});
 await runtime.consume(p.settings);assert.equal(runtime.offersFor(p.item).length,1);
 missing=true;await runtime.consume(p.settings);assert.deepEqual(runtime.offersFor(p.item),[]);
 const second=setup(p,{minPassGapMs:0});await second.consume(p.settings);assert.equal(second.offersFor(p.item).length,1);
 await second.consume({...p.settings,matchCorrections:{reject:{accountId:p.item.accountId,itemId:p.item.id,platform:'yahoo',candidateId:p.candidate.id,deleted:false}}});
 assert.deepEqual(second.offersFor(p.item),[]);assert.deepEqual(p.counts(),{htmlReads:2,imageReads:2});
});

test('a stalled local fingerprint peek cannot consume a second full wait or commit late results',async t=>{
 const p=await pipeline(t);let reads=0;const begin=performance.now();
 const runtime=setup(p,{maxDurationMs:40,peekFingerprint:()=>{reads++;return new Promise(resolve=>setTimeout(()=>resolve(null),150));}});
 await runtime.consume(p.settings);const elapsed=performance.now()-begin;
 assert.ok(elapsed<120,`bounded local wait ${elapsed}ms`);assert.equal(reads,1);assert.deepEqual(runtime.offersFor(p.item),[]);
 await new Promise(resolve=>setTimeout(resolve,160));assert.deepEqual(runtime.offersFor(p.item),[]);assert.deepEqual(p.counts(),{htmlReads:2,imageReads:2});
});

test('quota/gap exhaustion and final output access cannot preserve a quote after known newer SOLD evidence',async t=>{
 const p=await pipeline(t);let changed=false;
 const peek=id=>{const row=p.loader.peekYahooBundle(id);if(!changed||id!==p.candidate.id)return row;row.detail.status='SOLD';row.originalObservation.parsedSha256='0'.repeat(64);return row;};
 const runtime=setup(p,{peekBundle:peek,minPassGapMs:0});for(let i=0;i<3;i++)await runtime.consume(p.settings);
 assert.equal(runtime.statistics().passes,3);assert.equal(runtime.offersFor(p.item).length,1);
 changed=true;assert.deepEqual(runtime.offersFor(p.item),[],'final read itself revokes known changed source');await runtime.consume(p.settings);assert.deepEqual(runtime.offersFor(p.item),[]);
});

test('absent synchronous cache-state dependency cannot authorize any shared quote',async t=>{
 const p=await pipeline(t),runtime=setup(p,{peekFingerprintState:null}),before=p.counts();await runtime.consume(p.settings);
 assert.deepEqual(runtime.offersFor(p.item),[]);assert.equal(runtime.statistics().passes,0);assert.equal(runtime.statistics().reasons.cache_metadata_required,1);assert.deepEqual(p.counts(),before);
});

for(const change of ['ownershipConflictCount','fromCache','future','old'])test(`final output revokes prior evidence when current ownership becomes ${change}`,async t=>{
 const p=await pipeline(t),runtime=setup(p);await runtime.consume(p.settings);assert.equal(runtime.offersFor(p.item).length,1);
 const row=p.contexts[0].profileDiscovery.profileObservation;
 if(change==='ownershipConflictCount')row.ownershipConflictCount=1;
 else if(change==='fromCache')row.fromCache=true;
 else row.observedAt=change==='future'?T+3600000:T-1;
 assert.deepEqual(runtime.offersFor(p.item),[]);assert.equal(runtime.statistics().activeVerifiedOffers,0);
 assert.deepEqual(p.counts(),{htmlReads:2,imageReads:2});
});

for(const change of ['owned','conflict','newer_price'])test(`new pooled ${change} evidence revokes an earlier quote even after pass quota without new reads`,async t=>{
 const p=await pipeline(t);let revision=0,observed=p.observer.snapshot();
 const runtime=setup(p,{snapshot:()=>structuredClone(observed),observationVersion:()=>revision,minPassGapMs:0});
 for(let i=0;i<3;i++)await runtime.consume(p.settings);assert.equal(runtime.offersFor(p.item).length,1);
 const page=observed.pages.find(page=>page.cards.some(card=>card.id===p.candidate.id)),card=page.cards.find(card=>card.id===p.candidate.id);
 if(change==='owned')card.sellerId='seller-boss';
 else if(change==='conflict')page.cards.push({...card,price:7000});
 else if(change==='newer_price'){page.source.observedAt=T+12000;card.price=7000;p.setTime(T+13000);}
 else observed.pages=[];
 revision++;assert.deepEqual(runtime.offersFor(p.item),[]);await runtime.consume(p.settings);
 assert.deepEqual(runtime.offersFor(p.item),[]);assert.equal(runtime.statistics().attemptedPairs,1);
 assert.deepEqual(p.counts(),{htmlReads:2,imageReads:2});
});

test('newer identical image bytes preserve original time and only shorten expiry, while unavailable or changed bytes revoke',async t=>{
 const p=await pipeline(t);let next=null;
 const runtime=setup(p,{peekFingerprintState:url=>next||peekKnownImageObservation(url)});await runtime.consume(p.settings);
 const original=runtime.offersFor(p.item)[0];assert.ok(original);const first=original.imageEvidence[0];
 next={status:'available',contentSha256:first.contentSha256,imageObservedAt:new Date(T+13000).toISOString(),imageCacheExpiresAt:T+15000};
 p.setTime(T+13000);const preserved=runtime.offersFor(p.item)[0];assert.ok(preserved);
 assert.equal(preserved.imageEvidence[0].imageObservedAt,first.imageObservedAt);assert.equal(preserved.imageEvidence[0].imageCacheExpiresAt,T+15000);
 assert.equal(preserved.checkedAt,original.checkedAt);assert.equal(preserved.identityVerifiedAt,original.identityVerifiedAt);
 next={status:'unavailable',reason:'pending'};assert.deepEqual(runtime.offersFor(p.item),[]);assert.deepEqual(p.counts(),{htmlReads:2,imageReads:2});
});

test('unchanged abbreviated rail title and thumbnail on a later page do not revoke separately verified full detail',async t=>{
 const p=await pipeline(t);let observed=p.observer.snapshot(),revision=0;
 for(const page of observed.pages)for(const card of page.cards)if(card.id===p.candidate.id){card.title=p.item.title.replace(' 特典付き','');card.image='https://images.example.invalid/thumbnail.png';}
 const runtime=setup(p,{snapshot:()=>structuredClone(observed),observationVersion:()=>revision});await runtime.consume(p.settings);
 const before=runtime.offersFor(p.item);assert.equal(before.length,1);assert.notEqual(before[0].title,p.item.title.replace(' 特典付き',''));
 p.setTime(T+13000);for(const page of observed.pages)page.source.observedAt=T+12000;revision++;
 assert.deepEqual(runtime.offersFor(p.item),before);assert.deepEqual(p.counts(),{htmlReads:2,imageReads:2});
});

test('recall tail expiry is not sale evidence and does not renew or erase still-current original detail quotes',async t=>{
 const p=await pipeline(t),runtime=setup(p,{peekOriginalReceipt:p.loader.yahooOriginalReceipt});await runtime.consume(p.settings);
 const before=runtime.offersFor(p.item);assert.equal(before.length,1);
 p.setTime(T+12*60_000+6000);assert.equal(p.observer.snapshot().pages.length,0);
 assert.deepEqual(runtime.offersFor(p.item),before);assert.deepEqual(p.counts(),{htmlReads:2,imageReads:2});
 p.setTime(T+21*60_000);assert.deepEqual(runtime.offersFor(p.item),[]);
});
