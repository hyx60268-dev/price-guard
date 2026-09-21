import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { openContext } from './lib/browser.mjs';
import { discoverYahooProfile,yahooCompare } from './lib/yahoo.mjs';
import { xianyuCost } from './lib/xianyu.mjs';
import { fairRoundRobin,inventoryDelta,isFresh,isFreshMinutes,reconcileLiveItems,verifiedXianyuCache } from './lib/planner.mjs';
import { decrypt } from './lib/crypto.mjs';
import { writeOutputs } from './lib/publish.mjs';
import { calculateManualFields,manualCostFor,mergeAccountConfigs } from './lib/state.mjs';
import { MATCHING_RULES_VERSION } from './lib/rules.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'..');
const readJson=file=>fs.readFile(file,'utf8').then(JSON.parse);
const exists=file=>fs.access(file).then(()=>true).catch(()=>false);
const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const startedAt=Date.now();
const settings=await readJson(path.join(root,'config','settings.json'));
const accountsCfg=await readJson(path.join(root,'config','accounts.json'));
const password=process.env.DASHBOARD_PASSWORD;
if(!password||password.length<8)throw new Error('DASHBOARD_PASSWORD 至少需要 8 个字符');
await Promise.all(['data','public/data','.auth','state'].map(directory=>fs.mkdir(path.join(root,directory),{recursive:true})));

async function mapLimit(values,limit,worker){
  const output=new Array(values.length);let cursor=0;
  async function runner(){while(true){const index=cursor++;if(index>=values.length)return;output[index]=await worker(values[index],index)}}
  await Promise.all(Array.from({length:Math.min(limit,values.length)},runner));return output;
}

async function xianyuStateFromEnv(){
  const file=path.join(root,'.auth','xianyu.json');
  const parts=['XIANYU_AUTH_PART_1','XIANYU_AUTH_PART_2','XIANYU_AUTH_PART_3'].map(key=>process.env[key]||'').join('');
  if(parts){try{await fs.writeFile(file,zlib.gunzipSync(Buffer.from(parts,'base64')));return file}catch(error){console.warn('[闲鱼授权] 三段 Secret 无法解压：',String(error))}}
  const gz=process.env.XIANYU_STORAGE_STATE_GZIP_B64;
  if(gz){try{await fs.writeFile(file,zlib.gunzipSync(Buffer.from(gz,'base64')));return file}catch(error){console.warn('[闲鱼授权] GZIP Secret 无法解压：',String(error))}}
  const raw=process.env.XIANYU_STORAGE_STATE_B64;
  if(raw){try{await fs.writeFile(file,Buffer.from(raw,'base64'));return file}catch(error){console.warn('[闲鱼授权] 旧 Secret 无法解析：',String(error))}}
  return undefined;
}

async function previousSnapshot(){
  const file=path.join(root,'state','latest.json.enc');
  if(!await exists(file))return null;
  try{return JSON.parse(decrypt(await fs.readFile(file),password).toString('utf8'))}
  catch(error){console.warn('[基准] 无法读取上次加密数据，将重新建立：',String(error));return null}
}

function priorFor(context,item){
  return context.previousById.get(item.id)||context.previousById.get(item.relistedFrom)||{};
}

function cachedYahoo(prior,item,reason='fresh_cache'){
  const cached=prior?.yahoo||item.cachedYahoo;
  if(Number(cached?.rulesVersion)!==MATCHING_RULES_VERSION)return null;
  if(!cached||!Number.isFinite(cached.lowestPrice??prior.lowestPrice))return null;
  return {
    ...cached,status:'cached',cacheReason:reason,checkedAt:cached.checkedAt||prior.checkedAt||null,
    lowestPrice:cached.lowestPrice??prior.lowestPrice,lowestUrl:cached.lowestUrl||prior.lowestUrl||item.url,
    recommendedPrice:cached.recommendedPrice??prior.recommendedPrice??item.ownPrice,
    candidates:cached.candidates||[],ownImages:cached.ownImages||prior.yahoo?.ownImages||[item.image].filter(Boolean)
  };
}

const previous=await previousSnapshot();
const manualCosts=previous?.manualCosts||{};
const portalPreferences=previous?.portalPreferences||{};
const dismissedDiscoveries=previous?.dismissedDiscoveries||{};
const discoveryReviews=previous?.discoveryReviews||{};
const managedAccounts=previous?.managedAccounts||[];
const portalUsers=previous?.portalUsers||[];
const accounts=mergeAccountConfigs(accountsCfg.accounts||[],managedAccounts);
const defaultAccountId=accounts[0]?.id;
const profileConcurrency=Math.max(1,Math.min(4,Number(settings.profileConcurrency)||3));
const contexts=await mapLimit(accounts,Math.min(profileConcurrency,accounts.length),async(account,accountIndex)=>{
  let catalogItems=[];
  if(account.catalogFile){
    try{catalogItems=(await readJson(path.join(root,account.catalogFile))).items||[]}
    catch(error){console.warn(`[${account.name}] 保存清单读取失败：${String(error)}`)}
  }
  const previousItems=(previous?.items||[]).filter(item=>item.accountId?item.accountId===account.id:account.id===defaultAccountId);
  const previousById=new Map(previousItems.map(item=>[item.id,item]));
  let activeItems=(previousItems.length?previousItems:catalogItems).map((item,index)=>({...item,accountId:account.id,seq:index+1}));
  let profileStatus='cached',profileError='';
  console.log(`\n=== 账号 ${account.name} (${account.id}) ===`);
  try{
    const discovered=await discoverYahooProfile(null,account.profileUrl,settings);
    if(discovered.items.length){
      activeItems=reconcileLiveItems(catalogItems,previousItems,discovered.items,account.id);
      profileStatus='live';
      console.log(`Yahoo 主页成功：${discovered.pages} 页，${activeItems.length} 件当前在售`);
    }else console.warn(`Yahoo 主页返回 0 件；沿用保存清单 ${activeItems.length} 件`);
  }catch(error){profileStatus='error';profileError=String(error);console.warn(`Yahoo 主页失败；沿用保存清单：${profileError}`)}
  const profileDelta=inventoryDelta(previousItems,activeItems);
  console.log(`清单变化：新增 ${profileDelta.added.length}、减少 ${profileDelta.removed.length}、重新上架 ${profileDelta.relisted.length}、复用 ${profileDelta.unchanged}`);
  return {account,accountIndex,catalogItems,previousItems,previousById,activeItems,profileStatus,profileError,profileDelta,yahooById:new Map(),xianyuById:new Map()};
});

const relistAliases={};
for(const context of contexts)for(const relisted of context.profileDelta.relisted||[])relistAliases[`${context.account.id}:${relisted.to}`]=relisted.from;

// 只有明确设置 FORCE_FULL_SCAN 才从头强制重扫。部署/手工重跑也沿用轮转缓存，
// 否则每次都会在时间预算耗尽前反复检查前半段，后半段商品长期得不到核验。
const forceYahoo=process.env.FORCE_FULL_SCAN==='1';
const yahooFreshMinutes=Number(settings.yahooFreshMinutes)||15;
const deadline=startedAt+(Number(settings.scanBudgetMinutes)||12)*60_000;
const yahooBuckets=contexts.map(context=>context.activeItems.map((item,itemIndex)=>{
  const prior=priorFor(context,item),added=context.profileDelta.added.includes(item.id)||Boolean(item.relistedFrom);
  const priceChanged=Number.isFinite(prior.ownPrice)&&prior.ownPrice!==item.ownPrice;
  const rulesChanged=Number(prior.yahoo?.rulesVersion)!==MATCHING_RULES_VERSION;
  const activePriceSignal=prior.yahoo?.underpriced===true||prior.yahoo?.comparisonStatus==='competitor_lower'||
    Number.isFinite(Number(prior.recommendedPrice))&&Number(prior.recommendedPrice)!==Number(item.ownPrice);
  const checked=Date.parse(prior.yahoo?.checkedAt||'');
  // 规则升级后先撤销/重核验所有正在触发调价的结果（降价和提价都包括），
  // 避免旧误判在数百件商品的普通轮转队尾继续显示多个周期。
  return {context,item,itemIndex,prior,priority:added?0:priceChanged?1:rulesChanged&&activePriceSignal?1:rulesChanged?2:Number.isFinite(checked)?3:2,lastChecked:Number.isFinite(checked)?checked:0};
}).sort((a,b)=>a.priority-b.priority||a.lastChecked-b.lastChecked||a.itemIndex-b.itemIndex));
// 每个店铺轮流取一件，不让商品多或旧缓存多的账号占满整轮预算。
const yahooTasks=fairRoundRobin(yahooBuckets);

const yahooConcurrency=Math.max(1,Math.min(4,Number(settings.yahooConcurrency)||3));
await mapLimit(yahooTasks,yahooConcurrency,async(task,taskIndex)=>{
  const {context,item,prior}=task;
  const fresh=cachedYahoo(prior,item);
  if(!forceYahoo&&fresh&&isFreshMinutes(fresh.checkedAt,yahooFreshMinutes)){
    context.yahooById.set(item.id,fresh);return;
  }
  if(Date.now()>=deadline){
    context.yahooById.set(item.id,cachedYahoo(prior,item,'scan_budget')||{status:'deferred_budget',cacheReason:'rules_changed',rulesVersion:MATCHING_RULES_VERSION,checkedAt:null,lowestPrice:item.ownPrice,lowestUrl:item.url,recommendedPrice:item.ownPrice,candidates:[]});return;
  }
  try{
    const profileSellerId=String(context.account.profileUrl||'').match(/\/user\/([^/?#]+)/i)?.[1]||'';
    const result=await yahooCompare(null,item,{...settings,ownSellerId:item.sellerId||profileSellerId,forceYahooBroadSearch:forceYahoo||task.priority<=1});context.yahooById.set(item.id,result);
    console.log(`[Yahoo ${taskIndex+1}/${yahooTasks.length}] ${context.account.name} ${item.id} cards=${result.cardCount} matches=${result.competitorCount} lowest=${result.lowestPrice} source=${result.sourceStatus?.search||'unknown'}`);
  }catch(error){
    console.error(`[Yahoo ERROR][${context.account.id}:${item.id}]`,String(error));
    context.yahooById.set(item.id,cachedYahoo(prior,item,'request_error')||{status:'error',error:String(error),rulesVersion:MATCHING_RULES_VERSION,checkedAt:null,candidates:[],lowestPrice:item.ownPrice,lowestUrl:item.url,recommendedPrice:item.ownPrice});
  }finally{await wait(550+Math.floor(Math.random()*350))}
});

const xianyuState=await xianyuStateFromEnv();
let xBrowser,xContext,xPage,xianyuMode=xianyuState?'saved':'anonymous',xianyuAuthExpired=false,anyXianyuLoginRequired=false;
async function ensureXianyuPage(){
  if(xPage)return xPage;
  const opened=await openContext(xianyuState);xBrowser=opened.browser;xContext=opened.context;xPage=await xContext.newPage();return xPage;
}
async function switchXianyuToAnonymous(){
  const page=await ensureXianyuPage();await xContext.clearCookies();
  await page.goto('https://www.goofish.com',{waitUntil:'domcontentloaded',timeout:25000}).catch(()=>{});
  await page.evaluate(()=>{localStorage.clear();sessionStorage.clear()}).catch(()=>{});xianyuMode='anonymous';
}

const xianyuFreshHours=Number(settings.xianyuFreshHours)||168;
const xianyuRetryHours=Number(settings.xianyuRetryHours)||24;
const xianyuLimit=Math.max(0,Number(settings.maxXianyuItemsPerRun)||3);
const xianyuBuckets=contexts.map(()=>[]);
for(const [contextIndex,context] of contexts.entries())for(const item of context.activeItems){
  const prior=priorFor(context,item),yc=context.yahooById.get(item.id)||{};
  const manual=manualCostFor(manualCosts,{...item,accountId:context.account.id},relistAliases);
  const verified=verifiedXianyuCache(prior);
  if(verified&&isFresh(verified.checkedAt,xianyuFreshHours)){
    context.xianyuById.set(item.id,{status:'cached_verified',...verified});continue;
  }
  if(prior.xianyu?.checkedAt&&isFresh(prior.xianyu.checkedAt,xianyuRetryHours)){
    context.xianyuById.set(item.id,{status:'skipped_recent_review',samples:[],averageCNY:null,checkedAt:prior.xianyu.checkedAt});continue;
  }
  // Refresh an automatic market reference for every listing. A user-confirmed
  // purchase cost remains authoritative for profit, but no longer prevents the
  // background reference scan from running.
  xianyuBuckets[contextIndex].push({context,item,prior,priority:Number.isFinite(manual?.purchaseCNY)?1:0});
}
for(const bucket of xianyuBuckets)bucket.sort((a,b)=>a.priority-b.priority||a.item.seq-b.item.seq);
const xianyuTasks=[];
for(let index=0;index<Math.max(0,...xianyuBuckets.map(bucket=>bucket.length));index++)for(const bucket of xianyuBuckets)if(bucket[index])xianyuTasks.push(bucket[index]);

try{
  for(const [index,task] of xianyuTasks.entries()){
    const {context,item}=task;
    // Yahoo owns the general scan budget, but the small fixed Xianyu batch must
    // still run afterwards; otherwise a large inventory permanently starves cost
    // refreshes before they start.
    if(index>=xianyuLimit){context.xianyuById.set(item.id,{status:'deferred_limit',samples:[],averageCNY:null});continue}
    if(anyXianyuLoginRequired){context.xianyuById.set(item.id,{status:'deferred_auth',samples:[],averageCNY:null});continue}
    console.log(`[闲鱼 ${index+1}/${Math.min(xianyuTasks.length,xianyuLimit)}] ${context.account.name} ${item.title}`);
    let result;
    try{
      const yc=context.yahooById.get(item.id)||{};
      result=await xianyuCost(await ensureXianyuPage(),{...item,yahoo:{...(item.yahoo||{}),...yc}},settings);
      if(result.status==='login_required'&&xianyuMode==='saved'){
        xianyuAuthExpired=true;console.warn('[闲鱼授权] 登录状态失效，切换匿名搜索重试');
        await switchXianyuToAnonymous();result=await xianyuCost(xPage,{...item,yahoo:{...(item.yahoo||{}),...yc}},settings);result.fallback='anonymous';
      }
    }catch(error){console.error(`[闲鱼 ERROR][${item.id}]`,String(error));result={status:'error',error:String(error),samples:[],averageCNY:null}}
    result.checkedAt=result.checkedAt||new Date().toISOString();
    console.log(`[闲鱼结果] ${item.id} 状态=${result.status} 卡片=${result.cardCount??0} 初筛=${result.preliminaryCount??0} 核验=${result.verifiedCount??0} 卖家=${result.sellerCount??0} 参考=${result.averageCNY??'—'}`);
    if(result.status==='login_required'||result.status==='blocked')anyXianyuLoginRequired=true;
    context.xianyuById.set(item.id,result);
  }
}finally{await xBrowser?.close().catch(()=>{})}

const accountResults=[];
for(const context of contexts){
  const rows=context.activeItems.map(item=>{
    const prior=priorFor(context,item),yc=context.yahooById.get(item.id)||{},xc=context.xianyuById.get(item.id)||{status:'not_requested',samples:[],averageCNY:null};
    const priorVerified=verifiedXianyuCache(prior);
    const cachedAverage=priorVerified?.averageCNY??null;
    const averageCNY=Number.isFinite(xc.averageCNY)?xc.averageCNY:cachedAverage;
    const ownPrice=item.ownPrice;
    const lowestPrice=Number.isFinite(yc.lowestPrice)?yc.lowestPrice:(prior.lowestPrice??item.cachedYahoo?.lowestPrice??ownPrice);
    const lowestUrl=yc.lowestUrl||prior.lowestUrl||item.cachedYahoo?.lowestUrl||item.url||'';
    const recommendedPrice=Number.isFinite(yc.recommendedPrice)?yc.recommendedPrice:Number.isFinite(lowestPrice)&&lowestPrice<ownPrice?Math.max(1,Math.floor(lowestPrice)-1):ownPrice;
    const needsXianyu=Number.isFinite(lowestPrice)&&lowestPrice<ownPrice;
    const manual=manualCostFor(manualCosts,{...item,accountId:context.account.id},relistAliases);
    const yahooSource=yc.status==='ok'?'live':yc.status==='cached'?'cached':Number.isFinite(prior.lowestPrice)?'cached':'own_baseline';
    const costSource=Number.isFinite(manual?.purchaseCNY)?'manual':xc.status==='ok'&&Number.isFinite(xc.averageCNY)?'live':Number.isFinite(averageCNY)?'cached':'missing';
    const samples=xc.samples?.length?xc.samples:(priorVerified?.samples||[]);
    const confidence=yc.status==='ok'&&(!needsXianyu||xc.status==='ok'||Number.isFinite(manual?.purchaseCNY))?'高':(yahooSource==='cached'||costSource==='cached')?'参考缓存':'需人工';
    const priceSignal=yc.underpriced&&recommendedPrice>ownPrice?'raise':recommendedPrice<ownPrice?'lower':'hold';
    const base={...item,accountId:context.account.id,accountName:context.account.name,ownUrl:item.url,lowestPrice,lowestUrl,recommendedPrice,priceSignal,difference:ownPrice-lowestPrice,
      marketMedianPrice:yc.marketMedianPrice??prior.marketMedianPrice??null,marketSampleCount:yc.marketSampleCount??prior.marketSampleCount??0,
      averageCNY,confidence,yahooSource,costSource,needsXianyu,needsManualPurchase:needsXianyu&&!Number.isFinite(averageCNY)&&!Number.isFinite(manual?.purchaseCNY),
      yahoo:{...(prior.yahoo||{}),...yc,lowestPrice,lowestUrl},xianyu:{...(prior.xianyu||{}),...xc,averageCNY,samples},
      xianyuSearchUrl:xc.searchUrl||prior.xianyuSearchUrl||`https://www.goofish.com/search?q=${encodeURIComponent(item.xianyuQuery||item.title||'')}`};
    const calculated=calculateManualFields(base,manual,settings);
    if(yc.underpriced)calculated.advice='售价明显低于同款市场，建议提价';
    return {...base,...calculated};
  });
  const yahooValues=[...context.yahooById.values()];
  const xianyuValues=[...context.xianyuById.values()];
  const xianyuVerifiedNew=context.activeItems.filter(item=>{
    const current=context.xianyuById.get(item.id),prior=priorFor(context,item);
    return current?.status==='ok'&&Number.isFinite(current.averageCNY)&&!Number.isFinite(verifiedXianyuCache(prior)?.averageCNY);
  }).length;
  const scanStats={
    yahoo:rows.length,yahooLive:yahooValues.filter(value=>value.status==='ok').length,
    yahooCached:yahooValues.filter(value=>value.status==='cached').length,
    yahooDeferred:yahooValues.filter(value=>value.status==='deferred_budget'||value.cacheReason==='scan_budget').length,
    xianyuRequested:xianyuValues.filter(value=>!['not_requested'].includes(String(value.status))).length,
    xianyuScanned:xianyuValues.filter(value=>['ok','manual_review','page_empty','login_required','blocked','error'].includes(value.status)).length,
    xianyuVerifiedNew,
    xianyuCached:xianyuValues.filter(value=>value.status==='cached_verified').length,
    xianyuSkipped:xianyuValues.filter(value=>String(value.status).startsWith('skipped')||String(value.status).startsWith('deferred')).length
  };
  accountResults.push({id:context.account.id,name:context.account.name,profileUrl:context.account.profileUrl,managed:context.account.managed,
    profileStatus:context.profileStatus,profileError:context.profileError,profileDelta:context.profileDelta,itemCount:rows.length,
    lastCatalogCount:context.catalogItems.length,scanStats,items:rows});
}

const checkedAt=new Date().toISOString(),allItems=accountResults.flatMap(account=>account.items);
// Keep an encrypted, cross-account history of every title that has appeared in the
// seller inventories.  A sold item disappears from the live profile, but it must
// still be excluded from future product discovery runs.
const ownedTitleHistory=[...new Set([
  ...(previous?.ownedTitleHistory||[]),
  ...(previous?.items||[]).map(item=>item.title),
  ...contexts.flatMap(context=>context.catalogItems.map(item=>item.title)),
  ...allItems.map(item=>item.title)
].map(value=>String(value||'').trim()).filter(Boolean))].slice(-5000);
const result={
  version:6,checkedAt,dataRevision:checkedAt,settings,accounts:accountResults,managedAccounts,portalUsers,
  manualCosts,portalPreferences,dismissedDiscoveries,discoveryReviews,ownedTitleHistory,relistAliases,login:{xianyuRequired:anyXianyuLoginRequired,xianyuAuthExpired,xianyuMode},items:allItems,
  scanMeta:{trigger:process.env.SCAN_TRIGGER||'local',startedAt:new Date(startedAt).toISOString(),durationSeconds:Math.round((Date.now()-startedAt)/1000),
    budgetMinutes:Number(settings.scanBudgetMinutes)||12,profileConcurrency,yahooConcurrency,xianyuLimit}
};
const {summary}=await writeOutputs({root,result,previous,password});
console.log(summary);
