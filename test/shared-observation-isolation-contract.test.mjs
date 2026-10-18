import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {pricingDecision,PRICING_RULES_VERSION} from '../public/pricing-policy.js';
import {pricingSummary} from '../public/pricing-status.js';
import {buildOwnedOffers,excludeOwnedOffers} from '../public/owned-offers.js';
import {invalidateCorrectedMatches} from '../public/match-memory.js';
import {comparisonObservationsMarkup} from '../public/comparison-observations.js';
import {evaluateYahooDetail} from '../scripts/lib/yahoo.mjs';
import {retainYahooProfileIdentity,observeYahooProfilePair} from '../scripts/lib/yahoo-profile-identity.mjs';
import {createYahooPageObservationPool,mapYahooPoolToTargets} from '../scripts/lib/yahoo-page-observation-pool.mjs';
import {compactDashboardResult,scopeResultForPortalUser,writeOutputs} from '../scripts/lib/publish.mjs';
import {pricingCoverage} from '../scripts/lib/pricing-coverage.mjs';
import {cycleCoverage} from '../scripts/lib/cycle-coverage.mjs';
import {encrypt,decrypt} from '../scripts/lib/crypto.mjs';

// Contract characterization only. Production has no shared-observation ingress
// or UI renderer. This deliberately test-only property is an opaque extension,
// not a proposed production schema or a claim that hints are displayed safely.
// Current compaction passes unknown item properties through without interpreting
// them. A future real ingress needs its own schema, redaction and rendering tests.
const EXTENSION='__testOnlySharedObservation';
const NOW=Date.parse('2026-10-18T06:11:00.000Z'),OLD=NOW-25*3600_000,START=NOW-60_000;
const iso=value=>new Date(value).toISOString();
const url=id=>`https://paypayfleamarket.yahoo.co.jp/item/${id}`;
const title='APEX ヴァイオレット・エヴァーガーデン 自動手記人形Ver. 1/7 フィギュア';
const description='新品 未使用 フィギュア1点';
const adminPassword='local-isolation-fixture-admin',memberPassword='local-isolation-fixture-member';
const fingerprint={dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[100,100,100],colorGrid:Array(768).fill(100)};
const accounts=['a','b'].map(letter=>({id:`account-${letter}`,name:`Account ${letter}`,platform:'yahoo',sellerId:`owner-${letter}`,
 profileUrl:`https://paypayfleamarket.yahoo.co.jp/user/owner-${letter}`,profileStatus:'live',itemCount:1,
 inventoryObservation:{complete:true,fromCache:false,observedAt:START+1}}));
const member={username:'fixture',displayName:'Fixture member',password:memberPassword,accountIds:['account-a'],enabled:true,updatedAt:iso(OLD)};
function item(letter='a'){
 const account=accounts.find(row=>row.id===`account-${letter}`),id=letter==='a'?'z100':'z101';
 return {id,accountId:account.id,accountName:account.name,platform:'yahoo',comparisonMode:'same_platform',sellerId:account.sellerId,
  title:letter==='a'?title:'PRIVATE_OTHER_ACCOUNT_TITLE',image:`https://example.invalid/${id}.jpg`,url:url(id),ownUrl:url(id),itemStatus:'OPEN',
  ownPrice:10000,recommendedPrice:10000,lowestPrice:10000,lowestUrl:url(id),priceSignal:'hold',comparisonIncomplete:true,
  yahoo:{rulesVersion:PRICING_RULES_VERSION,status:'incomplete',evidenceStatus:'incomplete',checkedAt:iso(OLD),searchCheckedAt:iso(OLD-1000),searchComplete:false,
   audit:{ownItemId:id,accountId:account.id,rulesVersion:PRICING_RULES_VERSION},candidates:[]},
  xianyu:{status:'not_requested',checkedAt:iso(OLD),samples:[],averageCNY:null}};
}
function state(){
 const items=[item('a'),item('b')],manualCosts=Object.fromEntries(items.map(row=>[`${row.accountId}:item:${row.id}`,
  {accountId:row.accountId,itemId:row.id,purchaseCNY:123,manualFeeCNY:10,shippingJPY:500,updatedAt:iso(OLD)}]));
 const result={version:1,checkedAt:iso(NOW),dataRevision:iso(NOW),settings:{comparisonMode:'same_platform',exchangeRate:20,costMultiplier:1,profitWarningJPY:1500},
  accounts:structuredClone(accounts),items,manualCosts,matchCorrections:{},portalUsers:[structuredClone(member)],portalPreferences:{},relistAliases:{}};
 result.pricingCoverage=pricingCoverage(items,result.accounts);
 result.cycleCoverage=cycleCoverage(items,result.accounts,{startedAt:START,finishedAt:NOW});
 return result;
}
function currentCard(detail,accountId){
 const sellerId=detail.seller.id;
 return {id:detail.id,accountId,sellerId,title:detail.title,priceJPY:detail.price,imageUrl:detail.images[0],itemStatus:'OPEN',
  profileUrl:`https://paypayfleamarket.yahoo.co.jp/user/${sellerId}`,pageUrl:`https://paypayfleamarket.yahoo.co.jp/user/${sellerId}?page=1`,
  pageNumber:1,observedAt:START+10,source:'current_profile_card'};
}
async function existingObservationOutputs(own){
 const ownDetail={id:own.id,title:own.title,description,price:10000,status:'OPEN',seller:{id:own.sellerId},images:[own.image]};
 const candidateDetail={id:'z200',title,description,price:8500,status:'OPEN',seller:{id:'external-seller'},images:['https://example.invalid/z200.jpg']};
 const candidate={id:candidateDetail.id,url:url(candidateDetail.id),title,image:candidateDetail.images[0],sellerId:'external-seller',price:8500};
 const settings={ownedOffers:buildOwnedOffers(accounts,[own,item('b')]),ownedOffersComplete:true};
 // Mint the historical binding through the existing real strict evaluator.
 // Only fixture image evidence is supplied; this performs no transport.
 const evaluation=await evaluateYahooDetail({item:own,card:candidate,bundle:{detail:candidateDetail,observedAt:OLD+10},ownDetail,
  ownSellerId:own.sellerId,ownConditionText:description,ownObservedAt:OLD,ownFingerprints:[fingerprint],ownImageEvidence:[fingerprint],settings},
 {imageFingerprints:async()=>fingerprint,now:()=>OLD+20});
 assert.ok(evaluation.candidate,'the historical fixture must actually pass the existing verifier');
 const identity=retainYahooProfileIdentity({item:own,ownDetail,candidateDetail,evaluation,ownObservedAt:OLD,candidateObservedAt:OLD+10,
  identityVerifiedAt:OLD+20,rulesVersion:PRICING_RULES_VERSION,now:NOW});
 assert.ok(identity);
 const ownCard=currentCard(ownDetail,own.accountId),candidateCard=currentCard({...candidateDetail,price:8000},'external-account');
 const historical=observeYahooProfilePair({ownCard,candidateCard,identity,settings,now:NOW});
 assert.equal(historical.mode,'profile_observation');assert.equal(historical.observation.priceJPY,8000);
 assert.equal(historical.observation.ownDescriptionObservedAt,iso(OLD));
 assert.equal(historical.observation.candidateDescriptionObservedAt,iso(OLD+10));
 assert.equal(historical.observation.historicalIdentityVerifiedAt,iso(OLD+20));
 assert.equal(historical.observation.canRecommend,false);assert.equal(historical.observation.identityVerifiedAt,null);
 const sourceDetail={...candidateDetail,id:'z900'},html=`<script id="__NEXT_DATA__">${JSON.stringify({item:sourceDetail})}</script>`;
 const pool=createYahooPageObservationPool({now:()=>NOW,cycleStartedAt:START,deadlineAt:NOW+60_000});
 pool.ingest({source:{id:'z900',url:url('z900'),sha256:createHash('sha256').update(html).digest('hex'),sha256Scope:'decoded_response_html_utf8',
  observedAt:START+20,status:200,redirected:false,fromCache:false,role:'candidate'},detail:sourceDetail,
  cards:[{id:'z300',url:url('z300'),title,image:'https://example.invalid/z300.jpg',sellerId:'another-external',price:8000,priceKind:'ordinary',currency:'JPY'}]});
 const mapping=mapYahooPoolToTargets({snapshot:pool.snapshot(),targets:[{...own,profileCard:ownCard}],settings,now:NOW});
 const rail=mapping.rows[0].candidates[0];assert.ok(rail);assert.equal(rail.id,'z300');
 assert.equal(rail.card.availability,null);assert.equal(rail.card.description,null);assert.equal(rail.canRecommend,false);
 return {historical,rail,identity};
}
function protectSnapshot(result){
 return {items:result.items.map(row=>({id:row.id,accountId:row.accountId,ownPrice:row.ownPrice,recommendedPrice:row.recommendedPrice,
  lowestPrice:row.lowestPrice,lowestUrl:row.lowestUrl,priceSignal:row.priceSignal,yahoo:row.yahoo,xianyu:row.xianyu})),
  manualCosts:result.manualCosts,pricingCoverage:pricingCoverage(result.items,result.accounts),
  cycleCoverage:cycleCoverage(result.items,result.accounts,{startedAt:START,finishedAt:NOW}),
  decisions:result.items.map(row=>pricingDecision(row,{now:NOW})),summary:pricingSummary(result.items,{now:NOW})};
}
function normalized(result){
 const ownership=buildOwnedOffers(result.accounts,result.items);
 return {...result,items:result.items.map(row=>invalidateCorrectedMatches(excludeOwnedOffers(row,ownership),result.matchCorrections))};
}
function jsonEncryptedRoundTrip(result){
 const json=JSON.stringify(result),restored=JSON.parse(decrypt(encrypt(Buffer.from(json),adminPassword),adminPassword));
 assert.deepEqual(restored,JSON.parse(json));return restored;
}
async function publish(t,result){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'shared-observation-contract-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const oldUsers=process.env.PORTAL_USERS_JSON;process.env.PORTAL_USERS_JSON='';
 try{await writeOutputs({root,result:structuredClone(result),previous:structuredClone(result),password:adminPassword});}
 finally{if(oldUsers===undefined)delete process.env.PORTAL_USERS_JSON;else process.env.PORTAL_USERS_JSON=oldUsers;}
 const read=async(relative,password=adminPassword)=>JSON.parse(decrypt(await fs.readFile(path.join(root,relative)),password));
 return {full:await read('state/latest.json.enc'),admin:await read('public/data/latest.json.enc'),
  member:await read('public/data/users/fixture/latest.json.enc',memberPassword),status:JSON.parse(await fs.readFile(path.join(root,'public/data/status.json'),'utf8'))};
}
async function ui(result){
 const [html,source]=await Promise.all(['index.html','app.js'].map(name=>fs.readFile(new URL('../public/'+name,import.meta.url),'utf8')));
 const dom=new JSDOM(html,{url:'https://example.invalid',runScripts:'outside-only'}),win=dom.window;
 for(const match of source.matchAll(/^import .* from '(\.\/[^']+)';/gm))Object.assign(win,await import(new URL('../public/'+match[1].slice(2),import.meta.url)));
 Object.assign(win,{fetch:async()=>{throw Error('No network in isolation fixture')},setInterval:()=>0,
  pricingDecision:(row,options)=>pricingDecision(row,{now:NOW,...options}),pricingSummary:(rows,options)=>pricingSummary(rows,{now:NOW,...options})});
 win.Date.now=()=>NOW;
 win.HTMLDialogElement.prototype.showModal=function(){this.open=true};win.HTMLDialogElement.prototype.close=function(){this.open=false};
 win.eval(source.replace(/^import .*;\r?\n/gm,'')+`window.fixture={set(value){data=value;manualCosts=value.manualCosts;matchCorrections=value.matchCorrections;currentAccountId='__all__'},render,detail,effective,refresh(){refreshDetailPrices()},costs:()=>manualCosts};`);
 const input=structuredClone(result);
 win.fixture.set(input);win.fixture.render();win.fixture.detail('z100','account-a');
 await new Promise(resolve=>setImmediate(resolve));
 return {win,input,close:()=>win.close()};
}
function clockAndNoNetwork(t){
 t.mock.method(Date,'now',()=>NOW);
 t.mock.method(globalThis,'fetch',()=>{throw Error('No source requests are allowed in this contract test')});
}

test('hazard characterization: canRecommend:false in fresh candidates still causes 10000 -> 7999 through publication and actual UI',async t=>{
 clockAndNoNetwork(t);
 const base=state(),{historical,identity}=await existingObservationOutputs(base.items[0]);
 const unsafe=structuredClone(base),own=unsafe.items[0],observation=historical.observation;
 own.yahoo.checkedAt=iso(NOW);
 own.yahoo.candidates=[{id:observation.id,url:observation.url,title:'HISTORICAL_HINT_NOT_FRESH_IDENTITY',sellerId:'external-seller',price:observation.priceJPY,
  matchMethod:identity.matchMethod,canRecommend:false,detailVerified:false,identityVerifiedAt:null}];
 const assertHazard=row=>{
  const decision=pricingDecision(row,{now:NOW});assert.equal(decision.canRecommend,true);assert.equal(decision.recommendedPrice,7999);
  assert.equal(decision.complete,false);assert.equal(decision.priceSignal,'lower');
 };
 assert.equal(pricingDecision(base.items[0],{now:NOW}).recommendedPrice,10000);assertHazard(own);
 const restored=jsonEncryptedRoundTrip(normalized(unsafe));assertHazard(restored.items[0]);
 const compact=compactDashboardResult(restored,{now:NOW});assertHazard(compact.items[0]);
 assert.equal(Object.hasOwn(compact.items[0].yahoo.candidates[0],'canRecommend'),false,'compact drops the decorative deny flag');
 const published=await publish(t,restored);
 for(const result of [published.full,published.admin,published.member])assertHazard(result.items.find(row=>row.id==='z100'));
 const view=await ui(published.member);
 try{
  assert.equal(view.win.fixture.effective(published.member.items[0]).recommendedPrice,7999);
  assert.match(view.win.document.querySelector('#detailRecommendation').textContent,/7,999/);
 }finally{view.close()}
 // This expected hazard is not approval for ingress. Any future observation
 // consumer must satisfy the separate-field regression below instead.
});

test('opaque test-only historical and rail observations preserve prices, clocks, costs, coverage and account scope through real publication',async t=>{
 clockAndNoNetwork(t);
 const base=state(),before=protectSnapshot(base),safe=structuredClone(base);
 const {historical,rail}=await existingObservationOutputs(safe.items[0]);
 safe.items[0][EXTENSION]={fixtureOnly:true,historical,rail};
 safe.items[1][EXTENSION]={fixtureOnly:true,marker:'PRIVATE_OTHER_ACCOUNT_OBSERVATION'};
 const originalExtension=structuredClone(safe.items[0][EXTENSION]);
 const stages=[normalized(safe),jsonEncryptedRoundTrip(normalized(safe))];
 stages.push(compactDashboardResult(stages[1],{now:NOW}));
 for(const [index,result] of stages.entries()){
  const expected=index===2?protectSnapshot(compactDashboardResult(base,{now:NOW})):before;
  assert.deepEqual(protectSnapshot(result),expected);
  assert.deepEqual(result.items[0][EXTENSION],originalExtension,'unknown properties are retained but never interpreted');
 }
 const published=await publish(t,stages[1]);
 for(const result of [published.full,published.admin]){
  // Compaction has its existing candidate/default-field normalization; compare
  // against an equally compact baseline, rather than inventing a new schema.
  const baseline=result===published.admin?compactDashboardResult(base,{now:NOW}):base;
  assert.deepEqual(protectSnapshot(result),protectSnapshot(baseline));
  assert.deepEqual(result.items[0][EXTENSION],originalExtension);
  assert.deepEqual(result.manualCosts,base.manualCosts);
 }
 const scopedBase=compactDashboardResult(scopeResultForPortalUser(base,member),{now:NOW});
 assert.deepEqual(protectSnapshot(published.member),protectSnapshot(scopedBase));
 assert.deepEqual(published.member.items.map(row=>row.accountId),['account-a']);
 assert.deepEqual(Object.keys(published.member.manualCosts),['account-a:item:z100']);
 assert.deepEqual(published.member.items[0][EXTENSION],originalExtension);
 for(const marker of ['PRIVATE_OTHER_ACCOUNT_TITLE','PRIVATE_OTHER_ACCOUNT_OBSERVATION','owner-b'])assert.equal(JSON.stringify(published.member).includes(marker),false);
 assert.equal(JSON.stringify(published.status).includes(EXTENSION),false,'aggregate status does not expose the opaque payload');
 assert.deepEqual(published.status.pricingCoverage,base.pricingCoverage);assert.deepEqual(published.status.cycleCoverage,base.cycleCoverage);
 assert.equal(published.status.repricing,0);assert.equal(published.status.cycleCoverage.priceObserved,0);assert.equal(published.status.cycleCoverage.priceComplete,0);
 assert.equal(published.status.cycleCoverage.costVerified,0);assert.equal(published.status.cycleCoverage.coverageComplete,false);
 const view=await ui(published.member);
 try{
  const row=published.member.items[0],beforeItem=structuredClone(row),beforeCosts=structuredClone(published.member.manualCosts);
  const effective=view.win.fixture.effective(row),doc=view.win.document;
  assert.equal(effective.recommendedPrice,10000);assert.equal(effective.canRecommend,false);assert.equal(effective.lowestPrice,null);
  assert.equal(doc.querySelector('#detailRecommendation').textContent,'暂无建议');assert.match(doc.querySelector('#detailLowest').textContent,/待核验/);
  assert.equal(doc.querySelector('#previewAfterProfit').textContent,'—');assert.equal(doc.querySelector('#purchaseCNY').value,'123');
  assert.equal(doc.querySelector('.comparison-observations'),null,'there is no shared-hint UI implementation');
  assert.equal(doc.querySelector(`a[href="${url('z200')}"]`),null);assert.equal(doc.querySelector(`a[href="${url('z300')}"]`),null);
  const ownershipIndex=buildOwnedOffers(published.member.accounts,published.member.items);
  assert.equal(comparisonObservationsMarkup(row,{ownershipIndex,corrections:{},now:NOW}),'');
  view.win.fixture.refresh();assert.equal(doc.querySelector('#detailRecommendation').textContent,'暂无建议');
  assert.deepEqual(row,beforeItem);assert.deepEqual(view.input.items[0],beforeItem);assert.deepEqual(view.win.fixture.costs(),beforeCosts);
  assert.equal(row.yahoo.checkedAt,iso(OLD));assert.equal(row.yahoo.searchCheckedAt,iso(OLD-1000));
  assert.deepEqual(row.yahoo.candidates,[]);assert.deepEqual(row[EXTENSION],originalExtension);
 }finally{view.close()}
});
