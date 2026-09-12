import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import zlib from 'node:zlib';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const authDir=path.join(root,'.auth'); await fs.mkdir(authDir,{recursive:true});
const rl=readline.createInterface({input:process.stdin,output:process.stdout});
const browser=await chromium.launch({headless:false});
try{
  const context=await browser.newContext({locale:'zh-CN',timezoneId:'Asia/Tokyo'});
  const page=await context.newPage();
  await page.goto('https://www.goofish.com/');
  console.log('\n只需要登录闲鱼。Yahoo 主页与比价默认使用公开页面，不保存 Yahoo 登录状态。');
  await rl.question('请在浏览器完成闲鱼登录，并确认能搜索到商品与价格，然后回到这里按回车：');
  await context.storageState({path:path.join(authDir,'xianyu.json')});
  const raw=await fs.readFile(path.join(authDir,'xianyu.json'));
  const b64=zlib.gzipSync(raw,{level:9}).toString('base64');
  const n=Math.ceil(b64.length/3);
  const parts=[b64.slice(0,n),b64.slice(n,n*2),b64.slice(n*2)];
  for(let i=0;i<3;i++) await fs.writeFile(path.join(authDir,`XIANYU_AUTH_PART_${i+1}.txt`),parts[i]);
  await fs.writeFile(path.join(authDir,'xianyu.gzip.b64'),b64);
  console.log('\n完成。请把下面三个文件内容分别放进 GitHub Repository secrets：');
  console.log('  XIANYU_AUTH_PART_1 <- .auth/XIANYU_AUTH_PART_1.txt');
  console.log('  XIANYU_AUTH_PART_2 <- .auth/XIANYU_AUTH_PART_2.txt');
  console.log('  XIANYU_AUTH_PART_3 <- .auth/XIANYU_AUTH_PART_3.txt');
  console.log(`总长度 ${b64.length}；三段长度：${parts.map(x=>x.length).join(' / ')}`);
}finally{await browser.close();rl.close();}
