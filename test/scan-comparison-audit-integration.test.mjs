import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {encrypt,decrypt} from '../scripts/lib/crypto.mjs';
import {comparisonAuditMarker,COMPARISON_AUDIT_LIMITS,decideComparisonAuditActivation} from '../scripts/lib/comparison-audit-control.mjs';
import {PRICING_RULES_VERSION} from '../public/pricing-policy.js';
import {normalizeOfferPlatform} from '../public/owned-offers.js';

const NOW=Date.parse('2026-10-16T22:00:00.000Z'),OLD=new Date(NOW-2*3600000).toISOString();
const SHA='a'.repeat(40),password='synthetic-comparison-audit-password',memberPassword='synthetic-member-password';
const requestId='synthetic-real-scan-audit',hook='__scanComparisonAuditFixture';
const source=fileURLToPath(new URL('../',import.meta.url)),origin='https://paypayfleamarket.yahoo.co.jp';
const TITLE='APEX ヴァイオレット・エヴァーガーデン 自動手記人形Ver. 1/7 フィギュア 新品 未使用 1点';
const DESCRIPTION='新品 未使用 フィギュア1点';
const iso=value=>new Date(value).toISOString(),itemUrl=id=>`${origin}/item/${id}`;
const envKeys=['PRICE_SCAN_ENGINE','FULL_PRICE_AUDIT','FORCE_FULL_SCAN','PRICE_AUDIT_ITEM_IDS','DASHBOARD_PASSWORD','PORTAL_USERS_JSON',
 'GITHUB_SHA','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_EVENT_NAME','GITHUB_EVENT_PATH','GITHUB_REF','GITHUB_REPOSITORY','GITHUB_TOKEN',
 'GITHUB_OUTPUT','GITHUB_ACTIONS','SCAN_WRITER_LOCK','SCAN_TRIGGER'];
const accounts=[
 {id:'rakuma',name:'Rakuma fixture',platform:'rakuma',profileUrl:'https://fril.jp/shop/fixture'},
 ...['melon','boss','momoka'].map((id,index)=>({id,name:`${id} fixture`,platform:'yahoo',sellerId:`p${index+1}`,profileUrl:`${origin}/user/p${index+1}`}))
];
const targets=[{accountId:'melon',itemId:'melon-1'},{accountId:'boss',itemId:'boss-1'}];
function inventory(){return accounts.flatMap(account=>[1,2].map(n=>{
 const id=account.platform==='rakuma'?(n===1?'a':'b').repeat(32):`${account.id}-${n}`;
 const candidate={id:`old-external-${id}`,platform:account.platform,url:account.platform==='rakuma'?`https://item.fril.jp/${'c'.repeat(32)}`:itemUrl(`old-external-${id}`),
  title:TITLE,image:`https://synthetic.invalid/old-${id}.jpg`,price:8750,sellerId:'external-old',checkedAt:OLD,matchMethod:'synthetic-retained',isOwn:false};
 const comparison={status:'ok',rulesVersion:PRICING_RULES_VERSION,checkedAt:OLD,searchCheckedAt:OLD,lastAttemptAt:OLD,lastFullAttemptAt:OLD,
  ownLastAttemptAt:OLD,knownLastAttemptAt:OLD,candidates:[candidate],lowestPrice:8750,recommendedPrice:8750,cardCount:1,competitorCount:1};
 return {id,accountId:account.id,platform:account.platform,comparisonMode:'same_platform',title:TITLE,itemStatus:'OPEN',sellerId:account.sellerId||'900',
  image:`https://synthetic.invalid/${id}.jpg`,url:account.platform==='rakuma'?`https://item.fril.jp/${id}`:itemUrl(id),ownPrice:10000,
  lowestPrice:8750,recommendedPrice:8750,[account.platform]:comparison,
  xianyu:{status:'error',checkedAt:OLD,lastAttemptAt:OLD,samples:[],averageCNY:null},
  procurementSource:{status:'error',checkedAt:OLD,lastAttemptAt:OLD,samples:[],averageCNY:null}};
}));}
function initialState(){
 const items=inventory();
 const matchCorrections=Object.fromEntries(targets.map(target=>{
  const record={accountId:target.accountId,itemId:target.itemId,platform:'yahoo',candidateId:`corrected-${target.itemId}`,updatedAt:OLD,reason:'saved fixture exclusion'};
  return [`${record.accountId}:${record.itemId}:${record.platform}:${record.candidateId}`,record];
 }));
 matchCorrections['momoka:momoka-2:yahoo:deleted-correction']={accountId:'momoka',itemId:'momoka-2',platform:'yahoo',candidateId:'deleted-correction',deleted:true,updatedAt:OLD};
 return {checkedAt:OLD,dataRevision:OLD,cycleCoverage:{finishedAt:OLD},items,accounts,scanMeta:{codeSha:SHA},
  scanAdmission:{version:1,runKey:'123:1',codeSha:SHA,claimedAt:iso(NOW-1),slotKey:''},
  comparisonAuditReceipt:{version:1,revision:0,consumed:[]},
  manualCosts:{'melon:melon-1':{accountId:'melon',itemId:'melon-1',purchaseCNY:123,manualFeeCNY:4,shippingJPY:500,updatedAt:OLD}},matchCorrections,
  portalPreferences:{fixture:{notificationEmail:'fixture@example.invalid'}},
  portalUsers:[{username:'fixture',displayName:'Fixture member',password:memberPassword,accountIds:['melon'],enabled:true,updatedAt:OLD}],
  merchantMonitors:[{id:'retained-monitor',name:'Saved merchant',checkedAt:OLD,items:[{id:'saved-merchant-item'}]}],
  listingHistory:{'melon:historical-own':{id:'historical-own',accountId:'melon',platform:'yahoo',sellerId:'p99',title:'Historical own fixture',itemStatus:'SOLD'}},
  relistAliases:{'momoka:momoka-2':'momoka-old'},dismissedDiscoveries:{kept:{dismissedAt:OLD}},discoveryReviews:{kept:{status:'listed',updatedAt:OLD}},
  yahooRequestAccess:{reason:'http_429',retryAt:NOW-60_000},
  rakumaRequestAccess:{httpStatus:403,retryAfter:null,observedAt:OLD,retryAt:NOW-60_000,holdReason:'internal_fallback'}};
}
const htmlFor=data=>`<!doctype html><html><script id="__NEXT_DATA__">${JSON.stringify(data)}</script><!--${'x'.repeat(11000)}--></html>`;

// The disposable copy keeps scan.mjs, the real Yahoo HTTP gate and parsers,
// audit controller/runner, state, reconciliation, encryption and publication.
// Only forbidden normal workers, image bytes and browser/session exports are
// replaced. fetch never leaves this process: every allowed response is fixture
// HTML or the synthetic current-main response. No market or remote is touched.
async function runFixture(t,{mode='success',previous:restored,flowMode,baselineValidation}={}){
 t.mock.timers.enable({apis:['Date'],now:NOW});
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'scan-comparison-audit-integration-'));
 const savedEnv=Object.fromEntries(envKeys.map(key=>[key,process.env[key]])),savedFetch=globalThis.fetch;
 const savedConsole={log:console.log,warn:console.warn};
 console.log=()=>{};console.warn=()=>{};
 const previous=structuredClone(restored||initialState()),events=[],forbidden=[],network=[],imageEvents=[];
 const byId=new Map(previous.items.map(item=>[item.id,item]));
 const activation={enabled:true,requestId,issuedAt:iso(NOW-60_000),expiresAt:iso(NOW+3600000),prerequisitePublication:{codeSha:SHA,checkedAt:OLD,dataRevision:OLD,finishedAt:OLD},targets,...(flowMode===undefined?{}:{flowMode}),...(baselineValidation===undefined?{}:{baselineValidation})};
 if(mode==='expired')activation.expiresAt=iso(NOW);
 if(mode==='overlong')activation.expiresAt=iso(NOW+3*3600000);
 if(mode==='duplicate_target')activation.targets=[targets[0],targets[0]];
 if(mode==='missing_binding')activation.targets=[targets[0],{accountId:'boss',itemId:'unbound-foreign-id'}];
 if(mode==='corrupt_receipt')previous.comparisonAuditReceipt={version:1,revision:2,consumed:[]};
 if(mode==='missing_pin')delete activation.prerequisitePublication;
 if(mode==='future_pin')activation.prerequisitePublication.checkedAt=iso(NOW+1);
 if(mode==='missing_receipt')delete previous.comparisonAuditReceipt;
 if(mode==='replay')previous.comparisonAuditReceipt={version:1,revision:1,consumed:[{requestId,expectedSha:SHA,runId:'122',startedAt:iso(NOW-60_000),consumedAt:iso(NOW-60_000),deadlineAt:iso(NOW+660_000)}]};
 if(mode==='missing_admission')delete previous.scanAdmission;
 const deny=kind=>(...args)=>{forbidden.push({kind,args:args.map(value=>typeof value==='string'?value:value?.id)});throw Error(`Forbidden normal ${kind} in comparison audit`);};
 globalThis[hook]={
  yahooQuote:deny('yahoo comparison'),rakumaProfile:deny('Rakuma profile'),rakumaItem:deny('Rakuma detail'),rakumaPage:deny('Rakuma page'),rakumaQuote:deny('Rakuma comparison'),
  mercariQuote:deny('Mercari comparison'),publicCost:deny('public procurement'),xianyuCost:deny('Xianyu procurement'),openContext:deny('browser'),
  async session(){return {file:null,access:()=>({allowed:true,reason:null,retryAt:null}),persist:deny('session persistence')};},
  async fingerprint(url,options={}){
   options.observeImageTransferStart?.();
   imageEvents.push({url,deadlineAt:options.deadlineAt,aborted:options.signal?.aborted});
   assert.equal(options.stopOnAccessDenial,true);assert.equal(options.signal?.aborted,false);
   options.observeImageTransfer?.({fetches:1,bytes:20,durationMs:1});
   return {url,dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[100,100,100],colorGrid:Array(768).fill(100),
    contentSha256:'b'.repeat(64),imageObservedAt:iso(Date.now())};
  }
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
   await fs.writeFile(path.join(root,'scripts/lib',module),`export * from './${original}';\n`+Object.entries(exports).map(([name,method])=>`export const ${name}=(...args)=>globalThis.${hook}.${method}(...args);`).join('\n'));
  }
  await wrap('yahoo.mjs',{yahooCompare:'yahooQuote'});
  await wrap('rakuma.mjs',{discoverRakumaProfile:'rakumaProfile',fetchRakumaItem:'rakumaItem',fetchRakumaPage:'rakumaPage',rakumaCompare:'rakumaQuote'});
  await wrap('mercari.mjs',{mercariCompare:'mercariQuote'});
  await wrap('procurement-sources.mjs',{alternativeProcurementCost:'publicCost'});
  await wrap('xianyu.mjs',{xianyuCost:'xianyuCost'});
  await wrap('browser.mjs',{openContext:'openContext'});
  await wrap('image.mjs',{imageFingerprints:'fingerprint'});
  await wrap('xianyu-session.mjs',{loadXianyuSession:'session'});
  await fs.writeFile(path.join(root,'config/accounts.json'),JSON.stringify({accounts}));
  await fs.writeFile(path.join(root,'config/settings.json'),JSON.stringify({comparisonMode:'same_platform',scanAccountPriorityIds:['melon','boss','momoka'],
   scanBudgetMinutes:12,profileConcurrency:1,yahooConcurrency:1,rakumaConcurrency:1,maxXianyuItemsPerRun:8,maxPublicProcurementItemsPerRun:8,exchangeRate:20}));
  await fs.writeFile(path.join(root,'config/comparison-audit.json'),JSON.stringify(activation));
  const stateFile=path.join(root,'state/latest.json.enc');
  const originalEncrypted=encrypt(Buffer.from(JSON.stringify(previous)),password);
  await fs.writeFile(stateFile,originalEncrypted);
  if(previous.scanAdmission)await fs.writeFile(path.join(root,'state/scan-admission.json'),JSON.stringify(previous.scanAdmission));
  const eventFile=path.join(root,'event.json'),outputFile=path.join(root,'github-output');
  await fs.writeFile(eventFile,JSON.stringify({after:SHA,head_commit:{message:`Synthetic audit ${comparisonAuditMarker(requestId)}`}}));
  for(const key of envKeys)process.env[key]='';
  Object.assign(process.env,{DASHBOARD_PASSWORD:password,PRICE_SCAN_ENGINE:'legacy',GITHUB_SHA:SHA,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:mode==='rerun'?'2':'1',
   GITHUB_EVENT_NAME:mode==='cron'?'schedule':'push',GITHUB_EVENT_PATH:eventFile,GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'synthetic/fixture',GITHUB_TOKEN:'synthetic-token',
   GITHUB_OUTPUT:outputFile,GITHUB_ACTIONS:'true',SCAN_WRITER_LOCK:mode==='missing_lock'?'':'pages'});
  globalThis.fetch=async(input,options={})=>{
   const url=String(input);network.push(url);
   if(url==='https://api.github.com/repos/synthetic/fixture/branches/main'){
    assert.equal(options.headers.authorization,'Bearer synthetic-token');
    return {ok:true,json:async()=>({commit:{sha:mode==='stale_main'?'b'.repeat(40):SHA}})};
   }
   if(url==='https://hyx60268-dev.github.io/price-guard/data/state.json.enc'){
    assert.equal(options.redirect,'error');
    const before=JSON.parse(decrypt(await fs.readFile(stateFile),password));
    assert.deepEqual(before.comparisonAuditReceipt,previous.comparisonAuditReceipt,'receipt parity happens before consumption');
    if(mode==='publication_denied')return new Response('fixture unavailable',{status:403});
    if(mode==='publication_corrupt')return new Response('fixture unreadable encrypted bytes');
    const published=structuredClone(previous);
    if(mode==='publication_old')published.dataRevision=iso(NOW-3*3600000);
    if(mode==='publication_new')published.dataRevision=iso(NOW-1);
    if(mode==='publication_other_sha')published.scanMeta.codeSha='c'.repeat(40);
    if(mode==='publication_missing_ledger')delete published.comparisonAuditReceipt;
    return new Response(encrypt(Buffer.from(JSON.stringify(published)),password));
   }
   const parsed=new URL(url);assert.equal(parsed.origin,origin,'unexpected non-fixture network destination');
   assert.equal(options.redirect,'manual','every audit transport must expose redirects instead of hiding additional HTTP requests');
   const beforeSource=JSON.parse(decrypt(await fs.readFile(stateFile),password));
   assert.equal(beforeSource.comparisonAuditReceipt?.consumed?.filter(row=>row.requestId===requestId).length,1,'every source starts only after durable one-shot consumption');
   assert.equal(options.signal?.aborted,false,'no fixture source may start after cancellation');
   let data,kind,id,accountId;
   const profile=accounts.find(account=>account.profileUrl===`${parsed.origin}${parsed.pathname}`);
   if(profile){
    kind='profile';accountId=profile.id;
    const page=Number(parsed.searchParams.get('page'));
    const rows=previous.items.filter(item=>item.accountId===accountId).map(item=>({id:item.id,title:item.title,price:item.ownPrice,thumbnailImageUrl:item.image,itemStatus:'OPEN',sellerId:profile.sellerId}));
    // A second actual profile page is mandatory, including current SOLD IDs.
    if(accountId==='melon')for(let n=0;n<(mode==='profile_budget'?7899:99);n++)rows.push({id:`melon-sold-${n}`,title:'Historical fixture',price:2000,thumbnailImageUrl:'https://synthetic.invalid/sold.jpg',itemStatus:'SOLD',sellerId:profile.sellerId});
    const result={items:rows.slice((page-1)*100,page*100),totalResultsAvailable:rows.length,totalResultsReturned:Math.min(100,rows.length-(page-1)*100),offset:(page-1)*100};
    if(mode==='incomplete_ownership'&&accountId==='momoka')delete result.totalResultsAvailable;
    data={props:{initialState:{searchState:{search:{result}}}}};
   }else{
    assert.match(parsed.pathname,/^\/item\/[A-Za-z0-9_-]+$/,'audit may not search or read other source routes');
    id=parsed.pathname.split('/').at(-1);
    const own=byId.get(id),target=own&&targets.find(row=>row.itemId===id);
    kind=own?'own':'detail';accountId=own?.accountId;
    if(own)assert.ok(target,'only the two configured own details are permitted');
    const detail={id,title:TITLE,description:DESCRIPTION,price:own?.ownPrice??(mode==='low_card_flow'?9000:100),status:'OPEN',seller:{id:own?.sellerId??'external-current'},
     images:[own?.image??`https://synthetic.invalid/${id}.jpg`],delivery:{fee:'出品者負担'}};
    const rawCard=(cardId,sellerId)=>({itemId:cardId,title:TITLE,price:mode==='low_card_flow'?9000:100,image:{url:`https://synthetic.invalid/${cardId}.jpg`},seller:{id:sellerId},log:{rctype:'vector',rcsm:1}});
    const cards=own?[
     rawCard(`new-external-${id}`,'external-current'),rawCard('momoka-2','p3'),rawCard('historical-own','p99'),
     rawCard('melon-sold-0',''),rawCard(`corrected-${id}`,'external-corrected')
    ]:[];
    if(own&&mode==='low_card_flow'){cards.push({...rawCard(`higher-${id}`,'external-higher'),price:11000});cards.push({...rawCard(`unknown-${id}`,'external-current'),price:null});}
    data={props:{initialState:{itemsState:{items:{item:detail}},recommendsState:{recommends:{recommends:{related:{recommendItems:{items:cards}}}}}}}};
   }
   events.push({kind,id,accountId,url,at:Date.now()});
   if(mode==='denied'&&kind==='profile')return {ok:false,status:429,headers:new Headers({'retry-after':'3600'}),url,redirected:false,text:async()=>''};
   if(mode==='redirect'&&kind==='own')return {ok:false,status:302,headers:new Headers({location:'https://forbidden-redirect.synthetic.invalid/hidden-hop'}),url,redirected:false,text:async()=>''};
   if(mode==='deadline'&&kind==='profile')t.mock.timers.tick(COMPARISON_AUDIT_LIMITS.durationMs);
   return {ok:true,status:200,headers:new Headers(),url,redirected:false,text:async()=>{
    // Actual transport completion keeps its own observed time. Moving fake
    // Date beyond the unchanged 5.5-second gate prevents real fixture waits.
    t.mock.timers.tick(6000);
    const detail=data?.props?.initialState?.itemsState?.items?.item;
    const priceArea=mode==='low_card_flow'&&detail?`<main><h1>${detail.title}</h1><div><span class="ItemPrice__Component">${detail.price}円</span><span class="ItemDetail__ShippingFreeLabel">送料無料</span></div><h2>商品の説明</h2></main>`:'';
    return htmlFor(data)+priceArea;
   }};
  };
  let error;
  try{await import(pathToFileURL(path.join(root,'scripts/scan.mjs')));}catch(cause){error=cause;}
  const readEncrypted=async(file,key=password)=>JSON.parse(decrypt(await fs.readFile(path.join(root,file)),key));
  const disk=await readEncrypted('state/latest.json.enc');
  const published=[];
  for(const file of ['public/data/state.json.enc','public/data/latest.json.enc']){
   try{published.push(await readEncrypted(file));}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  let member=null;try{member=await readEncrypted('public/data/users/fixture/latest.json.enc',memberPassword);}catch(error){if(error.code!=='ENOENT')throw error;}
  const output=await fs.readFile(outputFile,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
  assert.deepEqual(forbidden,[],'audit must not invoke ordinary pricing, procurement or browser workers');
  return {events,imageEvents,network,error,disk,published,member,previous,output,activation,stateUnchanged:Buffer.compare(originalEncrypted,await fs.readFile(stateFile))===0};
 }finally{
  globalThis.fetch=savedFetch;delete globalThis[hook];
  console.log=savedConsole.log;console.warn=savedConsole.warn;
  for(const [key,value] of Object.entries(savedEnv))if(value===undefined)delete process.env[key];else process.env[key]=value;
  await fs.rm(root,{recursive:true,force:true});
  t.mock.timers.reset();
 }
}

function assertPreserved(outcome){
 const {previous,disk,published}=outcome;
 assert.ifError(outcome.error);assert.equal(published.length,2,'both actual encrypted publications must be written');
 for(const [index,snapshot] of [disk,...published].entries()){
  assert.equal(snapshot.items.length,previous.items.length);assert.equal(snapshot.accounts.length,accounts.length);
  assert.deepEqual(snapshot.items.map(row=>row.id).sort(),previous.items.map(row=>row.id).sort());
  assert.deepEqual(snapshot.manualCosts,previous.manualCosts);assert.deepEqual(snapshot.matchCorrections,previous.matchCorrections);
  assert.deepEqual(snapshot.merchantMonitors,previous.merchantMonitors);assert.deepEqual(snapshot.dismissedDiscoveries,previous.dismissedDiscoveries);
  assert.deepEqual(snapshot.discoveryReviews,previous.discoveryReviews);assert.deepEqual(snapshot.relistAliases,previous.relistAliases);
  assert.deepEqual(snapshot.rakumaRequestAccess,previous.rakumaRequestAccess);
  assert.equal(snapshot.scanMeta.comparisonAuditActive,true);assert.equal(snapshot.cycleCoverage.accepted,false);
  assert.equal(snapshot.cycleCoverage.total,previous.items.length);assert.equal(snapshot.cycleCoverage.priceObserved,0);
  assert.deepEqual(snapshot.scanMeta.comparisonTasks,{yahoo:6,rakuma:2,mercari:0});
  for(const account of snapshot.accounts)assert.equal(account.priorityDeferredReason,'deferred_due_to_comparison_audit');
  for(const item of snapshot.items){
   const old=previous.items.find(row=>row.id===item.id),platform=normalizeOfferPlatform(item.platform);
   assert.equal(item.ownPrice,old.ownPrice);
   assert.equal(item[platform].status,'deferred_due_to_comparison_audit');assert.equal(item[platform].deferredReason,'deferred_due_to_comparison_audit');
   for(const field of ['checkedAt','searchCheckedAt','lastAttemptAt','lastFullAttemptAt','ownLastAttemptAt','knownLastAttemptAt','lowestPrice'])assert.deepEqual(item[platform][field],old[platform][field],`${item.id}.${platform}.${field} must remain old evidence`);
   assert.deepEqual(item[platform].candidates.map(row=>[row.id,row.price,row.checkedAt]),old[platform].candidates.map(row=>[row.id,row.price,row.checkedAt]));
   assert.equal(item.xianyu.checkedAt,old.xianyu.checkedAt);assert.equal(item.xianyu.lastAttemptAt,old.xianyu.lastAttemptAt);
   assert.equal(item.procurementSource.checkedAt,old.procurementSource.checkedAt);assert.equal(item.procurementSource.lastAttemptAt,old.procurementSource.lastAttemptAt);
   assert.equal(item.procurementSource.attempted,false);assert.equal(item.procurementSource.cacheStatus,'deferred_due_to_comparison_audit');
   assert.equal(item[platform].candidates.some(row=>row.id.startsWith('new-external-')),false);
   assert.notEqual(item.recommendedPrice,100,'audit verdict never supplies a new repricing recommendation');
   if(index<2){assert.equal(item.xianyu.deferredReason,'deferred_due_to_comparison_audit');assert.deepEqual(item[platform].candidates,old[platform].candidates);}
  }
  const manual=snapshot.items.find(row=>row.id==='melon-1');assert.equal(manual.manualPurchaseCNY,123);assert.equal(manual.manualFeeCNY,4);assert.equal(manual.shippingJPY,500);
 }
 assert.deepEqual(disk.comparisonAuditReceipt,published[0].comparisonAuditReceipt,'consumed receipt survives final private restore publication');
 assert.equal(disk.comparisonAuditReceipt.revision,1);assert.equal(disk.comparisonAuditReceipt.consumed[0].requestId,requestId);
 assert.equal(disk.comparisonAuditReceipt.consumed[0].runId,'123');assert.deepEqual(disk.scanAdmission,previous.scanAdmission);
 assert.equal(published[1].comparisonAudit,undefined);assert.equal(published[1].comparisonAuditReceipt,undefined);
 assert.equal(outcome.member.comparisonAudit,undefined);assert.equal(outcome.member.comparisonAuditReceipt,undefined);
 assert.ok(outcome.member.items.every(item=>item.accountId==='melon'));assert.equal(outcome.member.items.length,2);
 assert.equal(outcome.output,'comparison_audit=true\n');
}

test('real scan: two-target audit counts full three-account profiles, preserves all evidence and never runs normal workers',async t=>{
 const outcome=await runFixture(t);assertPreserved(outcome);
 const report=outcome.disk.comparisonAudit;
 assert.equal(report.status,'completed');assert.equal(report.canRecommend,false);assert.equal(report.procurementCostEligible,false);
 assert.deepEqual(outcome.events.map(row=>row.kind),['profile','profile','profile','profile','own','own','detail','detail']);
 assert.deepEqual(outcome.events.filter(row=>row.kind==='profile').map(row=>row.accountId),['melon','melon','boss','momoka']);
 assert.deepEqual(outcome.events.filter(row=>row.kind==='own').map(row=>row.id),targets.map(row=>row.itemId));
 assert.deepEqual(outcome.events.filter(row=>row.kind==='detail').map(row=>row.id).sort(),targets.map(row=>`new-external-${row.itemId}`).sort());
 assert.equal(report.controller.counts.pageFetches,8);assert.equal(report.controller.counts.byKind.profile,4);assert.equal(report.controller.counts.byKind.own,2);
 assert.equal(report.controller.counts.competitorDetailFetches,2);assert.ok(report.controller.counts.pageFetches<=COMPARISON_AUDIT_LIMITS.pageFetches);
 assert.equal(outcome.disk.scanMeta.yahooTransport.transportRequests,report.controller.counts.pageFetches);
 assert.equal(report.controller.counts.imageFetches,outcome.imageEvents.length);assert.ok(outcome.imageEvents.length>0);
 assert.equal(report.imageTransfers.started,outcome.imageEvents.length);assert.equal(report.imageTransfers.settled,outcome.imageEvents.length);
 assert.equal(report.imageTransfers.pending,0);assert.equal(report.imageTransfers.metricsComplete,true);
 assert.equal(report.counts.comparable,2);assert.equal(report.counts.excluded,8);
 assert.ok(outcome.disk.accounts.filter(account=>account.platform==='yahoo_fleamarket'||account.platform==='yahoo').every(account=>account.yahooProfileObservation.complete));
 assert.equal(outcome.disk.accounts.find(account=>account.id==='melon').yahooProfileObservation.pageObservations.length,2);
 assert.equal(outcome.disk.accounts.find(account=>account.id==='melon').yahooProfileObservation.membershipIds.length,101);
 for(const target of report.targets){
  const paired=target.rows.find(row=>row.id===`new-external-${target.targetId}`);
  assert.equal(paired.baseline.status,'comparable');assert.ok(Date.parse(paired.detailObservation.observedAt)>Date.parse(target.recommendationReceipt.observedAt));
  assert.equal(paired.baseline.checkedAt,undefined);assert.equal(paired.baseline.candidate,undefined);
  assert.equal(target.rows.find(row=>row.id===`corrected-${target.targetId}`).exclusionReason,'saved_user_correction');
  for(const id of ['momoka-2','historical-own','melon-sold-0'])assert.equal(target.rows.find(row=>row.id===id).exclusionReason,'own_offer');
 }
 const auditItemIds=outcome.disk.items.filter(row=>row.comparisonAudit).map(row=>row.id).sort();
 assert.deepEqual(auditItemIds,targets.map(row=>row.itemId).sort());
 assert.deepEqual(outcome.disk.yahooRequestAccess,outcome.previous.yahooRequestAccess);
 for(const snapshot of [outcome.published[1],outcome.member])for(const item of snapshot.items.filter(row=>row.comparisonAudit)){
  const audit=item.comparisonAudit;
  assert.equal(audit.ownershipCheckedAtPublication,true);assert.equal(audit.target.accountId,item.accountId);assert.equal(audit.target.targetId,item.id);
  assert.doesNotMatch(JSON.stringify(audit),/momoka-2|historical-own|melon-sold-0|corrected-/,'display/member audit must not retain excluded owned or corrected cards in any nested receipt');
 }
 const replay=await runFixture(t,{mode:'repeat_final_state',previous:outcome.disk});
 assert.match(String(replay.error),/already_consumed/);assert.deepEqual(replay.events,[]);assert.equal(replay.stateUnchanged,true);
 assert.deepEqual(replay.disk.comparisonAuditReceipt,outcome.disk.comparisonAuditReceipt,'the actual final encrypted claim cannot be replayed');
});

test('real scan: first Yahoo denial stops every later source admission and still publishes retained inventory plus consumed claim',async t=>{
 const outcome=await runFixture(t,{mode:'denied'});assertPreserved(outcome);
 assert.equal(outcome.events.length,1);assert.equal(outcome.events[0].kind,'profile');assert.equal(outcome.imageEvents.length,0);
 assert.equal(outcome.disk.comparisonAudit.status,'incomplete');assert.equal(outcome.disk.comparisonAudit.controller.stopped,'source_denied');
 assert.equal(outcome.disk.comparisonAudit.stopReason,'source_denied');
 assert.equal(outcome.disk.comparisonAudit.controller.counts.pageFetches,1);
 assert.ok(outcome.disk.yahooRequestAccess.retryAt>=NOW+3600000,'actual 429 transport persists the source hold');
});

test('real scan: incomplete current profile index blocks both own detail reads while keeping claim and all accounts',async t=>{
 const outcome=await runFixture(t,{mode:'incomplete_ownership'});assertPreserved(outcome);
 assert.equal(outcome.events.length,4);assert.ok(outcome.events.every(row=>row.kind==='profile'));assert.equal(outcome.imageEvents.length,0);
 assert.equal(outcome.disk.comparisonAudit.status,'incomplete');assert.equal(outcome.disk.comparisonAudit.controller.ownershipReady,false);
 assert.equal(outcome.disk.comparisonAudit.controller.counts.pageFetches,4);
});

test('real scan: manual 302 response never follows or retries a hidden hop and retains inventory plus consumed claim',async t=>{
 const outcome=await runFixture(t,{mode:'redirect'});assertPreserved(outcome);
 assert.deepEqual(outcome.events.map(row=>row.kind),['profile','profile','profile','profile','own']);
 assert.equal(outcome.events.at(-1).id,targets[0].itemId);
 assert.equal(outcome.network.filter(url=>url===itemUrl(targets[0].itemId)).length,1,'a 302 audit response cannot retry');
 assert.equal(outcome.network.some(url=>url.includes('forbidden-redirect')),false,'the redirect destination is never fetched');
 assert.equal(outcome.disk.scanMeta.yahooTransport.transportRequests,5);assert.equal(outcome.disk.scanMeta.yahooTransport.httpStatuses['302'],1);
 assert.equal(outcome.disk.comparisonAudit.controller.counts.pageFetches,5);assert.equal(outcome.disk.comparisonAudit.controller.counts.byKind.own,1);
 assert.equal(outcome.disk.comparisonAudit.controller.counts.outcomes.failed,1);assert.equal(outcome.disk.comparisonAudit.status,'incomplete');
 assert.equal(outcome.imageEvents.length,0);
});

test('real scan: elapsed original deadline prevents retry, details and normal workers and retains the claim',async t=>{
 const outcome=await runFixture(t,{mode:'deadline'});assertPreserved(outcome);
 assert.equal(outcome.events.length,1);assert.equal(outcome.imageEvents.length,0);
 assert.equal(outcome.disk.comparisonAudit.status,'incomplete');assert.equal(outcome.disk.comparisonAudit.controller.stopped,'deadline_exceeded');
 assert.equal(outcome.disk.comparisonAudit.stopReason,'deadline_exceeded');
});

test('real scan: all profile pages share the 80-page ceiling and exhaustion cannot start target or normal reads',async t=>{
 const outcome=await runFixture(t,{mode:'profile_budget'});assertPreserved(outcome);
 assert.equal(outcome.events.length,COMPARISON_AUDIT_LIMITS.pageFetches);assert.ok(outcome.events.every(row=>row.kind==='profile'&&row.accountId==='melon'));
 assert.equal(outcome.disk.comparisonAudit.controller.counts.pageFetches,80);assert.equal(outcome.disk.comparisonAudit.controller.counts.byKind.profile,80);
 assert.equal(outcome.disk.comparisonAudit.controller.ownershipReady,false);assert.equal(outcome.disk.comparisonAudit.status,'incomplete');
 assert.equal(outcome.imageEvents.length,0);
});

for(const [mode,reason] of [['replay',/already_consumed/],['expired',/expired/],['stale_main',/unexpected_main_sha/],
 ['missing_receipt',/receipt/],['corrupt_receipt',/receipt/],['overlong',/invalid_activation_window/],['duplicate_target',/distinct bound/],['missing_binding',/target binding/],['rerun',/runKey|rerun|admission/i],['cron',/not_main_push/],['missing_admission',/scanAdmission/],['missing_lock',/writer lock/],['missing_pin',/expected_publication/],['future_pin',/expected_publication/],
 ['publication_old',/published_revision_mismatch/],['publication_new',/published_revision_mismatch/],['publication_other_sha',/published_revision_mismatch/],['publication_missing_ledger',/receipt_invalid/],['publication_denied',/published_http_denied/],['publication_corrupt',/state_decryption_failed/]]){
 test(`real scan: ${mode} fails before any source and cannot replace durable state`,async t=>{
  const outcome=await runFixture(t,{mode});assert.ok(outcome.error);assert.match(String(outcome.error),reason);
  assert.deepEqual(outcome.events,[]);assert.deepEqual(outcome.imageEvents,[]);assert.equal(outcome.stateUnchanged,true);
  assert.ok(outcome.network.filter(url=>url==='https://hyx60268-dev.github.io/price-guard/data/state.json.enc').length<=1,'failed prerequisite never retries Pages');
  assert.deepEqual(outcome.disk,outcome.previous);assert.deepEqual(outcome.published,[]);assert.equal(outcome.output,'');
 });
}

test('production configuration is disabled or bounded one-shot, and audit output suppresses unrelated source work',async()=>{
 const config=JSON.parse(await fs.readFile(path.join(source,'config/comparison-audit.json'),'utf8'));
 assertSafeProductionAuditConfig(config);
 const workflow=await fs.readFile(path.join(source,'.github/workflows/price-scan-transaction.yml'),'utf8');
 const steps=workflow.split(/\n      - /);
 const scan=steps.find(step=>/run: npm run scan\s/.test(step));
 assert.match(scan,/\bid: scan\b/);assert.match(scan,/SCAN_WRITER_LOCK: ['"]?pages/);assert.match(scan,/GITHUB_TOKEN:/);
 for(const command of ['node scripts/merchant-monitor.mjs','npm run prepare:share-images']){
  const step=steps.find(value=>value.includes(`run: ${command}`));assert.ok(step,command);
  assert.match(step,/if:.*steps\.scan\.outputs\.comparison_audit != 'true'/,`${command} must skip an audit-only scan`);
 }
});


for(const baselineValidation of [false,true])test(`real scan lower-price card-first mode and validation=${baselineValidation} survive encrypted publication without pricing promotion`,async t=>{
 const outcome=await runFixture(t,{mode:'low_card_flow',flowMode:'lower_price_card_first',baselineValidation});assertPreserved(outcome);
 const report=outcome.disk.comparisonAudit;
 assert.equal(report.flowMode,'lower_price_card_first');assert.equal(report.baselineValidationEnabled,baselineValidation);
 assert.equal(report.status,'completed');assert.equal(report.mainflowComplete,true);assert.equal(report.canRecommend,false);
 assert.equal(report.counts.skippedNotLower,2,JSON.stringify(report.targets.flatMap(target=>target.rows.map(row=>({id:row.id,cardFirst:row.cardFirst,priceComparison:row.priceComparison})))));assert.equal(report.counts.unknownPrice,2);
 assert.equal(report.counts.mainflowCardOnly,2,JSON.stringify(report.targets.flatMap(target=>target.rows.map(row=>({id:row.id,cardFirst:row.cardFirst,priceComparison:row.priceComparison})))));assert.equal(report.counts.mainflowDetailPaired,2);
 assert.equal(report.counts.baselineValidationPaired,baselineValidation?2:0);
 assert.equal(report.requestPhases.prerequisite.pageFetches,6);assert.equal(report.requestPhases.newflow.pageFetches,2);
 assert.equal(report.requestPhases.baseline_validation.pageFetches,baselineValidation?2:0);
 assert.equal(report.controller.counts.pageFetches,baselineValidation?10:8);
 assert.ok(outcome.events.filter(row=>row.kind==='detail').every(row=>!row.id.startsWith('higher-')));
 assert.ok(outcome.imageEvents.every(row=>!row.url.includes('/higher-')));
 for(const target of report.targets){
  const unknown=target.rows.find(row=>row.id===`unknown-${target.targetId}`);
  assert.equal(unknown.priceComparison.status,'unknown');assert.equal(unknown.cardObservations[0].price,null);
  assert.equal(unknown.detailPhase,'newflow');assert.equal(unknown.paired,true);
  const strong=target.rows.find(row=>row.id===`new-external-${target.targetId}`);
  assert.equal(strong.mainflow.mode,'card_only');assert.equal(strong.paired,baselineValidation);
 }
 for(const snapshot of [outcome.disk,...outcome.published,outcome.member])for(const item of snapshot.items.filter(row=>row.comparisonAudit)){
  assert.equal(item.comparisonAudit.flowMode,'lower_price_card_first');
  assert.equal(item.comparisonAudit.baselineValidationEnabled,baselineValidation);
 }
});


function assertSafeProductionAuditConfig(config){
 if(config.enabled===false){assert.deepEqual(config.targets,[]);return}
 assert.equal(config.enabled,true);assert.equal(config.flowMode,'lower_price_card_first');assert.equal(config.baselineValidation,true);
 assert.match(config.prerequisitePublication.codeSha,/^[a-f0-9]{40}$/);
 for(const field of ['checkedAt','dataRevision','finishedAt'])assert.ok(new Date(config.prerequisitePublication[field]).toISOString()===config.prerequisitePublication[field]&&Date.parse(config.prerequisitePublication[field])<=Date.parse(config.issuedAt));
 assert.equal(config.targets.length,2);assert.equal(new Set(config.targets.map(row=>row.itemId)).size,2);
 assert.ok(config.targets.every(row=>typeof row.accountId==='string'&&row.accountId.trim()&&/^z[0-9]+$/.test(row.itemId)&&
  (row.knownCandidateIds===undefined||Array.isArray(row.knownCandidateIds)&&row.knownCandidateIds.every(id=>/^z[0-9]+$/.test(id)))));
 const now=Date.parse(config.issuedAt)+1,startedAt=iso(now),commitMessage=comparisonAuditMarker(config.requestId);
 const context={eventName:'push',ref:'refs/heads/main',runId:'123',runAttempt:1,expectedSha:SHA,codeSha:SHA,eventSha:SHA,currentMainSha:SHA,startedAt,commitMessage};
 const receipt={version:1,revision:0,consumed:[]};
 assert.equal(decideComparisonAuditActivation({activation:config,context,receipt,now}).admitted,true);
 for(const eventName of ['push','schedule','workflow_dispatch']){
  const ordinary=decideComparisonAuditActivation({activation:config,context:{...context,eventName,commitMessage:'ordinary source update'},receipt,now});
  assert.equal(ordinary.active,false);assert.equal(ordinary.requested,false);assert.equal(ordinary.reason,'no_matching_marker');
 }
}

test('bounded configuration contract cannot turn an ordinary event, replay, invalid binding or broken receipt into activation',()=>{
 const config={enabled:true,flowMode:'lower_price_card_first',baselineValidation:true,requestId:'synthetic-safe-audit',issuedAt:iso(NOW),expiresAt:iso(NOW+3600000),prerequisitePublication:{codeSha:SHA,checkedAt:OLD,dataRevision:OLD,finishedAt:OLD},targets:[{accountId:'melon',itemId:'z1'},{accountId:'melon',itemId:'z2'}]};
 assertSafeProductionAuditConfig(config);
 for(const patch of [{enabled:'true'},{baselineValidation:false},{flowMode:'paired_baseline'},{requestId:'bad'},{expiresAt:iso(NOW+3*3600000)},{targets:[]},{targets:[config.targets[0],config.targets[0]]},{targets:[config.targets[0],{accountId:'',itemId:'z2'}]}])
  assert.throws(()=>assertSafeProductionAuditConfig({...config,...patch}));
});
