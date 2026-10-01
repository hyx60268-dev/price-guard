import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import zlib from 'node:zlib';
import { spawn,spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { verifyLoginAccess,captureVerifiedSession } from './lib/login-verification.mjs';

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


const browser=await chromium.launch({headless:false});
try{
  const context=await browser.newContext({locale:'zh-CN',timezoneId:'Asia/Tokyo'});
  const page=await context.newPage();
  await page.goto('https://www.goofish.com/');
  console.log('\n请在打开的浏览器登录闲鱼，并搜索任意商品确认能看到真实结果。');
  await rl.question('确认已登录后回到这里按回车，程序会保存登录状态并同步 GitHub：');
  // Xianyu may keep part of the authenticated browser session in IndexedDB.
  // Saving cookies/localStorage alone can look logged in on the search page but
  // still redirect every item detail to login in the cloud runner.
  const session=await captureVerifiedSession(context,()=>verifyLoginAccess(context,{root}));
  const xianyuCookies=session.cookies.filter(cookie=>/(?:goofish|idlefish)\.com$/i.test(cookie.domain.replace(/^\./,'')));
  await fs.writeFile(authFile,JSON.stringify(session));
  console.log(`闲鱼登录状态已验证并保存：${xianyuCookies.length} 个会话 Cookie，真实商品详情可读取。`);

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
      run('gh',['auth','login','--web','--hostname','github.com','--git-protocol','https','--skip-ssh-key'],{input:'\n'});
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
