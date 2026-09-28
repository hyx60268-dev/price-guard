import { mergeMerchantConfigs } from '../public/merchant-config.js';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encrypt,decrypt } from './lib/crypto.mjs';
import { openContext } from './lib/browser.mjs';
import { loadXianyuSession } from './lib/xianyu-session.mjs';
import { xianyuCost } from './lib/xianyu.mjs';
import { merchantProfile,qualifiesMerchantItem,recordMerchantObservation,merchantProducts } from './lib/merchant-monitor.mjs';
import { merchantCards,merchantDetail } from './lib/merchant-sources.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const cfg=JSON.parse(await fs.readFile(path.join(root,'config/merchant-monitor.json'),'utf8'));
const settings=JSON.parse(await fs.readFile(path.join(root,'config/settings.json'),'utf8'));
const password=process.env.DASHBOARD_PASSWORD;if(!password||password.length<8)throw Error('需要已配置的仪表盘密码');
for(const p of ['state','public/data','.auth'])await fs.mkdir(path.join(root,p),{recursive:true});
let previous={};try{previous=JSON.parse(decrypt(await fs.readFile(path.join(root,'state/discovery.json.enc')),password))}catch(e){if(e.code!=='ENOENT')throw e}
let dashboard={};try{dashboard=JSON.parse(decrypt(await fs.readFile(path.join(root,'state/latest.json.enc')),password))}catch(e){if(e.code!=='ENOENT')throw e}
cfg.merchants=mergeMerchantConfigs((cfg.merchants||[]).map(raw=>({...merchantProfile(raw),enabled:true})),dashboard.merchantMonitors||[]).filter(m=>m.enabled);
const configDigest=crypto.createHash('sha256').update(JSON.stringify(cfg)).digest('hex');
if(process.env.MERCHANT_MONITOR_IF_DUE==='1'&&previous.mode==='merchant_monitor'&&previous.configDigest===configDigest&&Date.now()-Date.parse(previous.checkedAt||'')<24*3600000){console.log('商家监控未到下次更新时间，保留已发布记录');process.exit(0)}
const merchants=[...new Map((cfg.merchants||[]).map(raw=>{const m=merchantProfile(raw);return [m.key,m]})).values()];
let records=previous.mode==='merchant_monitor'?previous.merchantListings||{}:{};
const errors=[],sources=[],deadline=Date.now()+(Number(cfg.budgetMinutes)||12)*60000;
let browser,context,page,details=0;
async function publicPage(){if(!page){const opened=await openContext();browser=opened.browser;context=opened.context;page=await context.newPage()}return page}
try{
 for(const merchant of merchants){
  if(Date.now()>=deadline){sources.push({...merchant,status:'deferred'});continue}
  try{
   const options={settings,page:merchant.platform==='mercari'?await publicPage():null,maxPages:cfg.maxPagesPerMerchant||10,deadline};
   const result=await merchantCards(merchant,options);
   records=recordMerchantObservation(records,merchant,result.cards);
   const tasks=result.cards.filter(c=>c.price>4999).sort((a,b)=>(Date.parse(records[merchant.key+':'+a.id]?.lastDetailAt)||0)-(Date.parse(records[merchant.key+':'+b.id]?.lastDetailAt)||0));
   let pending=0;
   for(const card of tasks){
    const old=records[merchant.key+':'+card.id];
    if(old.description&&Date.now()-Date.parse(old.lastDetailAt||'')<24*3600000)continue;
    if(Date.now()>=deadline||details>=Number(cfg.maxDetailsPerRun||100)){pending++;continue}
    details++;
    try{const detail=await merchantDetail(merchant,card,options);records=recordMerchantObservation(records,merchant,[{...detail,lastDetailAt:new Date().toISOString()}])}
    catch(e){errors.push(`${merchant.key}/${card.id}: ${String(e)}`);pending++}
   }
   sources.push({...merchant,status:result.complete&&!pending?'ok':'partial',cards:result.cards.length,pages:result.pages,pendingDetails:pending});
  }catch(e){sources.push({...merchant,status:'error'});errors.push(`${merchant.key}: ${String(e)}`)}
 }
}finally{await browser?.close()}
// Image lookups use the same strict detail verifier and persistent challenge
// cooldown as procurement. No search thumbnail is relabelled as a verified image.
let xBrowser,xContext,xPage,imageLookups=0;
const session=await loadXianyuSession(root);
try{
 const allowedKeys=new Set(merchants.map(m=>m.key));
 const pending=Object.values(records).filter(r=>allowedKeys.has(r.merchant.key)&&qualifiesMerchantItem(r)&&r.description&&!r.xianyuImages?.length)
  .sort((a,b)=>(Date.parse(a.imageCheckedAt)||0)-(Date.parse(b.imageCheckedAt)||0));
 for(const item of pending){
  if(Date.now()>=deadline||imageLookups>=Number(cfg.maxImageLookupsPerRun||8)||!session.access().allowed)break;
  if(item.imageCheckedAt&&Date.now()-Date.parse(item.imageCheckedAt)<24*3600000)continue;
  if(!xPage){const opened=await openContext(session.file);xBrowser=opened.browser;xContext=opened.context;xPage=await xContext.newPage()}
  imageLookups++;
  try{
   const cost=await xianyuCost(xPage,{...item,yahoo:{ownDescription:item.description,ownImages:item.images||[item.image].filter(Boolean)}},settings);
   await session.persist(xContext,cost);
   item.imageCheckedAt=new Date().toISOString();item.imageLookupStatus=cost.status;
   const images=(cost.samples||[]).flatMap(sample=>(sample.detailImages||[]).map(url=>({url,sourceUrl:sample.url,sellerKey:sample.sellerKey}))).filter(p=>p.url&&p.sourceUrl);
   if(images.length)item.xianyuImages=images.slice(0,12);
   if(['blocked','login_required'].includes(cost.status))break;
  }catch(e){errors.push(`闲鱼找图 ${item.key}: ${String(e)}`);item.imageLookupStatus='error'}
 }
}finally{await xBrowser?.close()}
const configured=new Set(merchants.map(m=>m.key));
const products=merchantProducts(Object.fromEntries(Object.entries(records).filter(([,r])=>configured.has(r.merchant.key))));
const checkedAt=new Date().toISOString();
const result={version:13,mode:'merchant_monitor',configDigest,checkedAt,codeSha:process.env.GITHUB_SHA||null,merchantListings:records,merchants:sources,products,errors,
 stats:{merchants:merchants.length,total:products.length,details,imageLookups},login:{xianyuRequired:!session.access().allowed}};
const status={version:13,mode:result.mode,checkedAt,total:products.length,sourceStats:result.stats,errors,merchants:sources};
const sealed=encrypt(Buffer.from(JSON.stringify(result)),password);
for(const p of ['state','public/data']){await fs.writeFile(path.join(root,p,'discovery.json.enc'),sealed);await fs.writeFile(path.join(root,p,'discovery-status.json'),JSON.stringify(status))}
console.log(JSON.stringify(status));
