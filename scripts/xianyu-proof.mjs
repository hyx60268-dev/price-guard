import fs from 'node:fs/promises';
import path from 'node:path';
import { loadXianyuSession } from './lib/xianyu-session.mjs';
import { openContext } from './lib/browser.mjs';
import { xianyuCost } from './lib/xianyu.mjs';
import { fetchYahooItemBundle } from './lib/yahoo.mjs';

const root=path.resolve(new URL('..',import.meta.url).pathname);
const settings=JSON.parse(await fs.readFile(path.join(root,'config/settings.json'),'utf8'));
const catalog=JSON.parse(await fs.readFile(path.join(root,'config/catalogs/melon.json'),'utf8')).items||[];
const sessionManager=await loadXianyuSession(root);
const stateFile=sessionManager.file;
if(!sessionManager.access().allowed){console.error('[PROOF COOLDOWN]',JSON.stringify(sessionManager.access()));process.exit(1)}
const selected=catalog.filter(item=>item.id==='z667987740');
if(selected.length!==1)throw new Error('指定真实商品不在清单中');
const {browser,context}=await openContext(stateFile);
const page=await context.newPage();
let accepted=0,tested=0;
try{
  for(const item of selected){
    tested++;
    console.log('\n[PROOF ITEM]',item.id,item.xianyuQuery);
    const own=await fetchYahooItemBundle(item.id,settings);
    const result=await xianyuCost(page,{...item,description:own.detail?.description||'',yahoo:{ownDescription:own.detail?.description||'',ownImages:(own.detail?.images||[]).map(image=>typeof image==='string'?image:image.url).filter(Boolean)}},{...settings,maxXianyuDetailChecks:6,maxXianyuSamples:5,onDetailRead:detail=>console.log('[TARGET DETAIL READ]',JSON.stringify(detail))});
    await sessionManager.persist(context,result).catch(()=>console.warn('[闲鱼会话] 更新保存失败，保留原会话'));
    console.log('[PROOF RESULT]',JSON.stringify({id:item.id,status:result.status,accessibleDetailCount:result.accessibleDetailCount,cardCount:result.cardCount,preliminaryCount:result.preliminaryCount,verifiedCount:result.verifiedCount,sellerCount:result.sellerCount,averageCNY:result.averageCNY,samples:result.samples?.map(row=>({url:row.url,price:row.price,priceSource:row.priceSource,detailTitle:row.detailTitle,primaryImageScore:row.primaryImageScore})),rejected:result.rejected}));
    if(result.status==='ok'&&Number.isFinite(result.averageCNY))accepted++;
    if(['blocked','login_required'].includes(result.status)){console.error('[PROOF BLOCKED]',result.diagnostic||result.status);break}
  }
}finally{await browser.close()}
console.log('[PROOF SUMMARY]',JSON.stringify({selected:selected.length,tested,accepted}));
if(!accepted){console.error('闲鱼验收未通过：没有取得可核验的目标详情、多卖家及实价证据。搜索返回卡片不等于成本成功。');process.exitCode=1}
