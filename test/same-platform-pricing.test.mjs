import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { pricingDecision,requiredPricingPlatforms,pricingItemsForPlatform,PRICING_RULES_VERSION } from '../public/pricing-policy.js';
import { pricingStatus,pricingSummary } from '../public/pricing-status.js';
import { pricingCoverage } from '../scripts/lib/pricing-coverage.mjs';
import { compactDashboardResult,scopeResultForPortalUser } from '../scripts/lib/publish.mjs';
import { invalidateCorrectedMatches } from '../public/match-memory.js';
const now=Date.now(),options={now};
const candidate=(price,id)=>({id,price,sellerId:id,url:'https://fixture.test/'+id,matchMethod:'verified'});
const source=(candidates=[])=>({rulesVersion:PRICING_RULES_VERSION,status:'ok',checkedAt:new Date(now).toISOString(),candidates});
const item=(platform='yahoo_fleamarket')=>({id:'own',accountId:'melon',platform,comparisonMode:'same_platform',ownPrice:20000,
 yahoo:source([candidate(19000,'y')]),rakuma:source([candidate(18000,'r')]),mercari:source([candidate(17000,'m')])});

for(const [platform,expected,price] of [['yahoo_fleamarket','yahoo',18999],['yahoo','yahoo',18999],['rakuma','rakuma',17999],['mercari','mercari',16999]])test(`${platform}: only native offers determine the price and completion`,()=>{
 const row=item(platform),decision=pricingDecision(row,options);
 assert.deepEqual(requiredPricingPlatforms(row),[expected]);assert.deepEqual(decision.requiredPlatforms,[expected]);
 assert.equal(decision.lowest.platform,expected);assert.equal(decision.recommendedPrice,price);assert.equal(decision.complete,true);
 for(const p of ['yahoo','rakuma','mercari'].filter(p=>p!==expected))row[p]={status:'error'};
 assert.equal(pricingDecision(row,options).complete,true);assert.equal(pricingStatus(row,options).state,'ready');
 assert.equal(pricingStatus(row,options).platforms.filter(p=>p.state==='excluded').length,2);
});

test('unknown native platform fails closed while legacy snapshots retain cross-platform behavior',()=>{
 const unknown=item('unknown');assert.equal(pricingDecision(unknown,options).complete,false);assert.equal(pricingDecision(unknown,options).canRecommend,false);assert.equal(pricingStatus(unknown,options).state,'queued');
 const legacy=item();delete legacy.comparisonMode;assert.equal(pricingDecision(legacy,options).lowest.platform,'mercari');
 legacy.comparisonMode='cross_platform';delete legacy.mercari;assert.equal(pricingDecision(legacy,options).complete,false);
});

test('retained cheap cross-platform evidence cannot bypass missing, stale, failed or incomplete native evidence',()=>{
 for(const patch of [{status:'error'},{status:'deferred_budget',checkedAt:null},{checkedAt:new Date(now-7*3600_000).toISOString()},{rulesVersion:0},{status:'cached',cacheReason:'request_error'}]){
  const row=item();row.yahoo={...source(),...patch};const decision=pricingDecision(row,options);
  assert.equal(decision.canRecommend,false);assert.equal(decision.lowest,null);assert.equal(decision.recommendedPrice,row.ownPrice);
 }
 const row=item();row.yahoo=source();row.yahoo.status='incomplete';assert.equal(pricingDecision(row,options).complete,false);assert.equal(pricingDecision(row,options).canRecommend,false);
});

test('same-platform raises still need full fresh evidence, two sellers, and all unresolved native guards',()=>{
 const row=item();row.yahoo=source([candidate(23000,'a')]);assert.equal(pricingDecision(row,options).recommendedPrice,20000);
 row.yahoo.candidates.push(candidate(23500,'b'));assert.equal(pricingDecision(row,options).recommendedPrice,22999);
 row.yahoo.raiseGuardMinPrice=20500;assert.equal(pricingDecision(row,options).recommendedPrice,20000);
 row.yahoo.raiseGuardMinPrice=25000;row.yahoo.status='incomplete';assert.equal(pricingDecision(row,options).recommendedPrice,20000);
});

test('scope changes preserve exclusions and own-offer protection',()=>{
 const row=item();row.id='y';assert.equal(pricingDecision(row,options).lowest,null);
 const clean=item();const corrected=invalidateCorrectedMatches(clean,{one:{accountId:'melon',itemId:'own',platform:'yahoo',candidateId:'y',updatedAt:new Date(now).toISOString()}});
 assert.equal(pricingDecision(corrected,options).lowest,null);assert.equal(corrected.comparisonMode,'same_platform');
});

test('production inventory queues shrink from 4380 to 1460 without removing accounts or rows',()=>{
 const accounts=[['melon','yahoo_fleamarket',97],['momo','yahoo_fleamarket',48],['boss','yahoo_fleamarket',489],['rakuma','rakuma',826]];
 const rows=accounts.flatMap(([accountId,platform,count])=>Array.from({length:count},(_,index)=>({...item(platform),id:String(index),accountId})));
 assert.equal(rows.length,1460);assert.equal(new Set(rows.map(r=>r.accountId)).size,4);
 const scoped=['yahoo','rakuma','mercari'].map(p=>pricingItemsForPlatform(rows,p).length);assert.deepEqual(scoped,[634,826,0]);
 const cross=rows.map(r=>({...r,comparisonMode:'cross_platform'}));assert.equal(['yahoo','rakuma','mercari'].reduce((n,p)=>n+pricingItemsForPlatform(cross,p).length,0),4380);
 const queueKeys=['yahoo','rakuma','mercari'].flatMap(p=>pricingItemsForPlatform(rows,p).map(r=>r.accountId+':'+r.id));assert.equal(new Set(queueKeys).size,1460);
});

test('coverage, compact publication and employee scoping use native denominator without leaking accounts',()=>{
 const rows=[item(),{...item('rakuma'),id:'r-own',accountId:'r'}],accounts=[{id:'melon',profileStatus:'live'},{id:'r',profileStatus:'live'}];
 const result={accounts,items:rows,manualCosts:{one:{accountId:'melon',purchaseCNY:123}},matchCorrections:{},settings:{comparisonMode:'same_platform'}};
 const coverage=pricingCoverage(rows,accounts);assert.equal(coverage.complete,true);assert.equal(coverage.platforms.yahoo.total,1);assert.equal(coverage.platforms.rakuma.total,1);assert.equal(coverage.platforms.mercari.total,0);
 const compact=compactDashboardResult(result,{now});assert.equal(pricingDecision(compact.items[0],options).lowest.platform,'yahoo');assert.equal(compact.manualCosts.one.purchaseCNY,123);
 const scoped=scopeResultForPortalUser(compact,{accountIds:['melon'],username:'test'});assert.equal(scoped.items.length,1);assert.equal(scoped.pricingCoverage.platforms.rakuma.total,0);assert.equal(scoped.pricingCoverage.complete,true);
 const summary=pricingSummary(rows,options);assert.equal(summary.scopeLabel,'同平台');assert.equal(summary.ready,2);assert.match(summary.note,/已核验/);
});

test('scanner routes every platform queue through shared scope policy and does not change request pacing',async()=>{
 const scan=await fs.readFile(new URL('../scripts/scan.mjs',import.meta.url),'utf8');
 for(const p of ['yahoo','rakuma','mercari'])assert.ok(scan.includes(`pricingItemsForPlatform(context.activeItems,'${p}')`));
 const settings=JSON.parse(await fs.readFile(new URL('../config/settings.json',import.meta.url)));assert.equal(settings.comparisonMode,'same_platform');assert.equal(settings.yahooRequestIntervalMs,5000);
});
