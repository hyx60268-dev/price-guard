import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createYahooPageObservationPool} from '../scripts/lib/yahoo-page-observation-pool.mjs';
import {createYahooScanPageObservation} from '../scripts/lib/yahoo-scan-page-observation.mjs';

const T=Date.parse('2026-10-18T05:00:00Z'),url=id=>`https://paypayfleamarket.yahoo.co.jp/item/${id}`;
const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
const hash=value=>createHash('sha256').update(value).digest('hex');
const fields=['id','title','image','sellerId','price','priceKind','currency','currencySource','priceField','priceSource','recommendationSection'];
function card(id='shared',extra={}) {
  return {id,url:url(id),title:'合成の商品 フィギュア 1/7',image:`https://fixture.invalid/${id}.jpg`,sellerId:'outside-seller',
    price:12345.67,priceKind:'ordinary',currency:'JPY',priceField:'recommendItems.items.price',
    priceSource:'yahoo_recommendation_receipt_v1',recommendationSection:'similar',...extra};
}
function input(id='source-a',cards=[card()],at=T+10,extra={}) {
  return {source:{id,url:url(id),sha256:hash(id+at),sha256Scope:'decoded_response_html_utf8',observedAt:at,fromCache:false,
    status:200,redirected:false,role:'candidate',auditReservationId:'fixture-reservation'},
    detail:{id,title:'合成の商品',description:'新品・仕様未核验 synthetic detail',price:12345.67,sellerId:'outside-seller',status:'OPEN',images:[`https://fixture.invalid/${id}.jpg`]},
    shipping:{shippingKnown:true,currency:'JPY',shippingJPY:123.45},cards,...extra};
}
function harness(extra={}) {
  let now=T+1000;
  return {pool:createYahooPageObservationPool({cycleStartedAt:T,deadlineAt:T+20*60_000,now:()=>now,maxSources:120,maxCardsPerSource:80,...extra}),setNow:value=>{now=value;}};
}
// Independent schema encoder: verifies all tables, source/detail metadata,
// references, UTF-8 framing and tombstones are included in the measured cap.
function encodeSnapshot(snapshot) {
  if(!snapshot.pages.length&&!snapshot.conflicts.length)return '';
  const cardPayloads=[],byContent=new Map();
  const pages=snapshot.pages.map(page=>{
    const {id,sha256,sha256Scope,auditReservationId,observedAt,role,expiresAt}=page.source;
    return {...page,source:{id,sha256,sha256Scope,auditReservationId,observedAt,role,expiresAt},cards:page.cards.map(card=>{
      const tuple=fields.map(field=>card[field]),key=JSON.stringify(tuple);
      if(!byContent.has(key)){byContent.set(key,cardPayloads.length);cardPayloads.push(tuple);}
      return byContent.get(key);
    })};
  });
  return JSON.stringify({version:2,pages,cardPayloads,conflicts:snapshot.conflicts});
}
function assertAccounting(snapshot) {
  assert.equal(snapshot.retention.retainedEvidenceBytes,Buffer.byteLength(encodeSnapshot(snapshot),'utf8'));
  assert.ok(snapshot.retention.retainedEvidenceBytes<=snapshot.bounds.maxRetainedEvidenceBytes);
  assert.equal(snapshot.retention.expandedSnapshotEvidenceBytes,bytes({pages:snapshot.pages,conflicts:snapshot.conflicts}));
}

test('exact immutable payloads share storage while each source order, original clock, full price and provenance reconstructs',()=>{
  const {pool}=harness();
  const a=input('source-a',[card(),card('second'),card()]),b=input('source-b',[card('second'),card()],T+20);
  assert.equal(pool.ingest(a).retained,true);assert.equal(pool.ingest(b).retained,true);
  let snapshot=pool.snapshot();assertAccounting(snapshot);
  assert.equal(snapshot.retainedCards,5);assert.equal(snapshot.retention.retainedCardPayloads,2);
  assert.equal(snapshot.retention.deduplicatedCardPayloadReferences,3);assert.equal(snapshot.uniqueCandidateIds,2);
  assert.deepEqual(snapshot.pages.map(page=>page.cards.map(card=>card.id)),[['shared','second','shared'],['second','shared']]);
  for(const page of snapshot.pages){
    const original=page.source.id==='source-a'?a:b;
    assert.equal(page.source.sha256,original.source.sha256);assert.equal(page.source.url,original.source.url);
    assert.equal(page.source.auditReservationId,original.source.auditReservationId);assert.equal(page.source.observedAt,original.source.observedAt);
    assert.equal(page.source.key,JSON.stringify([original.source.url,original.source.sha256,original.source.observedAt]));
    assert.equal(page.detail.price,12345.67);assert.equal(page.shipping.shippingJPY,123.45);
    for(const card of page.cards){assert.equal(card.observedAt,new Date(page.source.observedAt).toISOString());assert.equal(card.price,12345.67);assert.equal(card.identityVerified,false);assert.equal(card.canRecommend,false);}
  }
  a.cards[0].title='mutated input';snapshot.pages[0].cards[0].title='mutated snapshot';snapshot.pages[0].detail.description='changed';
  snapshot=pool.snapshot();assert.equal(snapshot.pages[0].cards[0].title,card().title);assert.notEqual(snapshot.pages[0].detail.description,'changed');assertAccounting(snapshot);
});

test('the same ID with different title, price, image, seller or price provenance is never collapsed into one payload',()=>{
  const {pool}=harness();
  const variants=[{}, {title:'different title'}, {price:12345.68}, {image:'https://fixture.invalid/different.jpg'},
    {sellerId:'different-seller'}, {currency:undefined}, {recommendationSection:'related'}, {priceKind:'conditional'}, {currency:'USD'}];
  variants.forEach((extra,index)=>pool.ingest(input(`source-${index}`,[card('shared',extra)],T+index)));
  const snapshot=pool.snapshot();assertAccounting(snapshot);assert.equal(snapshot.uniqueCandidateIds,1);
  assert.equal(snapshot.retention.retainedCardPayloads,variants.length);assert.equal(snapshot.retainedCards,variants.length);
  assert.equal(snapshot.retention.deduplicatedCardPayloadReferences,0);
  assert.deepEqual(snapshot.pages.slice(0,5).map(page=>[page.cards[0].title,page.cards[0].price,page.cards[0].image,page.cards[0].sellerId]),
    variants.slice(0,5).map(extra=>{const value=card('shared',extra);return [value.title,value.price,value.image,value.sellerId];}));
});

test('first admission includes complete table overhead; exact cap succeeds and one-byte-short refuses transactionally',()=>{
  const probe=harness();assert.equal(probe.pool.snapshot().retention.retainedEvidenceBytes,0);
  probe.pool.ingest(input());const first=probe.pool.snapshot(),limit=first.retention.retainedEvidenceBytes;assertAccounting(first);
  assert.ok(limit>bytes(first.pages[0].detail)+bytes(first.pages[0].shipping));
  const exact=harness({maxRetainedEvidenceBytes:limit});assert.equal(exact.pool.ingest(input()).retained,true);assertAccounting(exact.pool.snapshot());
  for(const cap of [1,limit-1]){
    const tiny=harness({maxRetainedEvidenceBytes:cap});assert.equal(tiny.pool.ingest(input()).reason,'retained_evidence_byte_budget');
    const snapshot=tiny.pool.snapshot();assert.equal(snapshot.activeSources,0);assert.equal(snapshot.retention.retainedEvidenceBytes,0);assertAccounting(snapshot);
  }
  probe.pool.ingest(input('source-b',[card()],T+20));const two=probe.pool.snapshot().retention.retainedEvidenceBytes;
  const twoExact=harness({maxRetainedEvidenceBytes:two});twoExact.pool.ingest(input());assert.equal(twoExact.pool.ingest(input('source-b',[card()],T+20)).retained,true);
  const below=harness({maxRetainedEvidenceBytes:two-1});below.pool.ingest(input());const before=below.pool.snapshot();
  assert.equal(below.pool.ingest(input('source-b',[card()],T+20)).reason,'retained_evidence_byte_budget');
  const after=below.pool.snapshot();assert.deepEqual(after.pages,before.pages);assert.equal(after.retention.retainedEvidenceBytes,before.retention.retainedEvidenceBytes);
  assert.equal(after.counters.acceptedSourceReads,1);assertAccounting(after);
});

test('newer replacement collects only unused references, preserves source order and rejects oversized changes without losing old valid state',()=>{
  const first=input('source-a',[card(),card('old')]),second=input('source-b',[card()],T+20),replacement=input('source-a',[card()],T+30);
  const probe=harness();probe.pool.ingest(first);probe.pool.ingest(second);const limit=probe.pool.snapshot().retention.retainedEvidenceBytes;
  const {pool}=harness({maxRetainedEvidenceBytes:limit});pool.ingest(first);pool.ingest(second);
  assert.equal(pool.ingest(replacement).retained,true);const before=pool.snapshot();assertAccounting(before);
  assert.deepEqual(before.pages.map(page=>page.source.id),['source-a','source-b']);assert.equal(before.retention.retainedCardPayloads,1);
  const tooLarge=input('source-a',[card('large',{title:'長'.repeat(1000),image:'https://fixture.invalid/'+'a'.repeat(1800)})],T+40);
  tooLarge.source.sha256=replacement.source.sha256; // Same body, no new evidence or renewed clock on refusal.
  assert.equal(pool.ingest(tooLarge).reason,'retained_evidence_byte_budget');const after=pool.snapshot();
  assert.deepEqual(after.pages,before.pages);assert.deepEqual(after.retention,before.retention);assert.equal(after.counters.acceptedSourceReads,3);assertAccounting(after);
});

test('same-clock source conflict tombstone cannot be byte-refused and never revives through cache or older reads',()=>{
  const original=input(),probe=harness();probe.pool.ingest(original);const limit=probe.pool.snapshot().retention.retainedEvidenceBytes;
  const {pool}=harness({maxRetainedEvidenceBytes:limit});pool.ingest(original);
  const conflicting={...original,source:{...original.source,sha256:hash('different original body')}};
  assert.equal(pool.ingest(conflicting).reason,'source_same_time_conflict');let snapshot=pool.snapshot();assertAccounting(snapshot);
  assert.equal(snapshot.activeSources,0);assert.equal(snapshot.retention.retainedCardPayloads,0);assert.equal(snapshot.conflicts.length,1);
  assert.equal(snapshot.counters.byteBudgetRefusals,0);assert.equal(snapshot.conflicts[0].observedAt,T+10);
  assert.equal(pool.ingest({...original,source:{...original.source,fromCache:true}}).retained,false);
  assert.equal(pool.ingest(original).retained,false);assert.equal(pool.ingest(input('source-a',[card()],T+9)).retained,false);
  assert.equal(pool.ingest(input('source-a',[card()],T+11)).retained,true);snapshot=pool.snapshot();assert.equal(snapshot.conflicts.length,0);assertAccounting(snapshot);
});

test('expiry, source eviction and conflict garbage collection keep only reachable payloads and their original deadlines',()=>{
  const h=harness({maxSources:2,maxAgeMs:1000}),{pool}=h;
  pool.ingest(input('source-a',[card('a')]));pool.ingest(input('source-b',[card('b')],T+20));
  assert.equal(pool.ingest(input('source-c',[card('c')],T+30)).retained,true);let snapshot=pool.snapshot();
  assert.equal(snapshot.counters.evictedSources,1);assert.equal(snapshot.retention.retainedCardPayloads,2);assertAccounting(snapshot);
  const duplicate=input('source-b',[card('b')],T+20);duplicate.source.fromCache=true;
  assert.equal(pool.ingest(duplicate).duplicate,true);assert.equal(pool.snapshot().pages[0].source.expiresAt,T+1020);
  h.setNow(T+1020);snapshot=pool.snapshot();assert.equal(snapshot.activeSources,1);assert.equal(snapshot.retention.retainedCardPayloads,1);assertAccounting(snapshot);
  const conflict=input('source-c',[card('c')],T+30);conflict.source.sha256=hash('source-c-conflict');pool.ingest(conflict);
  h.setNow(T+1030);snapshot=pool.snapshot();assert.equal(snapshot.activeSources,0);assert.equal(snapshot.conflicts.length,0);
  assert.equal(snapshot.retention.retainedEvidenceBytes,0);assertAccounting(snapshot);
});

test('a byte-rejected eviction preserves valid evidence while a rejected conflict replacement advances its unavailable clock',()=>{
  const probe=harness({maxSources:1});probe.pool.ingest(input());const limit=probe.pool.snapshot().retention.retainedEvidenceBytes;
  const {pool}=harness({maxSources:1,maxRetainedEvidenceBytes:limit});pool.ingest(input());const before=pool.snapshot();
  const large=input('source-b',[card('different',{title:'x'.repeat(1000)})],T+20);
  assert.equal(pool.ingest(large).reason,'retained_evidence_byte_budget');assert.deepEqual(pool.snapshot().pages,before.pages);
  assert.equal(pool.snapshot().counters.evictedSources,0);
  const conflict=input();conflict.source.sha256=hash('conflict');pool.ingest(conflict);const tombstone=pool.snapshot();
  const largeReplacement=input('source-a',[card('different',{title:'x'.repeat(1000)})],T+20);
  assert.equal(pool.ingest(largeReplacement).reason,'retained_evidence_byte_budget');
  assert.equal(pool.snapshot().conflicts.length,1);assert.equal(pool.snapshot().conflicts[0].observedAt,T+20);
  assert.ok(pool.snapshot().conflicts[0].observedAt>tombstone.conflicts[0].observedAt);
  assert.equal(pool.snapshot().conflicts[0].reason,'newer_observation_unretained');
  assert.equal(pool.ingest(input('source-a',[card()],T+15)).retained,false);
  assert.equal(pool.ingest(input()).retained,false);assertAccounting(pool.snapshot());
});

test('normal source and card caps remain 120 and 80, and transient expansion is explicitly counted separately',()=>{
  const {pool}=harness();
  for(let index=0;index<120;index++)pool.ingest(input(`source-${index}`,Array.from({length:83},(_,i)=>card(`shared-${i}`)),T+index));
  const snapshot=pool.snapshot();assertAccounting(snapshot);
  assert.equal(snapshot.activeSources,120);assert.equal(snapshot.retainedCards,9600);assert.equal(snapshot.counters.omittedCards,360);
  assert.equal(snapshot.retention.retainedCardPayloads,80);assert.equal(snapshot.bounds.maxRetainedCards,9600);
  assert.equal(pool.hasSourceCapacity('source-120'),false);assert.equal(pool.hasSourceCapacity('source-0'),true);
  assert.ok(snapshot.retention.expandedSnapshotEvidenceBytes>snapshot.retention.retainedEvidenceBytes*10);
});

test('scan observer rejects excess new sources and reports encoded bytes without adding authority or exposing evidence',()=>{
  const session=createYahooScanPageObservation({startedAt:T,deadlineAt:T+60_000,now:()=>T+1000,maxSources:1});
  const event=value=>({page:{html:`synthetic ${value.source.id}`,url:value.source.url,status:200,redirected:false,fromCache:false,observedAt:value.source.observedAt},
    requestedItemId:value.source.id,role:'candidate',detail:value.detail,shipping:value.shipping,
    recommendationReceipt:{version:1,requestedItemId:value.source.id,sourceUrl:value.source.url,observedAt:new Date(value.source.observedAt).toISOString(),
      cards:value.cards,totalCards:value.cards.length,invalidCards:0,sectionsTruncated:false}});
  session.observe(event(input()));session.observe(event(input('source-b')));const snapshot=session.snapshot(),result=session.finish();assertAccounting(snapshot);
  assert.equal(result.sourceCapacityRefusals,1);assert.equal(result.retainedSources,1);assert.equal(result.retainedEvidenceBytes,snapshot.retention.retainedEvidenceBytes);
  assert.equal(result.expandedSnapshotEvidenceBytes,snapshot.retention.expandedSnapshotEvidenceBytes);assert.equal(result.retainedEvidenceFormatVersion,2);
  for(const field of ['marketplaceRequests','imageRequests','completeComparisons','saleTermsVerifiedPairs'])assert.equal(result[field],0);
  assert.equal(result.checkedAt,null);assert.equal(result.searchCheckedAt,null);assert.equal(result.canRecommend,false);
  for(const privateText of ['source-a','outside-seller','fixture.invalid',card().title])assert.equal(JSON.stringify(result).includes(privateText),false);
});

test('generated 100-page scale counts real encoded savings without promising that 100 production pages fit',async t=>{
  const {generatedYahooPageRetentionEvents}=await import('./fixtures/yahoo-page-retention-scale.mjs');
  const events=generatedYahooPageRetentionEvents(),session=createYahooScanPageObservation({startedAt:T,deadlineAt:T+60_000,now:()=>T+1000});
  let legacyPages=0,legacyBytes=0;
  for(const event of events){
    // Historical accounting charged the complete expanded page once per source.
    const individual=createYahooScanPageObservation({startedAt:T,deadlineAt:T+60_000,now:()=>T+1000});individual.observe(event);
    const cost=bytes(individual.snapshot().pages[0]);if(legacyBytes+cost<=2*1024*1024){legacyBytes+=cost;legacyPages++;}
    session.observe(event);
  }
  const snapshot=session.snapshot(),result=session.finish();assertAccounting(snapshot);
  assert.equal(events.length,100);assert.ok(result.retainedSources>legacyPages);assert.ok(result.retainedSources<100,'this fixture intentionally still exceeds the byte cap');
  assert.equal(result.retainedSources+result.byteBudgetRefusals,100);assert.equal(result.retainedCardObservations,result.retainedSources*80);
  assert.equal(result.omittedRailCards,result.retainedSources*16);assert.ok(result.expandedSnapshotEvidenceBytes>2*1024*1024);
  assert.equal(result.observerFailures,0);assert.equal(result.marketplaceRequests,0);assert.equal(result.imageRequests,0);
  const first29=new Set(events.slice(0,29).flatMap(event=>event.recommendationReceipt.cards.slice(0,80).map(card=>card.id)));
  assert.equal(first29.size,1833);
  t.diagnostic(JSON.stringify({fixture:'generated_not_production',readPages:100,sourceCap:120,cardsPerSourceCap:80,byteCap:2*1024*1024,
    legacyExpandedAccounting:{retainedSources:legacyPages,retainedEvidenceBytes:legacyBytes},
    normalized:{retainedSources:result.retainedSources,retainedEvidenceBytes:result.retainedEvidenceBytes,byteBudgetRefusals:result.byteBudgetRefusals,
      retainedCardObservations:result.retainedCardObservations,retainedCardPayloads:result.retainedCardPayloads,
      expandedSnapshotEvidenceBytes:result.expandedSnapshotEvidenceBytes,observerDurationMs:result.observerDurationMs}}));
});

test('a newer changed body that exceeds storage invalidates only its old active source with an original-clock tombstone',()=>{
  const a=input('source-a'),b=input('source-b',[card('other')],T+20),probe=harness();probe.pool.ingest(a);probe.pool.ingest(b);
  const limit=probe.pool.snapshot().retention.retainedEvidenceBytes,h=harness({maxRetainedEvidenceBytes:limit}),{pool}=h;
  pool.ingest(a);pool.ingest(b);const before=pool.snapshot(),newer=input('source-a',[card('new',{title:'x'.repeat(1000)})],T+30);
  assert.equal(pool.ingest(newer).reason,'retained_evidence_byte_budget');let after=pool.snapshot();assertAccounting(after);
  assert.deepEqual(after.pages,[before.pages[1]]);assert.equal(after.retention.retainedCardPayloads,1);
  assert.deepEqual(after.conflicts,[{id:'source-a',observedAt:T+30,expiresAt:T+20*60_000,reason:'newer_observation_unretained'}]);
  assert.equal(after.counters.newerUnretainedSources,1);
  for(const rejected of [a,newer,{...a,source:{...a.source,fromCache:true}}])assert.equal(pool.ingest(rejected).retained,false);
  assert.equal(pool.hasSourceCapacity('source-a'),true);
  assert.equal(pool.ingest(input('source-a',[card()],T+31)).retained,true);after=pool.snapshot();assert.equal(after.conflicts.length,0);assertAccounting(after);
  h.setNow(T+20*60_000);assert.equal(pool.snapshot().retention.retainedEvidenceBytes,0);
});

test('a caught observer invalidation error cannot leave the contradicted old source available',t=>{
  const event=(id,html,at=T+10)=>({page:{html,url:url(id),status:200,redirected:false,fromCache:false,observedAt:at},requestedItemId:id,role:'candidate',
    detail:input(id).detail,shipping:input(id).shipping,recommendationReceipt:{version:1,requestedItemId:id,sourceUrl:url(id),observedAt:new Date(at).toISOString(),
      cards:[card()],totalCards:1,invalidCards:0,sectionsTruncated:false}});
  const create=extra=>createYahooScanPageObservation({startedAt:T,deadlineAt:T+60_000,now:()=>T+1000,...extra});
  const first=event('source-a','first body'),probe=create();probe.observe(first);
  const session=create({maxRetainedEvidenceBytes:probe.snapshot().retention.retainedEvidenceBytes});session.observe(first);
  const changed=event('source-a','newer changed body',T+20);changed.detail.description='x'.repeat(30000);
  const original=Buffer.byteLength;
  t.mock.method(Buffer,'byteLength',function(value,...args){
    if(typeof value==='string'&&value.includes('newer_observation_unretained'))throw Error('synthetic tombstone serialization failure');
    return original.call(this,value,...args);
  });
  session.observe(changed);t.mock.restoreAll();
  assert.equal(session.snapshot().activeSources,0);assert.equal(session.snapshot().retentionUnavailable,true);
  session.observe(first);assert.equal(session.snapshot().activeSources,0,'failure cannot revive the old original');
  const result=session.finish();assert.equal(result.observerFailures,1);assert.equal(result.retentionUnavailable,true);
  assert.equal(result.retainedSources,0);assert.equal(result.retainedEvidenceBytes,0);assert.equal(result.canRecommend,false);
});

test('successive byte-rejected newer observations advance unavailable tombstones and block intermediate late arrivals',()=>{
  for(const originalConflict of ['changed_body','same_clock']){
    const a=input('source-a'),b=input('source-b',[card('other')],T+11),probe=harness({maxAgeMs:1000});probe.pool.ingest(a);probe.pool.ingest(b);
    const {pool}=harness({maxRetainedEvidenceBytes:probe.pool.snapshot().retention.retainedEvidenceBytes,maxAgeMs:1000});
    pool.ingest(a);pool.ingest(b);const other=pool.snapshot().pages[1];
    if(originalConflict==='same_clock'){
      const equal=input();equal.source.sha256=hash('same-clock-conflicting-body');pool.ingest(equal);
    }
    const oversized=at=>input('source-a',[card('new',{title:'x'.repeat(1000)})],at);
    assert.equal(pool.ingest(oversized(T+20)).reason,'retained_evidence_byte_budget');
    assert.equal(pool.snapshot().conflicts[0].observedAt,T+20);
    assert.equal(pool.ingest(oversized(T+30)).reason,'retained_evidence_byte_budget');
    const snapshot=pool.snapshot();assertAccounting(snapshot);assert.deepEqual(snapshot.pages,[other]);
    assert.deepEqual(snapshot.conflicts,[{id:'source-a',observedAt:T+30,expiresAt:T+1030,reason:'newer_observation_unretained'}]);
    for(const at of [T+20,T+25,T+30])assert.equal(pool.ingest(input('source-a',[card()],at)).reason,'newer_observation_unretained');
    assert.equal(pool.snapshot().activeSources,1);assert.equal(pool.ingest(input('source-a',[card()],T+31)).retained,true);
    assert.equal(pool.snapshot().conflicts.length,0);assertAccounting(pool.snapshot());
  }
});
