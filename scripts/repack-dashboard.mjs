import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decrypt,encrypt } from './lib/crypto.mjs';
import { curateMerchantProducts } from './lib/merchant-curation.mjs';
import { merchantProducts } from './lib/merchant-monitor.mjs';
import { writeOutputs } from './lib/publish.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const password=process.env.DASHBOARD_PASSWORD;
if(!password||password.length<8)throw new Error('DASHBOARD_PASSWORD 至少需要 8 个字符');
const file=path.join(root,'state','latest.json.enc');
const result=JSON.parse(decrypt(await fs.readFile(file),password).toString('utf8'));
await writeOutputs({root,result,previous:result,password});
try{
 const discovery=JSON.parse(decrypt(await fs.readFile(path.join(root,'state/discovery.json.enc')),password));
 if(discovery.mode==='merchant_monitor'){
  const configured=new Set((result.merchantMonitors||[]).filter(m=>m.enabled).map(m=>m.key));
  const raw=discovery.merchantListings?merchantProducts(Object.fromEntries(Object.entries(discovery.merchantListings).filter(([,r])=>configured.has(r.merchant.key)))):(discovery.products||[]).flatMap(p=>p.observations||[p]);
  const curated=curateMerchantProducts(raw,{...result,merchantPrimaryImages:discovery.merchantPrimaryImages||{}});discovery.products=curated.products;discovery.stats={...discovery.stats,total:curated.products.length,excludedOwned:curated.excludedOwned,mergedListings:curated.mergedListings};
  await fs.writeFile(path.join(root,'state/discovery.json.enc'),encrypt(Buffer.from(JSON.stringify(discovery)),password));
  await fs.writeFile(path.join(root,'state/discovery-status.json'),JSON.stringify({version:discovery.version,mode:discovery.mode,checkedAt:discovery.checkedAt,total:discovery.products.length,sourceStats:discovery.stats,errors:discovery.errors||[],merchants:discovery.merchants||[]}));
 }
}catch(error){if(error.code!=='ENOENT')throw error}
for(const name of ['discovery.json.enc','discovery-status.json']){
  try{await fs.copyFile(path.join(root,'state',name),path.join(root,'public/data',name))}
  catch(error){if(error.code!=='ENOENT')throw error}
}
const [phone,baseline]=await Promise.all([
  fs.stat(path.join(root,'public','data','latest.json.enc')),
  fs.stat(path.join(root,'public','data','state.json.enc'))
]);
console.log(`仪表盘快速包：${phone.size} bytes；完整后台基准：${baseline.size} bytes`);
