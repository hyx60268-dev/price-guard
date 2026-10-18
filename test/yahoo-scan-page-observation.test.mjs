import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createYahooScanPageObservation} from '../scripts/lib/yahoo-scan-page-observation.mjs';
import {createOwnSourceLoader} from '../scripts/lib/own-source.mjs';
import {yahooRecommendationReceipt} from '../scripts/lib/yahoo-recommendation-receipt.mjs';
import {correctionKey} from '../public/match-memory.js';

const T=Date.parse('2026-10-18T05:00:00Z'),title='APEX ヴァイオレット フィギュア';
const url=id=>`https://paypayfleamarket.yahoo.co.jp/item/${id}`,image=id=>`https://fixture.invalid/${id}.jpg`;
const hash=value=>createHash('sha256').update(value).digest('hex');
function inventory(){
  const accounts=['a','b','c'].map((id,i)=>({id,platform:'yahoo',sellerId:'p'+i,profileUrl:`https://paypayfleamarket.yahoo.co.jp/user/p${i}`}));
  const contexts=accounts.map(account=>{
    const id='own-'+account.id,item={id,accountId:account.id,platform:'yahoo',title,ownPrice:30000,sellerId:account.sellerId,image:image(id)};
    const card={id,accountId:account.id,sellerId:account.sellerId,title,priceJPY:30000,imageUrl:image(id),itemStatus:'OPEN',source:'current_profile_card',
      observedAt:T+1,profileUrl:account.profileUrl,pageUrl:account.profileUrl+'?page=1',pageNumber:1};
    return {account,activeItems:[item],previousItems:[item],previousById:new Map(),profileStatus:'live',profileDiscovery:{profileObservation:{complete:true,enumerationComplete:true,
      fromCache:false,ownershipConflictCount:0,observedAt:T+1,cards:[card],membershipIds:[id,'closed-'+account.id]}}};
  });
  return {accounts,contexts};
}
function event(id='candidate',ids=['candidate','other'],at=T+10){
  const detail={id,title,price:28000,status:'OPEN',description:'新品 未使用 フィギュア1点',seller:{id:id.startsWith('own-')?'p0':'p99'},images:[image(id)]};
  const items=ids.map(itemId=>({itemId,title,price:28000,seller:{id:'p99'},image:{url:image(itemId)}}));
  const next={props:{initialState:{itemsState:{items:{item:detail}},
    recommendsState:{recommends:{recommends:{similar:{recommendItems:{items}}}}}}}};
  const html=`<html><h1>${title}</h1><div><span class="ItemPrice__Component">28,000円</span><span class="ItemDetail__ShippingFreeLabel">送料無料</span></div><script id="__NEXT_DATA__">${JSON.stringify(next)}</script></html>`+' '.repeat(10000);
  return {page:{html,url:url(id),status:200,redirected:false,fromCache:false,observedAt:at},requestedItemId:id,role:id.startsWith('own-')?'own':'candidate',detail,
    shipping:{shippingKnown:true,currency:'JPY',shippingJPY:0},recommendationReceipt:yahooRecommendationReceipt(next,{requestedItemId:id,sourceUrl:url(id),observedAt:at,now:Math.max(T+1000,at)}),next};
}
function harness(extra={}){let now=T+1000;const rows=inventory();return {...rows,session:createYahooScanPageObservation({...rows,startedAt:T,deadlineAt:T+60_000,now:()=>now,...extra}),advance:ms=>{now+=ms;}};}

test('real producer shares parsed rails once with the actual own-source memo, preserving old bundle shape and original hash/time',async t=>{
  const h=harness(),input=event('own-a');let now=T,reads=0,calls=0,parses=0;const parse=JSON.parse,raw=JSON.stringify(input.next);
  t.mock.method(Date,'now',()=>now);t.mock.method(JSON,'parse',function(value,...rest){if(value===raw)parses++;return parse.call(this,value,...rest);});
  t.mock.method(globalThis,'fetch',async requested=>{
    assert.equal(requested,url('own-a'));reads++;const response=new Response(input.page.html);Object.defineProperty(response,'url',{value:requested});
    Object.defineProperty(response,'text',{value:async()=>{now=T+10;return input.page.html;}});return response;
  });
  const yahoo=await import('../scripts/lib/yahoo.mjs?scan-pool='+crypto.randomUUID());
  const loader=createOwnSourceLoader({now:()=>now,fetchYahooBundle:id=>yahoo.fetchYahooItemBundle(id,{attempts:1,yahooRequestPurpose:'own',
    onYahooItemPageObserved(value){calls++;h.session.observe(value);value.detail.description='changed local copy';value.recommendationReceipt.cards.length=0;}})});
  const original=await loader.yahooBundle('own-a');now+=5000;assert.strictEqual(await loader.yahooBundle('own-a'),original);
  assert.equal(reads,1);assert.equal(calls,1);assert.equal(parses,1,'observer uses already parsed rails, no second JSON parse');
  assert.deepEqual(Object.keys(original).sort(),['detail','shipping','recommendations','components','observedAt','fromCache','sourceUrl'].sort());
  assert.equal(original.detail.description,input.detail.description);assert.equal(original.recommendations.length,2);
  const source=h.session.snapshot().pages[0].source;assert.equal(source.url,url('own-a'));assert.equal(source.sha256,hash(input.page.html));
  assert.equal(source.observedAt,T+10);assert.equal(original.observedAt,T+10);assert.equal(source.fromCache,false);
  assert.equal(loader.stats.yahooBundleRequests,1);assert.equal(loader.stats.yahooBundleReuses,1);
  const summary=h.session.finish({contexts:h.contexts});assert.equal(summary.acceptedSourceReads,1);assert.equal(summary.mappingPasses,1);
  assert.equal(summary.totalManagedTargets,3);assert.equal(summary.mappedTargets,3);assert.equal(summary.ownPageObservedTargets,1);
  assert.equal(summary.recalledPendingOwnRoots,2);assert.equal(summary.unresolvedTargets,3);assert.equal(summary.completeComparisons,0);
  assert.strictEqual(h.session.finish(),summary);h.session.observe(event());assert.equal(h.session.snapshot().activeSources,1);
});

test('disabled producer has no observation work; callback failure cannot change a successful original bundle',async t=>{
  for(const enabled of [false,true]){
    let now=T,calls=0;const input=event();t.mock.method(Date,'now',()=>now);
    t.mock.method(globalThis,'fetch',async requested=>{const response=new Response(input.page.html);Object.defineProperty(response,'url',{value:requested});
      Object.defineProperty(response,'text',{value:async()=>{now=T+10;return input.page.html;}});return response;});
    const yahoo=await import('../scripts/lib/yahoo.mjs?scan-default='+crypto.randomUUID());
    const result=await yahoo.fetchYahooItemBundle('candidate',{attempts:1,...(enabled?{onYahooItemPageObserved(){calls++;throw Error('sentinel private exception');}}:{})});
    assert.equal(result.observedAt,T+10);assert.deepEqual(result.detail,input.detail);assert.equal(calls,enabled?1:0);assert.equal(result.pagePoolObservation,undefined);
    t.mock.restoreAll();
  }
  const code=await readFile(new URL('../scripts/lib/yahoo.mjs',import.meta.url),'utf8');assert.doesNotMatch(code,/^import.*(?:page-pool|observation-pool|scan-page-observation)/m);
});

test('all accounts, full owned membership, per-target correction and deletion tombstone are preserved without changing original observations',()=>{
  const h=harness(),input=event('candidate',['candidate','closed-b']);h.session.observe(input);
  const correction={accountId:'b',itemId:'own-b',platform:'yahoo',candidateId:'candidate',updatedAt:new Date(T+20).toISOString()};
  const settings={matchCorrections:{[correctionKey(correction)]:correction}};
  const result=h.session.finish({contexts:h.contexts,settings});assert.equal(result.targetCandidatePairs,2);assert.equal(result.uniqueCandidateIds,1);
  assert.equal(result.totalManagedTargets,3);assert.equal(result.mappedTargets,2);assert.equal(result.originalObservedAtMin,T+10);
  const other=harness();other.session.observe(input);correction.deleted=true;
  assert.equal(other.session.finish({contexts:other.contexts,settings}).targetCandidatePairs,3);
});

test('incomplete profiles and missing authorized context block fan-out without shrinking the current/fallback denominator',()=>{
  for(const missing of ['profile','context']){
    const h=harness();h.session.observe(event());const contexts=[...h.contexts];
    if(missing==='profile')contexts[1].profileDiscovery.profileObservation.complete=false;else contexts.splice(1,1);
    const result=h.session.finish({contexts});assert.equal(result.totalManagedTargets,3);assert.equal(result.blockedTargets,3);assert.equal(result.unresolvedTargets,3);
    assert.equal(result.completeOwnedIndex,false);assert.equal(result.mappedTargets,0);assert.equal(result.acceptedSourceReads,1);
    assert.equal(result.missingAccountContexts,missing==='context'?1:0);
  }
});

test('expired cycle keeps denominator and original observation clocks without a late fan-out or cache revival',()=>{
  const h=harness();h.session.observe(event());h.advance(64000);const result=h.session.finish({contexts:h.contexts});
  assert.equal(result.reason,'finalization_deadline');assert.equal(result.totalManagedTargets,3);assert.equal(result.unresolvedTargets,3);assert.equal(result.mappingPasses,0);
  assert.equal(result.acceptedSourceReads,1);assert.equal(result.expiredSources,1);assert.equal(result.retainedSources,0);
  assert.equal(result.originalObservedAtMin,T+10);assert.equal(result.originalObservedAtMax,T+10);assert.equal(result.checkedAt,null);
});

test('source/byte and target-observation budgets are explicit and never drop managed targets',()=>{
  const first=harness();first.session.observe(event());const bytes=first.session.finish({contexts:first.contexts}).retainedEvidenceBytes;
  for(const extra of [{maxSources:1},{maxRetainedEvidenceBytes:bytes}]){
    const h=harness(extra);h.session.observe(event());h.session.observe(event('second'));const result=h.session.finish({contexts:h.contexts});
    assert.equal(result.retainedSources,1);assert.equal(result.totalManagedTargets,3);
    assert.equal(result.sourceCapacityRefusals+result.byteBudgetRefusals,1);
  }
  const h=harness({maxTargetObservationVisits:3});h.session.observe(event());const result=h.session.finish({contexts:h.contexts});
  assert.equal(result.mappingTargetObservationVisits,3);assert.equal(result.omittedMappingCardObservations,0);assert.equal(result.totalManagedTargets,3);
  assert.equal(result.mappingTargetObservationVisitUpperBound,6);assert.equal(result.omittedTargetObservationVisits,3);
  assert.equal(result.mappingStopped,true);assert.equal(result.mappingStoppedReason,'actual_visit_limit');
});

test('the real observer indexes later retained cards instead of clipping by the naive Cartesian bound',()=>{
  const h=harness({maxTargetObservationVisits:3});
  const names=['AAAAAAA','BBBBBBB','CCCCCCC'];
  h.contexts.forEach((context,index)=>{
    context.activeItems[0].title=names[index];
    context.profileDiscovery.profileObservation.cards[0].title=names[index];
  });
  const input=event('source',['noise-x','noise-y','noise-z','match-a','match-b','match-c']);
  input.recommendationReceipt.cards.forEach((card,index)=>{card.title=index<3?['XXXXXXX','YYYYYYY','ZZZZZZZ'][index]:names[index-3];});
  h.session.observe(input);const result=h.session.finish({contexts:h.contexts});
  assert.equal(result.retainedCardObservations,6);assert.equal(result.mappingTargetObservationVisitUpperBound,18);
  assert.equal(result.mappingTargetObservationVisits,3);assert.equal(result.mappedTargets,3);assert.equal(result.targetCandidatePairs,3);
  assert.equal(result.mappingStopped,false);assert.equal(result.omittedMappingCardObservations,0);assert.equal(result.omittedTargetObservationVisits,0);
  assert.equal(result.actualIndexedWorkUnits,result.indexBuildPostingVisits+result.indexQueryPostingVisits+result.mappingTargetObservationVisits);
  assert.equal(result.totalManagedTargets,3);assert.equal(result.completeComparisons,0);assert.equal(result.checkedAt,null);
});

test('conflicting body/receipt binding and cached body are unavailable; aggregate output cannot leak source content',()=>{
  const h=harness(),input=event();
  for(const changed of [{...input,page:{...input.page,fromCache:true}},{...input,page:{...input.page,url:url('wrong')}},
    {...input,recommendationReceipt:{...input.recommendationReceipt,observedAt:new Date(T+11).toISOString()}}])h.session.observe(changed);
  h.session.observe(input);const result=h.session.finish({contexts:h.contexts});assert.equal(result.rejectedSources,3);assert.equal(result.acceptedSourceReads,1);
  const output=JSON.stringify(result);for(const sentinel of [title,'新品 未使用','own-a','closed-b','https://',hash(input.page.html)])assert.equal(output.includes(sentinel),false,sentinel);
});

test('aggregate separates recall prices and exact observed detail field availability without claiming strict evidence',()=>{
  const h=harness();h.session.observe(event('own-a',['candidate','unknown']));
  const candidate=event('candidate',['candidate','unknown']);
  for(const card of candidate.recommendationReceipt.cards)if(card.id==='unknown'){card.price=null;card.priceKind='unknown';}
  h.session.observe(candidate);
  const result=h.session.finish({contexts:h.contexts});
  assert.equal(result.uniqueCandidateIds,2);assert.equal(result.targetCandidatePairs,6);
  assert.equal(result.currentOwnDetailFieldTargets,1);assert.equal(result.missingOwnDetailFieldTargets,2);
  assert.equal(result.mappedTargetsWithBothObservedDetailFields,1);assert.equal(result.mappedPairsWithBothObservedDetailFields,1);
  assert.equal(result.mappedPairsMissingOwnObservedDetailFields,4);assert.equal(result.mappedPairsMissingCandidateObservedDetailFields,3);
  assert.equal(result.lowerListedPricePairs,3);assert.equal(result.unknownListedPricePairs,3);assert.equal(result.notLowerListedPricePairs,0);
  assert.equal(result.conflictingCardPairs,3);assert.equal(result.saleTermsVerificationPendingPairs,6);assert.equal(result.saleTermsVerifiedPairs,0);
  assert.deepEqual(result.bodyFieldPresenceByCardPrice,{
    both:{lower:1,not_lower:0,unknown:0,conflicting:0},own_only:{lower:0,not_lower:0,unknown:0,conflicting:1},
    candidate_only:{lower:2,not_lower:0,unknown:0,conflicting:0},neither:{lower:0,not_lower:0,unknown:0,conflicting:2}
  });
  assert.equal(result.detailInputAssessment,'retained_fields_only');assert.equal(result.completeComparisons,0);assert.equal(result.unresolvedTargets,3);
});


test('already-read pages map in the bounded post-source tail while late bodies and failed phases cannot add work',()=>{
  const h=harness();h.session.observe(event());h.advance(61000);
  const result=h.session.finish({contexts:h.contexts});assert.equal(result.mappingPasses,1);assert.equal(result.mappedTargets,3);
  assert.equal(result.originalObservedAtMin,T+10);assert.equal(result.retainedSources,1);assert.equal(result.maxPostScanMs,5000);
  const late=harness();late.advance(60000);late.session.observe(event('late',['candidate'],T+60_001));
  assert.equal(late.session.finish({contexts:late.contexts}).acceptedSourceReads,0);
  const lateCallback=harness();lateCallback.advance(60000);lateCallback.session.observe(event());
  assert.equal(lateCallback.session.finish({contexts:lateCallback.contexts}).acceptedSourceReads,0);
  const failed=harness();failed.session.observe(event());const blocked=failed.session.finish({contexts:failed.contexts,scanPhaseFailed:true});
  assert.equal(blocked.reason,'scan_phase_failed');assert.equal(blocked.mappingPasses,0);assert.equal(blocked.totalManagedTargets,3);assert.equal(blocked.originalObservedAtMin,T+10);
});

test('local mapping wall-time budget stops fan-out explicitly without changing denominator or original clocks',()=>{
  let clock=0;const h=harness({mappingClock:()=>clock+=600});h.session.observe(event());
  const result=h.session.finish({contexts:h.contexts});assert.equal(result.reason,'local_mapping_budget');assert.equal(result.mappingStopped,true);
  assert.equal(result.mappingActualTargetObservationVisits,0);assert.equal(result.omittedTargetObservationVisits,6);
  assert.equal(result.unresolvedTargets,3);assert.equal(result.originalObservedAtMin,T+10);assert.equal(result.completeComparisons,0);
});


test('the short local tail never extends the original twenty-minute body TTL',()=>{
 const h=harness({deadlineAt:T+30*60_000});h.session.observe(event());h.advance(20*60_000);
 const result=h.session.finish({contexts:h.contexts});assert.equal(result.acceptedSourceReads,1);assert.equal(result.retainedSources,0);
 assert.equal(result.expiredSources,1);assert.equal(result.mappedTargets,0);assert.equal(result.originalObservedAtMin,T+10);assert.equal(result.unresolvedTargets,3);
});

test('unsupported targets remain in the denominator without consuming Yahoo inner-loop visit budget',()=>{
 const h=harness({maxTargetObservationVisits:6});const extra={account:{id:'r',platform:'rakuma'},activeItems:[{id:'r1',platform:'rakuma'}],previousItems:[],previousById:new Map()};
 h.accounts.push(extra.account);h.contexts.push(extra);h.session.observe(event());
 const result=h.session.finish({contexts:h.contexts});assert.equal(result.totalManagedTargets,4);assert.equal(result.mappingEligibleTargets,3);
 assert.equal(result.mappingTargetObservationVisitUpperBound,6);assert.equal(result.mappingTargetObservationVisits,6);assert.equal(result.omittedMappingCardObservations,0);
 assert.equal(result.blockedTargets,1);assert.equal(result.targetCandidatePairs,6);assert.equal(result.unresolvedTargets,4);
});


test('pending own roots distinguish low listed prices, unknown prices and only non-low recall',()=>{
 for(const kind of ['lower','unknown','not_lower']){
  const h=harness(),input=event('candidate',['candidate']);
  for(const card of input.recommendationReceipt.cards){card.price=kind==='lower'?28000:kind==='not_lower'?35000:null;card.priceKind=kind==='unknown'?'unknown':'ordinary';}
  h.session.observe(input);const result=h.session.finish({contexts:h.contexts});
  assert.equal(result.recalledPendingOwnRoots,3);
  assert.equal(result.lowerLinkedPendingOwnRoots,kind==='lower'?3:0);
  assert.equal(result.unknownPriceLinkedPendingOwnRoots,kind==='unknown'?3:0);
  assert.equal(result.notLowerOnlyPendingOwnRoots,kind==='not_lower'?3:0);
  assert.equal(result.bodyFieldPresenceByCardPrice.candidate_only[kind],3);
  assert.equal(Object.values(result.bodyFieldPresenceByCardPrice).flatMap(Object.values).reduce((sum,value)=>sum+value,0),3);
  assert.equal(result.saleTermsVerifiedPairs,0);assert.equal(result.completeComparisons,0);
 }
});
