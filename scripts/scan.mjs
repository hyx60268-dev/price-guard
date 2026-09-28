import { buildOwnedOffers } from '../public/owned-offers.js';
import { createOwnSourceLoader } from './lib/own-source.mjs';
import { xianyuReviewPlan } from './lib/xianyu-review-plan.mjs';
import { mercariCompare } from './lib/mercari.mjs';
import { pricingDecision } from '../public/pricing-policy.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadXianyuSession } from './lib/xianyu-session.mjs';
import { deferredXianyuAccess } from './lib/xianyu-access.mjs';
import { fileURLToPath } from 'node:url';
import { openContext } from './lib/browser.mjs';
import { discoverYahooProfile,fetchYahooItemBundle,marketPriceDecision,yahooCompare } from './lib/yahoo.mjs';
import { discoverRakumaProfile,fetchRakumaItem,rakumaCompare } from './lib/rakuma.mjs';
import { cachedComparison,comparisonIncomplete as isComparisonIncomplete,pricingCoverage } from './lib/pricing-coverage.mjs';
import { xianyuCost } from './lib/xianyu.mjs';
import { XIANYU_VERIFICATION,completedXianyuReview } from './lib/xianyu-evidence.mjs';
import { fairRoundRobin,fairPriorityRoundRobin,inventoryDelta,isFresh,isFreshMinutes,reconcileLiveItems,verifiedXianyuCache } from './lib/planner.mjs';
import { decrypt } from './lib/crypto.mjs';
import { writeOutputs } from './lib/publish.mjs';
import { calculateManualFields,manualCostFor,mergeAccountConfigs } from './lib/state.mjs';
import { MATCHING_RULES_VERSION } from './lib/rules.mjs';
import { invalidateCorrectedMatches } from '../public/match-memory.js';
import { listingAge } from './lib/listing-age.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'..');
const readJson=file=>fs.readFile(file,'utf8').then(JSON.parse);
const exists=file=>fs.access(file).then(()=>true).catch(()=>false);
const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const startedAt=Date.now();
let sessionManager;
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
  sessionManager=await loadXianyuSession(root);return sessionManager.file;
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
  const cached=cachedComparison(prior?.yahoo||item.cachedYahoo,reason);
  if(!cached||!Number.isFinite(cached.lowestPrice??prior.lowestPrice))return null;
  return {
    ...cached,status:'cached',checkedAt:cached.checkedAt||prior.checkedAt||null,
    lowestPrice:cached.lowestPrice??prior.lowestPrice,lowestUrl:cached.lowestUrl||prior.lowestUrl||item.url,
    recommendedPrice:cached.recommendedPrice??prior.recommendedPrice??item.ownPrice,
    candidates:cached.candidates||[],ownImages:cached.ownImages||prior.yahoo?.ownImages||[item.image].filter(Boolean)
  };
}

function cachedRakuma(prior,reason='fresh_cache'){
  return cachedComparison(prior?.rakuma,reason);
}

const previous=await previousSnapshot();
const matchCorrections=previous?.matchCorrections||{};
if(previous?.items)previous.items=previous.items.map(item=>invalidateCorrectedMatches(item,matchCorrections));
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
    const discovered=account.platform==='rakuma'?await discoverRakumaProfile(account.profileUrl,settings):await discoverYahooProfile(null,account.profileUrl,settings);
    if(discovered.items.length||discovered.complete===true){
      activeItems=reconcileLiveItems(catalogItems,previousItems,discovered.items,account.id,Object.values(previous?.listingHistory||{}));
      profileStatus='live';
      console.log(`${account.platform} 主页成功：${discovered.pages} 页，${activeItems.length} 件当前在售`);
    }else console.warn(`${account.platform} 主页返回 0 件；沿用保存清单 ${activeItems.length} 件`);
  }catch(error){profileStatus='error';profileError=String(error);console.warn(`${account.platform} 主页失败；沿用保存清单：${profileError}`)}
  const profileDelta=inventoryDelta(previousItems,activeItems);
  activeItems=activeItems.map(item=>({...item,platform:account.platform}));
  console.log(`清单变化：新增 ${profileDelta.added.length}、减少 ${profileDelta.removed.length}、重新上架 ${profileDelta.relisted.length}、复用 ${profileDelta.unchanged}`);
  return {account,accountIndex,catalogItems,previousItems,previousById,activeItems,profileStatus,profileError,profileDelta,yahooById:new Map(),rakumaById:new Map(),mercariById:new Map(),xianyuById:new Map()};
});

settings.ownedOffers=buildOwnedOffers(accounts,contexts.flatMap(c=>[...c.previousItems,...c.activeItems]));

const relistAliases={...(previous?.relistAliases||{})};
for(const context of contexts)for(const item of context.activeItems)if(item.relistedFrom)relistAliases[`${context.account.id}:${item.id}`]=item.relistedFrom;

// 只有明确设置 FORCE_FULL_SCAN 才从头强制重扫。部署/手工重跑也沿用轮转缓存，
// 否则每次都会在时间预算耗尽前反复检查前半段，后半段商品长期得不到核验。
const fullPriceAudit=process.env.FULL_PRICE_AUDIT==='1';
const forceYahoo=process.env.FORCE_FULL_SCAN==='1';
const yahooFreshMinutes=Number(settings.yahooFreshMinutes)||360;
const deadline=startedAt+(fullPriceAudit?280:(Number(settings.scanBudgetMinutes)||12))*60_000;
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
const yahooTasks=fairPriorityRoundRobin(yahooBuckets);

// One in-flight read per own listing, shared across independent platform workers.
// A deferred Yahoo task must not deprive Rakuma/Mercari/Xianyu of the sale description.
const {hydrate:hydratedItem,yahooBundle:ownBundle}=createOwnSourceLoader({fetchYahooBundle:id=>fetchYahooItemBundle(id,settings),fetchRakumaItem:item=>fetchRakumaItem(item,settings)});
const yahooConcurrency=Math.max(1,Math.min(4,Number(settings.yahooConcurrency)||3));
const yahooWork=mapLimit(yahooTasks,yahooConcurrency,async(task,taskIndex)=>{
  const {context,item,prior}=task;
  const fresh=cachedYahoo(prior,item);
  if(!forceYahoo&&fresh&&prior.ownPrice===item.ownPrice&&isFreshMinutes(fresh.checkedAt,yahooFreshMinutes)){
    context.yahooById.set(item.id,fresh);return;
  }
  if(Date.now()>=deadline){
    context.yahooById.set(item.id,cachedYahoo(prior,item,'scan_budget')||{status:'deferred_budget',cacheReason:'rules_changed',rulesVersion:MATCHING_RULES_VERSION,checkedAt:null,lowestPrice:item.ownPrice,lowestUrl:item.url,recommendedPrice:item.ownPrice,candidates:[]});return;
  }
  try{
    if(item.platform==='rakuma'){
      item.sourceDetail=(await hydratedItem(item,prior)).sourceDetail;
      if(item.sourceDetail.status!=='OPEN')throw new Error('自有ラクマ商品不再在售，等待主页刷新');
      item.ownPrice=item.sourceDetail.price;
    }
    const profileSellerId=String(context.account.profileUrl||'').match(/\/user\/([^/?#]+)/i)?.[1]||'';
    const result=await yahooCompare(null,item,{...settings,matchCorrections,ownSellerId:item.sellerId||profileSellerId,forceYahooBroadSearch:forceYahoo||task.priority<=1},{fetchYahooItemBundle:(id)=>id===item.id?ownBundle(id):fetchYahooItemBundle(id,settings)});context.yahooById.set(item.id,result);
    console.log(`[Yahoo ${taskIndex+1}/${yahooTasks.length}] ${context.account.name} ${item.id} cards=${result.cardCount} matches=${result.competitorCount} lowest=${result.lowestPrice} source=${result.sourceStatus?.search||'unknown'}`);
  }catch(error){
    console.error(`[Yahoo ERROR][${context.account.id}:${item.id}]`,String(error));
    context.yahooById.set(item.id,cachedYahoo(prior,item,'request_error')||{status:'error',error:String(error),rulesVersion:MATCHING_RULES_VERSION,checkedAt:new Date().toISOString(),candidates:[],lowestPrice:item.ownPrice,lowestUrl:item.url,recommendedPrice:item.ownPrice});
  }finally{await wait(550+Math.floor(Math.random()*350))}
});

// ラクマ也按三个店铺公平轮转。每次只刷新固定数量，其余保留上次严格核验结果，
// 防止数百件商品同时请求令云端任务超时。
const rakumaFreshHours=Math.max(1,Number(settings.rakumaFreshHours)||6);
const rakumaLimit=fullPriceAudit?Number.POSITIVE_INFINITY:Math.max(0,Number(settings.maxRakumaItemsPerRun)||30);
const rakumaBuckets=contexts.map(context=>context.activeItems.map((item,itemIndex)=>{
  // Failed attempts rotate to the tail too, without becoming accepted cache.
  const prior=priorFor(context,item),cached=cachedRakuma(prior),checked=Date.parse(prior.rakuma?.checkedAt||'');
  return {context,item,prior,cached,itemIndex,lastChecked:Number.isFinite(checked)?checked:0};
}).filter(task=>!task.cached||!isFresh(task.cached.checkedAt,rakumaFreshHours)).sort((a,b)=>a.lastChecked-b.lastChecked||a.itemIndex-b.itemIndex));
const rakumaTasks=fairRoundRobin(rakumaBuckets);
for(const context of contexts)for(const item of context.activeItems){
  const cached=cachedRakuma(priorFor(context,item));if(cached&&isFresh(cached.checkedAt,rakumaFreshHours))context.rakumaById.set(item.id,cached);
}
const rakumaWork=(async()=>{
for(const [index,task] of rakumaTasks.entries()){
  const {context,item,prior}=task;
  if(index>=rakumaLimit||Date.now()>=deadline){context.rakumaById.set(item.id,cachedRakuma(prior,'rotation_limit')||{status:'deferred_limit',candidates:[],lowestPrice:null,checkedAt:null});continue}
  try{
    const result=await rakumaCompare(await hydratedItem(item,prior),{...settings,matchCorrections});
    context.rakumaById.set(item.id,result);
    console.log(`[ラクマ ${index+1}/${Math.min(rakumaTasks.length,rakumaLimit)}] ${context.account.name} ${item.id} cards=${result.cardCount} matches=${result.competitorCount} lowest=${result.lowestPrice??'—'}`);
  }catch(error){
    console.error(`[ラクマ ERROR][${context.account.id}:${item.id}]`,String(error));
    context.rakumaById.set(item.id,cachedRakuma(prior,'request_error')||{status:'error',error:String(error),rulesVersion:MATCHING_RULES_VERSION,candidates:[],lowestPrice:null,checkedAt:new Date().toISOString()});
  }
}

})();

// All accounts receive a fair turn. A failed source never becomes 'no offers'.
const mercariLimit=fullPriceAudit?Infinity:Math.max(1,Number(settings.maxMercariItemsPerRun)||30);
const mercariTasks=fairRoundRobin(contexts.map(context=>context.activeItems.map((item,itemIndex)=>{
 const prior=priorFor(context,item),cached=cachedComparison(prior.mercari),stamp=Date.parse(prior.mercari?.checkedAt||'');
 if(cached&&isFresh(cached.checkedAt,6)){context.mercariById.set(item.id,cached);return null}
 return {context,item,prior,itemIndex,lastChecked:Number.isFinite(stamp)?stamp:0};
}).filter(Boolean).sort((a,b)=>a.lastChecked-b.lastChecked||a.itemIndex-b.itemIndex)));
const mercariWork=(async()=>{
let mercariBrowser,mercariPage;
try{for(const [index,{context,item,prior}] of mercariTasks.entries()){
 if(index>=mercariLimit||Date.now()>=deadline){context.mercariById.set(item.id,cachedComparison(prior.mercari,'rotation_limit')||{status:'deferred_limit',candidates:[],checkedAt:null});continue}
 try{
  if(!mercariPage){const opened=await openContext();mercariBrowser=opened.browser;mercariPage=await opened.context.newPage()}
  const result=await mercariCompare(mercariPage,await hydratedItem(item,prior),{...settings,matchCorrections});context.mercariById.set(item.id,result);
  console.log('[Mercari]',context.account.id,item.id,result.status,'matches='+result.competitorCount,'lowest='+result.lowestPrice);
 }catch(error){context.mercariById.set(item.id,{status:'error',error:String(error),rulesVersion:MATCHING_RULES_VERSION,checkedAt:new Date().toISOString(),candidates:[]});console.error('[Mercari ERROR]',item.id,String(error))}
}}finally{await mercariBrowser?.close().catch(()=>{})}

})();

const xianyuState=await xianyuStateFromEnv();
const initialAccess=sessionManager.access();
if(!initialAccess.allowed)console.log(`[闲鱼访问冷却] 原因=${initialAccess.reason} 下次允许检查=${initialAccess.retryAt}；本轮继续Yahoo与网页发布`);
let xBrowser,xContext,xPage,xianyuMode=xianyuState?'saved':'anonymous',xianyuAuthExpired=false,anyXianyuLoginRequired=false;
async function ensureXianyuPage(){
  if(xPage)return xPage;
  const opened=await openContext(xianyuState);xBrowser=opened.browser;xContext=opened.context;xPage=await xContext.newPage();return xPage;
}
const xianyuFreshHours=Number(settings.xianyuFreshHours)||168;
const xianyuRetryHours=Number(settings.xianyuRetryHours)||24;
const xianyuLimit=Math.max(0,Number(settings.maxXianyuItemsPerRun)||3);
const xianyuBuckets=contexts.map(()=>[]);
for(const [contextIndex,context] of contexts.entries())for(const item of context.activeItems){
  const prior=priorFor(context,item),yc=context.yahooById.get(item.id)||{};
  const manual=manualCostFor(manualCosts,{...item,accountId:context.account.id},relistAliases,context.activeItems);
  const verified=verifiedXianyuCache(prior);
  if(verified&&isFresh(verified.checkedAt,xianyuFreshHours)){
    context.xianyuById.set(item.id,{status:'cached_verified',...verified});continue;
  }
  // Only a completed, non-verified review may enter the retry cooldown.
  // Login/challenge/errors and deferred rows must be retried/rotated; otherwise
  // one failed batch stamps checkedAt and can freeze the whole inventory for a day.
  const reviewPlan=xianyuReviewPlan(item,prior,{retryHours:xianyuRetryHours});
  if(reviewPlan.skip){
    context.xianyuById.set(item.id,{...prior.xianyu,status:'skipped_recent_review',reviewStatus:reviewPlan.reviewStatus,samples:[],averageCNY:null});continue;
  }
  // Refresh an automatic market reference for every listing. A user-confirmed
  // purchase cost remains authoritative for profit, but no longer prevents the
  // background reference scan from running.
  const attemptedAt=Date.parse(prior.xianyu?.checkedAt||'');
  xianyuBuckets[contextIndex].push({context,item,prior,priority:reviewPlan.changedQuery?-1:Number.isFinite(manual?.purchaseCNY)?1:0,lastAttempt:Number.isFinite(attemptedAt)?attemptedAt:0});
}
for(const bucket of xianyuBuckets)bucket.sort((a,b)=>a.priority-b.priority||a.lastAttempt-b.lastAttempt||a.item.seq-b.item.seq);
const xianyuTasks=[];
for(let index=0;index<Math.max(0,...xianyuBuckets.map(bucket=>bucket.length));index++)for(const bucket of xianyuBuckets)if(bucket[index])xianyuTasks.push(bucket[index]);

const xianyuWork=(async()=>{
try{
  for(const [index,task] of xianyuTasks.entries()){
    const {context,item}=task;
    // Yahoo owns the general scan budget, but the small fixed Xianyu batch must
    // still run afterwards; otherwise a large inventory permanently starves cost
    // refreshes before they start.
    if(index>=xianyuLimit||Date.now()>=deadline){context.xianyuById.set(item.id,{status:'deferred_limit',samples:[],averageCNY:null});continue}
    if(!sessionManager.access().allowed){context.xianyuById.set(item.id,deferredXianyuAccess(sessionManager.access()));continue}
    if(anyXianyuLoginRequired){context.xianyuById.set(item.id,{status:'deferred_auth',samples:[],averageCNY:null});continue}
    console.log(`[闲鱼 ${index+1}/${Math.min(xianyuTasks.length,xianyuLimit)}] ${context.account.name} ${item.title}`);
    let result;
    try{
      const hydrated=await hydratedItem(item,task.prior);
      result=await xianyuCost(await ensureXianyuPage(),hydrated,{...settings,matchCorrections});
      await sessionManager.persist(xContext,result).catch(()=>console.warn('[闲鱼会话] 更新保存失败，保留原会话'));
      if(result.status==='login_required'&&xianyuMode==='saved'){
        xianyuAuthExpired=true;console.warn('[闲鱼授权] 目标详情需要登录，停止本轮闲鱼检查，不切换身份绕过');
      }
    }catch(error){console.error(`[闲鱼 ERROR][${item.id}]`,String(error));result={status:'error',error:String(error),samples:[],averageCNY:null}}
    result.checkedAt=result.checkedAt||new Date().toISOString();
    if(completedXianyuReview(result)){result.reviewedAt=result.checkedAt;result.reviewVersion=XIANYU_VERIFICATION;}
    console.log(`[闲鱼结果] ${item.id} 状态=${result.status} 卡片=${result.cardCount??0} 初筛=${result.preliminaryCount??0} 核验=${result.verifiedCount??0} 卖家=${result.sellerCount??0} 参考=${result.averageCNY??'—'}`);
    if(result.rejected?.length){
      const reasons=Object.entries(result.rejected.reduce((map,row)=>{map[row.reason||'unknown']=(map[row.reason||'unknown']||0)+1;return map},{})).map(([reason,count])=>`${reason}:${count}`).join(', ');
      console.log(`[闲鱼拒绝原因] ${item.id} ${reasons}`);
      for(const row of [...new Set([...result.rejected.slice(0,2),...result.rejected.filter(row=>/detail_(blocked|login_required|network_error|error)$/.test(row.reason))])])console.log(`[闲鱼拒绝样本] ${item.id} 原因=${row.reason} 标题=${String(row.detailTitle||row.title||'').slice(0,100)} 标题分=${row.titleMatch??'—'} 图片分=${row.imageScore??'—'} 错误=${String(row.error||'').slice(0,180)} 详情字段=${JSON.stringify(row.diagnostic||{})}`);
    }
    if(result.status==='login_required'||result.status==='blocked')anyXianyuLoginRequired=true;
    context.xianyuById.set(item.id,result);
  }
}finally{await xBrowser?.close().catch(()=>{})}

})();
await Promise.all([yahooWork,rakumaWork,mercariWork,xianyuWork]);

const accountResults=[];
for(const context of contexts){
  const rows=context.activeItems.map(item=>{
    const prior=priorFor(context,item),yc=context.yahooById.get(item.id)||{},rc=context.rakumaById.get(item.id)||{status:'not_requested',candidates:[],lowestPrice:null},mc=context.mercariById.get(item.id)||{status:'not_requested',candidates:[]},xc=context.xianyuById.get(item.id)||{status:'not_requested',samples:[],averageCNY:null};
    const priorVerified=verifiedXianyuCache(prior);
    const cachedAverage=priorVerified?.averageCNY??null;
    const averageCNY=Number.isFinite(xc.averageCNY)?xc.averageCNY:cachedAverage;
    const ownPrice=item.ownPrice;
    const yahooCompetitors=(yc.candidates||[]).map(value=>({...value,platform:'yahoo'}));
    const rakumaCompetitors=(rc.candidates||[]).map(value=>({...value,platform:'rakuma'}));
    const competitors=[...yahooCompetitors,...rakumaCompetitors,...(mc.candidates||[]).map(value=>({...value,platform:"mercari"}))].filter(value=>Number.isFinite(Number(value.price))).sort((a,b)=>a.price-b.price);
    const verifiedLowest=competitors[0]||null;
    const rakumaCovered=['ok','incomplete','cached'].includes(rc.status);
    const decision=pricingDecision({ownPrice,yahoo:yc,rakuma:rc,mercari:mc});
    const comparisonIncomplete=!decision.complete;
    const combinedMarket=marketPriceDecision(ownPrice,competitors,settings,{plausibleCompetitors:[yc.raiseGuardMinPrice,rc.plausibleMinPrice,mc.plausibleMinPrice].filter(Number.isFinite)});
    const lowestPrice=verifiedLowest&&verifiedLowest.price<ownPrice?verifiedLowest.price:ownPrice;
    const lowestUrl=verifiedLowest&&verifiedLowest.price<ownPrice?verifiedLowest.url:(yc.lowestUrl||prior.lowestUrl||item.cachedYahoo?.lowestUrl||item.url||'');
    // Always recalculate against the freshly read own price. A manual price
    // change must not replay yesterday's cached recommendation.
    const recommendedPrice=decision.recommendedPrice;
    const needsXianyu=Number.isFinite(lowestPrice)&&lowestPrice<ownPrice;
    const manual=manualCostFor(manualCosts,{...item,accountId:context.account.id},relistAliases,context.activeItems);
    const yahooSource=['ok','incomplete'].includes(yc.status)?'live':yc.status==='cached'?'cached':Number.isFinite(prior.lowestPrice)?'cached':'own_baseline';
    const costSource=Number.isFinite(manual?.purchaseCNY)?'manual':xc.status==='ok'&&Number.isFinite(xc.averageCNY)?'live':Number.isFinite(averageCNY)?'cached':'missing';
    const samples=xc.samples?.length?xc.samples:(priorVerified?.samples||[]);
    const confidence=yc.status==='ok'&&rakumaCovered&&!comparisonIncomplete&&(!needsXianyu||xc.status==='ok'||Number.isFinite(manual?.purchaseCNY))?'高':(yahooSource==='cached'||rc.status==='cached'||costSource==='cached')?'参考缓存':'需人工';
    const priceSignal=recommendedPrice>ownPrice?'raise':recommendedPrice<ownPrice?'lower':'hold';
    const base={...item,accountId:context.account.id,accountName:context.account.name,ownUrl:item.url,lowestPrice,lowestUrl,recommendedPrice,priceSignal,difference:ownPrice-lowestPrice,
      marketMedianPrice:combinedMarket.marketMedianPrice??yc.marketMedianPrice??null,marketSampleCount:combinedMarket.marketPrices.length||yc.marketSampleCount||0,
      marketMinPrice:combinedMarket.marketMinPrice??yc.marketMinPrice??null,marketMaxPrice:combinedMarket.marketMaxPrice??yc.marketMaxPrice??null,
      marketSourcePlatform:verifiedLowest?.platform||'yahoo',comparisonIncomplete,singleMarketSample:combinedMarket.singleVerified,
      averageCNY,confidence,yahooSource,costSource,needsXianyu,needsManualPurchase:needsXianyu&&!Number.isFinite(averageCNY)&&!Number.isFinite(manual?.purchaseCNY),
      yahoo:yc,rakuma:rc,mercari:mc,xianyu:{...(prior.xianyu||{}),...xc,averageCNY,samples},
      xianyuSearchUrl:xc.searchUrl||prior.xianyuSearchUrl||`https://www.goofish.com/search?q=${encodeURIComponent(item.xianyuQuery||item.title||'')}`};
    base.listingAge=listingAge(base,context.previousById.get(item.id)||{},context.profileStatus);
    base.staleListingSuggested=base.listingAge.eligible;
    const calculated=calculateManualFields(base,manual,settings);
    if(combinedMarket.underpriced&&recommendedPrice>ownPrice)calculated.advice=combinedMarket.singleVerified?'与下一家同款存在提价空间（仅1个核验样本）':'与下一家同款存在提价空间，建议提价';
    if(comparisonIncomplete)calculated.advice=decision.canRecommend?'已有核验同款低价，可参考降价；其他平台仍在更新':'三平台比价待核验';
    return {...base,...calculated};
  });
  const yahooValues=[...context.yahooById.values()];
  const rakumaValues=[...context.rakumaById.values()];
  const mercariValues=[...context.mercariById.values()];
  const xianyuValues=[...context.xianyuById.values()];
  const xianyuVerifiedNew=context.activeItems.filter(item=>{
    const current=context.xianyuById.get(item.id),prior=priorFor(context,item);
    return current?.status==='ok'&&Number.isFinite(current.averageCNY)&&!Number.isFinite(verifiedXianyuCache(prior)?.averageCNY);
  }).length;
  const scanStats={
    yahoo:rows.length,yahooLive:yahooValues.filter(value=>['ok','incomplete'].includes(value.status)).length,
    yahooCached:yahooValues.filter(value=>value.status==='cached').length,
    yahooDeferred:yahooValues.filter(value=>value.status==='deferred_budget'||value.cacheReason==='scan_budget').length,
    rakuma:rows.length,rakumaLive:rakumaValues.filter(value=>['ok','incomplete'].includes(value.status)).length,
    rakumaCached:rakumaValues.filter(value=>value.status==='cached').length,
    rakumaDeferred:rakumaValues.filter(value=>value.status==='deferred_limit'||value.cacheReason==='rotation_limit').length,
    mercari:rows.length,mercariLive:mercariValues.filter(value=>['ok','incomplete'].includes(value.status)).length,mercariCached:mercariValues.filter(value=>value.status==='cached').length,
    xianyuRequested:xianyuValues.filter(value=>!['not_requested'].includes(String(value.status))).length,
    xianyuScanned:xianyuValues.filter(value=>['ok','manual_review','page_empty','login_required','blocked','detail_inaccessible','error'].includes(value.status)).length,
    xianyuVerifiedNew,
    xianyuCached:xianyuValues.filter(value=>value.status==='cached_verified').length,
    xianyuSkipped:xianyuValues.filter(value=>String(value.status).startsWith('skipped')||String(value.status).startsWith('deferred')).length,
    xianyuStatuses:xianyuValues.reduce((counts,value)=>{counts[value.status]=(counts[value.status]||0)+1;return counts},{}),
    xianyuRejectionReasons:xianyuValues.flatMap(value=>value.rejected||[]).reduce((counts,value)=>{counts[value.reason]=(counts[value.reason]||0)+1;return counts},{})
  };
  accountResults.push({id:context.account.id,name:context.account.name,platform:context.account.platform,profileUrl:context.account.profileUrl,managed:context.account.managed,
    profileStatus:context.profileStatus,profileError:context.profileError,profileDelta:context.profileDelta,itemCount:rows.length,
    lastCatalogCount:context.catalogItems.length,scanStats,items:rows});
}

const checkedAt=new Date().toISOString(),allItems=accountResults.flatMap(account=>account.items);
const listingHistory={...(previous?.listingHistory||{})};
for(const item of [...(previous?.items||[]),...allItems]){
  if(!item.accountId||!item.id)continue;
  const {id,accountId,title,xianyuQuery,image,relistedFrom}=item;
  listingHistory[`${accountId}:${id}`]={id,accountId,title,xianyuQuery,image,relistedFrom};
}
for(const [key,oldId] of Object.entries(relistAliases))delete listingHistory[`${key.slice(0,key.lastIndexOf(':'))}:${oldId}`];
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
  merchantMonitors:previous?.merchantMonitors||[],listingHistory,pricingCoverage:pricingCoverage(allItems,accountResults),
  version:6,checkedAt,dataRevision:checkedAt,settings,accounts:accountResults,managedAccounts,portalUsers,appliedSyncIssues:previous?.appliedSyncIssues||{},
  manualCosts,matchCorrections,portalPreferences,dismissedDiscoveries,discoveryReviews,ownedTitleHistory,relistAliases,login:{xianyuRequired:anyXianyuLoginRequired,xianyuAuthExpired,xianyuMode,xianyuAccess:sessionManager.access()},items:allItems,
  scanMeta:{codeSha:process.env.GITHUB_SHA||null,trigger:process.env.SCAN_TRIGGER||'local',startedAt:new Date(startedAt).toISOString(),durationSeconds:Math.round((Date.now()-startedAt)/1000),
    budgetMinutes:Number(settings.scanBudgetMinutes)||12,profileConcurrency,yahooConcurrency,rakumaLimit,xianyuLimit}
};
const {summary}=await writeOutputs({root,result,previous,password});
console.log(summary);
