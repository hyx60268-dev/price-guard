import fs from 'node:fs/promises';
import path from 'node:path';
import { xianyuCost } from './xianyu.mjs';
export async function verifyLoginAccess(context,{root,lookup=xianyuCost}={}){
  const settings=JSON.parse(await fs.readFile(path.join(root,'config/settings.json'),'utf8'));
  const catalogsDir=path.join(root,'config/catalogs');
  const files=(await fs.readdir(catalogsDir)).filter(name=>name.endsWith('.json'));
  const items=[];
  for(const file of files){
    const catalog=JSON.parse(await fs.readFile(path.join(catalogsDir,file),'utf8'));
    items.push(...(catalog.items||[]).filter(item=>item.xianyuQuery));
  }
  // 优先核验标题里规格明确的商品，避免单只/套装含糊造成假阳性。
  const selected=[...items].sort((a,b)=>/(?:一对|ペア|セット|BOX|個入り)/i.test(b.title||'')-/(?:一对|ペア|セット|BOX|個入り)/i.test(a.title||'')).slice(0,5);
  const page=await context.newPage();
  try{
    for(const item of selected){
      process.stdout.write(`\n真实成本验证：${item.title}\n`);
      let result;
      try{
        result=await lookup(page,item,{...settings,maxXianyuDetailChecks:8,maxXianyuSamples:5});
      }catch(error){
        console.warn(`本商品核验暂时失败，继续下一个：${String(error?.message||error).split('\\n')[0]}`);
        continue;
      }
      console.log(`状态 ${result.status}；候选 ${result.cardCount||0}；核验通过 ${result.verifiedCount||0}`);
      if(['blocked','login_required'].includes(result.status))throw new Error('当前详情仍要求本人登录或安全验证，已停止会话保存。');
      // 这里验证的是“登录会话确实能读到真实搜索与详情”，不是直接批准成本。
      // 正式扫描仍由 xianyuCost 要求至少两个独立卖家的同款价格样本。
      // 若把登录同步也绑定到两个样本，会让有效登录因冷门商品只有一个卖家而无法上传。
      if((result.cardCount||0)>0&&(result.accessibleDetailCount||0)>0&&!result.loginVisible&&!['login_required','blocked'].includes(result.status)){
        console.log(`登录会话验证成功：已读取 ${result.cardCount} 个真实搜索候选、${result.accessibleDetailCount} 个商品详情；严格同款详情 ${result.verifiedCount||0} 个。`);
        return {item,result};
      }
    }
  }finally{await page.close().catch(()=>{})}
  throw new Error('未能读取真实闲鱼搜索结果；已停止同步。');
}

export async function captureVerifiedSession(context,verify){
 const before=await context.storageState({indexedDB:true});
 const hasCookies=state=>(state.cookies||[]).some(cookie=>/(?:goofish|idlefish)\.com$/i.test(String(cookie.domain||'').replace(/^\./,'')));
 if(!hasCookies(before))throw new Error('未检测到闲鱼登录 Cookie');
 await verify();
 const state=await context.storageState({indexedDB:true});
 if(!hasCookies(state))throw new Error('详情验证后闲鱼登录状态丢失');
 return state;
}
