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
const catalog=await readJson(path.join(root,'config','catalog.json'));
const password=process.env.DASHBOARD_PASSWORD;
if(!password||password.length<8) throw new Error('DASHBOARD_PASSWORD 至少需要 8 个字符');

await fs.mkdir(path.join(root,'data'),{recursive:true});
await fs.mkdir(path.join(root,'public','data'),{recursive:true});
async function stateFromEnv(name,file,compressed=false){
  const value=process.env[name];
  if(value){
    const raw=Buffer.from(value,'base64');
    await fs.writeFile(file,compressed?zlib.gunzipSync(raw):raw);
  }
  return await fs.access(file).then(()=>file).catch(()=>undefined);
}
async function stateFromParts(names,file){
  const value=names.map(name=>process.env[name]||'').join('');
  if(!value)return undefined;
  await fs.writeFile(file,zlib.gunzipSync(Buffer.from(value,'base64')));
  return file;
}
await fs.mkdir(path.join(root,'.auth'),{recursive:true});
const yahooState=await stateFromEnv('YAHOO_STORAGE_STATE_B64',path.join(root,'.auth','yahoo.json'));
const xianyuFile=path.join(root,'.auth','xianyu.json');
const xianyuState=await stateFromParts(['XIANYU_AUTH_PART_1','XIANYU_AUTH_PART_2','XIANYU_AUTH_PART_3'],xianyuFile)
  || await stateFromEnv('XIANYU_STORAGE_STATE_GZIP_B64',xianyuFile,true)
  || await stateFromEnv('XIANYU_STORAGE_STATE_B64',xianyuFile);
const y=await openContext(yahooState), x=await openContext(xianyuState);
const yp=await y.context.newPage(), xp=await x.context.newPage();
let activeItems=catalog.items;
try{
  const discovered=await discoverYahooProfile(yp,settings.profileUrl,settings);
  if(discovered.length){
    const known=new Map(catalog.items.map(x=>[x.id,x]));
    activeItems=discovered.map((live,index)=>({...known.get(live.id),...live,seq:index+1,xianyuQuery:known.get(live.id)?.xianyuQuery||'',size:known.get(live.id)?.size||inferSize(live.title)}));
    console.log(`主页刷新成功：发现 ${activeItems.length} 件当前在售商品`);
  }else console.warn('主页未读取到商品，继续使用已确认清单');
}catch(error){console.warn('主页刷新失败，继续使用已确认清单：',String(error));}
const rows=[]; let xianyuLoginRequired=false;
try{
  for(const [index,item] of activeItems.entries()){
    console.log(`[${index+1}/${activeItems.length}] ${item.title}`);
    let yc,xc;
    try{yc=await yahooCompare(yp,item,settings);}catch(error){yc={status:'error',error:String(error),candidates:[]};}
    try{xc=await xianyuCost(xp,item,settings);}catch(error){xc={status:'error',error:String(error),samples:[],averageCNY:null};}
    if(xc.status==='login_required') xianyuLoginRequired=true;
    const avg=Number.isFinite(xc.averageCNY)?xc.averageCNY:item.cachedXianyu?.averageCNY;
    const size=item.size||inferSize(item.title);
    const ownPrice=item.ownPrice;
    const lowestPrice=Number.isFinite(yc.lowestPrice)?yc.lowestPrice:item.cachedYahoo?.lowestPrice;
    const lowestUrl=yc.lowestUrl||item.cachedYahoo?.lowestUrl||'';
    const recommendedPrice=Number.isFinite(yc.recommendedPrice)?yc.recommendedPrice:(item.cachedYahoo?.recommendedPrice??ownPrice);
    const costJPY=calculateCost(avg,size,settings);
    const currentProfitJPY=Number.isFinite(costJPY)?ownPrice-costJPY:null;
    const afterProfitJPY=Number.isFinite(costJPY)?recommendedPrice-costJPY:null;
    rows.push({...item,ownUrl:item.url,lowestPrice,lowestUrl,recommendedPrice,difference:Number.isFinite(lowestPrice)?ownPrice-lowestPrice:null,
      averageCNY:avg,costJPY,currentProfitJPY,afterProfitJPY,
      currentUnder1500:Number.isFinite(currentProfitJPY)&&currentProfitJPY<settings.profitWarningJPY,
      afterUnder1500:Number.isFinite(afterProfitJPY)&&afterProfitJPY<settings.profitWarningJPY,
      advice:advice({ownPrice,recommendedPrice,cost:costJPY,warning:settings.profitWarningJPY}),
      confidence:yc.status==='ok'&&xc.status==='ok'?'高':avg!=null?'参考缓存':'需人工',
      yahoo:{...yc,lowestPrice,lowestUrl},xianyu:{...xc,averageCNY:avg,samples:xc.samples?.length?xc.samples:(item.cachedXianyu?.samplePricesCNY||[]).map((price,i)=>({price,url:item.cachedXianyu.sampleLinks?.[i]||'',title:'历史确认样本'}))},
      xianyuSearchUrl:xc.searchUrl||`https://www.goofish.com/search?q=${encodeURIComponent(item.xianyuQuery||'')}`});
  }
}finally{await Promise.allSettled([y.browser.close(),x.browser.close()]);}

const checkedAt=new Date().toISOString();
const result={version:1,checkedAt,profile:catalog.profile,seller:catalog.seller,settings,login:{xianyuRequired:xianyuLoginRequired},items:rows};
const jsonPath=path.join(root,'data','latest.json'),xlsxPath=path.join(root,'data','latest.xlsx');
await fs.writeFile(jsonPath,JSON.stringify(result,null,2));
await makeWorkbook(result,xlsxPath);
await Promise.all([
  encryptFile(jsonPath,path.join(root,'public','data','latest.json.enc'),password),
  encryptFile(xlsxPath,path.join(root,'public','data','latest.xlsx.enc'),password)
]);
const summary={checkedAt,total:rows.length,repricing:rows.filter(r=>r.recommendedPrice<r.ownPrice).length,currentLow:rows.filter(r=>r.currentUnder1500).length,afterLow:rows.filter(r=>r.afterUnder1500).length,manual:rows.filter(r=>r.confidence!=='高').length,xianyuLoginRequired};
await fs.writeFile(path.join(root,'public','data','status.json'),JSON.stringify(summary,null,2));
await Promise.allSettled([fs.unlink(jsonPath),fs.unlink(xlsxPath)]);
console.log(summary);
