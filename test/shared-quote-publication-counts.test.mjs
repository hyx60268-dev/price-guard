import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {countSharedQuoteRows,summarizeSharedQuotePublication} from '../scripts/lib/shared-quote-publication-counts.mjs';
import {writeOutputs,compactDashboardResult,scopeResultForPortalUser} from '../scripts/lib/publish.mjs';
import {sharedYahooTargetBinding,currentSharedYahooOffers} from '../public/shared-yahoo-offers.js';
import {buildOwnedOffers} from '../public/owned-offers.js';
import {PRICING_RULES_VERSION,pricingDecision} from '../public/pricing-policy.js';
import {pricingCoverage} from '../scripts/lib/pricing-coverage.mjs';
import {cycleCoverage} from '../scripts/lib/cycle-coverage.mjs';
import {decrypt} from '../scripts/lib/crypto.mjs';
import {pipeline,T,url} from './fixtures/shared-detail-pipeline.mjs';

const NOW=T+13000,iso=value=>new Date(value).toISOString();
const ordinary=(id,price=8000,sellerId='external-seller')=>({id,price,sellerId,url:url(id),matchMethod:'detail_type_quantity_text_images'});
const source=(candidates,checkedAt=iso(NOW))=>({rulesVersion:PRICING_RULES_VERSION,status:'incomplete',evidenceStatus:'incomplete',checkedAt,
 searchCheckedAt:iso(T-3600_000),lastAttemptAt:iso(T+5000),searchComplete:false,candidates});
const counts=result=>result.scanMeta.sharedDetailSummary.publicationCounts;
const failure={version:1,valid:false,reason:'summary_unavailable'};
function checkPrivacy(summary){
 for(const [key,value] of Object.entries(summary)){
  if(['version','valid','scope','evaluatedAt','reason'].includes(key))continue;
  assert.equal(typeof value,'number',key);assert.ok(Number.isSafeInteger(value)&&value>=0,key);
 }
 const text=JSON.stringify(summary);
 for(const secret of ['PRIVATE','external-offer','own-melon','seller-','https://','password','Error:'])assert.equal(text.includes(secret),false,secret);
}

test('snapshot counts deduplicate account + own ID + candidate ID, including repeated rows and targets',()=>{
 const first={accountId:'a',id:'same-own',platform:'yahoo',ownPrice:10000,sharedYahooOffers:[{id:'same',price:8000},{id:'same',price:8000}],yahoo:source([ordinary('same'),ordinary('same')])};
 const second={...first,accountId:'b',sharedYahooOffers:[{id:'same',price:8000}],yahoo:source([ordinary('same')],iso(NOW-7*3600_000))};
 const third={...first,id:'other-own',sharedYahooOffers:[{id:'different',price:12000}],yahoo:source([ordinary('ordinary-only')])};
 const items=[first,structuredClone(first),second,third],pre=[...items,{...first,sharedYahooOffers:[{id:'raw-hint'},{}]}];
 const result={items,accounts:[],matchCorrections:{}},original=structuredClone(result);
 const summary=summarizeSharedQuotePublication(result,{before:countSharedQuoteRows(pre),now:NOW});
 assert.deepEqual(summary,{version:1,valid:true,scope:'full_state_publication_preparation',evaluatedAt:iso(NOW),
  preFilterSharedRows:8,preFilterSharedPairs:4,preFilterSharedTargets:3,
  postFilterSharedRows:6,postFilterSharedPairs:3,postFilterSharedTargets:3,
  samePairAlreadyInOrdinaryStorage:2,pairsAbsentFromOrdinaryStorage:1,
  samePairEligibleInOrdinaryPricing:1,pairsAdditionalToEligibleOrdinaryPricing:2,
  sharedTargetsWithoutAnyStoredOrdinaryCandidate:0,sharedTargetsWithoutAnyEligibleOrdinaryQuote:1,lowerListedSharedPairs:2});
 assert.deepEqual(result,original);checkPrivacy(summary);
});

test('ordinary eligibility delegates to current pricing policy, ownership, corrections and source clocks',()=>{
 const base={accountId:'a',id:'own',platform:'yahoo',ownPrice:10000,sharedYahooOffers:[{id:'shared',price:8000}],yahoo:source([ordinary('shared')])};
 const result={accounts:[{id:'a',platform:'yahoo',sellerId:'owner'}],items:[base],matchCorrections:{}};
 const run=(item=base,extra={})=>summarizeSharedQuotePublication({...result,...extra,items:[item]},{before:countSharedQuoteRows([item]),now:NOW});
 assert.equal(run().samePairEligibleInOrdinaryPricing,1);
 const invalidSources=[{rulesVersion:PRICING_RULES_VERSION-1},{checkedAt:iso(NOW-6*3600_000-1)},{checkedAt:iso(NOW+60001)},
  {cacheReason:'request_error'},{status:'error',evidenceStatus:'error'}];
 for(const change of invalidSources){
  const summary=run({...base,yahoo:{...base.yahoo,...change}});
  assert.equal(summary.samePairAlreadyInOrdinaryStorage,1);assert.equal(summary.samePairEligibleInOrdinaryPricing,0,JSON.stringify(change));
 }
 for(const candidate of [{...ordinary('shared'),isOwn:true},{...ordinary('shared'),price:0},{...ordinary('shared'),matchMethod:null},{...ordinary('shared'),url:''}])
  assert.equal(run({...base,yahoo:source([candidate])}).samePairEligibleInOrdinaryPricing,0);
 const correction={accountId:'a',itemId:'own',platform:'yahoo',candidateId:'shared'};
 assert.equal(run(base,{matchCorrections:{reject:correction}}).samePairEligibleInOrdinaryPricing,0);
 assert.equal(run(base,{matchCorrections:{reject:{...correction,deleted:true}}}).samePairEligibleInOrdinaryPricing,1);
 assert.equal(run(base,{matchCorrections:{reject:{...correction,accountId:'other'}}}).samePairEligibleInOrdinaryPricing,1);
 assert.equal(run(base,{managedAccounts:[{id:'hidden',platform:'yahoo',sellerId:'external-seller'}]}).samePairEligibleInOrdinaryPricing,0);
 assert.equal(run(base,{listingHistory:{old:{id:'shared',accountId:'hidden',platform:'yahoo'}}}).samePairEligibleInOrdinaryPricing,0);
 const cached=run({...base,yahoo:{...base.yahoo,status:'cached',evidenceStatus:'incomplete'}});assert.equal(cached.samePairEligibleInOrdinaryPricing,1);
});

test('diagnostic failures use one fixed enum and empty shared output does not inspect ordinary candidates',()=>{
 for(const input of [null,{},[{id:'own',sharedYahooOffers:{PRIVATE:'private failure'}}],[{id:'own',sharedYahooOffers:[{id:'candidate'}]}]])
  assert.deepEqual(countSharedQuoteRows(input),failure);
 const before=countSharedQuoteRows([]);
 assert.deepEqual(summarizeSharedQuotePublication({}, {before,now:Infinity}),failure);
 assert.deepEqual(summarizeSharedQuotePublication({}, {before:failure,now:NOW}),failure);
 const candidate={id:'candidate',get price(){throw Error('PRIVATE_RAW_ERROR_WITH_URL_AND_CREDENTIAL');}};
 const item={accountId:'a',id:'own',platform:'yahoo',sharedYahooOffers:[{id:'candidate'}],yahoo:source([candidate])};
 assert.deepEqual(summarizeSharedQuotePublication({items:[item]},{before:countSharedQuoteRows([item]),now:NOW}),failure);
 const empty={accountId:'a',id:'own',get yahoo(){throw Error('unrelated ordinary candidates must not be inspected');}};
 assert.equal(summarizeSharedQuotePublication({items:[empty]},{before,now:NOW}).valid,true);
 checkPrivacy(failure);
});

function rebind(offer,item,{id=offer.id,price=offer.price,sellerId=offer.sellerId}={}){
 return {...structuredClone(offer),id,url:url(id),price,sellerId,target:sharedYahooTargetBinding(item),
  ownSource:{...offer.ownSource,url:url(item.id)},candidateSource:{...offer.candidateSource,url:url(id)}};
}
function protectedFields(result){
 return {checkedAt:result.checkedAt,dataRevision:result.dataRevision,cloudSyncedAt:result.cloudSyncedAt,cycleCoverage:result.cycleCoverage,
  manualCosts:result.manualCosts,matchCorrections:result.matchCorrections,
  items:result.items.map(item=>({accountId:item.accountId,id:item.id,yahoo:item.yahoo,xianyu:item.xianyu,
   ownPrice:item.ownPrice,recommendedPrice:item.recommendedPrice,lowestPrice:item.lowestPrice,priceSignal:item.priceSignal,costJPY:item.costJPY})),
  decisions:result.items.map(item=>pricingDecision(item,{now:NOW})),coverage:pricingCoverage(result.items,result.accounts)};
}
async function writeAndRead(t,result){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'publication-counts-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const password='local-counts-fixture-only',oldEnv=process.env.PORTAL_USERS_JSON;process.env.PORTAL_USERS_JSON='';
 try{await writeOutputs({root,result,previous:structuredClone(result),password});}
 finally{if(oldEnv===undefined)delete process.env.PORTAL_USERS_JSON;else process.env.PORTAL_USERS_JSON=oldEnv;}
 const read=async(file,key=password)=>JSON.parse(decrypt(await fs.readFile(path.join(root,file)),key));
 return {full:await read('state/latest.json.enc'),admin:await read('public/data/latest.json.enc'),
  member:result.portalUsers.length?await read('public/data/users/member/latest.json.enc','local-member-fixture'):null};
}

test('real writeOutputs counts actual filtering, preserves clocks/pricing, and scopes compact/member payloads',async t=>{
 const p=await pipeline(t),verified=await p.run();assert.equal(verified.status,'verified_single_offer');
 const first={...p.item,comparisonMode:'same_platform',recommendedPrice:7999,lowestPrice:8000,priceSignal:'lower',costJPY:3000,yahoo:source([ordinary(verified.offer.id),ordinary(verified.offer.id)])};
 const second={...first,accountId:'boss',sellerId:'seller-boss',yahoo:source([ordinary(verified.offer.id)],iso(NOW-7*3600_000))};
 const third={...first,id:'other-own',url:url('other-own'),yahoo:source([ordinary('ordinary-only')])};
 const fourth={...first,id:'new-target',accountId:'momoka',sellerId:'seller-momoka',url:url('new-target'),yahoo:source([])};
 first.sharedYahooOffers=[rebind(verified.offer,first),rebind(verified.offer,first),{...p.input.recall.card,id:'raw-hint',canRecommend:false},
  rebind(verified.offer,first,{id:'managed-owned',sellerId:'hidden-owner'}),rebind(verified.offer,first,{id:'history-owned'}),
  {...rebind(verified.offer,first,{id:'expired'}),checkedAt:iso(NOW-20*60000)},rebind(verified.offer,first,{id:'corrected'}),
  {...rebind(verified.offer,first,{id:'wrong-binding'}),target:{...sharedYahooTargetBinding(first),accountId:'PRIVATE_WRONG_ACCOUNT'}}];
 second.sharedYahooOffers=[rebind(verified.offer,second)];
 third.sharedYahooOffers=[rebind(verified.offer,third,{id:'different',price:12000})];
 fourth.sharedYahooOffers=[rebind(verified.offer,fourth,{id:'additional',price:7000})];
 const result={version:6,checkedAt:iso(NOW-2000),dataRevision:iso(NOW-1000),cloudSyncedAt:iso(T-1000),settings:{exchangeRate:20,costMultiplier:1,profitWarningJPY:1500},
  accounts:structuredClone(p.accounts),items:[first,second,third,fourth],scanMeta:{startedAt:iso(T),sharedDetailSummary:{verifiedPairs:77}},
  managedAccounts:[{id:'PRIVATE_HIDDEN_ACCOUNT',platform:'yahoo',sellerId:'hidden-owner'}],
  listingHistory:{old:{id:'history-owned',accountId:'PRIVATE_HIDDEN_ACCOUNT',platform:'yahoo'}},
  matchCorrections:{reject:{accountId:first.accountId,itemId:first.id,platform:'yahoo',candidateId:'corrected'},
   tombstone:{accountId:first.accountId,itemId:first.id,platform:'yahoo',candidateId:verified.offer.id,deleted:true},
   other:{accountId:'PRIVATE_OTHER_ACCOUNT',itemId:first.id,platform:'yahoo',candidateId:verified.offer.id}},
  manualCosts:{cost:{accountId:first.accountId,itemId:first.id,purchaseCNY:123,shippingJPY:500,updatedAt:iso(T-5000)}},
  portalUsers:[{username:'member',displayName:'Member',password:'local-member-fixture',accountIds:['melon'],enabled:true}],portalPreferences:{},relistAliases:{}};
 result.cycleCoverage=cycleCoverage(result.items,result.accounts,{startedAt:T,finishedAt:NOW});
 const protectedBefore=structuredClone(protectedFields(result)),readsBefore=p.counts(),published=await writeAndRead(t,result);
 assert.deepEqual(p.counts(),readsBefore,'publication diagnostics must not fetch sources');
 assert.deepEqual(protectedFields(published.full),protectedBefore);
 const summary=counts(published.full);
 assert.deepEqual(summary,{version:1,valid:true,scope:'full_state_publication_preparation',evaluatedAt:iso(NOW),
  preFilterSharedRows:11,preFilterSharedPairs:10,preFilterSharedTargets:4,
  postFilterSharedRows:4,postFilterSharedPairs:4,postFilterSharedTargets:4,
  samePairAlreadyInOrdinaryStorage:2,pairsAbsentFromOrdinaryStorage:2,
  samePairEligibleInOrdinaryPricing:1,pairsAdditionalToEligibleOrdinaryPricing:3,
  sharedTargetsWithoutAnyStoredOrdinaryCandidate:1,sharedTargetsWithoutAnyEligibleOrdinaryQuote:2,lowerListedSharedPairs:3});
 checkPrivacy(summary);
 assert.deepEqual(counts(published.admin),summary);assert.deepEqual(counts(result),summary);
 assert.equal(result.scanMeta.sharedDetailSummary.outputOffers,summary.postFilterSharedRows);
 assert.equal(result.scanMeta.sharedDetailSummary.outputOfferTargets,summary.postFilterSharedTargets);
 assert.equal(result.scanMeta.sharedDetailSummary.verifiedPairs,77);
 assert.equal(published.member.scanMeta.sharedDetailSummary.publicationCounts,undefined);
 assert.equal(published.member.scanMeta.sharedDetailSummary.verifiedPairs,77);
 assert.equal(published.member.items.length,2);assert.ok(published.member.items.every(item=>item.accountId==='melon'));
 assert.equal(JSON.stringify(published.member).includes('PRIVATE_'),false);
 const scoped=scopeResultForPortalUser(published.full,{username:'member',accountIds:['melon']});
 assert.equal(scoped.scanMeta.sharedDetailSummary.publicationCounts,undefined);assert.deepEqual(counts(published.full),summary,'scoping does not mutate the administrator snapshot');
 for(const row of published.full.items){
  const retained=row.sharedYahooOffers[0];assert.equal(retained.checkedAt,verified.offer.checkedAt);assert.equal(retained.ownObservedAt,verified.offer.ownObservedAt);
  assert.equal(retained.identityVerifiedAt,verified.offer.identityVerifiedAt);assert.equal(retained.cycleStartedAt,verified.offer.cycleStartedAt);
  assert.deepEqual(retained.imageEvidence,verified.offer.imageEvidence);
 }
 const expired=compactDashboardResult(published.full,{now:NOW+20*60000});
 assert.ok(expired.items.every(item=>item.sharedYahooOffers.length===0));
 assert.deepEqual(counts(expired),summary,'a preparation count is not silently refreshed into a current visibility claim');
 assert.deepEqual(expired.items.map(item=>item.yahoo.checkedAt),published.full.items.map(item=>item.yahoo.checkedAt));
 const ownership=buildOwnedOffers(published.full.accounts,published.full.items);
 assert.equal(currentSharedYahooOffers(published.full.items[0],{ownershipIndex:ownership,corrections:result.matchCorrections,now:NOW+20*60000}).length,0);
});

test('real writeOutputs survives a malformed diagnostic pre-filter input and publishes the fixed failure enum',async t=>{
 const p=await pipeline(t),readsBefore=p.counts();
 const result={checkedAt:iso(NOW-2000),dataRevision:iso(NOW-1000),settings:{},accounts:p.accounts,items:[{...p.item,sharedYahooOffers:{PRIVATE:'NEVER_LOG_THIS'}}],
  scanMeta:{sharedDetailSummary:{verifiedPairs:1}},matchCorrections:{},portalUsers:[]};
 const published=await writeAndRead(t,result);
 assert.deepEqual(counts(published.full),failure);assert.deepEqual(counts(published.admin),failure);
 assert.deepEqual(published.full.items[0].sharedYahooOffers,[]);
 assert.equal(published.full.items[0].yahoo.checkedAt,p.item.yahoo.checkedAt);assert.equal(published.full.dataRevision,iso(NOW-1000));
 assert.deepEqual(p.counts(),readsBefore);checkPrivacy(counts(published.full));
});
