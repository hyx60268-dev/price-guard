import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { openContext } from './lib/browser.mjs';
import { discoverYahooProfile,yahooCompare } from './lib/yahoo.mjs';
import { xianyuCost } from './lib/xianyu.mjs';
import { advice,calculateCost,inferSize } from './lib/rules.mjs';
import { makeWorkbook } from './lib/excel.mjs';
import { encryptFile } from './lib/crypto.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)), root=path.resolve(here,'..');
const readJson=p=>fs.readFile(p,'utf8').then(JSON.parse);
const settings=await readJson(path.join(root,'config','settings.json'));
const accountsCfg=await readJson(path.join(root,'config','accounts.json'));
const password=process.env.DASHBOARD_PASSWORD;
if(!password||password.length<8) throw new Error('DASHBOARD_PASSWORD 至少需要 8 个字符');
await fs.mkdir(path.join(root,'data'),{recursive:true});
await fs.mkdir(path.join(root,'public','data'),{recursive:true});
await fs.mkdir(path.join(root,'.auth'),{recursive:true});

async function xianyuStateFromEnv(){
  const file=path.join(root,'.auth','xianyu.json');
  const parts=['XIANYU_AUTH_PART_1','XIANYU_AUTH_PART_2','XIANYU_AUTH_PART_3'].map(k=>process.env[k]||'').join('');
  if(parts){
    try{await fs.writeFile(file,zlib.gunzipSync(Buffer.from(parts,'base64')));return file}
    catch(e){console.warn('[闲鱼授权] 三段 Secret 无法解压：',String(e));}
  }
  const gz=process.env.XIANYU_STORAGE_STATE_GZIP_B64;
  if(gz){try{await fs.writeFile(file,zlib.gunzipSync(Buffer.from(gz,'base64')));return file}catch(e){console.warn('[闲鱼授权] GZIP Secret 无法解压：',String(e));}}
  const raw=process.env.XIANYU_STORAGE_STATE_B64;
  if(raw){try{await fs.writeFile(file,Buffer.from(raw,'base64'));return file}catch(e){console.warn('[闲鱼授权] 旧 Secret 无法解析：',String(e));}}
  return undefined;
}

const xianyuState=await xianyuStateFromEnv();
const y=await openContext(undefined), x=await openContext(xianyuState);
const yp=await y.context.newPage(), xp=await x.context.newPage();
const accountResults=[];
let anyXianyuLoginRequired=false;

try{
  for(const account of accountsCfg.accounts.filter(a=>a.enabled!==false)){
    const catalogPath=path.join(root,account.catalogFile);
    const catalog=await readJson(catalogPath);
    let activeItems=catalog.items||[];
    let profileStatus='cached';
    let profileError='';
    console.log(`\n=== 账号 ${account.name} (${account.id}) ===`);
    console.log(`公开主页：${account.profileUrl}`);
    try{
      const discovered=await discoverYahooProfile(yp,account.profileUrl,settings);
      if(discovered.length){
        const known=new Map((catalog.items||[]).map(i=>[i.id,i]));
        activeItems=discovered.map((live,index)=>({
          ...known.get(live.id),...live,seq:index+1,
          xianyuQuery:known.get(live.id)?.xianyuQuery||'',
          size:known.get(live.id)?.size||inferSize(live.title)
        }));
        profileStatus='live';
        console.log(`主页刷新成功：发现 ${activeItems.length} 件当前在售商品`);
      }else{
        profileStatus='cached';
        console.warn(`主页未读取到商品；沿用账号 ${account.name} 已保存的 ${activeItems.length} 件清单`);
      }
    }catch(error){
      profileStatus='error';profileError=String(error);
      console.warn(`主页刷新失败；沿用已保存清单：${profileError}`);
    }

    const rows=[];
    for(const [index,item] of activeItems.entries()){
      console.log(`[${account.name} ${index+1}/${activeItems.length}] ${item.title}`);
      let yc,xc;
      try{
        yc=await yahooCompare(yp,item,settings);
        if(yc.status!=='ok') console.warn(`[Yahoo][${item.id}] status=${yc.status} cards=${yc.cardCount??0}`);
      }catch(error){
        console.error(`[Yahoo ERROR][${item.id}]`,String(error));
        yc={status:'error',error:String(error),candidates:[],lowestPrice:null,lowestUrl:'',recommendedPrice:item.ownPrice};
      }
      try{
        xc=await xianyuCost(xp,item,settings);
        if(xc.status!=='ok') console.warn(`[闲鱼][${item.id}] status=${xc.status} cards=${xc.cardCount??0}`);
      }catch(error){
        console.error(`[闲鱼 ERROR][${item.id}]`,String(error));
        xc={status:'error',error:String(error),samples:[],averageCNY:null};
      }
      if(xc.status==='login_required') anyXianyuLoginRequired=true;
      const avg=Number.isFinite(xc.averageCNY)?xc.averageCNY:item.cachedXianyu?.averageCNY;
      const costSource=Number.isFinite(xc.averageCNY)?'live':Number.isFinite(item.cachedXianyu?.averageCNY)?'cached':'missing';
      const size=item.size||inferSize(item.title);
      const ownPrice=item.ownPrice;
      const lowestPrice=Number.isFinite(yc.lowestPrice)?yc.lowestPrice:item.cachedYahoo?.lowestPrice;
      const lowestUrl=yc.lowestUrl||item.cachedYahoo?.lowestUrl||'';
      const recommendedPrice=Number.isFinite(yc.recommendedPrice)?yc.recommendedPrice:(item.cachedYahoo?.recommendedPrice??ownPrice);
      const costJPY=calculateCost(avg,size,settings);
      const currentProfitJPY=Number.isFinite(costJPY)?ownPrice-costJPY:null;
      const afterProfitJPY=Number.isFinite(costJPY)?recommendedPrice-costJPY:null;
      const yahooSource=yc.status==='ok'?'live':Number.isFinite(item.cachedYahoo?.lowestPrice)?'cached':'missing';
      const confidence=yc.status==='ok'&&xc.status==='ok'?'高':(yahooSource==='cached'||costSource==='cached')?'参考缓存':'需人工';
      rows.push({...item,accountId:account.id,accountName:account.name,ownUrl:item.url,lowestPrice,lowestUrl,recommendedPrice,
        difference:Number.isFinite(lowestPrice)?ownPrice-lowestPrice:null,averageCNY:avg,costJPY,currentProfitJPY,afterProfitJPY,
        currentUnder1500:Number.isFinite(currentProfitJPY)&&currentProfitJPY<settings.profitWarningJPY,
        afterUnder1500:Number.isFinite(afterProfitJPY)&&afterProfitJPY<settings.profitWarningJPY,
        advice:advice({ownPrice,recommendedPrice,cost:costJPY,warning:settings.profitWarningJPY}),confidence,yahooSource,costSource,
        yahoo:{...yc,lowestPrice,lowestUrl},xianyu:{...xc,averageCNY:avg,samples:xc.samples?.length?xc.samples:(item.cachedXianyu?.samplePricesCNY||[]).map((price,i)=>({price,url:item.cachedXianyu.sampleLinks?.[i]||'',title:'历史确认样本'}))},
        xianyuSearchUrl:xc.searchUrl||`https://www.goofish.com/search?q=${encodeURIComponent(item.xianyuQuery||'')}`});
    }
    accountResults.push({
      id:account.id,name:account.name,profileUrl:account.profileUrl,profileStatus,profileError,
      itemCount:rows.length,lastCatalogCount:(catalog.items||[]).length,items:rows
    });
  }
}finally{await Promise.allSettled([y.browser.close(),x.browser.close()]);}

const checkedAt=new Date().toISOString();
const allItems=accountResults.flatMap(a=>a.items);
const result={version:2,checkedAt,settings,accounts:accountResults,login:{xianyuRequired:anyXianyuLoginRequired},items:allItems};
const jsonPath=path.join(root,'data','latest.json'),xlsxPath=path.join(root,'data','latest.xlsx');
await fs.writeFile(jsonPath,JSON.stringify(result,null,2));
await makeWorkbook(result,xlsxPath);
await Promise.all([
  encryptFile(jsonPath,path.join(root,'public','data','latest.json.enc'),password),
  encryptFile(xlsxPath,path.join(root,'public','data','latest.xlsx.enc'),password)
]);
const summary={checkedAt,total:allItems.length,accounts:accountResults.map(a=>({id:a.id,name:a.name,count:a.itemCount,profileStatus:a.profileStatus})),repricing:allItems.filter(r=>r.recommendedPrice<r.ownPrice).length,currentLow:allItems.filter(r=>r.currentUnder1500).length,afterLow:allItems.filter(r=>r.afterUnder1500).length,manual:allItems.filter(r=>r.confidence!=='高').length,xianyuLoginRequired:anyXianyuLoginRequired};
await fs.writeFile(path.join(root,'public','data','status.json'),JSON.stringify(summary,null,2));
await Promise.allSettled([fs.unlink(jsonPath),fs.unlink(xlsxPath)]);
console.log(summary);
