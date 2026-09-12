import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { openContext } from './lib/browser.mjs';
import { discoverYahooProfile,yahooCompare } from './lib/yahoo.mjs';
import { xianyuCost } from './lib/xianyu.mjs';
import { advice,calculateCost } from './lib/rules.mjs';
import { inventoryDelta,reconcileLiveItems,shouldScanXianyu,verifiedXianyuCache } from './lib/planner.mjs';
import { makeWorkbook } from './lib/excel.mjs';
import { decrypt,encryptFile } from './lib/crypto.mjs';
import { compareSnapshots } from './lib/changes.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'..');
const readJson=file=>fs.readFile(file,'utf8').then(JSON.parse);
const exists=file=>fs.access(file).then(()=>true).catch(()=>false);
const settings=await readJson(path.join(root,'config','settings.json'));
const accountsCfg=await readJson(path.join(root,'config','accounts.json'));
const password=process.env.DASHBOARD_PASSWORD;
if(!password||password.length<8) throw new Error('DASHBOARD_PASSWORD 至少需要 8 个字符');
await Promise.all(['data','public/data','.auth','state'].map(dir=>fs.mkdir(path.join(root,dir),{recursive:true})));

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
  if(!await exists(file)) return null;
  try{return JSON.parse(decrypt(await fs.readFile(file),password).toString('utf8'))}
  catch(error){console.warn('[变化检测] 无法读取上次基准，将重新建立：',String(error));return null}
}

async function mapLimit(values,limit,worker){
  const output=new Array(values.length);let cursor=0;
  async function runner(){while(true){const index=cursor++;if(index>=values.length)return;output[index]=await worker(values[index],index)}}
  await Promise.all(Array.from({length:Math.min(limit,values.length)},runner));return output;
}

const previous=await previousSnapshot();
const xianyuState=await xianyuStateFromEnv();
let xBrowser,xContext,xPage,xianyuMode=xianyuState?'saved':'anonymous',xianyuAuthExpired=false,anyXianyuLoginRequired=false;

async function ensureXianyuPage(){
  if(xPage)return xPage;
  const opened=await openContext(xianyuState);xBrowser=opened.browser;xContext=opened.context;xPage=await xContext.newPage();
  return xPage;
}

async function switchXianyuToAnonymous(){
  const page=await ensureXianyuPage();
  await xContext.clearCookies();
  await page.goto('https://www.goofish.com',{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});
  await page.evaluate(()=>{localStorage.clear();sessionStorage.clear()}).catch(()=>{});
  xianyuMode='anonymous';
}

const accountResults=[];
try{
  for(const account of accountsCfg.accounts.filter(a=>a.enabled!==false)){
    const catalog=await readJson(path.join(root,account.catalogFile));
    const catalogItems=catalog.items||[];
    const previousItems=(previous?.items||[]).filter(item=>(item.accountId||account.id)===account.id);
    let activeItems=(previousItems.length?previousItems:catalogItems).map((item,index)=>({...item,seq:index+1}));
    let profileStatus='cached',profileError='';
    console.log(`\n=== 账号 ${account.name} (${account.id}) ===`);
    try{
      const discovered=await discoverYahooProfile(null,account.profileUrl,settings);
      if(discovered.items.length){
        activeItems=reconcileLiveItems(catalogItems,previousItems,discovered.items);
        profileStatus='live';
        console.log(`Yahoo 主页实时刷新成功：${discovered.pages} 页中发现 ${activeItems.length} 件当前在售（历史总数 ${discovered.totalResults}）`);
      }else console.warn(`Yahoo 主页返回 0 件在售；沿用上次/保存清单 ${activeItems.length} 件`);
    }catch(error){profileStatus='error';profileError=String(error);console.warn(`Yahoo 主页刷新失败；沿用上次/保存清单：${profileError}`)}

    const profileDelta=inventoryDelta(previousItems,activeItems);
    console.log(`商品清单变化：新增 ${profileDelta.added.length}、减少 ${profileDelta.removed.length}、复用 ${profileDelta.unchanged}`);

    // 主页只负责增减与当前售价；商品搜索词等元数据优先复用 catalog/上次结果。
    // Yahoo 搜索单通道限速以降低 429；全部 Yahoo 完成后，才决定哪些商品需要查闲鱼。
    const yahooResults=await mapLimit(activeItems,1,async(item,index)=>{
      try{const result=await yahooCompare(null,item,settings);console.log(`[Yahoo ${account.name} ${index+1}/${activeItems.length}] cards=${result.cardCount} matches=${result.competitorCount}`);return result}
      catch(error){console.error(`[Yahoo ERROR][${item.id}]`,String(error));return {status:'error',error:String(error),candidates:[],lowestPrice:null,lowestUrl:'',recommendedPrice:item.ownPrice}}
      finally{await new Promise(resolve=>setTimeout(resolve,4200+Math.floor(Math.random()*800)))}
    });

    const previousById=new Map(previousItems.map(item=>[item.id,item]));
    const xianyuResults=[];
    let xianyuRequested=0,xianyuScanned=0,xianyuSkipped=0;
    for(const [index,item] of activeItems.entries()){
      if(!shouldScanXianyu(item,yahooResults[index])){
        xianyuSkipped++;
        xianyuResults.push({status:'skipped_no_reprice',reason:'当前售价已是最低或 Yahoo 本次未成功',samples:[],averageCNY:null});
        continue;
      }
      xianyuRequested++;
      if(!item.xianyuQuery){
        xianyuResults.push({query:'',status:'missing_query',samples:[],averageCNY:null});
        continue;
      }
      xianyuScanned++;
      console.log(`[闲鱼 ${account.name} ${xianyuScanned}/${xianyuRequested}] ${item.title}`);
      let result;
      try{
        result=await xianyuCost(await ensureXianyuPage(),item,settings);
        if(result.status==='login_required'&&xianyuMode==='saved'){
          xianyuAuthExpired=true;
          console.warn('[闲鱼授权] 保存的登录状态失效，自动切换匿名搜索后重试');
          await switchXianyuToAnonymous();
          result=await xianyuCost(xPage,item,settings);result.fallback='anonymous';
        }
      }catch(error){console.error(`[闲鱼 ERROR][${item.id}]`,String(error));result={status:'error',error:String(error),samples:[],averageCNY:null}}
      if(result.status==='login_required') anyXianyuLoginRequired=true;
      if(result.status!=='ok'&&result.status!=='missing_query') console.warn(`[闲鱼][${item.id}] status=${result.status} cards=${result.cardCount??0} preliminary=${result.preliminaryCount??0} verified=${result.verifiedCount??0}`);
      xianyuResults.push(result);
    }

    const rows=activeItems.map((item,index)=>{
      const yc=yahooResults[index],xc=xianyuResults[index],prior=previousById.get(item.id)||{};
      // v3 的闲鱼卡片均价没有进入详情页核验，可能包含系列最低价钩子，不能沿用。
      // 只有 v4 详情验证 + 价格聚类产生的历史结果才有资格作为缓存。
      const priorVerified=verifiedXianyuCache(prior);
      const cachedAverage=priorVerified?.averageCNY??null;
      const averageCNY=Number.isFinite(xc.averageCNY)?xc.averageCNY:cachedAverage;
      const costSource=Number.isFinite(xc.averageCNY)?'live':Number.isFinite(cachedAverage)?'cached':'missing';
      const ownPrice=item.ownPrice;
      const lowestPrice=Number.isFinite(yc.lowestPrice)?yc.lowestPrice:(prior.lowestPrice??item.cachedYahoo?.lowestPrice??ownPrice);
      const lowestUrl=yc.lowestUrl||prior.lowestUrl||item.cachedYahoo?.lowestUrl||item.url||'';
      const recommendedPrice=Number.isFinite(yc.recommendedPrice)?yc.recommendedPrice:(prior.recommendedPrice??item.cachedYahoo?.recommendedPrice??ownPrice);
      const needsXianyu=shouldScanXianyu(item,yc);
      // 人肉费和日本物流费不再由系统猜测。网页端填入三个值后即时计算并保存在浏览器。
      const costJPY=calculateCost(averageCNY,null,null,settings),currentProfitJPY=null,afterProfitJPY=null;
      const yahooSource=yc.status==='ok'?'live':Number.isFinite(prior.lowestPrice)||Number.isFinite(item.cachedYahoo?.lowestPrice)?'cached':'own_baseline';
      const confidence=yc.status==='ok'&&(!needsXianyu||xc.status==='ok')?'高':(yahooSource==='cached'||costSource==='cached')?'参考缓存':'需人工';
      const cachedSamples=priorVerified?.samples||[];
      const samples=xc.samples?.length?xc.samples:(cachedSamples||[]);
      return {...item,accountId:account.id,accountName:account.name,ownUrl:item.url,lowestPrice,lowestUrl,recommendedPrice,difference:ownPrice-lowestPrice,
        averageCNY,costJPY,currentProfitJPY,afterProfitJPY,currentUnder1500:false,afterUnder1500:false,
        advice:advice({ownPrice,recommendedPrice,cost:costJPY,warning:settings.profitWarningJPY}),confidence,yahooSource,costSource,needsXianyu,
        needsManualPurchase:needsXianyu&&!Number.isFinite(averageCNY),
        yahoo:{...yc,lowestPrice,lowestUrl},xianyu:{...xc,averageCNY,samples},
        xianyuSearchUrl:xc.searchUrl||prior.xianyuSearchUrl||`https://www.goofish.com/search?q=${encodeURIComponent(item.xianyuQuery||'')}`};
    });
    accountResults.push({id:account.id,name:account.name,profileUrl:account.profileUrl,profileStatus,profileError,profileDelta,itemCount:rows.length,lastCatalogCount:catalogItems.length,
      scanStats:{yahoo:rows.length,xianyuRequested,xianyuScanned,xianyuSkipped},items:rows});
  }
}finally{await xBrowser?.close().catch(()=>{})}

const checkedAt=new Date().toISOString(),allItems=accountResults.flatMap(account=>account.items);
const result={version:4,checkedAt,settings,accounts:accountResults,login:{xianyuRequired:anyXianyuLoginRequired,xianyuAuthExpired,xianyuMode},items:allItems};
const changeSummary=compareSnapshots(previous,result);result.changes={...changeSummary,changes:changeSummary.changes.slice(0,100)};
const jsonPath=path.join(root,'data','latest.json'),xlsxPath=path.join(root,'data','latest.xlsx');
await fs.writeFile(jsonPath,JSON.stringify(result,null,2));await makeWorkbook(result,xlsxPath);
await Promise.all([encryptFile(jsonPath,path.join(root,'public','data','latest.json.enc'),password),encryptFile(xlsxPath,path.join(root,'public','data','latest.xlsx.enc'),password)]);
const scanTotals=accountResults.reduce((sum,account)=>({yahoo:sum.yahoo+account.scanStats.yahoo,xianyuRequested:sum.xianyuRequested+account.scanStats.xianyuRequested,xianyuScanned:sum.xianyuScanned+account.scanStats.xianyuScanned,xianyuSkipped:sum.xianyuSkipped+account.scanStats.xianyuSkipped}),{yahoo:0,xianyuRequested:0,xianyuScanned:0,xianyuSkipped:0});
const summary={checkedAt,total:allItems.length,accounts:accountResults.map(a=>({id:a.id,name:a.name,count:a.itemCount,profileStatus:a.profileStatus,profileDelta:a.profileDelta,scanStats:a.scanStats})),repricing:allItems.filter(r=>r.recommendedPrice<r.ownPrice).length,
  manual:allItems.filter(r=>r.confidence!=='高').length,needsManualPurchase:allItems.filter(r=>r.needsManualPurchase).length,scanTotals,
  xianyuLoginRequired:anyXianyuLoginRequired,xianyuAuthExpired,xianyuMode,changes:{total:changeSummary.total,firstRun:changeSummary.firstRun}};
await Promise.all([fs.writeFile(path.join(root,'public','data','status.json'),JSON.stringify(summary,null,2)),fs.writeFile(path.join(root,'data','change-summary.json'),JSON.stringify(changeSummary,null,2))]);
await Promise.allSettled([fs.unlink(jsonPath),fs.unlink(xlsxPath)]);console.log(summary);
