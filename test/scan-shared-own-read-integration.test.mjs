import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {encrypt,decrypt} from '../scripts/lib/crypto.mjs';
import {PRICING_RULES_VERSION} from '../public/pricing-policy.js';

const NOW=Date.parse('2026-10-17T06:00:00.000Z'),OLD=new Date(NOW-2*3600000).toISOString();
const ORIGIN='https://paypayfleamarket.yahoo.co.jp',url=id=>`${ORIGIN}/item/${id}`;
const TITLE='APEX ヴァイオレット・エヴァーガーデン 自動手記人形Ver. 1/7 フィギュア 新品 未使用 1点';
const DESCRIPTION='新品 未使用 フィギュア1点。PRIVATE_SHARED_ROOT_DESCRIPTION';
const hook='__scanSharedOwnReadFixture',password='synthetic-shared-root-password',memberPassword='synthetic-shared-root-member-password';
const imageUrl=id=>`https://synthetic.invalid/${id}.jpg`;
const accounts=[{id:'rakuma',name:'Rakuma fixture',platform:'rakuma',sellerId:'900',profileUrl:'https://fril.jp/shop/fixture'},
 ...['melon','boss','momoka'].map((id,index)=>({id,name:`${id} fixture`,platform:'yahoo',sellerId:`p${index+1}`,profileUrl:`${ORIGIN}/user/p${index+1}`}))];
const envKeys=['PRICE_SCAN_ENGINE','FULL_PRICE_AUDIT','FORCE_FULL_SCAN','PRICE_AUDIT_ITEM_IDS','DASHBOARD_PASSWORD','PORTAL_USERS_JSON',
 'GITHUB_SHA','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_EVENT_NAME','GITHUB_EVENT_PATH','GITHUB_REF','GITHUB_REPOSITORY','GITHUB_TOKEN',
 'GITHUB_OUTPUT','GITHUB_ACTIONS','SCAN_WRITER_LOCK','SCAN_TRIGGER','XIANYU_AUTH_PART_1','XIANYU_AUTH_PART_2','XIANYU_AUTH_PART_3',
 'XIANYU_STORAGE_STATE_GZIP_B64','XIANYU_STORAGE_STATE_B64'];
const html=data=>`<!doctype html><html><script id="__NEXT_DATA__">${JSON.stringify(data)}</script><!--${'x'.repeat(11000)}--></html>`;
const clocks=value=>Object.fromEntries(['checkedAt','searchCheckedAt','lastAttemptAt','lastFullAttemptAt','knownLastAttemptAt'].map(field=>[field,value?.[field]??null]));
const itemKey=item=>`${item.accountId}:${item.id}`;
function initialState(fillers){
 const items=accounts.flatMap(account=>{
  const names=account.platform==='rakuma'?['a'.repeat(32)]:['driver',...Array.from({length:fillers},(_,n)=>`nohit-${String(n).padStart(2,'0')}`),'root-a','root-b'];
  return names.map(name=>{
   const id=account.platform==='rakuma'?name:`${account.id}-${name}`;
   const title=name.startsWith('nohit')?`任天堂 Nintendo Switch Pro コントローラー モデル ${id}`:TITLE;
   const candidate={id:'old-external',title:'破損 ジャンク 部品のみ',price:8500,sellerId:'old-seller',image:imageUrl('old-external'),url:url('old-external'),matchMethod:'fixture-retained',checkedAt:OLD};
   const comparison={status:'ok',rulesVersion:PRICING_RULES_VERSION,checkedAt:OLD,searchCheckedAt:OLD,lastAttemptAt:OLD,lastFullAttemptAt:OLD,
    candidates:[candidate],lowestPrice:8500,lowestUrl:candidate.url,recommendedPrice:8499};
   return {id,accountId:account.id,platform:account.platform,comparisonMode:'same_platform',title,sellerId:account.sellerId,image:imageUrl(id),
    url:account.platform==='rakuma'?`https://item.fril.jp/${id}`:url(id),itemStatus:'OPEN',ownPrice:10000,
    [account.platform]:comparison,xianyu:{status:'error',checkedAt:OLD,samples:[],averageCNY:null}};
  });
 });
 return {checkedAt:OLD,items,accounts,manualCosts:{'melon:melon-root-a':{accountId:'melon',itemId:'melon-root-a',purchaseCNY:123,updatedAt:OLD}},
  matchCorrections:{'melon:melon-root-a:yahoo:deleted-correction':{accountId:'melon',itemId:'melon-root-a',platform:'yahoo',candidateId:'deleted-correction',deleted:true,updatedAt:OLD}},
  portalUsers:[{username:'fixture',displayName:'Fixture member',password:memberPassword,accountIds:['melon'],enabled:true,updatedAt:OLD}],
  portalPreferences:{fixture:{priceAlerts:false,updatedAt:OLD}},relistAliases:{},dismissedDiscoveries:{kept:{dismissedAt:OLD}},discoveryReviews:{kept:{status:'listed',updatedAt:OLD}}};
}

// Execute a disposable copy of the actual scan, unchanged Yahoo source gate,
// HTTP parsers, original loader, observer, planner, dispatcher, strict matcher,
// encrypted publication, and member filter. Only HTTP/image bytes, unrelated
// platform workers and sub-second pacing are synthetic. No network is allowed.
async function runFixture(t,{enabled=true,mode='success',fillers=4}={}){
 t.mock.timers.enable({apis:['Date'],now:NOW});
 const source=fileURLToPath(new URL('../',import.meta.url)),root=await fs.mkdtemp(path.join(os.tmpdir(),'scan-shared-own-read-'));
 const savedEnv=Object.fromEntries(envKeys.map(key=>[key,process.env[key]])),savedFetch=globalThis.fetch,savedTimeout=globalThis.setTimeout;
 const savedConsole={log:console.log,warn:console.warn,error:console.error};
 const logs=[],requests=[],events=[],fingerprintCalls=[],imageTransfers=[],comparisons=[],observations=[],dispatchRuns=[];
 const fingerprints=new Map(),previous=initialState(fillers),byId=new Map(previous.items.map(item=>[item.id,item]));
 let sharedTarget=null,ordinaryTarget=null;
 if(mode==='active_hold')previous.yahooRequestAccess={reason:'http_429',retryAt:NOW+3600000};
 if(mode==='cached_ordinary')for(const item of previous.items.filter(row=>row.id.endsWith('-nohit-00')))item.yahoo.checkedAt=new Date(NOW-5*60_000).toISOString();
 const detailFor=(id,item)=>{
  const rootItem=id.includes('-root-');
  const detail={id,title:item?.title||TITLE,description:DESCRIPTION,price:item?.ownPrice??9000,status:'OPEN',seller:{id:item?.sellerId??'external-seller'},
   images:rootItem?Array.from({length:11},(_,n)=>imageUrl(n?`${id}-${n}`:id)):id==='external-shared'?[imageUrl(id),imageUrl(`${id}-detail`)]:[imageUrl(id)],delivery:{fee:'出品者負担'}};
  if(rootItem){
   if(mode==='own_title_changed')detail.title='別の商品 セーラームーン フィギュア';
   if(mode==='own_price_changed')detail.price=12000;
   if(mode==='own_status_changed')detail.status='SOLD';
   if(mode==='wrong_quantity')detail.description='新品 未使用 フィギュア2点セット。2個をまとめて販売します。';
   if(mode==='bonus_mismatch')detail.description='新品 未使用 フィギュア1点。特典付き。';
  }
  if(mode==='bonus_mismatch'&&id==='external-shared')detail.description='新品 未使用 フィギュア1点。特典なし。';
  return detail;
 };
 const capture=(...args)=>logs.push(args.map(value=>typeof value==='string'?value:JSON.stringify(value)).join(' '));
 console.log=capture;console.warn=capture;console.error=capture;
 // The production 5-second source gate remains untouched. Removing its
 // unrelated 550–899ms inter-task pause makes the explicit model reproducible.
 globalThis.setTimeout=(callback,ms,...args)=>savedTimeout(callback,ms>=550&&ms<=899?0:ms,...args);
 globalThis[hook]={
  async dispatch(original,tasks,options){
   const run={tasks:tasks.map(({item})=>itemKey(item)),ordinary:[],shared:[]};dispatchRuns.push(run);
   return original(tasks,{...options,
    ordinary:async(task,index,slot)=>{
     const event={kind:'D',key:itemKey(task.item),id:task.item.id,accountId:task.item.accountId,at:Date.now(),noHit:options.plan.hasRecall(itemKey(task.item))===false};
     events.push(event);run.ordinary.push(event);
     const value=await options.ordinary(task,index,slot);event.sourceInputObserved=value?.sourceInputObserved===true;event.finishedAt=Date.now();return value;
    },
    shared:async(root,slot)=>{
     const context=tasks.find(task=>task.context.account.id===root.item.accountId).context;
     const event={kind:'S',key:itemKey(root.item),id:root.item.id,accountId:root.item.accountId,at:Date.now(),requestStart:requests.length,imageStart:fingerprintCalls.length,
      before:clocks(context.yahooById.get(root.item.id)),beforeItem:structuredClone(context.activeItems.find(item=>item.id===root.item.id))};
     events.push(event);run.shared.push(event);sharedTarget=root.item.id;
     try{event.result=await options.shared(root,slot);return event.result;}
     finally{event.requestEnd=requests.length;event.imageEnd=fingerprintCalls.length;event.after=clocks(context.yahooById.get(root.item.id));event.afterItem=structuredClone(context.activeItems.find(item=>item.id===root.item.id));sharedTarget=null;}
    }});
  },
  async compare(original,page,item,settings,dependencies){
   const event={id:item.id,accountId:item.accountId,knownOnly:settings.yahooKnownOnly===true,sourceInputObserved:false};comparisons.push(event);ordinaryTarget=item;
   const read=method=>async(...args)=>{const value=await dependencies[method](...args);if(value!=null)event.sourceInputObserved=true;return value;};
   try{return await original(page,item,settings,{...dependencies,
    ...(dependencies.fetchYahooItemBundle?{fetchYahooItemBundle:read('fetchYahooItemBundle')}:{}),
    ...(dependencies.fetchYahooResult?{fetchYahooResult:read('fetchYahooResult')}:{})});}
   finally{ordinaryTarget=null;}
  },
  bundle(original,id,settings){
   const callback=settings.onYahooItemPageObserved;
   return original(id,{...settings,...(typeof callback==='function'?{onYahooItemPageObserved:(...args)=>{observations.push({id,at:Date.now(),role:args[0].role});return callback(...args);}}:{})});
  },
  async rakumaProfile(){return {items:previous.items.filter(row=>row.platform==='rakuma'),complete:true,pages:1};},
  async rakumaItem(item){return detailFor(item.id,item);},
  async rakumaCompare(item){return {...previous.items.find(row=>row.id===item.id).rakuma,status:'cached'};},
  async fingerprint(image,options={}){
   fingerprintCalls.push({url:image,sharedTarget,at:Date.now()});
   const value={url:image,dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[100,100,100],colorGrid:Array(768).fill(100),
    contentSha256:'b'.repeat(64),imageObservedAt:new Date(Date.now()).toISOString(),imageCacheExpiresAt:NOW+3600_000};
   // Deliberately model transfer observations separately from process calls.
   if(!fingerprints.has(image)){imageTransfers.push({url:image,sharedTarget,accountId:sharedTarget?byId.get(sharedTarget).accountId:ordinaryTarget?.accountId??null});options.observeImageTransferStart?.();options.observeImageTransfer?.({bytes:123,durationMs:2,httpStatus:200});}
   fingerprints.set(image,value);return value;
  },
  knownFingerprint(image){const value=fingerprints.get(image);return value&&!(mode==='missing_candidate_fingerprint'&&image===imageUrl('external-shared-detail'))?{status:'available',...value}:{status:'unavailable'};},
  async peekFingerprint(image){return mode==='missing_candidate_fingerprint'&&image===imageUrl('external-shared-detail')?null:structuredClone(fingerprints.get(image)||null);},
  async session(){return {file:null,access:()=>({allowed:false,reason:'fixture_hold',retryAt:new Date(NOW+3600000).toISOString()}),persist:async()=>{}};},
  async publicProcurement(){return new Map();},
  async denyBrowser(){throw Error('No browser or external network is allowed in this fixture');}
 };
 try{
  await fs.cp(path.join(source,'scripts'),path.join(root,'scripts'),{recursive:true});
  await fs.cp(path.join(source,'public'),path.join(root,'public'),{recursive:true});
  await fs.rm(path.join(root,'public/data'),{recursive:true,force:true});
  for(const name of ['state','config'])await fs.mkdir(path.join(root,name));
  await fs.writeFile(path.join(root,'package.json'),'{"type":"module"}');
  await fs.symlink(await fs.realpath(path.join(source,'node_modules')),path.join(root,'node_modules'),'dir');
  async function wrap(module,exports,forward=false){
   const original=module.replace('.mjs','-fixture-original.mjs');
   await fs.rename(path.join(root,'scripts/lib',module),path.join(root,'scripts/lib',original));
   await fs.writeFile(path.join(root,'scripts/lib',module),`import * as original from './${original}';\nexport * from './${original}';\n`+
    Object.entries(exports).map(([name,method])=>`export const ${name}=(...args)=>globalThis.${hook}.${method}(${forward?`original.${name},`:''}...args);`).join('\n'));
  }
  await wrap('rakuma.mjs',{discoverRakumaProfile:'rakumaProfile',fetchRakumaItem:'rakumaItem',rakumaCompare:'rakumaCompare'});
  await wrap('image.mjs',{imageFingerprints:'fingerprint',peekImageFingerprints:'peekFingerprint',peekKnownImageObservation:'knownFingerprint'});
  await wrap('xianyu-session.mjs',{loadXianyuSession:'session'});
  await wrap('procurement-runner.mjs',{runPublicProcurement:'publicProcurement'});
  await wrap('browser.mjs',{openContext:'denyBrowser'});
  await wrap('yahoo.mjs',{fetchYahooItemBundle:'bundle',yahooCompare:'compare'},true);
  await wrap('yahoo-shared-dispatch.mjs',{runSharedYahooDispatch:'dispatch'},true);
  await fs.writeFile(path.join(root,'config/accounts.json'),JSON.stringify({accounts}));
  await fs.writeFile(path.join(root,'config/settings.json'),JSON.stringify({comparisonMode:'same_platform',scanAccountPriorityIds:['melon','boss','momoka'],
   scanBudgetMinutes:12,yahooRequestIntervalMs:5000,profileConcurrency:1,yahooConcurrency:1,rakumaConcurrency:1,exchangeRate:20,attempts:1,maxYahooImages:8,
   yahooGeometryPriority:false,yahooObserveNormalPageRails:true,yahooSharedDetailOffers:true,yahooSharedOwnRootReads:enabled}));
  await fs.writeFile(path.join(root,'state/latest.json.enc'),encrypt(Buffer.from(JSON.stringify(previous)),password));
  for(const key of envKeys)process.env[key]='';
  Object.assign(process.env,{DASHBOARD_PASSWORD:password,PRICE_SCAN_ENGINE:'legacy'});
  globalThis.fetch=async(input,options={})=>{
   const requested=String(input),parsed=new URL(requested);
   assert.equal(parsed.origin,ORIGIN,'every HTML response must be local Yahoo fixture bytes');
   assert.equal(options.signal?.aborted,false,'no source request starts after an abort');
   assert.ok(Date.now()<NOW+12*60_000,'the original 12-minute source deadline is respected');
   const request={url:requested,at:Date.now(),sharedTarget,accountId:sharedTarget?byId.get(sharedTarget).accountId:ordinaryTarget?.accountId??null};requests.push(request);
   if(requests.length>1)assert.ok(request.at-requests.at(-2).at>=5000,'the real 5-second global source gate remains in force');
   const account=accounts.find(row=>row.profileUrl===`${parsed.origin}${parsed.pathname}`);
   let data;
   if(account){
    request.kind='profile';request.accountId=account.id;const rows=previous.items.filter(row=>row.accountId===account.id).map(row=>({id:row.id,title:row.title,price:row.ownPrice,thumbnailImageUrl:row.image,itemStatus:'OPEN',sellerId:row.sellerId}));
    const result={items:rows,totalResultsAvailable:rows.length,totalResultsReturned:rows.length,offset:0};
    if(mode==='incomplete_profile'&&account.id==='momoka')delete result.totalResultsAvailable;
    data={props:{initialState:{searchState:{search:{result}}}}};
   }else if(parsed.pathname.startsWith('/search/')){
    request.kind='search';data={props:{initialState:{searchState:{search:{result:{items:[],totalResultsAvailable:0}}}}}};
   }else{
    assert.match(parsed.pathname,/^\/item\/[A-Za-z0-9_-]+$/);request.id=parsed.pathname.split('/').at(-1);
    const item=byId.get(request.id);assert.ok(item||request.id==='external-shared','raw recommendation-only hints must never start detail reads');request.kind=item?'own':'candidate';
    const card=(id,title=TITLE)=>({itemId:id,title,price:9000,image:{url:imageUrl(id)},seller:{id:'external-seller'},log:{rctype:'vector',rcsm:1}});
    const cards=request.id.endsWith('-driver')?[card('external-shared'),card('raw-hint-only','破損 ジャンク 部品のみ')]:[];
    data={props:{initialState:{itemsState:{items:{item:detailFor(request.id,item)}},recommendsState:{recommends:{recommends:{related:{recommendItems:{items:cards}}}}}}}};
   }
   if(mode==='mid_scan_hold'&&request.id==='melon-nohit-00'){
    t.mock.timers.tick(5000);
    return {ok:false,status:429,headers:new Headers({'retry-after':'3600'}),url:requested,redirected:false,text:async()=>''};
   }
   return {ok:true,status:200,headers:new Headers(),url:requested,redirected:false,text:async()=>{
    t.mock.timers.tick(mode==='deadline'?12*60_000:5000);
    const detail=data?.props?.initialState?.itemsState?.items?.item;
    return html(data)+(detail?`<main><h1>${detail.title}</h1><div><span class="ItemPrice__Component">${detail.price}円</span><span class="ItemDetail__ShippingFreeLabel">送料無料</span></div><h2>商品の説明</h2></main>`:'');
   }};
  };
  await import(pathToFileURL(path.join(root,'scripts/scan.mjs')));
  const read=async(file,key=password)=>JSON.parse(decrypt(await fs.readFile(path.join(root,file)),key));
  const snapshots=await Promise.all(['state/latest.json.enc','public/data/state.json.enc','public/data/latest.json.enc'].map(file=>read(file)));
  const member=await read('public/data/users/fixture/latest.json.enc',memberPassword);
  return {snapshots,member,previous,requests,events,fingerprintCalls,imageTransfers,comparisons,observations,dispatchRuns,logs,finishedAt:Date.now()};
 }finally{
  globalThis.fetch=savedFetch;globalThis.setTimeout=savedTimeout;delete globalThis[hook];Object.assign(console,savedConsole);
  for(const [key,value] of Object.entries(savedEnv))if(value===undefined)delete process.env[key];else process.env[key]=value;
  await fs.rm(root,{recursive:true,force:true});t.mock.timers.reset();
 }
}
function assertPreserved(outcome){
 const total=outcome.previous.items.length,yahoo=total-1;
 for(const snapshot of outcome.snapshots){
  assert.deepEqual(snapshot.items.map(itemKey).sort(),outcome.previous.items.map(itemKey).sort());
  assert.equal(snapshot.accounts.length,4);assert.equal(snapshot.cycleCoverage.total,total);
  assert.deepEqual(snapshot.scanMeta.comparisonTasks,{yahoo,rakuma:1,mercari:0});
  assert.equal(snapshot.pricingCoverage.platforms.yahoo.total,yahoo);
  for(const field of ['manualCosts','matchCorrections','portalPreferences','dismissedDiscoveries','discoveryReviews'])assert.deepEqual(snapshot[field],outcome.previous[field],field);
  for(const item of snapshot.items)assert.ok((item.sharedYahooOffers||[]).every(offer=>offer.target.accountId===item.accountId&&offer.target.id===item.id));
 }
 assert.ok(outcome.member.items.length>0);assert.ok(outcome.member.items.every(item=>item.accountId==='melon'));
 assert.ok(Object.values(outcome.member.matchCorrections).every(row=>row.accountId==='melon'));
 assert.ok(Object.values(outcome.member.manualCosts).every(row=>row.accountId==='melon'));
}
const rootRows=outcome=>outcome.snapshots[0].items.filter(item=>item.id.includes('-root-'));
const sharedActions=outcome=>outcome.events.filter(event=>event.kind==='S');
function assertStrict(offer,item){
 assert.equal(offer.id,'external-shared');assert.equal(offer.price,9000);assert.equal(offer.currency,'JPY');assert.equal(offer.shippingJPY,0);
 assert.equal(offer.evidenceType,'current_shared_detail_pair');assert.equal(offer.itemStatus,'OPEN');assert.equal(offer.canRecommend,false);assert.equal(offer.discoveryComplete,false);assert.equal(offer.costEligible,false);
 assert.equal(offer.target.id,item.id);assert.equal(offer.target.accountId,item.accountId);assert.ok(offer.verification);
 for(const receipt of [offer.ownSource,offer.candidateSource]){assert.equal(receipt.kind,'original_yahoo_detail_body');assert.equal(receipt.status,200);assert.match(receipt.bodySha256,/^[a-f0-9]{64}$/);assert.match(receipt.parsedSha256,/^[a-f0-9]{64}$/);}
 assert.equal(offer.imageEvidence.length,10,'eight own images and both candidate images are bound to the strict result');
}

// Paired executions expose the actual extra source trajectory, rather than
// stubbing the normal scanner or treating a recommendation as an accepted quote.
test('real scan dispatches bounded own roots after two source-observed ordinary jobs and preserves discovery obligations',async t=>{
 const enabled=await runFixture(t),disabled=await runFixture(t,{enabled:false});
 assertPreserved(enabled);assertPreserved(disabled);
 const actions=sharedActions(enabled);assert.equal(actions.length,6);
 assert.equal(disabled.dispatchRuns.length,0);assert.equal(disabled.snapshots[0].scanMeta.sharedOwnReadSummary,undefined);
 const summary=enabled.snapshots[0].scanMeta.sharedOwnReadSummary;
 assert.equal(summary.executor.actions,6);assert.equal(summary.executor.rootReadCalls,6);assert.equal(summary.executor.htmlRequests,6);assert.equal(summary.executor.imageProcessingCalls,48);assert.equal(summary.executor.verified,6);
 assert.equal(summary.executor.imageFetches,48);assert.equal(summary.executor.imageBytes,48*123);assert.equal(summary.executor.imageTransferDurationMs,48*2);
 assert.equal(summary.plan.claimedRoots,6);assert.equal(summary.dispatch.sharedClaims,6);
 assert.equal(summary.executor.completeComparisons,0);assert.equal(summary.executor.automaticPriceChanged,false);
 assert.equal(summary.dispatch.ordinaryClaims,enabled.previous.items.length-1,'S never removes the ordinary discovery task');
 for(const account of ['melon','boss','momoka']){
  const sequence=enabled.events.filter(event=>event.accountId===account);
  assert.deepEqual(sequence.slice(0,6).map(event=>event.kind),['D','D','S','D','D','S']);
  for(const event of sequence.filter(event=>event.kind==='D').slice(0,4))assert.equal(event.sourceInputObserved,true);
  assert.equal(sequence[1].noHit,true,'an established no-hit discovery job receives the second ordinary turn');
  assert.equal(sequence.filter(event=>event.kind==='S').length,2);
 }
 for(const action of actions){
  assert.deepEqual(action.after,action.before,'S cannot advance comparison check, search or attempt clocks');
  assert.deepEqual(action.afterItem,action.beforeItem,'S cannot change automatic price/cost/queue inputs');
  assert.equal(action.result.status,'verified_single_offer');
  assert.deepEqual(enabled.requests.slice(action.requestStart,action.requestEnd).map(row=>[row.kind,row.id]),[['own',action.id]],'S makes one own GET and no search or competitor read');
  const images=enabled.fingerprintCalls.slice(action.imageStart,action.imageEnd);assert.equal(images.length,8);assert.ok(images.every(row=>row.url.includes(action.id)));
  assert.equal(enabled.requests.filter(row=>row.id===action.id).length,1,'the later ordinary task reuses its already-read own body');
  assert.equal(enabled.observations.filter(row=>row.id===action.id).length,1,'a reused own page never becomes a second original observation');
 }
 assert.equal(enabled.requests.filter(row=>row.id==='external-shared').length,1);
 assert.equal(enabled.requests.some(row=>row.url.includes('raw-hint-only')),false);
 assert.deepEqual(enabled.requests.map(row=>row.url).sort(),disabled.requests.map(row=>row.url).sort(),'with enough time both trajectories retain the identical ordinary source work');
 for(const row of rootRows(enabled)){assert.equal(row.sharedYahooOffers.length,1);assertStrict(row.sharedYahooOffers[0],row);}
 const aggregate=enabled.logs.filter(line=>line.startsWith('[Yahoo共享补根读取]'));assert.equal(aggregate.length,1);
 for(const secret of [TITLE,DESCRIPTION,'external-shared','melon-root',ORIGIN,password,'synthetic.invalid'])assert.equal(aggregate[0].includes(secret),false);
});

test('real scan cached ordinary jobs never buy a shared-root turn',async t=>{
 const outcome=await runFixture(t,{mode:'cached_ordinary'});assertPreserved(outcome);
 assert.equal(sharedActions(outcome).length,6);
 for(const accountId of ['melon','boss','momoka']){
  const events=outcome.events.filter(event=>event.accountId===accountId),firstShared=events.findIndex(event=>event.kind==='S');
  const preceding=events.slice(0,firstShared);
  assert.equal(preceding.filter(event=>event.sourceInputObserved===true).length,2);
  assert.equal(preceding.filter(event=>event.sourceInputObserved===false).length,1);
  assert.equal(preceding.find(event=>event.sourceInputObserved===false).id,`${accountId}-nohit-00`);
 }
});

for(const mode of ['active_hold','mid_scan_hold','deadline','missing_candidate_fingerprint','incomplete_profile'])test(`real scan ${mode}: no extra own-root work or fabricated strict target`,async t=>{
 const enabled=await runFixture(t,{mode}),disabled=await runFixture(t,{enabled:false,mode});
 assertPreserved(enabled);assertPreserved(disabled);
 assert.equal(sharedActions(enabled).length,0);assert.equal(enabled.snapshots[0].scanMeta.sharedOwnReadSummary.executor.htmlRequests,0);
 assert.deepEqual(enabled.requests.map(row=>row.url),disabled.requests.map(row=>row.url));
 assert.ok(rootRows(enabled).every(item=>!item.sharedYahooOffers?.length));
 if(mode==='active_hold')assert.equal(enabled.requests.length,0);
 if(mode==='mid_scan_hold'){assert.equal(enabled.requests.at(-1).id,'melon-nohit-00');assert.ok(enabled.requests.some(row=>row.id==='external-shared'));}
 if(mode==='deadline')assert.equal(enabled.requests.length,1);
 if(['active_hold','deadline'].includes(mode))for(const item of rootRows(enabled))assert.deepEqual(clocks(item.yahoo),clocks(enabled.previous.items.find(row=>row.id===item.id).yahoo));
});

for(const mode of ['own_title_changed','own_price_changed','own_status_changed','wrong_quantity','bonus_mismatch'])test(`real scan ${mode}: reading a recalled root never bypasses original identity or sale-term checks`,async t=>{
 const outcome=await runFixture(t,{mode});assertPreserved(outcome);
 assert.equal(sharedActions(outcome).length,6);assert.equal(outcome.snapshots[0].scanMeta.sharedOwnReadSummary.executor.verified,0);
 assert.ok(sharedActions(outcome).every(action=>action.result.status!=='verified_single_offer'));
 assert.ok(rootRows(outcome).every(item=>!item.sharedYahooOffers?.length));
 for(const action of sharedActions(outcome))assert.deepEqual(action.after,action.before);
 const executor=outcome.snapshots[0].scanMeta.sharedOwnReadSummary.executor;
 if(['own_title_changed','own_price_changed','own_status_changed'].includes(mode)){
  assert.equal(executor.imageProcessingCalls,0,'changed own terms are rejected before any shared image processing');
  assert.equal(executor.imageFetches,0,'changed own terms cannot start an image GET');
  for(const action of sharedActions(outcome)){
   assert.equal(action.imageEnd,action.imageStart);
   assert.equal(action.result.status,'pending');assert.equal(action.result.reason,'own_terms_changed_or_missing');
  }
 }else{
  assert.equal(executor.imageProcessingCalls,48,'quantity and bonus still reach the full strict verifier with bounded image evidence');
  assert.equal(executor.imageFetches,48);assert.equal(executor.rejected,6);
 }

});

test('explicit offline 12-minute / 144-HTML model: useful strict verified targets improve without claiming live throughput',async t=>{
 // 90 managed Yahoo items: 3 ordinary seeds, 81 no-hit discovery obligations,
 // 6 still-queued exact targets; plus one preserved Rakuma item. Each actual
 // HTML source response costs exactly 5 simulated seconds. The source gate and
 // 12-minute deadline execute unchanged, so each run has the same 144 slots.
 const enabled=await runFixture(t,{fillers:27}),disabled=await runFixture(t,{enabled:false,fillers:27});
 assertPreserved(enabled);assertPreserved(disabled);
 assert.equal(enabled.requests.length,144);assert.equal(disabled.requests.length,144);
 assert.equal(enabled.finishedAt,NOW+12*60_000);assert.equal(disabled.finishedAt,NOW+12*60_000);
 const useful=outcome=>outcome.snapshots[0].items.filter(item=>(item.sharedYahooOffers||[]).some(offer=>offer.id==='external-shared'&&offer.price<item.ownPrice));
 assert.equal(useful(disabled).length,3);assert.equal(useful(enabled).length,9);
 assert.equal(rootRows(disabled).filter(item=>item.sharedYahooOffers?.length).length,0);
 for(const item of rootRows(enabled)){
  assert.equal(item.sharedYahooOffers.length,1);assertStrict(item.sharedYahooOffers[0],item);
  const prior=enabled.previous.items.find(row=>row.id===item.id);assert.deepEqual(clocks(item.yahoo),clocks(prior.yahoo),'extra verified pair does not relabel unfinished ordinary discovery');
  assert.deepEqual(item.yahoo.candidates,prior.yahoo.candidates,'old ordinary evidence remains independent');
  assert.equal(item.yahoo.deferredReason,'request_deadline');
  const old=rootRows(disabled).find(row=>row.id===item.id);
  for(const field of ['ownPrice','recommendedPrice','lowestPrice','priceSignal','procurementSource','purchaseCNY'])assert.deepEqual(item[field],old[field],`shared quote cannot change ${field}`);
 }
 assert.equal(enabled.snapshots[0].scanMeta.sharedOwnReadSummary.dispatch.ordinaryClaims,90);
 assert.equal(enabled.snapshots[0].cycleCoverage.total,91);
 assert.equal(enabled.snapshots[0].cycleCoverage.coverageComplete,false);
 assert.equal(enabled.snapshots[0].cycleCoverage.accepted,false);
 const summarize=outcome=>{
  const snapshot=outcome.snapshots[0];
  const htmlByKind=Object.fromEntries(['profile','own','search','candidate'].map(kind=>[kind,outcome.requests.filter(row=>row.kind===kind).length]));
  const accountRows=accounts.map(account=>{
   const items=snapshot.items.filter(item=>item.accountId===account.id),ordinary=outcome.comparisons.filter(row=>row.accountId===account.id&&!row.knownOnly);
   const observed=new Set(ordinary.filter(row=>row.sourceInputObserved).map(row=>row.id)),coverage=snapshot.cycleCoverage.accounts.find(row=>row.accountId===account.id);
   return {accountId:account.id,platform:account.platform,managedTargets:items.length,
    usefulStrictTargets:items.filter(item=>item.sharedYahooOffers?.length).length,
    ordinaryYahooEntered:ordinary.length,ordinaryYahooSourceObserved:observed.size,
    ordinaryYahooNotEntered:account.platform==='yahoo'?items.length-ordinary.length:0,
    ordinaryYahooWithoutSourceInput:account.platform==='yahoo'?items.length-observed.size:0,
    currentFullPriceComparisons:coverage.priceComplete,fullPriceAndCostComplete:coverage.completeItems,
    remainingFullPriceComparisons:items.length-coverage.priceComplete,
    html:Object.fromEntries(['profile','own','search','candidate'].map(kind=>[kind,outcome.requests.filter(row=>row.kind===kind&&row.accountId===account.id).length])),
    modeledImageGETs:outcome.imageTransfers.filter(row=>row.accountId===account.id).length,
    sharedRootHTML:outcome.requests.filter(row=>row.sharedTarget&&row.accountId===account.id).length,
    sharedRootImageGETs:outcome.imageTransfers.filter(row=>row.sharedTarget&&row.accountId===account.id).length};
  });
  return {simulatedSeconds:(outcome.finishedAt-NOW)/1000,htmlTotal:outcome.requests.length,htmlByKind,
   modeledImageGETs:outcome.imageTransfers.length,modeledImageBytes:outcome.imageTransfers.length*123,
   imageProcessingCalls:outcome.fingerprintCalls.length,sharedRootHTML:outcome.requests.filter(row=>row.sharedTarget).length,
   sharedRootImageGETs:outcome.imageTransfers.filter(row=>row.sharedTarget).length,
   usefulStrictTargets:useful(outcome).length,currentFullPriceComparisons:snapshot.cycleCoverage.priceComplete,
   fullPriceAndCostComplete:snapshot.cycleCoverage.completeItems,accounts:accountRows};
 };
 const before=summarize(disabled),after=summarize(enabled);
 const report={kind:'explicit_offline_fixture_simulation',productionMeasurement:false,
  assumptions:{htmlAllowance:144,sourceDeadlineSeconds:720,sourceSpacingMs:5000,htmlResponseCostMs:5000,yahooTargets:90,rakumaTargets:1,
   ordinarySeeds:3,noHitObligations:81,queuedSameProductRoots:6,ownImageLimit:8,candidateImages:2,
   images:'Synthetic fingerprints; one modeled image GET per first URL cache miss, 123 bytes each. No image network request occurred.',
   otherPlatform:'Rakuma worker is substituted and retains its old comparison. No live price or procurement measurement.',
   ordinaryNotEntered:'Normal task retained in the queue, but source deadline pre-admission prevents entering the comparator; not a removed obligation.'},
  disabled:before,enabled:after,delta:{usefulStrictTargets:after.usefulStrictTargets-before.usefulStrictTargets,
   currentFullPriceComparisons:after.currentFullPriceComparisons-before.currentFullPriceComparisons,
   htmlTotal:after.htmlTotal-before.htmlTotal,
   htmlByKind:Object.fromEntries(Object.keys(before.htmlByKind).map(kind=>[kind,after.htmlByKind[kind]-before.htmlByKind[kind]])),
   modeledImageGETs:after.modeledImageGETs-before.modeledImageGETs,modeledImageBytes:after.modeledImageBytes-before.modeledImageBytes}};
 assert.equal(report.enabled.sharedRootHTML,6);assert.equal(report.enabled.sharedRootImageGETs,48);
 if(process.env.SHARED_OWN_READ_REPORT_PATH)await fs.writeFile(process.env.SHARED_OWN_READ_REPORT_PATH,JSON.stringify(report,null,2)+'\n');
});
