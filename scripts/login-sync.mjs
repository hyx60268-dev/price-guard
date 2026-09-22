import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import zlib from 'node:zlib';
import { spawn,spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { xianyuCost } from './lib/xianyu.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const authDir=path.join(root,'.auth');
const authFile=path.join(authDir,'xianyu.json');
const repository='hyx60268-dev/price-guard';
await fs.mkdir(authDir,{recursive:true});
const rl=readline.createInterface({input:process.stdin,output:process.stdout});

function run(command,args,options={}){
  const result=spawnSync(command,args,{cwd:root,encoding:'utf8',stdio:options.input===undefined?'inherit':['pipe','inherit','inherit'],input:options.input});
  if(result.error?.code==='ENOENT')return {missing:true,status:127};
  if(result.status!==0)throw new Error(`${command} ${args.join(' ')} 执行失败`);
  return result;
}

async function verifyRealCost(context){
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
      const result=await xianyuCost(page,item,{...settings,maxXianyuDetailChecks:8,maxXianyuSamples:5});
      console.log(`状态 ${result.status}；候选 ${result.cardCount||0}；核验通过 ${result.verifiedCount||0}`);
      // 这里验证的是“登录会话确实能读到真实搜索与详情”，不是直接批准成本。
      // 正式扫描仍由 xianyuCost 要求至少两个独立卖家的同款价格样本。
      // 若把登录同步也绑定到两个样本，会让有效登录因冷门商品只有一个卖家而无法上传。
      if((result.cardCount||0)>0&&(result.verifiedCount||0)>=1){
        console.log(`登录会话验证成功：${result.cardCount} 个真实候选，${result.verifiedCount} 个详情严格通过。`);
        return {item,result};
      }
    }
  }finally{await page.close().catch(()=>{})}
  throw new Error('登录虽成功，但测试商品尚未取得任何严格核验通过的闲鱼详情；已停止同步。');
}

const browser=await chromium.launch({headless:false});
try{
  const context=await browser.newContext({locale:'zh-CN',timezoneId:'Asia/Tokyo'});
  const page=await context.newPage();
  await page.goto('https://www.goofish.com/');
  console.log('\n请在打开的浏览器登录闲鱼，并搜索任意商品确认能看到真实结果。');
  await rl.question('确认后回到这里按回车，程序会先测试真实成本，再同步 GitHub：');
  await context.storageState({path:authFile});
  await verifyRealCost(context);

  const raw=await fs.readFile(authFile);
  const encoded=zlib.gzipSync(raw,{level:9}).toString('base64');
  const size=Math.ceil(encoded.length/3);
  const parts=[encoded.slice(0,size),encoded.slice(size,size*2),encoded.slice(size*2)];

  const gh=run('gh',['--version']);
  if(gh.missing){
    console.error('\n没有检测到 GitHub CLI。请先安装：https://cli.github.com/');
    console.error('安装后重新运行 npm run login:sync；无需重新修改代码。');
    process.exitCode=2;
  }else{
    const auth=spawnSync('gh',['auth','status'],{cwd:root,stdio:'inherit'});
    if(auth.status!==0){
      console.log('\n请在接下来的 GitHub 官方窗口完成一次授权。');
      run('gh',['auth','login','--web','--hostname','github.com']);
    }
    for(let index=0;index<3;index++){
      run('gh',['secret','set',`XIANYU_AUTH_PART_${index+1}`,'--repo',repository],{input:parts[index]});
    }
    run('gh',['workflow','run','price-guard.yml','--repo',repository]);
    console.log('\n同步完成，已触发线上扫描。登录内容未打印、未写入 Git 仓库。');
  }
}finally{
  await browser.close().catch(()=>{});
  rl.close();
}
