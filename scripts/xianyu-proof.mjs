import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { openContext } from './lib/browser.mjs';
import { xianyuCost } from './lib/xianyu.mjs';

const root=path.resolve(new URL('..',import.meta.url).pathname);
const settings=JSON.parse(await fs.readFile(path.join(root,'config/settings.json'),'utf8'));
const catalog=JSON.parse(await fs.readFile(path.join(root,'config/catalogs/melon.json'),'utf8')).items||[];
const parts=['XIANYU_AUTH_PART_1','XIANYU_AUTH_PART_2','XIANYU_AUTH_PART_3'].map(key=>process.env[key]||'').join('');
let stateFile;
if(parts){
  stateFile=path.join(root,'.auth','xianyu-proof.json');
  await fs.mkdir(path.dirname(stateFile),{recursive:true});
  await fs.writeFile(stateFile,zlib.gunzipSync(Buffer.from(parts,'base64')));
}
const selected=catalog.filter(item=>item.xianyuQuery&&item.image).slice(0,3);
const {browser,context}=await openContext(stateFile);
const page=await context.newPage();
let accepted=0;
try{
  for(const item of selected){
    console.log('\n[PROOF ITEM]',item.id,item.xianyuQuery);
    const result=await xianyuCost(page,item,{...settings,maxXianyuDetailChecks:8,maxXianyuSamples:5,scanDelayMs:800});
    console.log('[PROOF RESULT]',JSON.stringify({id:item.id,status:result.status,cardCount:result.cardCount,preliminaryCount:result.preliminaryCount,verifiedCount:result.verifiedCount,sellerCount:result.sellerCount,averageCNY:result.averageCNY,rejected:result.rejected}));
    if(result.status==='ok'&&Number.isFinite(result.averageCNY))accepted++;
  }
}finally{await browser.close()}
console.log('[PROOF SUMMARY]',JSON.stringify({tested:selected.length,accepted}));
