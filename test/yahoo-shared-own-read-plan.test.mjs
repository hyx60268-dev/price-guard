import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createSharedOwnReadPlan} from '../scripts/lib/yahoo-shared-own-read-plan.mjs';
import {buildOwnedOffers} from '../public/owned-offers.js';

const START=Date.parse('2026-10-18T06:00:00Z'),END=START+12*60_000;
const url=id=>`https://paypayfleamarket.yahoo.co.jp/item/${id}`;
const hash=value=>createHash('sha256').update(value).digest('hex');
function bundle(id,{price=8000,sellerId='external-seller',status='OPEN'}={}){
  const detail={id,title:'APEX フィギュア 新品 1点',description:'新品 未使用 フィギュア1点',price,status,
    seller:{id:sellerId},images:[`https://images.example.invalid/${id}-1.jpg`,`https://images.example.invalid/${id}-2.jpg`]};
  const shipping={shippingKnown:true,shippingJPY:0,currency:'JPY',shippingSource:'target_price_area'};
  return {detail,shipping,sourceUrl:url(id),fromCache:false,observedAt:START+2000,
    originalObservation:{version:1,kind:'original_yahoo_detail_body',url:url(id),status:200,redirected:false,
      observedAt:START+2000,bodySha256Scope:'decoded_response_html_utf8',bodySha256:'a'.repeat(64),
      parsedSha256:hash(JSON.stringify({detail,shipping}))}};
}
function redigest(value){value.originalObservation.parsedSha256=hash(JSON.stringify({detail:value.detail,shipping:value.shipping}));}
function fixture(options={}){
  let at=START+10000;
  const accounts=['melon','boss','momoka'].map(id=>({id,platform:'yahoo',sellerId:`owner-${id}`,
    profileUrl:`https://paypayfleamarket.yahoo.co.jp/user/owner-${id}`}));
  const targets=accounts.flatMap(account=>Array.from({length:3},(_,index)=>{
    const id=`${account.id}-${index}`,image=`https://images.example.invalid/${id}.jpg`;
    const item={id,accountId:account.id,platform:'yahoo',sellerId:account.sellerId,title:'APEX フィギュア 新品 1点',image,ownPrice:10000,itemStatus:'OPEN',url:url(id)};
    item.profileCard={id,accountId:account.id,sellerId:account.sellerId,title:item.title,imageUrl:image,priceJPY:10000,
      itemStatus:'OPEN',source:'current_profile_card',observedAt:START+1000,profileUrl:account.profileUrl,pageUrl:account.profileUrl+'?page=1',pageNumber:1};
    return item;
  }));
  const bundles=new Map(),images=new Map();
  const rows=targets.map(item=>{
    const id=`external-${item.id}`,original=bundle(id);bundles.set(id,original);
    for(const image of original.detail.images)images.set(image,{status:'available',contentSha256:'b'.repeat(64),imageObservedAt:new Date(START+3000).toISOString(),imageCacheExpiresAt:END});
    const recall={id,card:{id,url:url(id),title:original.detail.title,image:original.detail.images[0],sellerId:'external-seller',price:8000,priceKind:'ordinary',currency:'JPY'},
      sources:[{id:'producer',url:url('producer'),observedAt:START+1000,expiresAt:END}],lowerListedPrice:true,titleSimilarity:.7};
    return {targetKey:`${item.accountId}:${item.id}`,accountId:item.accountId,status:'local_recall_only',reason:'requires_verification',candidates:[recall]};
  });
  const mapping={indexBuildComplete:true,mappingStopped:false,rows};
  const settings={ownedOffers:buildOwnedOffers(accounts,targets),ownedOffersComplete:true,matchCorrections:{},maxYahooImages:8};
  const plan=createSharedOwnReadPlan({accounts,peekBundle:id=>bundles.get(id)||null,peekFingerprintState:url=>images.get(url)||{status:'unavailable'},startedAt:START,deadlineAt:END,now:()=>at,...options});
  const observe=()=>plan.observeMapping(mapping,{targets,strictSettings:settings});
  observe();return {plan,accounts,targets,bundles,images,mapping,settings,observe,setTime:value=>{at=value;}};
}
function addCandidate(f,row,{id,price=500,titleSimilarity=.35,sameImageUrl=false,historicalIdentity=null}={}){
  const value=bundle(id,{price});f.bundles.set(id,value);
  for(const url of value.detail.images)f.images.set(url,{status:'available',contentSha256:'b'.repeat(64),
    imageObservedAt:new Date(START+3000).toISOString(),imageCacheExpiresAt:END});
  const recall=structuredClone(row.candidates[0]);
  Object.assign(recall,{id,titleSimilarity,sameImageUrl,historicalIdentity,identityVerified:false,canRecommend:false});
  Object.assign(recall.card,{id,url:url(id),price,image:value.detail.images[0]});
  row.candidates.push(recall);return recall;
}

test('three-account round robin claims six distinct roots, without reads or accepted prices',t=>{
  t.mock.method(globalThis,'fetch',()=>{throw Error('planner must not fetch');});
  const f=fixture(),claimed=Array.from({length:6},()=>f.plan.claim());
  assert.deepEqual(claimed.map(row=>row.item.accountId),['melon','boss','momoka','melon','boss','momoka']);
  assert.equal(new Set(claimed.map(row=>row.item.accountId+':'+row.item.id)).size,6);
  assert.equal(f.plan.claim(),null);assert.equal(f.plan.statistics().claimedRoots,6);
  assert.equal(f.plan.statistics().marketplaceRequests,0);assert.equal(f.plan.statistics().imageRequests,0);
  assert.equal(f.plan.statistics().canRecommend,false);assert.equal(f.plan.statistics().completeComparisons,0);
  assert.equal(claimed[0].recall.sources[0].observedAt,START+1000);
  assert.equal(claimed[0].profileCard.observedAt,START+1000);
  assert.equal(Object.hasOwn(claimed[0],'checkedAt'),false);
});

test('explicit account claims and repeated mappings never reset total, per-account or per-root quotas',()=>{
  const f=fixture();
  const first=f.plan.claim('melon');assert.ok(first);f.observe();
  const second=f.plan.claim('melon');assert.ok(second);assert.notEqual(first.item.id,second.item.id);
  f.observe();assert.equal(f.plan.claim('melon'),null);
  assert.ok(f.plan.claim('boss'));f.observe();assert.ok(f.plan.claim('boss'));assert.equal(f.plan.claim('boss'),null);
  assert.ok(f.plan.claim('momoka'));f.observe();assert.ok(f.plan.claim('momoka'));assert.equal(f.plan.claim(),null);
  assert.equal(f.plan.statistics().claimedRoots,6);
});

test('duplicate root/pair rows cannot reserve the same root twice',()=>{
  const f=fixture();f.mapping.rows=[f.mapping.rows[0],structuredClone(f.mapping.rows[0])];f.observe();
  assert.equal(f.plan.statistics().bodyCosts.candidate_only.lower,1);assert.equal(f.plan.statistics().eligibleRoots,1);
  assert.ok(f.plan.claim('melon'));assert.equal(f.plan.claim('melon'),null);assert.equal(f.plan.statistics().claimedRoots,1);
});

test('in-flight roots are skipped without spending quota or dropping their later turn',()=>{
  const f=fixture();f.mapping.rows=f.mapping.rows.slice(0,2);f.observe();
  const blocked=new Set([f.mapping.rows[0].targetKey]);
  const next=f.plan.claim('melon',{blockedTargetKeys:blocked});assert.equal(next.item.id,f.targets[1].id);
  assert.equal(f.plan.statistics().claimedRoots,1);assert.equal(f.plan.claim('melon',{blockedTargetKeys:blocked}),null);
  assert.equal(f.plan.statistics().claimedRoots,1);blocked.clear();
  assert.equal(f.plan.claim('melon',{blockedTargetKeys:blocked}).item.id,f.targets[0].id);
  assert.equal(f.plan.statistics().claimedRoots,2);
});

test('an entirely in-flight account cannot prevent a different account from receiving a turn',()=>{
  const f=fixture(),blockedTargetKeys=new Set(f.mapping.rows.filter(row=>row.accountId==='melon').map(row=>row.targetKey));
  assert.equal(f.plan.claim(undefined,{blockedTargetKeys}).item.accountId,'boss');
  assert.equal(f.plan.statistics().claimedRoots,1);
});

test('returned snapshots cannot mutate planner source bindings, ownership or corrections',()=>{
  const f=fixture(),first=f.plan.claim('melon');first.item.profileCard.priceJPY=1;first.profileCard.title='changed';
  first.recall.card.price=1;first.recall.sources[0].observedAt=0;first.settings.ownedOffers.yahoo.items.clear();first.settings.matchCorrections.any={deleted:false};
  assert.equal(f.targets[0].profileCard.priceJPY,10000);assert.equal(f.mapping.rows[0].candidates[0].card.price,8000);
  assert.equal(f.mapping.rows[0].candidates[0].sources[0].observedAt,START+1000);assert.ok(f.settings.ownedOffers.yahoo.items.size);
  assert.deepEqual(f.settings.matchCorrections,{});assert.ok(f.plan.claim('melon'));
});

test('all four actual-original cost classes remain separate from unknown and conflicting prices',()=>{
  const f=fixture();f.mapping.rows=f.mapping.rows.slice(0,4);
  const [both,ownOnly,candidateOnly,neither]=f.targets;
  f.bundles.set(both.id,bundle(both.id,{sellerId:both.sellerId,price:10000}));
  f.bundles.set(ownOnly.id,bundle(ownOnly.id,{sellerId:ownOnly.sellerId,price:10000}));
  f.bundles.delete(f.mapping.rows[1].candidates[0].id);f.bundles.delete(f.mapping.rows[3].candidates[0].id);
  f.mapping.rows[1].candidates[0].lowerListedPrice=null;f.mapping.rows[1].candidates[0].card.price=null;
  f.mapping.rows[3].candidates[0].conflictingCardObservations=true;f.observe();
  assert.deepEqual(f.plan.statistics().bodyCosts,{both:{lower:1,not_lower:0,unknown:0,conflicting:0},
    own_only:{lower:0,not_lower:0,unknown:1,conflicting:0},candidate_only:{lower:1,not_lower:0,unknown:0,conflicting:0},
    neither:{lower:0,not_lower:0,unknown:0,conflicting:1}});
  assert.equal(f.plan.claim('melon').item.id,candidateOnly.id);assert.equal(f.plan.claim(),null);
});

for(const change of ['sold','price','description','shipping','seller','digest','source_time','missing_original','missing_secondary_image','expired_image','future_image','changed_image'])
test(`claim rechecks candidate ${change} before an own read can be admitted`,()=>{
  const f=fixture();f.mapping.rows=[f.mapping.rows[0]];f.observe();
  const id=f.mapping.rows[0].candidates[0].id,value=f.bundles.get(id),image=f.images.get(value.detail.images[1]);
  if(change==='sold')value.detail.status='SOLD';
  if(change==='price')value.detail.price=12000;
  if(change==='description')value.detail.description='';
  if(change==='shipping')value.shipping.shippingJPY=500;
  if(change==='seller')value.detail.seller.id='owner-boss';
  if(change==='digest')value.originalObservation.parsedSha256='0'.repeat(64);
  if(change==='source_time'){value.observedAt=START-1;value.originalObservation.observedAt=START-1;}
  if(change==='missing_original')f.bundles.delete(id);
  if(change==='missing_secondary_image')f.images.delete(value.detail.images[1]);
  if(change==='expired_image')image.imageCacheExpiresAt=START+10000;
  if(change==='future_image')image.imageObservedAt=new Date(START+11000).toISOString();
  if(change==='changed_image')image.status='unavailable';
  if(['sold','price','description','shipping','seller'].includes(change))redigest(value);
  assert.equal(f.plan.claim('melon'),null);assert.equal(f.plan.statistics().claimedRoots,0);
});

for(const change of ['own_already_read','own_price','profile_price','profile_sold','profile_old','ownership_incomplete','owned_candidate','correction'])
test(`claim fails closed after ${change} changes without remapping`,()=>{
  const f=fixture();f.mapping.rows=[f.mapping.rows[0]];f.observe();const item=f.targets[0],id=f.mapping.rows[0].candidates[0].id;
  if(change==='own_already_read')f.bundles.set(item.id,bundle(item.id));
  if(change==='own_price')item.ownPrice=11000;
  if(change==='profile_price')item.profileCard.priceJPY=11000;
  if(change==='profile_sold')item.profileCard.itemStatus='SOLD';
  if(change==='profile_old')item.profileCard.observedAt=START-1;
  if(change==='ownership_incomplete')f.settings.ownedOffersComplete=false;
  if(change==='owned_candidate')f.settings.ownedOffers.yahoo.items.add(id);
  if(change==='correction')f.settings.matchCorrections.reject={accountId:item.accountId,itemId:item.id,platform:'yahoo',candidateId:id,deleted:false};
  assert.equal(f.plan.claim('melon'),null);assert.equal(f.plan.statistics().claimedRoots,0);
});

test('a correction tombstone does not suppress a root, but a current account-specific correction does',()=>{
  const f=fixture();f.mapping.rows=[f.mapping.rows[0]];const item=f.targets[0],id=f.mapping.rows[0].candidates[0].id;
  f.settings.matchCorrections.deleted={accountId:item.accountId,itemId:item.id,platform:'yahoo',candidateId:id,deleted:true};
  f.settings.matchCorrections.other={accountId:'boss',itemId:item.id,platform:'yahoo',candidateId:id,deleted:false};f.observe();
  assert.ok(f.plan.claim('melon'));
});

for(const change of ['conflicting','unknown','not_lower','nonordinary','candidate_not_lower','unretained_fields_only','expired_recall','partial_mapping'])
test(`${change} is never scheduled as a one-read lower-price root`,()=>{
  const f=fixture();f.mapping.rows=[f.mapping.rows[0]];const row=f.mapping.rows[0],recall=row.candidates[0];
  if(change==='conflicting')recall.conflictingCardObservations=true;
  if(change==='unknown'){recall.lowerListedPrice=null;recall.card.price=null;}
  if(change==='not_lower'){recall.lowerListedPrice=false;recall.card.price=11000;}
  if(change==='nonordinary')recall.card.priceKind='conditional';
  if(change==='candidate_not_lower'){f.bundles.get(recall.id).detail.price=11000;redigest(f.bundles.get(recall.id));}
  if(change==='unretained_fields_only')delete f.bundles.get(recall.id).originalObservation;
  if(change==='expired_recall')recall.sources[0].expiresAt=START+10000;
  if(change==='partial_mapping')row.mappingIncomplete=true;
  f.observe();assert.equal(f.plan.claim('melon'),null);
});

test('hasRecall distinguishes a completed no-hit row from unmapped, partial and invalid targets',()=>{
  const f=fixture();const a=f.mapping.rows[0],b=f.mapping.rows[1],c=f.mapping.rows[2];
  a.candidates=[];a.status='unresolved';a.reason='no_local_mapping';b.mappingIncomplete=true;
  c.candidates=[];c.status='blocked';c.reason='local_mapping_budget';f.observe();
  assert.equal(f.plan.hasRecall(a.targetKey),false);assert.equal(f.plan.hasRecall(b.targetKey),null);
  assert.equal(f.plan.hasRecall(c.targetKey),null);assert.equal(f.plan.hasRecall('missing'),null);
  assert.equal(f.plan.hasRecall(f.mapping.rows[3].targetKey),true);
  f.targets[0].ownPrice=12000;assert.equal(f.plan.hasRecall(a.targetKey),null);
});

test('source deadline and zero quota prevent claims without pretending that requests were attempted',()=>{
  const f=fixture();f.setTime(END);assert.equal(f.plan.claim(),null);assert.equal(f.plan.hasRecall(f.mapping.rows[0].targetKey),null);
  assert.equal(f.plan.statistics().claimedRoots,0);assert.equal(f.plan.statistics().marketplaceRequests,0);
  const disabled=fixture({maxRoots:0});assert.equal(disabled.plan.claim(),null);
});

test('caller current-recall guard can revoke new rail conflicts or source holds without another full mapping',()=>{
  let allowed=true;const f=fixture({isRecallCurrent:()=>allowed});allowed=false;
  assert.equal(f.plan.claim('melon'),null);assert.equal(f.plan.statistics().claimedRoots,0);
  assert.equal(f.plan.statistics().reasons.recall_no_longer_current,3);
});

test('statistics contain counts and account ordinals, never item IDs, titles, source URLs or descriptions',()=>{
  const f=fixture();f.plan.claim();const serialized=JSON.stringify(f.plan.statistics());
  for(const value of ['melon','boss','momoka','external-','https://','APEX','新品'])assert.equal(serialized.includes(value),false,value);
});

test('the first-version root and per-account ceilings cannot be raised through constructor options',()=>{
  for(const options of [{maxRoots:7},{maxPerAccount:3},{maxRoots:Infinity},{maxRoots:1.5},{maxPerAccount:-1}])
    assert.throws(()=>fixture(options),/invalid_shared_own_read_plan/);
  assert.equal(fixture({maxRoots:6,maxPerAccount:2}).plan.statistics().maximumRoots,6);
});

test('500 cheap broad candidate associations cannot displace a stronger historical lower-price link on one root',()=>{
  const f=fixture();f.mapping.rows=[f.mapping.rows[0]];const row=f.mapping.rows[0],known=row.candidates[0];
  known.historicalIdentity={source:'accepted_detail_pair',accountId:'melon',own:{id:f.targets[0].id},candidate:{id:known.id}};
  known.titleSimilarity=.4;known.identityVerified=false;known.canRecommend=false;
  for(let index=0;index<500;index++)addCandidate(f,row,{id:`cheap-${String(index).padStart(3,'0')}`,price:500});
  row.candidates.reverse();f.observe();const root=f.plan.claim('melon');
  assert.equal(root.recall.id,known.id);assert.equal(root.recall.card.price,8000);
  assert.equal(root.recall.identityVerified,false);assert.equal(root.recall.canRecommend,false);
  assert.equal(Object.hasOwn(root,'offer'),false);assert.equal(Object.hasOwn(root,'verification'),false);
  assert.equal(f.plan.hasRecall(row.targetKey),true);assert.equal(row.candidates.length,501,'ordering cannot discard discovery obligations');
});

test('500 cheap broad roots cannot crowd a stronger known lower-price association out of the bounded root queue',()=>{
  const f=fixture();f.mapping.rows=[f.mapping.rows[0]];const strong=f.targets[0],strongRow=f.mapping.rows[0];
  strongRow.candidates[0].historicalIdentity={source:'accepted_detail_pair',accountId:'melon',own:{id:strong.id},candidate:{id:strongRow.candidates[0].id}};
  for(let index=0;index<500;index++){
    const id=`broad-own-${index}`,item=structuredClone(strong),row=structuredClone(strongRow);
    Object.assign(item,{id,url:url(id),image:`https://images.example.invalid/${id}.jpg`});
    Object.assign(item.profileCard,{id,imageUrl:item.image});
    Object.assign(row,{targetKey:`melon:${id}`,candidates:[structuredClone(strongRow.candidates[0])]});
    const weak=addCandidate(f,row,{id:`broad-external-${index}`,price:500});row.candidates=[weak];
    f.targets.push(item);f.settings.ownedOffers.yahoo.items.add(id);f.mapping.rows.unshift(row);
  }
  f.observe();assert.equal(f.plan.claim('melon').item.id,strong.id);
  assert.ok(f.plan.statistics().pendingRoots<=3,'root evidence retention remains bounded');
  assert.equal(f.mapping.rows.length,501,'all original discovery obligations survive selection');
});

for(const [name,first,second] of [
  ['historical link before same URL',{historicalIdentity:{source:'accepted_detail_pair'},titleSimilarity:.35,price:8000},{sameImageUrl:true,titleSimilarity:.99,price:500}],
  ['same URL before stronger title',{sameImageUrl:true,titleSimilarity:.35,price:8000},{titleSimilarity:.99,price:500}],
  ['stronger title before price',{titleSimilarity:.9,price:8000},{titleSimilarity:.35,price:500}],
  ['price breaks equal evidence',{titleSimilarity:.9,price:500},{titleSimilarity:.9,price:8000}],
  ['stable ID breaks equal price',{titleSimilarity:.9,price:500},{titleSimilarity:.9,price:500}],
])test(`candidate order uses ${name}, without accepting either candidate`,()=>{
  const f=fixture();f.mapping.rows=[f.mapping.rows[0]];const row=f.mapping.rows[0];
  const expected=addCandidate(f,row,{id:'a-priority',...first}),other=addCandidate(f,row,{id:'z-other',...second});
  row.candidates=[other,expected];f.observe();const root=f.plan.claim('melon');
  assert.equal(root.recall.id,'a-priority');assert.equal(root.recall.identityVerified,false);assert.equal(root.recall.canRecommend,false);
});

test('planning time is cumulative across mappings and unprocessed targets stay unknown',()=>{
 let ticks=0;const f=fixture({clock:()=>ticks++,maxPlanningDurationMs:6});
 assert.ok(f.plan.statistics().planningStops>0);assert.ok(f.plan.statistics().planningDurationMs>=6);
 assert.equal(f.plan.hasRecall('momoka:momoka-2'),null);
 const pairs=f.plan.statistics().planningPairs;f.observe();
 assert.equal(f.plan.statistics().planningPairs,pairs,'refresh cannot refill the planning CPU allowance');
 assert.equal(f.plan.hasRecall('melon:melon-0'),null,'discarded expired plan cannot become a no-hit discovery assertion');
 assert.equal(f.plan.claim(),null);
});
test('zero planning budget schedules no roots; no constructor can increase its one-second ceiling',()=>{
 const f=fixture({maxPlanningDurationMs:0});assert.equal(f.plan.claim(),null);assert.equal(f.plan.hasRecall('melon:melon-0'),null);
 assert.equal(f.plan.statistics().planningPairs,0);
 for(const maxPlanningDurationMs of [1001,-1,NaN,1.5])assert.throws(()=>fixture({maxPlanningDurationMs}),/invalid_shared_own_read_plan/);
});
for(const change of ['evict','description','image','correction'])test(`post-root evidence recheck catches candidate ${change} before image work`,()=>{
 const f=fixture(),root=f.plan.claim('melon');assert.equal(f.plan.candidateReadProblem(root),null);
 if(change==='evict')f.bundles.delete(root.recall.id);
 if(change==='description'){const row=f.bundles.get(root.recall.id);row.detail.description+=' 2個セット';redigest(row);}
 if(change==='image')f.images.delete(f.bundles.get(root.recall.id).detail.images[0]);
 if(change==='correction')f.settings.matchCorrections.reject={accountId:root.item.accountId,itemId:root.item.id,platform:'yahoo',candidateId:root.recall.id,deleted:false};
 assert.notEqual(f.plan.candidateReadProblem(root),null);
});
