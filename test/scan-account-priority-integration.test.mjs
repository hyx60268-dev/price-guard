import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {encrypt,decrypt} from '../scripts/lib/crypto.mjs';
import {PRICING_RULES_VERSION} from '../public/pricing-policy.js';
import {normalizeOfferPlatform} from '../public/owned-offers.js';
import {xianyuReviewPlan} from '../scripts/lib/xianyu-review-plan.mjs';
import {XIANYU_VERIFICATION} from '../scripts/lib/xianyu-evidence.mjs';
import {RequestDeferredError} from '../scripts/lib/request-cooldown.mjs';

const NOW=Date.parse('2026-10-16T22:00:00.000Z'),OLD=new Date(NOW-2*3600000).toISOString();
const password='synthetic-priority-password',hook='__scanAccountPriorityFixture';
const envKeys=['PRICE_SCAN_ENGINE','FULL_PRICE_AUDIT','FORCE_FULL_SCAN','PRICE_AUDIT_ITEM_IDS','DASHBOARD_PASSWORD','PORTAL_USERS_JSON','GITHUB_SHA'];
const accounts=[
 {id:'rakuma',name:'Rakuma fixture',platform:'rakuma',sellerId:'900',profileUrl:'https://fril.jp/shop/fixture'},
 {id:'momoka',name:'Momoka fixture',platform:'yahoo',sellerId:'momoka-seller',profileUrl:'https://paypayfleamarket.yahoo.co.jp/user/momoka-seller'},
 {id:'boss',name:'Boss fixture',platform:'yahoo',sellerId:'boss-seller',profileUrl:'https://paypayfleamarket.yahoo.co.jp/user/boss-seller'},
 {id:'melon',name:'Melon fixture',platform:'yahoo',sellerId:'melon-seller',profileUrl:'https://paypayfleamarket.yahoo.co.jp/user/melon-seller'}
];
const expectedOrder=['melon','boss','momoka','melon','boss','momoka'];
function inventory(){return accounts.flatMap(account=>[0,1].map(n=>{
 const id=account.platform==='rakuma'?(n?'b':'a').repeat(32):account.id+'-'+(n+1),title=account.id==='melon'?`Anker AeroClip 2 張凌赫 新品 fixture ${n+1}`:`新品 フィギュア fixture ${account.id} ${n+1}`;
 const comparison={status:'ok',rulesVersion:PRICING_RULES_VERSION,checkedAt:OLD,searchCheckedAt:OLD,lastAttemptAt:OLD,lastFullAttemptAt:OLD,candidates:[],lowestPrice:5000,recommendedPrice:5000};
 return {id,accountId:account.id,platform:account.platform,comparisonMode:'same_platform',title,image:'https://fixture.invalid/'+id+'.jpg',sellerId:account.sellerId,
  url:account.platform==='rakuma'?'https://item.fril.jp/'+id:'https://paypayfleamarket.yahoo.co.jp/item/'+id,ownPrice:5000,
  [account.platform]:comparison,xianyu:{status:'error',checkedAt:OLD,lastAttemptAt:OLD,samples:[],averageCNY:null},
  procurementSource:{status:'error',checkedAt:OLD,samples:[],averageCNY:null}};
}));}

// Only the disposable copy replaces collector/browser exports. Production scan,
// phase scheduling, own-source sharing, both budgets, reconciliation, coverage,
// encryption and publication execute unchanged. Every source call is synthetic.
async function runFixture(t,{exhaustYahoo=false,activeHolds=false,deferredQuotes=false}={}){
 t.mock.timers.enable({apis:['Date'],now:NOW});
 const source=fileURLToPath(new URL('../',import.meta.url)),root=await fs.mkdtemp(path.join(os.tmpdir(),'scan-account-priority-'));
 const savedEnv=Object.fromEntries(envKeys.map(key=>[key,process.env[key]])),savedFetch=globalThis.fetch;
 const items=inventory(),byId=new Map(items.map(item=>[item.id,item])),events=[],ownedChecks=[],network=[];
 const sharedError=Object.freeze(new RequestDeferredError('request_cooldown_deadline',NOW+3600000)),originalErrorJSON=JSON.stringify(sharedError);
 if(exhaustYahoo){const reviewed=items.find(item=>item.platform==='rakuma');reviewed.xianyu={...reviewed.xianyu,status:'page_empty',verification:XIANYU_VERIFICATION,query:xianyuReviewPlan(reviewed).query};}
 const yahooHold={reason:'http_429',retryAt:activeHolds?NOW+3600000:NOW-60_000};
 const rakumaHold={httpStatus:403,retryAfter:null,observedAt:new Date(exhaustYahoo||activeHolds?NOW:NOW-2*3600000).toISOString(),retryAt:exhaustYahoo||activeHolds?NOW+3600000:NOW-3600000,holdReason:'internal_fallback'};
 const previous={checkedAt:OLD,items,accounts,manualCosts:{},matchCorrections:{},yahooRequestAccess:yahooHold,rakumaRequestAccess:rakumaHold};
 const event=(kind,item,extra={})=>events.push({kind,platform:normalizeOfferPlatform(item?.platform),accountId:item?.accountId,id:item?.id,...extra});
 const pause=()=>new Promise(resolve=>setTimeout(resolve,2));
 const inspectOwned=settings=>ownedChecks.push({yahoo:items.filter(item=>item.platform==='yahoo').every(item=>settings.ownedOffers?.yahoo?.items.has(item.id)),
  rakuma:items.filter(item=>item.platform==='rakuma').every(item=>settings.ownedOffers?.rakuma?.items.has(item.id)),seller:settings.ownedOffers?.rakuma?.sellers.has('900')});
 const detail=item=>({id:item.id,title:item.title,price:item.ownPrice,status:'OPEN',description:'新品 未使用 フィギュア1点',images:[item.image],seller:{id:item.sellerId}});
 const quote=item=>({rulesVersion:PRICING_RULES_VERSION,status:'ok',checkedAt:new Date().toISOString(),searchCheckedAt:new Date().toISOString(),candidates:[],
  lowestPrice:item.ownPrice,recommendedPrice:item.ownPrice,cardCount:0,competitorCount:0,sourceStatus:{search:'ok',itemPage:'ok'},audit:{accountId:item.accountId,ownItemId:item.id}});
 let yahooQuotes=0;
 globalThis[hook]={
  async yahooProfile(_page,url,settings){const account=accounts.find(row=>row.profileUrl===url);event('profile',{...account,accountId:account.id});inspectOwned(settings);return {items:items.filter(row=>row.accountId===account.id),complete:true,pages:1};},
  async rakumaProfile(url,settings){const account=accounts.find(row=>row.profileUrl===url);event('profile',{...account,accountId:account.id});inspectOwned(settings);return {items:items.filter(row=>row.accountId===account.id),complete:true,pages:1};},
  async yahooBundle(id){const item=byId.get(id);assert.ok(item,'unexpected fixture Yahoo item');event('detail',item);return {detail:detail(item),recommendations:[]};},
  async yahooQuote(_page,item,settings,dependencies){
   event('quote:start',item);inspectOwned(settings);
   if(deferredQuotes){
    t.mock.timers.tick(1000);
    const observed=item.id.endsWith('-2');
    if(observed)await dependencies.fetchYahooItemBundle(item.id);
    event('quote:deferred',item,{sourceInputObserved:observed});throw sharedError;
   }
   await pause();event('quote:end',item);yahooQuotes++;if(exhaustYahoo&&yahooQuotes===6)t.mock.timers.tick(61_000);return quote(item);
  },
  async rakumaItem(item){event('detail',item);return detail(item);},
  async rakumaQuote(item,settings){event('quote:start',item);inspectOwned(settings);await pause();event('quote:end',item);return quote(item);},
  async publicCost(item){event('public:start',item);await pause();event('public:end',item);return {status:'no_results',samples:[],averageCNY:null,searched:1};},
  async xianyuCost(_page,item){event('xianyu:start',item);await pause();event('xianyu:end',item);return {status:'page_empty',samples:[],averageCNY:null};},
  async openContext(){return {browser:{close:async()=>{}},context:{newPage:async()=>({}),storageState:async()=>({})}};},
  async session(){return {file:null,access:()=>activeHolds?{allowed:false,reason:'login_required',retryAt:new Date(NOW+3600000).toISOString()}:{allowed:true,reason:null,retryAt:null},persist:async()=>{}};}
 };
 try{
  await fs.cp(path.join(source,'scripts'),path.join(root,'scripts'),{recursive:true});
  await fs.cp(path.join(source,'public'),path.join(root,'public'),{recursive:true});
  for(const name of ['state','config'])await fs.mkdir(path.join(root,name));
  await fs.writeFile(path.join(root,'package.json'),'{"type":"module"}');
  await fs.symlink(await fs.realpath(path.join(source,'node_modules')),path.join(root,'node_modules'),'dir');
  async function wrap(module,exports){
   const original=module.replace('.mjs','-fixture-original.mjs');await fs.rename(path.join(root,'scripts/lib',module),path.join(root,'scripts/lib',original));
   await fs.writeFile(path.join(root,'scripts/lib',module),`export * from './${original}';\n`+Object.entries(exports).map(([name,method])=>`export const ${name}=(...args)=>globalThis.${hook}.${method}(...args);`).join('\n'));
  }
  if(!activeHolds){
   await wrap('yahoo.mjs',{discoverYahooProfile:'yahooProfile',fetchYahooItemBundle:'yahooBundle',yahooCompare:'yahooQuote'});
   await wrap('rakuma.mjs',{discoverRakumaProfile:'rakumaProfile',fetchRakumaItem:'rakumaItem',rakumaCompare:'rakumaQuote'});
  }
  await wrap('procurement-sources.mjs',{alternativeProcurementCost:'publicCost'});
  await wrap('xianyu.mjs',{xianyuCost:'xianyuCost'});
  await wrap('browser.mjs',{openContext:'openContext'});
  await wrap('xianyu-session.mjs',{loadXianyuSession:'session'});
  await fs.writeFile(path.join(root,'config/accounts.json'),JSON.stringify({accounts}));
  await fs.writeFile(path.join(root,'config/settings.json'),JSON.stringify({comparisonMode:'same_platform',scanAccountPriorityIds:['melon','boss','momoka'],
   scanBudgetMinutes:1,profileConcurrency:1,yahooConcurrency:1,rakumaConcurrency:1,maxXianyuItemsPerRun:7,maxPublicProcurementItemsPerRun:7,exchangeRate:20}));
  await fs.writeFile(path.join(root,'state/latest.json.enc'),encrypt(Buffer.from(JSON.stringify(previous)),password));
  for(const key of envKeys)process.env[key]='';process.env.DASHBOARD_PASSWORD=password;process.env.PRICE_SCAN_ENGINE='legacy';
  if(!exhaustYahoo&&!activeHolds)process.env.PRICE_AUDIT_ITEM_IDS='momoka-2';
  globalThis.fetch=async url=>{network.push(String(url));throw Error('Unexpected network in offline priority regression');};
  await import(pathToFileURL(path.join(root,'scripts/scan.mjs')));
  const snapshots=[];
  for(const file of ['state/latest.json.enc','public/data/state.json.enc','public/data/latest.json.enc'])snapshots.push(JSON.parse(decrypt(await fs.readFile(path.join(root,file)),password)));
  assert.deepEqual(network,[],'no actual network may run');if(!activeHolds)assert.ok(ownedChecks.length>0);
  assert.ok(ownedChecks.every(value=>value.yahoo&&value.rakuma&&value.seller),'owned index must contain deferred Rakuma and all three Yahoo accounts before any phase');
  assert.equal(JSON.stringify(sharedError),originalErrorJSON,'shared deferred error remains unchanged');
  return {events,snapshots,previous,yahooHold,rakumaHold};
 }finally{
  globalThis.fetch=savedFetch;delete globalThis[hook];
  for(const [key,value] of Object.entries(savedEnv))if(value===undefined)delete process.env[key];else process.env[key]=value;
  await fs.rm(root,{recursive:true,force:true});
 }
}

function assertRetainedAllAccounts(snapshot,{yahooHold,rakumaHold}){
 assert.equal(snapshot.items.length,8);assert.equal(snapshot.accounts.length,4);
 assert.equal(snapshot.cycleCoverage.total,8);assert.deepEqual(snapshot.scanMeta.comparisonTasks,{yahoo:6,rakuma:2,mercari:0});
 assert.deepEqual(snapshot.yahooRequestAccess,yahooHold);assert.deepEqual(snapshot.rakumaRequestAccess,rakumaHold);
 assert.equal(snapshot.scanMeta.accountExecutionPolicy,'yahoo_first_rakuma_last');
}

test('real scan: all Yahoo prices and both cost workers finish before Rakuma, with one shared budget',async t=>{
 const outcome=await runFixture(t),{events}=outcome;
 assert.deepEqual(events.filter(row=>row.kind==='quote:start'&&row.platform==='yahoo').map(row=>row.accountId),expectedOrder);
 assert.deepEqual(events.filter(row=>row.kind==='profile'&&row.platform==='yahoo').map(row=>row.accountId),expectedOrder.slice(0,3));
 assert.deepEqual(events.filter(row=>row.kind==='quote:start'&&row.accountId==='momoka').map(row=>row.id),['momoka-2','momoka-1'],'audit priority only reorders inside its account');
 const firstRakuma=events.findIndex(row=>row.platform==='rakuma'),lastYahoo=Math.max(...events.map((row,index)=>row.platform==='yahoo'?index:-1));
 assert.ok(firstRakuma>lastYahoo,'Rakuma profile/detail/price/cost must wait for every Yahoo worker');
 assert.equal(events.filter(row=>row.platform==='yahoo'&&row.kind==='quote:end').length,6);
 assert.equal(events.filter(row=>row.platform==='yahoo'&&row.kind==='public:end').length,6);
 assert.equal(events.filter(row=>row.platform==='yahoo'&&row.kind==='xianyu:end').length,6);
 // Melon has two real known-URL title mappings. Global known-link sorting
 // would put both ahead of Boss; account-fair admission must retain the turns.
 for(const kind of ['public:start','xianyu:start'])assert.deepEqual(events.filter(row=>row.platform==='yahoo'&&row.kind===kind).map(row=>row.accountId),expectedOrder);
 for(const kind of ['public:start','xianyu:start']){
  assert.equal(events.filter(row=>row.kind===kind).length,7,'global cost admission cannot reset per phase');
  assert.equal(events.filter(row=>row.kind===kind&&row.platform==='rakuma').length,1,'Rakuma gets only the remaining single cost slot');
 }
 assert.equal(events.filter(row=>row.platform==='rakuma'&&row.kind==='quote:end').length,2);
 for(const snapshot of outcome.snapshots){
  assertRetainedAllAccounts(snapshot,outcome);assert.ok(snapshot.accounts.every(row=>row.profileStatus==='live'));
  for(const item of snapshot.items)assert.notEqual(item[normalizeOfferPlatform(item.platform)].checkedAt,OLD);
 }
});

test('real scan: exhausted Yahoo phase makes zero Rakuma reads and publishes all old inventory with original clocks',async t=>{
 const outcome=await runFixture(t,{exhaustYahoo:true}),{events,previous}=outcome;
 assert.deepEqual(events.filter(row=>row.kind==='quote:start'&&row.platform==='yahoo').map(row=>row.accountId),expectedOrder);
 assert.equal(events.some(row=>row.platform==='rakuma'),false,'no Rakuma profile/detail/cost may start after shared deadline');
 for(const [snapshotIndex,snapshot] of outcome.snapshots.entries()){
  assertRetainedAllAccounts(snapshot,outcome);const account=snapshot.accounts.find(row=>row.id==='rakuma');
  assert.equal(account.profileStatus,'deferred_due_to_priority');assert.equal(account.priorityDeferredReason,'deferred_due_to_priority');
  assert.equal(account.scanStats.rakumaDeferred,2);assert.equal(account.scanStats.rakumaLive,0);
  const oldRows=previous.items.filter(row=>row.platform==='rakuma'),rows=snapshot.items.filter(row=>row.platform==='rakuma');
  assert.deepEqual(rows.map(row=>row.id),oldRows.map(row=>row.id));assert.equal(account.itemCount,2);
  for(const row of rows){
   const old=oldRows.find(item=>item.id===row.id);
   assert.equal(row.rakuma.status,'deferred_due_to_priority');assert.equal(row.rakuma.deferredReason,'deferred_due_to_priority');
   assert.equal(row.rakuma.cacheReason,'request_error');
   for(const field of ['checkedAt','searchCheckedAt','lastAttemptAt'])assert.equal(row.rakuma[field],old.rakuma[field]);
   assert.deepEqual(row.rakuma.candidates,old.rakuma.candidates);assert.equal(row.ownPrice,old.ownPrice);
   assert.equal(row.xianyu.checkedAt,old.xianyu.checkedAt);assert.equal(row.xianyu.lastAttemptAt,old.xianyu.lastAttemptAt);
   assert.equal(row.procurementSource.checkedAt,old.procurementSource.checkedAt);
   // The two full encrypted restore sources retain query/review state. The
   // compact dashboard has historically omitted those non-display fields.
   if(snapshotIndex<2){
    assert.equal(row.xianyu.status,'deferred_limit');assert.equal(row.xianyu.deferredReason,'deferred_due_to_priority');
    assert.equal(row.xianyu.reviewStatus,old.xianyu.status);
    assert.equal(xianyuReviewPlan(row,row).skip,old.xianyu.status==='page_empty');
   }
  }
  assert.equal(snapshot.cycleCoverage.accepted,false);assert.equal(snapshot.cycleCoverage.inventoryComplete,false);
 }
});


test('real scan and source gates: active holds allow zero fetches and preserve every account and original quote clock',async t=>{
 const outcome=await runFixture(t,{activeHolds:true}),{events,previous}=outcome;
 assert.equal(events.some(row=>/^(?:public|xianyu):/.test(row.kind)),false,'no cost reader can start through a held source');
 for(const snapshot of outcome.snapshots){
  assertRetainedAllAccounts(snapshot,outcome);
  assert.equal(snapshot.login.xianyuAccess.allowed,false);
  assert.equal(snapshot.login.xianyuAccess.retryAt,new Date(NOW+3600000).toISOString());
  for(const row of snapshot.items){
   const old=previous.items.find(item=>item.id===row.id),platform=normalizeOfferPlatform(row.platform);
   assert.equal(row[platform].checkedAt,old[platform].checkedAt);
   assert.equal(row[platform].searchCheckedAt,old[platform].searchCheckedAt);
   if(platform==='yahoo')for(const field of ['lastAttemptAt','lastFullAttemptAt'])assert.equal(row.yahoo[field],old.yahoo[field],'pre-admission hold must not rotate attempt order');
   assert.deepEqual(row[platform].candidates,old[platform].candidates);
   assert.equal(row[platform].cacheReason,'request_error');
  }
  assert.equal(snapshot.scanMeta.yahooAttemptStats.preAdmissionDeferred,6);
  assert.equal(snapshot.scanMeta.yahooAttemptStats.noResponseDeferred,0);
  assert.equal(snapshot.scanMeta.yahooAttemptStats.responseBeforeDeferred,0);
  assert.equal(snapshot.cycleCoverage.priceObserved,0);
  assert.equal(snapshot.cycleCoverage.accepted,false);
 }
});


test('real scan: deferred compare advances attempt clocks only after its own source input returned',async t=>{
 const outcome=await runFixture(t,{deferredQuotes:true}),{events,previous}=outcome;
 assert.equal(events.filter(row=>row.kind==='quote:deferred'&&row.sourceInputObserved).length,3);
 assert.equal(events.filter(row=>row.kind==='quote:deferred'&&!row.sourceInputObserved).length,3);
 for(const snapshot of outcome.snapshots){
  assertRetainedAllAccounts(snapshot,outcome);
  assert.deepEqual(snapshot.scanMeta.yahooAttemptStats,{preAdmissionDeferred:0,noResponseDeferred:3,responseBeforeDeferred:3});
  for(const row of snapshot.items.filter(item=>normalizeOfferPlatform(item.platform)==='yahoo')){
   const old=previous.items.find(item=>item.id===row.id),observed=row.id.endsWith('-2');
   for(const field of ['checkedAt','searchCheckedAt','candidates','lowestPrice'])assert.deepEqual(row.yahoo[field],old.yahoo[field],field+' remains old evidence');
   assert.equal(row.yahoo.cacheReason,'request_error');assert.equal(row.yahoo.deferredReason,'request_cooldown_deadline');
   for(const field of ['lastAttemptAt','lastFullAttemptAt']){
    if(observed){assert.ok(Date.parse(row.yahoo[field])>=NOW);assert.notEqual(row.yahoo[field],old.yahoo[field]);}
    else assert.equal(row.yahoo[field],old.yahoo[field]);
   }
  }
 }
 // A returned input may be shared with another worker in this same run. These
 // are comparison-observation classifications, deliberately not network counts.
});
