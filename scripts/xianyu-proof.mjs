import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runXianyuProof } from './lib/xianyu-proof-runner.mjs';
import { loadXianyuSession } from './lib/xianyu-session.mjs';
import { openContext } from './lib/browser.mjs';
import { xianyuCost } from './lib/xianyu.mjs';
import { fetchYahooItemBundle } from './lib/yahoo.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const settings=JSON.parse(await fs.readFile(path.join(root,'config/settings.json'),'utf8'));
const catalog=JSON.parse(await fs.readFile(path.join(root,'config/catalogs/melon.json'),'utf8')).items||[];
const sessionManager=await loadXianyuSession(root);
const stateFile=sessionManager.file;
if(!sessionManager.access().allowed){console.error('[PROOF COOLDOWN]',JSON.stringify(sessionManager.access()));process.exit(1)}
const selected=catalog.filter(item=>item.xianyuQuery&&item.image).slice(0,9);
const {browser,context}=await openContext(stateFile);
const page=await context.newPage();
let summary;
try{
  summary=await runXianyuProof({items:selected,fetchOwn:item=>fetchYahooItemBundle(item.id,settings),
    verify:item=>xianyuCost(page,item,{...settings,maxXianyuDetailChecks:8,maxXianyuSamples:5,scanDelayMs:800}),
    persist:result=>sessionManager.persist(context,result).catch(()=>console.warn('[闲鱼会话] 更新保存失败，保留原会话'))});
}finally{await browser.close()}
console.log('[PROOF SUMMARY]',JSON.stringify(summary));
const accepted=summary.accepted;
if(!accepted){console.error('闲鱼验收未通过：没有取得可核验的目标详情、多卖家及实价证据。搜索返回卡片不等于成本成功。');process.exitCode=1}
