import { initializeExternalSearchAccess,externalSearchAccessSnapshot } from './lib/external-images.mjs';
import { xianyuAccessDiagnostic } from './lib/xianyu-evidence.mjs';
import { merchantRetryDelay,merchantBudget,merchantXianyuAccess } from './lib/merchant-scheduling.mjs';
import { curateMerchantProducts,prepareMerchantVisuals } from './lib/merchant-curation.mjs';
import { isMixedBundle,expandMerchantBundles,resolveMercariBundles } from './lib/merchant-bundles.mjs';
import { allowedMerchantPhotoSource } from '../public/merchant-records.js';
import { runMerchantImageJobs,imageCoverage } from './lib/merchant-image-jobs.mjs';
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
await initializeExternalSearchAccess({root,password});
console.log('[公开搜索访问]',JSON.stringify({stage:'merchant',providers:externalSearchAccessSnapshot()}));
const monitorVersion=21;
const configDigest=crypto.createHash('sha256').update(JSON.stringify({cfg,monitorVersion})).digest('hex');
if(process.env.MERCHANT_MONITOR_IF_DUE==='1'&&previous.mode==='merchant_monitor'&&previous.configDigest===configDigest&&Date.now()-Date.parse(previous.checkedAt||'')<merchantRetryDelay(previous)){console.log('商家监控未到下次更新时间，保留已发布记录');process.exit(0)}
const merchants=[...new Map((cfg.merchants||[]).map(raw=>{const m=merchantProfile(raw);return [m.key,m]})).values()];
let records=previous.mode==='merchant_monitor'?previous.merchantListings||{}:{};
const errors=[],sources=[],deadline=Date.now()+(Number(cfg.budgetMinutes)||12)*60000;
let browser,context,page,details=0;
async function publicPage(){if(!page){const opened=await openContext();browser=opened.browser;context=opened.context;page=await context.newPage()}return page}
try{
 for(const [merchantIndex,merchant] of merchants.entries()){
  if(Date.now()>=deadline){sources.push({...merchant,status:'deferred'});continue}
  const budget=merchantBudget({deadline:deadline-120000,remainingMerchants:merchants.length-merchantIndex,remainingDetails:Number(cfg.maxDetailsPerRun||100)-details});let merchantDetails=0;
  try{
   const options={settings,page:merchant.platform==='mercari'?await publicPage():null,maxPages:cfg.maxPagesPerMerchant||10,deadline:budget.deadline};
   console.log('[商家监控开始]',merchant.key);
   const result=await merchantCards(merchant,options);
   console.log('[商家列表]',merchant.key,'cards='+result.cards.length,'pages='+result.pages,'complete='+result.complete);
   records=recordMerchantObservation(records,merchant,result.cards.filter(c=>Number.isFinite(c.price)));
   const age=c=>{const old=records[merchant.key+':'+c.id];return isMixedBundle(old||c)&&!old?.bundleComplete?-1:(Date.parse(old?.lastDetailAt)||0)};
   const tasks=result.cards.filter(c=>c.price===null||c.price>4999).sort((a,b)=>age(a)-age(b));
   let pending=0;const pendingBundles=new Set();
   for(const card of tasks){
    const old=records[merchant.key+':'+card.id];
    if((!isMixedBundle(old)||old.bundleComplete)&&merchant.name!==merchant.id&&old?.description&&Date.now()-Date.parse(old.lastDetailAt||'')<24*3600000)continue;
    if(Date.now()>=budget.deadline||merchantDetails>=budget.detailLimit){pending++;continue}
    details++;merchantDetails++;
    try{const detail=await merchantDetail(merchant,card,options);if(detail.sellerName)merchant.name=detail.sellerName;records=recordMerchantObservation(records,merchant,[{...detail,lastDetailAt:new Date().toISOString()}]);if(isMixedBundle(detail)&&!detail.bundleComplete)pendingBundles.add(merchant.key+':'+card.id)}
    catch(e){errors.push(`${merchant.key}/${card.id}: ${String(e)}`);pending++}
   }
   resolveMercariBundles(records);
   pending+=[...pendingBundles].filter(key=>!records[key]?.bundleComplete).length;
   sources.push({...merchant,status:result.complete&&!pending?'ok':'partial',cards:result.cards.length,pages:result.pages,pendingDetails:pending});
  }catch(e){sources.push({...merchant,status:'error'});errors.push(`${merchant.key}: ${String(e)}`)}
 }
}finally{await browser?.close()}
// Reconcile explicit bundle contents using every verified detail collected above.
expandMerchantBundles(records);
for(const r of Object.values(records).filter(isMixedBundle))console.log('[集合明细]',JSON.stringify({key:r.key,complete:r.bundleComplete===true,resolved:r.components?.length||0,declared:r.bundleDeclarations?.length||r.components?.length||0,reason:r.bundleResolution||null,unresolved:r.bundleUnresolved||[]}));
dashboard.merchantPrimaryImages=previous.merchantPrimaryImages||{};
const visualProducts=merchantProducts(records);
const merchantPrimaryImages=await prepareMerchantVisuals(visualProducts,dashboard,{deadline:Math.min(deadline-60000,Date.now()+60000)});
dashboard.merchantPrimaryImages=merchantPrimaryImages;
const imageRecords=expandMerchantBundles(records);
for(const r of imageRecords)r.webImages=(r.webImages||[]).filter(p=>allowedMerchantPhotoSource(p.sourceUrl)&&allowedMerchantPhotoSource(p.url));
// Public same-item galleries remain available during an Xianyu cooldown.
const imageLookupKeys=new Set(curateMerchantProducts(merchantProducts(Object.fromEntries(Object.entries(records).filter(([,r])=>merchants.some(m=>m.key===r.merchant.key)))),dashboard).products.map(p=>p.key));
const {attempted:publicImageLookups}=await runMerchantImageJobs(imageRecords.filter(r=>imageLookupKeys.has(r.key)&&qualifiesMerchantItem(r)&&r.description),
 {deadline,log:result=>console.log('[站外找图]',JSON.stringify(result))});
// Image lookups use the same strict detail verifier and persistent challenge
// cooldown as procurement. No search thumbnail is relabelled as a verified image.
let xBrowser,xContext,xPage,imageLookups=0;
const session=await loadXianyuSession(root);
const imageAccess=merchantXianyuAccess(dashboard,session.access());
if(!imageAccess.allowed)console.log('[闲鱼找图暂停]',imageAccess.reason);
try{
 const allowedKeys=new Set(merchants.map(m=>m.key));
 const pending=imageRecords.filter(r=>allowedKeys.has(r.merchant.key)&&imageLookupKeys.has(r.key)&&qualifiesMerchantItem(r)&&r.description&&!r.xianyuImages?.length&&!r.webImages?.length)
  .sort((a,b)=>(Date.parse(a.imageCheckedAt)||0)-(Date.parse(b.imageCheckedAt)||0));
 for(const item of pending){
  if(Date.now()>=deadline||imageLookups>=Number(cfg.maxImageLookupsPerRun||8)||!imageAccess.allowed||!session.access().allowed)break;
  if(item.imageCheckedAt&&Date.now()-Date.parse(item.imageCheckedAt)<24*3600000)continue;
  if(!xPage){const opened=await openContext(session.file);xBrowser=opened.browser;xContext=opened.context;xPage=await xContext.newPage()}
  imageLookups++;
  try{
   const cost=await xianyuCost(xPage,{...item,yahoo:{ownDescription:item.description,ownImages:item.images||[item.image].filter(Boolean)}},settings);
   console.log('[闲鱼找图访问]',item.key,JSON.stringify(xianyuAccessDiagnostic(cost)));
   await session.persist(xContext,cost);
   item.imageCheckedAt=new Date().toISOString();item.imageLookupStatus=cost.status;
   const images=(cost.samples||[]).flatMap(sample=>(sample.detailImages||[]).map(url=>({url,sourceUrl:sample.url,sellerKey:sample.sellerKey}))).filter(p=>p.url&&p.sourceUrl);
   if(images.length)item.xianyuImages=images.slice(0,12);
   if(['blocked','login_required'].includes(cost.status))break;
  }catch(e){errors.push(`闲鱼找图 ${item.key}: ${String(e)}`);item.imageLookupStatus='error'}
 }
}finally{await xBrowser?.close()}
for(const item of imageRecords.filter(r=>r.bundleParentId)){
 const target=records[item.merchant.key+':'+item.bundleParentId]?.components?.find(c=>c.id===item.id);
 if(target)for(const key of ['webImages','xianyuImages','webImageVersion','webImageCheckedAt','webImageStatus','webImageReason','webImageRetryAt','webImageDiagnostics','imageCheckedAt','imageLookupStatus'])if(key in item)target[key]=item[key];
}
for(const expanded of visualProducts){const target=expanded.bundleParentId?records[expanded.merchant.key+':'+expanded.bundleParentId]?.components?.find(c=>c.id===expanded.sourceId):records[expanded.key];if(target)target.primaryFingerprint=merchantPrimaryImages[(expanded.sourceImages||[])[0]]}
const configured=new Set(merchants.map(m=>m.key));
for(const r of Object.values(records)){const source=sources.find(m=>m.key===r.merchant.key);if(source?.name&&source.name!==source.id)r.merchant={...r.merchant,name:source.name}}
const curated=curateMerchantProducts(merchantProducts(Object.fromEntries(Object.entries(records).filter(([,r])=>configured.has(r.merchant.key)))),dashboard);
for(const excluded of curated.reviewedOwnedExclusions)console.log('[已核对自有卡面排除]',JSON.stringify(excluded));
const products=curated.products;
const checkedAt=new Date().toISOString();
const result={externalSearchAccess:externalSearchAccessSnapshot(),version:monitorVersion,merchantPrimaryImages,mode:'merchant_monitor',configDigest,checkedAt,codeSha:process.env.GITHUB_SHA||null,merchantListings:records,merchants:sources,products,errors,
 stats:{merchants:merchants.length,total:products.length,details,imageLookups,publicImageLookups,images:imageCoverage(products),excludedOwned:curated.excludedOwned,mergedListings:curated.mergedListings},login:{xianyuRequired:!session.access().allowed}};
const status={version:monitorVersion,mode:result.mode,checkedAt,codeSha:result.codeSha,total:products.length,sourceStats:result.stats,errors,merchants:sources};
const sealed=encrypt(Buffer.from(JSON.stringify(result)),password);
for(const p of ['state','public/data']){await fs.writeFile(path.join(root,p,'discovery.json.enc'),sealed);await fs.writeFile(path.join(root,p,'discovery-status.json'),JSON.stringify(status))}
console.log(JSON.stringify(status));
