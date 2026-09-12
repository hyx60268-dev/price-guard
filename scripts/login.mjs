import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const authDir=path.join(root,'.auth'); await fs.mkdir(authDir,{recursive:true});
const rl=readline.createInterface({input:process.stdin,output:process.stdout});
const browser=await chromium.launch({headless:false});
try{
  const context=await browser.newContext({locale:'ja-JP',timezoneId:'Asia/Tokyo'});
  const yahoo=await context.newPage(); await yahoo.goto('https://paypayfleamarket.yahoo.co.jp/');
  await rl.question('请在打开的页面完成 Yahoo 登录，然后按回车：');
  await context.storageState({path:path.join(authDir,'yahoo.json')});
  const xianyu=await context.newPage(); await xianyu.goto('https://www.goofish.com/');
  await rl.question('请完成闲鱼登录，然后按回车：');
  await context.storageState({path:path.join(authDir,'xianyu.json')});
  for(const name of ['yahoo','xianyu']){
    const raw=await fs.readFile(path.join(authDir,`${name}.json`));
    await fs.writeFile(path.join(authDir,`${name}.b64`),raw.toString('base64'));
  }
  console.log('完成：.auth 文件夹内的两个 .b64 文件用于设置 GitHub Secrets。');
}finally{await browser.close();rl.close();}
