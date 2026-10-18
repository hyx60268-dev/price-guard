import test from 'node:test';
import assert from 'node:assert/strict';
import {pipeline,T} from './fixtures/shared-detail-pipeline.mjs';
import {createSharedYahooDetailRuntime} from '../scripts/lib/yahoo-shared-detail-runtime.mjs';
import {peekImageFingerprints,peekKnownImageObservation} from '../scripts/lib/image.mjs';
const setup=(p,extra={})=>createSharedYahooDetailRuntime({startedAt:T,deadlineAt:T+720000,accounts:p.accounts,contexts:p.contexts,
 snapshot:p.observer.snapshot,observationVersion:p.observer.revision,peekBundle:p.loader.peekYahooBundle,
 peekOriginalReceipt:p.loader.yahooOriginalReceipt,peekFingerprint:peekImageFingerprints,peekFingerprintState:peekKnownImageObservation,
 now:p.input.now,minPassGapMs:0,...extra});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('source admission window closing during optional recheck retains original valid quote without a new task or clock',async t=>{
 const p=await pipeline(t),before=p.counts(),blocked=deferred(),entered=deferred();let stall=false,clock=0;
 const runtime=setup(p,{clock:()=>clock,maxDurationMs:40,peekFingerprint:async(...args)=>{if(stall){entered.resolve();await blocked.promise;}return peekImageFingerprints(...args);}});
 await runtime.consume(p.settings);const accepted=runtime.offersFor(p.item);assert.equal(accepted.length,1);
 stall=true;const pending=runtime.consume(p.settings);await entered.promise;p.setTime(T+720000);clock=40;
 await pending;assert.deepEqual(runtime.offersFor(p.item),accepted);assert.equal(runtime.statistics().attemptedPairs,1);
 assert.equal(runtime.statistics().retentionReasons.source_window_closed_original_retained,1);
 blocked.resolve();await settle();await settle();assert.deepEqual(runtime.offersFor(p.item),accepted);
 await runtime.consume(p.settings);assert.deepEqual(runtime.offersFor(p.item),accepted);assert.deepEqual(p.counts(),before);
 assert.equal(runtime.directedAvailable(),false);
 p.setTime(T+21*60000);assert.deepEqual(runtime.offersFor(p.item),[]);assert.equal(runtime.statistics().attemptedPairs,1);
 assert.ok(runtime.statistics().withdrawalReasons.stored_quote_invalid_or_expired>0);
});
for(const accountId of ['melon','boss','momoka'])test(`budget-only callback retains ${accountId} accepted exact original row and clocks with no requests`,async t=>{
 const p=await pipeline(t,{accountId}),before=p.counts();let clock=0,passes=0;
 const runtime=setup(p,{clock:()=>clock,onMapping:()=>{if(++passes===2)clock=1000;}});
 await runtime.consume(p.settings);const accepted=runtime.offersFor(p.item);assert.equal(accepted.length,1);
 await runtime.consume(p.settings);assert.deepEqual(runtime.offersFor(p.item),accepted);assert.equal(runtime.statistics().activeVerifiedOffers,1);
 await runtime.consume(p.settings);assert.deepEqual(runtime.offersFor(p.item),accepted);
 assert.equal(runtime.statistics().attemptedPairs,1);assert.equal(runtime.statistics().verifiedPairs,1);assert.deepEqual(p.counts(),before);
});
test('mapping interruption retains accepted original row',async t=>{
 const p=await pipeline(t),before=p.counts();let second=false,calls=0;
 const runtime=setup(p,{clock:()=>second?(++calls<3?0:1000):0});await runtime.consume(p.settings);const accepted=runtime.offersFor(p.item);
 second=true;await runtime.consume(p.settings);assert.deepEqual(runtime.offersFor(p.item),accepted);assert.equal(runtime.statistics().mappingStops,1);assert.deepEqual(p.counts(),before);
});
test('partial multi-target revalidation retains the unpeeked second original row with no timestamp renewal',async t=>{
 const p=await pipeline(t,{secondTarget:true}),before=p.counts();let clock=0,second=false,reads=0;
 const runtime=setup(p,{clock:()=>clock,peekFingerprint:async(...args)=>{const value=await peekImageFingerprints(...args);if(second&&++reads===2)clock=1000;return value;}});
 await runtime.consume(p.settings);const first=runtime.offersFor(p.item),other=runtime.offersFor(p.second);second=true;
 await runtime.consume(p.settings);assert.deepEqual(runtime.offersFor(p.item),first);assert.deepEqual(runtime.offersFor(p.second),other);
 assert.equal(reads,2);assert.equal(runtime.statistics().verifiedPairs,2);assert.equal(runtime.statistics().activeVerifiedOffers,2);assert.deepEqual(p.counts(),before);
});
for(const failure of ['null','throw','changed_hash'])test(`completed ${failure} remains a withdrawal even when it spends the remaining local budget`,async t=>{
 const p=await pipeline(t),before=p.counts();let changed=false,clock=0;
 const runtime=setup(p,{clock:()=>clock,peekFingerprint:async(...args)=>{if(!changed)return peekImageFingerprints(...args);clock=1000;if(failure==='throw')throw Error('fixture unavailable');if(failure==='null')return null;return {...await peekImageFingerprints(...args),contentSha256:'0'.repeat(64)};}});
 await runtime.consume(p.settings);assert.equal(runtime.offersFor(p.item).length,1);changed=true;
 await runtime.consume(p.settings);assert.deepEqual(runtime.offersFor(p.item),[]);assert.deepEqual(p.counts(),before);
});
for(const failure of ['unknown_metadata','pending_metadata','expired_metadata','changed_image_hash','changed_body_sha','changed_parsed_sha','missing_receipt','expired_original','owned','correction','changed_target','recall_conflict'])test(`budget-only retention rejects ${failure}`,async t=>{
 const p=await pipeline(t),before=p.counts();let changed=false,clock=0,passes=0,revision=0,snapshot=p.observer.snapshot();
 const runtime=setup(p,{clock:()=>clock,snapshot:()=>structuredClone(snapshot),observationVersion:()=>revision,onMapping:()=>{if(++passes===2)clock=1000;},
  peekOriginalReceipt:id=>{const value=p.loader.yahooOriginalReceipt(id);if(!changed||id!==p.candidate.id)return value;
   if(failure==='changed_body_sha')return {...value,bodySha256:'0'.repeat(64)};
   if(failure==='changed_parsed_sha')return {...value,parsedSha256:'0'.repeat(64)};
   if(failure==='missing_receipt')return null;return value;},
  peekFingerprintState:url=>{const value=peekKnownImageObservation(url);if(!changed)return value;
   if(failure==='unknown_metadata')return {status:'unknown'};if(failure==='pending_metadata')return {status:'unavailable',reason:'pending'};
   if(failure==='expired_metadata')return {...value,imageCacheExpiresAt:p.input.now()};if(failure==='changed_image_hash')return {...value,contentSha256:'0'.repeat(64)};return value;}});
 await runtime.consume(p.settings);assert.equal(runtime.offersFor(p.item).length,1);changed=true;let settings=p.settings;
 if(failure==='expired_original')p.setTime(T+21*60000);
 if(failure==='owned')settings={...p.settings,ownedOffers:{...p.settings.ownedOffers,yahoo:{items:new Set([...p.settings.ownedOffers.yahoo.items,p.candidate.id]),sellers:p.settings.ownedOffers.yahoo.sellers}}};
 if(failure==='correction')settings={...p.settings,matchCorrections:{reject:{accountId:p.item.accountId,itemId:p.item.id,platform:'yahoo',candidateId:p.candidate.id,deleted:false}}};
 if(failure==='changed_target')p.item.ownPrice++;
 if(failure==='recall_conflict'){const page=snapshot.pages.find(page=>page.cards.some(c=>c.id===p.candidate.id));page.cards.push({...page.cards.find(c=>c.id===p.candidate.id),price:7000});revision++;}
 await runtime.consume(settings);assert.deepEqual(runtime.offersFor(p.item),[]);assert.deepEqual(p.counts(),before);
});
test('timed-out duplicate cache peek preserves currently valid original evidence; a late completion cannot renew it',async t=>{
 const p=await pipeline(t),before=p.counts(),blocked=deferred();let stall=false,clock=0;
 const runtime=setup(p,{clock:()=>clock,maxDurationMs:40,peekFingerprint:async(...args)=>{if(stall)await blocked.promise;return peekImageFingerprints(...args);}});
 await runtime.consume(p.settings);const accepted=runtime.offersFor(p.item);stall=true;
 await runtime.consume(p.settings);assert.deepEqual(runtime.offersFor(p.item),accepted);const stats=runtime.statistics();
 blocked.resolve();await settle();await settle();assert.deepEqual(runtime.offersFor(p.item),accepted);assert.equal(runtime.statistics().verifiedPairs,stats.verifiedPairs);assert.deepEqual(p.counts(),before);
});
for(const mode of ['changed_source','changed_image','already_revoked_then_restored'])test(`interrupted optional peek cannot resurrect ${mode} after late completion`,async t=>{
 const p=await pipeline(t),before=p.counts(),blocked=deferred(),entered=deferred();let stall=false,changed=false,clock=0;
 const runtime=setup(p,{clock:()=>clock,maxDurationMs:40,peekOriginalReceipt:id=>{const value=p.loader.yahooOriginalReceipt(id);return changed&&id===p.candidate.id&&['changed_source','already_revoked_then_restored'].includes(mode)?{...value,parsedSha256:'0'.repeat(64)}:value;},
  peekFingerprintState:url=>changed&&mode==='changed_image'?{status:'unknown'}:peekKnownImageObservation(url),
  peekFingerprint:async(...args)=>{if(stall){entered.resolve();await blocked.promise;}return peekImageFingerprints(...args);}});
 await runtime.consume(p.settings);assert.equal(runtime.offersFor(p.item).length,1);stall=true;const pending=runtime.consume(p.settings);await entered.promise;
 changed=true;clock=40;
 if(mode==='already_revoked_then_restored'){assert.deepEqual(runtime.offersFor(p.item),[]);changed=false;}
 await pending;assert.deepEqual(runtime.offersFor(p.item),[]);blocked.resolve();await settle();await settle();
 assert.deepEqual(runtime.offersFor(p.item),[]);assert.equal(runtime.statistics().verifiedPairs,1);assert.deepEqual(p.counts(),before);
});
test('unpeeked second row cannot bypass changed full-body binding after first row uses budget',async t=>{
 const p=await pipeline(t,{secondTarget:true}),before=p.counts();let changed=false,second=false,clock=0,reads=0;
 const runtime=setup(p,{clock:()=>clock,peekOriginalReceipt:id=>{const value=p.loader.yahooOriginalReceipt(id);return changed&&id===p.second.id?{...value,bodySha256:'0'.repeat(64)}:value;},peekFingerprint:async(...args)=>{const value=await peekImageFingerprints(...args);if(second&&++reads===2){clock=1000;changed=true;}return value;}});
 await runtime.consume(p.settings);const first=runtime.offersFor(p.item);assert.equal(runtime.offersFor(p.second).length,1);second=true;
 await runtime.consume(p.settings);assert.deepEqual(runtime.offersFor(p.item),first);assert.deepEqual(runtime.offersFor(p.second),[]);assert.equal(reads,2);assert.deepEqual(p.counts(),before);
});

test('real fingerprint loader newer identical bytes preserve original quote and identity clocks without duplicate strict work',async t=>{
 const {createFingerprintLoader}=await import('../scripts/lib/image-fingerprint-cache.mjs');
 const p=await pipeline(t),before=p.counts();let imageReads=0;
 const cache=createFingerprintLoader({now:p.input.now,
  fetchImage:async()=>{imageReads++;return {buffer:Buffer.from('same local fixture image bytes'),cacheControl:'public,max-age=3600'};},
  fingerprint:async(_bytes,url)=>peekImageFingerprints(url)});
 for(const url of [p.item.image,p.candidate.images[0]])await cache.get(url);
 const runtime=setup(p,{clock:()=>0,peekFingerprint:cache.peek,peekFingerprintState:cache.peekKnownObservation});
 await runtime.consume(p.settings);const accepted=runtime.offersFor(p.item);assert.equal(accepted.length,1);
 p.setTime(T+14000);
 for(const url of [p.item.image,p.candidate.images[0]])await cache.get(url);
 assert.equal(imageReads,4,'the fixture models two already-completed normal image refreshes');
 await runtime.consume(p.settings);assert.deepEqual(runtime.offersFor(p.item),accepted);
 assert.equal(runtime.statistics().attemptedPairs,1);assert.equal(runtime.statistics().verifiedPairs,1);
 assert.deepEqual(runtime.statistics().withdrawalReasons,{});assert.deepEqual(p.counts(),before);
});
for(const bad of ['backward','future','invalid','wrong_url','changed_hash','invalid_expiry'])test(`settled duplicate image ${bad} cannot preserve an accepted quote`,async t=>{
 const p=await pipeline(t),before=p.counts();let changed=false,clock=0;
 const runtime=setup(p,{clock:()=>clock,peekFingerprint:async(...args)=>{
  const value=await peekImageFingerprints(...args);if(!changed)return value;clock=1000;
  if(bad==='backward')return {...value,imageObservedAt:new Date(Date.parse(value.imageObservedAt)-1).toISOString()};
  if(bad==='future')return {...value,imageObservedAt:new Date(p.input.now()+1).toISOString()};
  if(bad==='invalid')return {...value,imageObservedAt:'invalid'};
  if(bad==='wrong_url')return {...value,url:'https://images.example.invalid/other.png'};
  if(bad==='changed_hash')return {...value,contentSha256:'0'.repeat(64)};
  return {...value,imageCacheExpiresAt:Infinity};
 }});
 await runtime.consume(p.settings);assert.equal(runtime.offersFor(p.item).length,1);changed=true;
 await runtime.consume(p.settings);assert.deepEqual(runtime.offersFor(p.item),[]);
 assert.equal(Object.values(runtime.statistics().withdrawalReasons).reduce((a,b)=>a+b,0),1);
 runtime.statistics();runtime.offersFor(p.item);
 assert.equal(Object.values(runtime.statistics().withdrawalReasons).reduce((a,b)=>a+b,0),1,'repeated output guards do not double-count the same withdrawn evidence');
 assert.deepEqual(p.counts(),before);
});
for(const bad of ['future','invalid','expired'])test(`synchronous negative image metadata ${bad} still withdraws during budget retention`,async t=>{
 const p=await pipeline(t);let changed=false,clock=0,passes=0;
 const runtime=setup(p,{clock:()=>clock,onMapping:()=>{if(++passes===2)clock=1000;},peekFingerprintState:url=>{
  const value=peekKnownImageObservation(url);if(!changed)return value;
  if(bad==='expired')return {...value,imageCacheExpiresAt:p.input.now()};
  return {...value,imageObservedAt:bad==='future'?new Date(p.input.now()+1).toISOString():'invalid'};
 }});
 await runtime.consume(p.settings);assert.equal(runtime.offersFor(p.item).length,1);changed=true;
 await runtime.consume(p.settings);assert.deepEqual(runtime.offersFor(p.item),[]);
 const reasons=runtime.statistics().withdrawalReasons;
 assert.equal(reasons[bad==='expired'?'image_metadata_expired':'image_observation_inconsistent'],1);
 assert.equal(Object.values(reasons).reduce((a,b)=>a+b,0),1);
});

test('a settled last duplicate peek must not revive evidence withdrawn while waiting',async t=>{
 const p=await pipeline(t),blocked=deferred(),entered=deferred();let duplicate=false,read=0,changed=false,clock=0;
 const runtime=setup(p,{clock:()=>clock,peekOriginalReceipt:id=>{
  const value=p.loader.yahooOriginalReceipt(id);return changed&&id===p.candidate.id?{...value,parsedSha256:'0'.repeat(64)}:value;
 },peekFingerprint:async(...args)=>{if(duplicate&&++read===2){entered.resolve();await blocked.promise;}return peekImageFingerprints(...args);}});
 await runtime.consume(p.settings);const original=runtime.offersFor(p.item);assert.equal(original.length,1);
 duplicate=true;const pending=runtime.consume(p.settings);await entered.promise;
 changed=true;assert.deepEqual(runtime.offersFor(p.item),[],'guard withdrew the accepted revision');
 changed=false;clock=1000;blocked.resolve();await pending;
 assert.equal(runtime.statistics().verifiedPairs,1,'no new strict acceptance occurred');
 assert.deepEqual(runtime.offersFor(p.item),[],'withdrawn row cannot return on completion of optional peek');
});

test('full-body change must revoke a budget-retained row after quota is exhausted',async t=>{
 const p=await pipeline(t);let changed=false,clock=0,passes=0;
 const runtime=setup(p,{clock:()=>clock,onMapping:()=>{if(++passes===2)clock=1000;},peekOriginalReceipt:id=>{
  const value=p.loader.yahooOriginalReceipt(id);return changed&&id===p.candidate.id?{...value,bodySha256:'0'.repeat(64)}:value;
 }});
 await runtime.consume(p.settings);assert.equal(runtime.offersFor(p.item).length,1);
 await runtime.consume(p.settings);assert.equal(runtime.offersFor(p.item).length,1);
 changed=true;await runtime.consume(p.settings);
 assert.deepEqual(runtime.offersFor(p.item),[]);
});

test('withdrawal telemetry counts changed image evidence as a distinct accepted revision',async t=>{
 const p=await pipeline(t);let mode=0;
 const runtime=setup(p,{clock:()=>0,peekFingerprint:async(...args)=>{
  const value=await peekImageFingerprints(...args);return mode?{...value,contentSha256:'0'.repeat(64)}:value;
 },peekFingerprintState:url=>{
  const value=peekKnownImageObservation(url);return mode===2?{status:'unknown'}:mode===1?{...value,contentSha256:'0'.repeat(64)}:value;
 }});
 await runtime.consume(p.settings);const old=runtime.offersFor(p.item);assert.equal(old.length,1);
 mode=1;assert.deepEqual(runtime.offersFor(p.item),[]);
 assert.equal(runtime.statistics().withdrawalReasons.image_bytes_changed,1);
 await runtime.consume(p.settings);const fresh=runtime.offersFor(p.item);assert.equal(fresh.length,1);
 assert.notDeepEqual(fresh[0].imageEvidence,old[0].imageEvidence);
 assert.equal(runtime.statistics().verifiedPairs,2);
 mode=2;assert.deepEqual(runtime.offersFor(p.item),[]);
 assert.equal(Object.values(runtime.statistics().withdrawalReasons).reduce((a,b)=>a+b,0),2);
});

import {createHash} from 'node:crypto';
function twoCandidates(p){
 const secondId='external-offer-two',original=p.loader.peekYahooBundle(p.candidate.id);
 const bundle=structuredClone(original);bundle.detail.id=secondId;bundle.detail.price++;
 bundle.sourceUrl=`https://paypayfleamarket.yahoo.co.jp/item/${secondId}`;
 Object.assign(bundle.originalObservation,{url:bundle.sourceUrl,bodySha256:'f'.repeat(64),parsedSha256:createHash('sha256').update(JSON.stringify({detail:bundle.detail,shipping:bundle.shipping})).digest('hex')});
 const snap=p.observer.snapshot(),page=snap.pages.find(page=>page.cards.some(card=>card.id===p.candidate.id));
 const first=page.cards.find(card=>card.id===p.candidate.id);page.cards.push({...first,id:secondId,price:bundle.detail.price,url:bundle.sourceUrl});
 return {secondId,snapshot:()=>structuredClone(snap),peekBundle:id=>id===secondId?structuredClone(bundle):p.loader.peekYahooBundle(id),
  peekOriginalReceipt:id=>id===secondId?structuredClone(bundle.originalObservation):p.loader.yahooOriginalReceipt(id)};
}

test('final optional commit cannot revive an earlier row withdrawn during later row wait at zero budget',async t=>{
 const p=await pipeline(t),two=twoCandidates(p),entered=deferred(),blocked=deferred();let duplicate=false,reads=0,changed=false,clock=0;
 const runtime=setup(p,{...two,clock:()=>clock,peekOriginalReceipt:id=>{
  const value=two.peekOriginalReceipt(id);return changed&&id===p.candidate.id?{...value,parsedSha256:'0'.repeat(64)}:value;
 },peekFingerprint:async(...args)=>{if(duplicate&&++reads===4){entered.resolve();await blocked.promise;}return peekImageFingerprints(...args);}});
 await runtime.consume(p.settings);assert.equal(runtime.offersFor(p.item).length,2);
 duplicate=true;const pending=runtime.consume(p.settings);await entered.promise;
 changed=true;assert.deepEqual(runtime.offersFor(p.item).map(row=>row.id),[two.secondId]);
 changed=false;clock=1000;blocked.resolve();await pending;
 assert.deepEqual(runtime.offersFor(p.item).map(row=>row.id),[two.secondId]);
 assert.equal(runtime.statistics().verifiedPairs,2,'optional callback did not reverify or resurrect first row');
});

test('a completed null row stays withdrawn while another optional row is waiting',async t=>{
 const p=await pipeline(t),two=twoCandidates(p),entered=deferred(),blocked=deferred();let duplicate=false,reads=0,clock=0;
 const runtime=setup(p,{...two,clock:()=>clock,peekFingerprint:async(...args)=>{
  if(duplicate){reads++;if(reads===1)return null;if(reads===2){entered.resolve();await blocked.promise;}}
  return peekImageFingerprints(...args);
 }});
 await runtime.consume(p.settings);assert.equal(runtime.offersFor(p.item).length,2);
 duplicate=true;const pending=runtime.consume(p.settings);await entered.promise;
 try{assert.deepEqual(runtime.offersFor(p.item).map(row=>row.id),[two.secondId],'known completed null must be visible to concurrent output guards');}
 finally{clock=1000;blocked.resolve();await pending;}
});
