import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {encrypt,decrypt} from '../scripts/lib/crypto.mjs';
import {PRICING_RULES_VERSION} from '../public/pricing-policy.js';

const NOW=Date.parse('2026-10-17T06:00:00.000Z'),OLD=new Date(NOW-2*3600000).toISOString();
const origin='https://paypayfleamarket.yahoo.co.jp',itemUrl=id=>`${origin}/item/${id}`;
const TITLE='APEX ヴァイオレット・エヴァーガーデン 自動手記人形Ver. 1/7 フィギュア 新品 未使用 1点';
const DESCRIPTION='新品 未使用 フィギュア1点。PRIVATE_DESCRIPTION_SENTINEL';
const phaseError=new Error('synthetic original scan phase failure');
const hook='__scanPagePoolObservationFixture',password='synthetic-pool-scan-password',memberPassword='synthetic-pool-member-password';
const accounts=[
 {id:'rakuma',name:'Rakuma fixture',platform:'rakuma',sellerId:'900',profileUrl:'https://fril.jp/shop/fixture'},
 ...['melon','boss','momoka'].map((id,index)=>({id,name:`${id} fixture`,platform:'yahoo',sellerId:`p${index+1}`,profileUrl:`${origin}/user/p${index+1}`}))
];
const envKeys=['PRICE_SCAN_ENGINE','FULL_PRICE_AUDIT','FORCE_FULL_SCAN','PRICE_AUDIT_ITEM_IDS','DASHBOARD_PASSWORD','PORTAL_USERS_JSON',
 'GITHUB_SHA','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_EVENT_NAME','GITHUB_EVENT_PATH','GITHUB_REF','GITHUB_REPOSITORY','GITHUB_TOKEN',
 'GITHUB_OUTPUT','GITHUB_ACTIONS','SCAN_WRITER_LOCK','SCAN_TRIGGER','XIANYU_AUTH_PART_1','XIANYU_AUTH_PART_2','XIANYU_AUTH_PART_3',
 'XIANYU_STORAGE_STATE_GZIP_B64','XIANYU_STORAGE_STATE_B64'];
const imageUrl=id=>`https://synthetic.invalid/${id}.jpg`;
const htmlFor=data=>`<!doctype html><html><script id="__NEXT_DATA__">${JSON.stringify(data)}</script><!--${'x'.repeat(11000)}--></html>`;
const normalPlatform=item=>item.platform==='rakuma'?'rakuma':'yahoo';
function initialState(){
 const items=accounts.map(account=>{
  const id=account.platform==='rakuma'?'a'.repeat(32):`${account.id}-own`;
  const candidate={id:'old-external',title:'破損 ジャンク 部品のみ',price:8500,sellerId:'old-seller',image:imageUrl('old-external'),
   url:itemUrl('old-external'),matchMethod:'fixture-retained',checkedAt:OLD};
  const comparison={status:'ok',rulesVersion:PRICING_RULES_VERSION,checkedAt:OLD,searchCheckedAt:OLD,lastAttemptAt:OLD,lastFullAttemptAt:OLD,
   candidates:[candidate],lowestPrice:8500,lowestUrl:candidate.url,recommendedPrice:8499};
  return {id,accountId:account.id,platform:account.platform,comparisonMode:'same_platform',title:TITLE,sellerId:account.sellerId,
   image:imageUrl(id),url:account.platform==='rakuma'?`https://item.fril.jp/${id}`:itemUrl(id),itemStatus:'OPEN',ownPrice:10000,
   [account.platform]:comparison,xianyu:{status:'error',checkedAt:OLD,samples:[],averageCNY:null}};
 });
 return {checkedAt:OLD,items,accounts,manualCosts:{'melon:melon-own':{accountId:'melon',itemId:'melon-own',purchaseCNY:123,updatedAt:OLD}},
  matchCorrections:{'melon:melon-own:yahoo:deleted-correction':{accountId:'melon',itemId:'melon-own',platform:'yahoo',candidateId:'deleted-correction',deleted:true,updatedAt:OLD}},
  portalUsers:[{username:'fixture',displayName:'Fixture member',password:memberPassword,accountIds:['melon'],enabled:true,updatedAt:OLD}],
  portalPreferences:{fixture:{priceAlerts:false,updatedAt:OLD}},relistAliases:{},dismissedDiscoveries:{kept:{dismissedAt:OLD}},discoveryReviews:{kept:{status:'listed',updatedAt:OLD}}};
}

// The actual scan, Yahoo transport gate, profile/item/search parsers, comparator,
// producer callback, pool mapping, encryption and publication execute unchanged.
// Only disposable-copy unrelated workers and image bytes are substituted. The
// forwarding spies below invoke the real Yahoo producer and real pool mapper.
async function runFixture(t,{enabled=true,mode='success',observerThrows=false,mapperThrows=false,finishThrows=false,phaseThrows=false,sharedDetails=false,sharedPeekMissing=false}={}){
 t.mock.timers.enable({apis:['Date'],now:NOW});
 const source=fileURLToPath(new URL('../',import.meta.url)),root=await fs.mkdtemp(path.join(os.tmpdir(),'scan-page-pool-observation-'));
 const savedEnv=Object.fromEntries(envKeys.map(key=>[key,process.env[key]])),savedFetch=globalThis.fetch;
 const savedConsole={log:console.log,warn:console.warn,error:console.error},logs=[],events=[],requests=[],callbacks=[],bundleCalls=[],mappings=[];
 const fingerprints=new Map();
 const previous=initialState(),byId=new Map(previous.items.map(item=>[item.id,item]));
 if(mode==='active_hold')previous.yahooRequestAccess={reason:'http_429',retryAt:NOW+3600000};
 const detailFor=(id,item)=>({id,title:TITLE,description:DESCRIPTION,price:item?.ownPrice??9000,status:'OPEN',
  seller:{id:item?.sellerId??'external-seller'},images:[imageUrl(id)],delivery:{fee:'出品者負担'}});
 const capture=(...args)=>logs.push(args.map(value=>typeof value==='string'?value:JSON.stringify(value)).join(' '));
 console.log=capture;console.warn=capture;console.error=capture;
 globalThis[hook]={
  bundle(original,id,settings){
   const callback=settings.onYahooItemPageObserved;
   bundleCalls.push({id,hasCallback:typeof callback==='function'});
   return original(id,typeof callback!=='function'?settings:{...settings,onYahooItemPageObserved:(...args)=>{
    callbacks.push({id,at:Date.now(),args});events.push({kind:'callback',id,at:Date.now()});
    if(observerThrows)throw Error('synthetic observation callback failure');
    return callback(...args);
   }});
  },
  mapping(original,args){
   mappings.push({targets:args.targets.map(row=>({id:row.id,accountId:row.accountId,platform:row.platform})),requestCount:requests.length,eventCount:events.length,at:Date.now()});
   events.push({kind:'mapping',at:Date.now()});
   if(mapperThrows)throw Error('synthetic observation mapping failure');
   return original(args);
  },
  observer(original,args){
   const observer=original(args);
   return {...observer,finish(...params){if(finishThrows)throw Error('PRIVATE_FINISH_FAILURE_SENTINEL');return observer.finish(...params);}};
  },
  phases(original,...args){if(phaseThrows)throw phaseError;return original(...args);},
  async rakumaProfile(){events.push({kind:'rakuma-profile',at:Date.now()});return {items:previous.items.filter(row=>row.platform==='rakuma'),complete:true,pages:1};},
  async rakumaItem(item){return detailFor(item.id,item);},
  async rakumaCompare(item){if(mode==='normal_tail')t.mock.timers.setTime(NOW+12*60_000+2000);events.push({kind:'rakuma-compare',at:Date.now()});return {...previous.items.find(row=>row.id===item.id).rakuma,status:'cached'};},
  async fingerprint(url){const value={url,dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[100,100,100],
   colorGrid:Array(768).fill(100),contentSha256:'b'.repeat(64),imageObservedAt:new Date(Date.now()).toISOString(),imageCacheExpiresAt:NOW+3600_000};fingerprints.set(url,value);return value;},
  knownFingerprint(url){const value=fingerprints.get(url);return value&&!sharedPeekMissing?{status:'available',...value}:{status:'unavailable'};},
  async peekFingerprint(url){return sharedPeekMissing?null:structuredClone(fingerprints.get(url)||null);},
  async session(){return {file:null,access:()=>({allowed:false,reason:'fixture_hold',retryAt:new Date(NOW+3600000).toISOString()}),persist:async()=>{}};},
  async publicProcurement(){return new Map();},
  async denyBrowser(){throw Error('No browser is allowed in the offline page-pool fixture');}
 };
 try{
  await fs.cp(path.join(source,'scripts'),path.join(root,'scripts'),{recursive:true});
  await fs.cp(path.join(source,'public'),path.join(root,'public'),{recursive:true});
  await fs.rm(path.join(root,'public/data'),{recursive:true,force:true});
  for(const name of ['state','config'])await fs.mkdir(path.join(root,name));
  await fs.writeFile(path.join(root,'package.json'),'{"type":"module"}');
  await fs.symlink(await fs.realpath(path.join(source,'node_modules')),path.join(root,'node_modules'),'dir');
  async function wrap(module,exports){
   const original=module.replace('.mjs','-fixture-original.mjs');
   await fs.rename(path.join(root,'scripts/lib',module),path.join(root,'scripts/lib',original));
   await fs.writeFile(path.join(root,'scripts/lib',module),`export * from './${original}';\n`+
    Object.entries(exports).map(([name,method])=>`export const ${name}=(...args)=>globalThis.${hook}.${method}(...args);`).join('\n'));
  }
  await wrap('rakuma.mjs',{discoverRakumaProfile:'rakumaProfile',fetchRakumaItem:'rakumaItem',rakumaCompare:'rakumaCompare'});
  await wrap('image.mjs',{imageFingerprints:'fingerprint',peekImageFingerprints:'peekFingerprint',peekKnownImageObservation:'knownFingerprint'});
  await wrap('xianyu-session.mjs',{loadXianyuSession:'session'});
  await wrap('procurement-runner.mjs',{runPublicProcurement:'publicProcurement'});
  await wrap('browser.mjs',{openContext:'denyBrowser'});
  for(const [module,name,method] of [['yahoo.mjs','fetchYahooItemBundle','bundle'],['yahoo-page-observation-pool.mjs','mapYahooPoolToTargets','mapping'],['yahoo-scan-page-observation.mjs','createYahooScanPageObservation','observer'],['account-scan-phases.mjs','runAccountScanPhases','phases']]){
   const original=module.replace('.mjs','-fixture-original.mjs');
   await fs.rename(path.join(root,'scripts/lib',module),path.join(root,'scripts/lib',original));
   await fs.writeFile(path.join(root,'scripts/lib',module),`import * as original from './${original}';\nexport * from './${original}';\nexport const ${name}=(...args)=>globalThis.${hook}.${method}(original.${name},...args);`);
  }
  await fs.writeFile(path.join(root,'config/accounts.json'),JSON.stringify({accounts}));
  await fs.writeFile(path.join(root,'config/settings.json'),JSON.stringify({comparisonMode:'same_platform',scanAccountPriorityIds:['melon','boss','momoka'],
   scanBudgetMinutes:12,profileConcurrency:1,yahooConcurrency:1,rakumaConcurrency:1,exchangeRate:20,attempts:1,
   yahooGeometryPriority:false,yahooObserveNormalPageRails:enabled,yahooSharedDetailOffers:sharedDetails}));
  await fs.writeFile(path.join(root,'state/latest.json.enc'),encrypt(Buffer.from(JSON.stringify(previous)),password));
  for(const key of envKeys)process.env[key]='';
  Object.assign(process.env,{DASHBOARD_PASSWORD:password,PRICE_SCAN_ENGINE:'legacy'});
  globalThis.fetch=async(input,options={})=>{
   const url=String(input),parsed=new URL(url);requests.push(url);
   assert.equal(parsed.origin,origin,'every permitted source response is in-process Yahoo fixture HTML');
   assert.equal(options.signal?.aborted,false,'expired/aborted source requests cannot start');
   const account=accounts.find(row=>row.profileUrl===`${parsed.origin}${parsed.pathname}`);
   let data,id,kind;
   if(account){
    kind='profile';const page=Number(parsed.searchParams.get('page'));assert.ok(page===1||page===2);
    const rows=previous.items.filter(row=>row.accountId===account.id).map(row=>({id:row.id,title:row.title,price:row.ownPrice,
     thumbnailImageUrl:row.image,itemStatus:'OPEN',sellerId:row.sellerId}));
    const result={items:rows,totalResultsAvailable:rows.length,totalResultsReturned:rows.length,offset:0};
    if(mode==='incomplete_profile'&&account.id==='momoka')delete result.totalResultsAvailable;
    if(mode==='truncated_profile'&&account.id==='momoka')Object.assign(result,{items:page===1?rows:[],totalResultsAvailable:101,totalResultsReturned:page===1?1:0,offset:(page-1)*100});
    data={props:{initialState:{searchState:{search:{result}}}}};
   }else if(parsed.pathname.startsWith('/search/')){
    kind='search';data={props:{initialState:{searchState:{search:{result:{items:[],totalResultsAvailable:0}}}}}};
   }else{
    assert.match(parsed.pathname,/^\/item\/[A-Za-z0-9_-]+$/);id=parsed.pathname.split('/').at(-1);
    const own=byId.get(id);assert.ok(own||id==='external-shared','observation must not schedule sentinel or speculative item reads');kind=own?'own':'candidate';
    const card=(itemId,title=TITLE,sellerId='external-seller')=>({itemId,title,price:9000,image:{url:imageUrl(itemId)},seller:{id:sellerId},log:{rctype:'vector',rcsm:1},description:'PRIVATE_RAW_CARD_DESCRIPTION'});
    const cards=own?[card('external-shared'),card('boss-own',TITLE,'p2'),card('rail-only-private-id','破損 ジャンク 部品のみ')]:[card('candidate-page-rail-id')];
    data={props:{initialState:{itemsState:{items:{item:detailFor(id,own)}},recommendsState:{recommends:{recommends:{related:{recommendItems:{items:cards}}}}}}}};
   }
   events.push({kind:'request',sourceKind:kind,id,url,at:Date.now()});
   if(mode==='source_failure'&&kind!=='profile'){
    t.mock.timers.tick(6000);return {ok:false,status:403,headers:new Headers(),url,redirected:false,text:async()=>''};
   }
   return {ok:true,status:200,headers:new Headers(),url,redirected:false,text:async()=>{
    t.mock.timers.tick(mode==='deadline'?12*60_000:6000);
    events.push({kind:'body',sourceKind:kind,id,url,at:Date.now()});
    const detail=data?.props?.initialState?.itemsState?.items?.item;
    const priceArea=detail?`<main><h1>${detail.title}</h1><div><span class="ItemPrice__Component">${detail.price}円</span><span class="ItemDetail__ShippingFreeLabel">送料無料</span></div><h2>商品の説明</h2></main>`:'';
    return htmlFor(data)+priceArea;
   }};
  };
  try{await import(pathToFileURL(path.join(root,'scripts/scan.mjs')));}
  catch(error){if(phaseThrows)return {phaseError:error,logs,requests,events};throw error;}
  const read=async(file,key=password)=>JSON.parse(decrypt(await fs.readFile(path.join(root,file)),key));
  const snapshots=await Promise.all(['state/latest.json.enc','public/data/state.json.enc','public/data/latest.json.enc'].map(file=>read(file)));
  const member=await read('public/data/users/fixture/latest.json.enc',memberPassword);
  return {snapshots,member,previous,requests,events,callbacks,bundleCalls,mappings,logs};
 }finally{
  globalThis.fetch=savedFetch;delete globalThis[hook];Object.assign(console,savedConsole);
  for(const [key,value] of Object.entries(savedEnv))if(value===undefined)delete process.env[key];else process.env[key]=value;
  await fs.rm(root,{recursive:true,force:true});t.mock.timers.reset();
 }
}

function evidence(snapshot){return snapshot.items.map(item=>({id:item.id,accountId:item.accountId,ownPrice:item.ownPrice,
 recommendedPrice:item.recommendedPrice,lowestPrice:item.lowestPrice,priceSignal:item.priceSignal,yahoo:item.yahoo,rakuma:item.rakuma,
 sourceDetail:item.sourceDetail}));}
function assertPreserved(outcome){
 for(const snapshot of outcome.snapshots){
  assert.deepEqual(snapshot.items.map(row=>`${row.accountId}:${row.id}`).sort(),outcome.previous.items.map(row=>`${row.accountId}:${row.id}`).sort());
  assert.equal(snapshot.accounts.length,4);assert.equal(snapshot.cycleCoverage.total,4);
  assert.deepEqual(snapshot.scanMeta.comparisonTasks,{yahoo:3,rakuma:1,mercari:0});
  for(const field of ['manualCosts','matchCorrections','portalPreferences','dismissedDiscoveries','discoveryReviews'])assert.deepEqual(snapshot[field],outcome.previous[field],field);
 }
 assert.deepEqual(outcome.member.items.map(row=>row.accountId),['melon']);
 assert.ok(Object.values(outcome.member.matchCorrections).every(row=>row.accountId==='melon'));
}
function assertObservation(outcome){
 const summary=outcome.snapshots[0].scanMeta.yahooPageObservation;
 assert.ok(summary,'enabled ordinary scan must publish its aggregate observation');
 assert.equal(summary.totalManagedTargets,4);assert.equal(summary.yahooTargets,3);assert.equal(summary.unresolvedTargets,4);
 assert.equal(summary.completeComparisons,0);assert.equal(summary.searchObservedTargets,0);
 assert.equal(summary.marketplaceRequests,0);assert.equal(summary.imageRequests,0);assert.equal(summary.checkedAt,null);assert.equal(summary.searchCheckedAt,null);
 assert.ok(summary.mappingPasses<=1);assert.equal(summary.mappedTargets+summary.unmappedTargets,4);
 assert.equal(summary.ownPageObservedTargets+summary.pendingOwnPageTargets,4);
 const aggregate=outcome.logs.filter(line=>line.startsWith('[Yahoo页面共享观察]'));
 assert.equal(aggregate.length,1,'one final aggregate, never per-account mapping summaries');
 assert.deepEqual(JSON.parse(aggregate[0].slice('[Yahoo页面共享观察]'.length).trim()),summary);
 for(const secret of [...outcome.previous.items.map(row=>row.id),'external-shared','rail-only-private-id','candidate-page-rail-id',TITLE,DESCRIPTION,
  'PRIVATE_RAW_CARD_DESCRIPTION','paypayfleamarket.yahoo.co.jp','synthetic.invalid'])assert.equal(aggregate[0].includes(secret),false,'new aggregate must omit '+secret);
 assert.doesNotMatch(aggregate[0],/[a-f0-9]{64}/,'body/image hashes remain out of the aggregate');
 for(const snapshot of outcome.snapshots)assert.deepEqual(snapshot.scanMeta.yahooPageObservation,summary);
 return summary;
}
function assertEquivalent(enabled,disabled){
 assert.deepEqual(enabled.requests,disabled.requests,'observation adds no source requests and does not reorder planned requests');
 for(let i=0;i<enabled.snapshots.length;i++){
  assert.deepEqual(evidence(enabled.snapshots[i]),evidence(disabled.snapshots[i]),'accepted results, queue state and original source clocks stay identical');
  assert.deepEqual(enabled.snapshots[i].pricingCoverage,disabled.snapshots[i].pricingCoverage);
  assert.deepEqual(enabled.snapshots[i].cycleCoverage,disabled.snapshots[i].cycleCoverage);
 }
 assert.equal(disabled.callbacks.length,0);assert.equal(disabled.mappings.length,0);
 assert.equal(disabled.logs.some(line=>line.startsWith('[Yahoo页面共享观察]')),false);
}

test('real ordinary scan: optional existing-page rails map every account once without changing source requests or accepted quote clocks',async t=>{
 const enabled=await runFixture(t),disabled=await runFixture(t,{enabled:false});
 assertPreserved(enabled);assertPreserved(disabled);assertEquivalent(enabled,disabled);const summary=assertObservation(enabled);
 assert.equal(enabled.mappings.length,1);assert.equal(summary.mappingPasses,1);
 assert.equal(enabled.mappings[0].targets.length,4,'the one mapping receives the full all-account target denominator');
 assert.deepEqual(enabled.mappings[0].targets.filter(row=>row.platform!=='rakuma').map(row=>`${row.accountId}:${row.id}`).sort(),['boss:boss-own','melon:melon-own','momoka:momoka-own']);
 assert.equal(enabled.mappings[0].requestCount,enabled.requests.length,'mapping runs after all planned source reads');
 assert.ok(enabled.events.findIndex(row=>row.kind==='mapping')>enabled.events.findIndex(row=>row.kind==='rakuma-compare'),'mapping waits for the final normal phase');
 assert.equal(summary.currentProfileTargets,3);assert.equal(summary.ownPageObservedTargets,3);assert.equal(summary.acceptedSourceReads,4);
 assert.equal(summary.mappedTargets,3);assert.equal(summary.targetCandidatePairs,6);assert.equal(summary.uniqueCandidateIds,2);
 assert.equal(summary.mappedTargetsWithBothObservedDetailFields,3);assert.equal(summary.mappedPairsWithBothObservedDetailFields,3);
 assert.equal(summary.mappedPairsMissingCandidateObservedDetailFields,3);assert.equal(summary.mappedPairsMissingOwnObservedDetailFields,0);
 assert.equal(summary.lowerListedPricePairs,6);assert.equal(summary.saleTermsVerificationPendingPairs,6);assert.equal(summary.saleTermsVerifiedPairs,0);
 assert.deepEqual(enabled.callbacks.map(row=>row.id).sort(),['boss-own','external-shared','melon-own','momoka-own']);
 assert.ok(enabled.bundleCalls.filter(row=>row.hasCallback).every(row=>enabled.requests.includes(itemUrl(row.id))),'every hooked bundle is an already-planned actual source read');
 for(const callback of enabled.callbacks){
  const body=enabled.events.find(row=>row.kind==='body'&&row.id===callback.id);assert.ok(body);assert.equal(callback.at,body.at);
  const receipt=callback.args[0];assert.equal(receipt.requestedItemId,callback.id);assert.equal(receipt.page.observedAt,body.at);
  assert.equal(Date.parse(receipt.recommendationReceipt.observedAt),body.at);assert.equal(receipt.page.url,itemUrl(callback.id));
  assert.equal(receipt.page.fromCache,false);assert.match(receipt.page.html,/__NEXT_DATA__/);
  assert.equal(receipt.role,callback.id==='external-shared'?'candidate':'own');
 }
 assert.equal(enabled.requests.some(url=>/rail-only-private-id|candidate-page-rail-id/.test(url)),false);
 for(const row of enabled.snapshots[0].items.filter(item=>normalPlatform(item)==='yahoo')){
  assert.ok(row.yahoo.candidates.some(candidate=>candidate.id==='external-shared'&&candidate.price===9000),'real comparator must accept a fixture offer');
  assert.notEqual(row.yahoo.checkedAt,OLD);assert.notEqual(row.yahoo.searchCheckedAt,OLD);
 }
});

for(const mode of ['incomplete_profile','truncated_profile','active_hold','deadline','source_failure'])test(`real ordinary scan: ${mode} retains every target and never upgrades old evidence from pooled observations`,async t=>{
 const enabled=await runFixture(t,{mode}),disabled=await runFixture(t,{enabled:false,mode});
 assertPreserved(enabled);assertPreserved(disabled);assertEquivalent(enabled,disabled);const summary=assertObservation(enabled);
 assert.equal(summary.unresolvedTargets,4);assert.ok(summary.blockedTargets>=1);
 if(mode==='incomplete_profile'||mode==='truncated_profile'){
  assert.equal(summary.currentProfileTargets,2);assert.ok(summary.blockedTargets>=2);
  const momoka=enabled.snapshots[0].accounts.find(row=>row.id==='momoka');
  assert.notEqual(momoka.yahooProfileObservation?.complete,true);
 }else{
  assert.equal(summary.acceptedSourceReads,0);assert.equal(enabled.callbacks.length,0);
  for(const row of enabled.snapshots[0].items.filter(item=>normalPlatform(item)==='yahoo')){
   const old=enabled.previous.items.find(item=>item.id===row.id);
   assert.equal(row.yahoo.checkedAt,old.yahoo.checkedAt);assert.equal(row.yahoo.searchCheckedAt,old.yahoo.searchCheckedAt);
   assert.deepEqual(row.yahoo.candidates,old.yahoo.candidates);
  }
  if(mode==='active_hold')assert.equal(enabled.requests.length,0);
  if(mode==='deadline')assert.equal(enabled.requests.length,1);
 }
});

for(const failure of ['observerThrows','mapperThrows'])test(`real ordinary scan: ${failure} cannot fail normal comparison or introduce source requests`,async t=>{
 const enabled=await runFixture(t,{[failure]:true}),disabled=await runFixture(t,{enabled:false});
 assertPreserved(enabled);assertEquivalent(enabled,disabled);const summary=assertObservation(enabled);
 assert.equal(summary.unresolvedTargets,4);assert.equal(summary.completeComparisons,0);
 if(failure==='observerThrows')assert.equal(summary.acceptedSourceReads,0);
 if(failure==='mapperThrows')assert.equal(enabled.mappings.length,1);
});


test('real ordinary scan finishing two seconds after source deadline still maps current original reads exactly once',async t=>{
 const enabled=await runFixture(t,{mode:'normal_tail'}),disabled=await runFixture(t,{enabled:false,mode:'normal_tail'});
 assertPreserved(enabled);assertEquivalent(enabled,disabled);const summary=assertObservation(enabled);
 assert.equal(summary.reason,'observed_only');assert.equal(summary.acceptedSourceReads,4);assert.equal(summary.retainedSources,4);
 assert.equal(summary.mappedTargets,3);assert.equal(summary.targetCandidatePairs,6);assert.equal(summary.mappingPasses,1);
 assert.equal(enabled.mappings[0].at,NOW+12*60_000+2000);assert.ok(summary.originalObservedAtMax<NOW+12*60_000);
});


test('real scan outer finalizer failure preserves successful results and emits only bounded failure fields',async t=>{
 const enabled=await runFixture(t,{finishThrows:true}),disabled=await runFixture(t,{enabled:false});
 assertPreserved(enabled);assertEquivalent(enabled,disabled);
 const summary=enabled.snapshots[0].scanMeta.yahooPageObservation;
 assert.equal(summary.reason,'observer_finalization_failed');assert.equal(summary.scanPhaseFailed,false);
 assert.equal(summary.totalManagedTargets,4);assert.equal(summary.unresolvedTargets,4);
 assert.equal(summary.completeComparisons,0);assert.equal(summary.mappingPasses,0);assert.equal(summary.checkedAt,null);
 const aggregate=enabled.logs.filter(line=>line.startsWith('[Yahoo页面共享观察]'));assert.equal(aggregate.length,1);
 assert.equal(aggregate[0].includes('PRIVATE_FINISH_FAILURE_SENTINEL'),false);
 for(const snapshot of enabled.snapshots)assert.deepEqual(snapshot.scanMeta.yahooPageObservation,summary);
});

test('real scan phase error remains the original error when observation finalization also throws',async t=>{
 const enabled=await runFixture(t,{phaseThrows:true,finishThrows:true}),disabled=await runFixture(t,{enabled:false,phaseThrows:true});
 assert.strictEqual(enabled.phaseError,phaseError);assert.strictEqual(disabled.phaseError,phaseError);
 assert.deepEqual(enabled.requests,disabled.requests);assert.equal(enabled.requests.length,0);
 const aggregate=enabled.logs.filter(line=>line.startsWith('[Yahoo页面共享观察]'));assert.equal(aggregate.length,1);
 const summary=JSON.parse(aggregate[0].slice('[Yahoo页面共享观察]'.length).trim());
 assert.equal(summary.reason,'observer_finalization_failed');assert.equal(summary.scanPhaseFailed,true);
 assert.equal(summary.totalManagedTargets,4);assert.equal(summary.completeComparisons,0);
 assert.equal(aggregate[0].includes('PRIVATE_FINISH_FAILURE_SENTINEL'),false);
});


test('real scan shared strict consumer publishes an independently verified quote with identical normal source trajectory and automatic decisions',async t=>{
 const enabled=await runFixture(t,{sharedDetails:true}),disabled=await runFixture(t);
 assert.deepEqual(enabled.requests,disabled.requests);assertPreserved(enabled);
 for(let i=0;i<enabled.snapshots.length;i++){
  assert.deepEqual(evidence(enabled.snapshots[i]),evidence(disabled.snapshots[i]));
  assert.deepEqual(enabled.snapshots[i].pricingCoverage,disabled.snapshots[i].pricingCoverage);
  assert.deepEqual(enabled.snapshots[i].cycleCoverage,disabled.snapshots[i].cycleCoverage);
 }
 const offers=enabled.snapshots[0].items.flatMap(item=>item.sharedYahooOffers||[]);assert.ok(offers.length>0);
 assert.ok(offers.every(offer=>offer.id==='external-shared'&&offer.price===9000&&offer.canRecommend===false));
 const line=enabled.logs.find(line=>line.startsWith('[Yahoo共享详情报价]'));assert.ok(line);
 const counts=JSON.parse(line.slice('[Yahoo共享详情报价]'.length));assert.equal(counts.htmlRequests,0);assert.equal(counts.imageRequests,0);assert.ok(counts.verifiedPairs>0);
 assert.equal(enabled.requests.some(url=>/candidate-page-rail-id|rail-only-private-id/.test(url)),false);
 for(const value of [TITLE,DESCRIPTION,'external-shared',password])assert.equal(line.includes(value),false);
});
for(const mode of ['active_hold','deadline','incomplete_profile','success'])test(`real scan shared strict ${mode} with missing images never fabricates a quote or retries missing source work`,async t=>{
 const enabled=await runFixture(t,{sharedDetails:true,sharedPeekMissing:true,mode}),disabled=await runFixture(t,{mode});
 assert.deepEqual(enabled.requests,disabled.requests);assertPreserved(enabled);
 for(let i=0;i<enabled.snapshots.length;i++){
  assert.deepEqual(evidence(enabled.snapshots[i]),evidence(disabled.snapshots[i]));
  assert.deepEqual(enabled.snapshots[i].cycleCoverage,disabled.snapshots[i].cycleCoverage);
  assert.ok(enabled.snapshots[i].items.every(item=>!item.sharedYahooOffers?.length));
 }
});
