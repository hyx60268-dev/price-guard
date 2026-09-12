import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { openContext } from './lib/browser.mjs';
import { discoverYahooProfile,yahooCompare } from './lib/yahoo.mjs';
import { xianyuCost } from './lib/xianyu.mjs';
import { advice,calculateCost,inferSize } from './lib/rules.mjs';
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
const x=await openContext(xianyuState),xp=await x.context.newPage();
let xianyuMode=xianyuState?'saved':'anonymous',xianyuAuthExpired=false,anyXianyuLoginRequired=false;
const accountResults=[];

async function switchXianyuToAnonymous(){
  await x.context.clearCookies();
  await xp.goto('https://www.goofish.com',{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});
  await xp.evaluate(()=>{localStorage.clear();sessionStorage.clear()}).catch(()=>{});
  xianyuMode='anonymous';
}

try{
  for(const account of accountsCfg.accounts.filter(a=>a.enabled!==false)){
    const catalog=await readJson(path.join(root,account.catalogFile));
    let activeItems=catalog.items||[],profileStatus='cached',profileError='';
    console.log(`\n=== 账号 ${account.name} (${account.id}) ===`);
    try{
      const discovered=await discoverYahooProfile(null,account.profileUrl,settings);
      if(discovered.items.length){
        const known=new Map((catalog.items||[]).map(item=>[item.id,item]));
        activeItems=discovered.items.map((live,index)=>({...known.get(live.id),...live,seq:index+1,xianyuQuery:known.get(live.id)?.xianyuQuery||'',size:known.get(live.id)?.size||inferSize(live.title)}));
        profileStatus='live';
        console.log(`Yahoo 主页实时刷新成功：${discovered.pages} 页中发现 ${activeItems.length} 件当前在售（历史总数 ${discovered.totalResults}）`);
      }else console.warn(`Yahoo 主页返回 0 件在售；沿用保存清单 ${activeItems.length} 件`);
    }catch(error){profileStatus='error';profileError=String(error);console.warn(`Yahoo 主页刷新失败；沿用保存清单：${profileError}`)}

    // Yahoo 对云端 IP 限流明显。单通道并在每次搜索后停 4.2–5.0 秒，和闲鱼扫描并行完成。
    const yahooPromise=mapLimit(activeItems,1,async(item,index)=>{
      try{const result=await yahooCompare(null,item,settings);console.log(`[Yahoo ${account.name} ${index+1}/${activeItems.length}] cards=${result.cardCount} matches=${result.competitorCount}`);return result}
      catch(error){console.error(`[Yahoo ERROR][${item.id}]`,String(error));return {status:'error',error:String(error),candidates:[],lowestPrice:null,lowestUrl:'',recommendedPrice:item.ownPrice}}
      finally{await new Promise(resolve=>setTimeout(resolve,4200+Math.floor(Math.random()*800)))}
    });
    const xianyuResults=[];
    for(const [index,item] of activeItems.entries()){
      console.log(`[闲鱼 ${account.name} ${index+1}/${activeItems.length}] ${item.title}`);
      let result;
      try{
        result=await xianyuCost(xp,item,settings);
        if(result.status==='login_required'&&xianyuMode==='saved'){
          xianyuAuthExpired=true;
          console.warn('[闲鱼授权] 保存的登录状态失效，自动切换匿名搜索后重试');
          await switchXianyuToAnonymous();
          result=await xianyuCost(xp,item,settings);result.fallback='anonymous';
        }
      }catch(error){console.error(`[闲鱼 ERROR][${item.id}]`,String(error));result={status:'error',error:String(error),samples:[],averageCNY:null}}
      if(result.status==='login_required') anyXianyuLoginRequired=true;
      if(result.status!=='ok'&&result.status!=='missing_query') console.warn(`[闲鱼][${item.id}] status=${result.status} cards=${result.cardCount??0}`);
      xianyuResults.push(result);
    }
    const yahooResults=await yahooPromise;
    const rows=activeItems.map((item,index)=>{
      const yc=yahooResults[index],xc=xianyuResults[index];
      const avg=Number.isFinite(xc.averageCNY)?xc.averageCNY:item.cachedXianyu?.averageCNY;
      const costSource=Number.isFinite(xc.averageCNY)?'live':Number.isFinite(item.cachedXianyu?.averageCNY)?'cached':'missing';
      const size=item.size||inferSize(item.title),ownPrice=item.ownPrice;
      const lowestPrice=Number.isFinite(yc.lowestPrice)?yc.lowestPrice:(item.cachedYahoo?.lowestPrice??ownPrice);
      const lowestUrl=yc.lowestUrl||item.cachedYahoo?.lowestUrl||item.url||'';
      const recommendedPrice=Number.isFinite(yc.recommendedPrice)?yc.recommendedPrice:(item.cachedYahoo?.recommendedPrice??ownPrice);
      const costJPY=calculateCost(avg,size,settings),currentProfitJPY=Number.isFinite(costJPY)?ownPrice-costJPY:null,afterProfitJPY=Number.isFinite(costJPY)?recommendedPrice-costJPY:null;
      const yahooSource=yc.status==='ok'?'live':Number.isFinite(item.cachedYahoo?.lowestPrice)?'cached':'own_baseline';
      const confidence=yc.status==='ok'&&xc.status==='ok'?'高':(yahooSource==='cached'||costSource==='cached')?'参考缓存':'需人工';
      return {...item,accountId:account.id,accountName:account.name,ownUrl:item.url,lowestPrice,lowestUrl,recommendedPrice,difference:ownPrice-lowestPrice,
        averageCNY:avg,costJPY,currentProfitJPY,afterProfitJPY,currentUnder1500:Number.isFinite(currentProfitJPY)&&currentProfitJPY<settings.profitWarningJPY,
        afterUnder1500:Number.isFinite(afterProfitJPY)&&afterProfitJPY<settings.profitWarningJPY,
        advice:advice({ownPrice,recommendedPrice,cost:costJPY,warning:settings.profitWarningJPY}),confidence,yahooSource,costSource,
        yahoo:{...yc,lowestPrice,lowestUrl},xianyu:{...xc,averageCNY:avg,samples:xc.samples?.length?xc.samples:(item.cachedXianyu?.samplePricesCNY||[]).map((price,i)=>({price,url:item.cachedXianyu.sampleLinks?.[i]||'',title:'历史确认样本'}))},
        xianyuSearchUrl:xc.searchUrl||`https://www.goofish.com/search?q=${encodeURIComponent(item.xianyuQuery||'')}`};
    });
    accountResults.push({id:account.id,name:account.name,profileUrl:account.profileUrl,profileStatus,profileError,itemCount:rows.length,lastCatalogCount:(catalog.items||[]).length,items:rows});
  }
}finally{await x.browser.close().catch(()=>{})}

const checkedAt=new Date().toISOString(),allItems=accountResults.flatMap(account=>account.items);
const result={version:3,checkedAt,settings,accounts:accountResults,login:{xianyuRequired:anyXianyuLoginRequired,xianyuAuthExpired,xianyuMode},items:allItems};
const changeSummary=compareSnapshots(previous,result);result.changes={...changeSummary,changes:changeSummary.changes.slice(0,100)};
const jsonPath=path.join(root,'data','latest.json'),xlsxPath=path.join(root,'data','latest.xlsx');
await fs.writeFile(jsonPath,JSON.stringify(result,null,2));await makeWorkbook(result,xlsxPath);
await Promise.all([encryptFile(jsonPath,path.join(root,'public','data','latest.json.enc'),password),encryptFile(xlsxPath,path.join(root,'public','data','latest.xlsx.enc'),password)]);
const summary={checkedAt,total:allItems.length,accounts:accountResults.map(a=>({id:a.id,name:a.name,count:a.itemCount,profileStatus:a.profileStatus})),repricing:allItems.filter(r=>r.recommendedPrice<r.ownPrice).length,currentLow:allItems.filter(r=>r.currentUnder1500).length,afterLow:allItems.filter(r=>r.afterUnder1500).length,manual:allItems.filter(r=>r.confidence!=='高').length,xianyuLoginRequired:anyXianyuLoginRequired,xianyuAuthExpired,xianyuMode,changes:{total:changeSummary.total,firstRun:changeSummary.firstRun}};
await Promise.all([fs.writeFile(path.join(root,'public','data','status.json'),JSON.stringify(summary,null,2)),fs.writeFile(path.join(root,'data','change-summary.json'),JSON.stringify(changeSummary,null,2))]);
await Promise.allSettled([fs.unlink(jsonPath),fs.unlink(xlsxPath)]);console.log(summary);
