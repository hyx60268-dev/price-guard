import fs from 'node:fs/promises';
import { openContext } from './lib/browser.mjs';
import { xianyuCost } from './lib/xianyu.mjs';

const settings=JSON.parse(await fs.readFile(new URL('../config/settings.json',import.meta.url),'utf8'));
const catalog=JSON.parse(await fs.readFile(new URL('../config/catalogs/melon.json',import.meta.url),'utf8'));
const requested=process.argv[2];
const item=catalog.items.find(value=>value.id===requested)||catalog.items.find(value=>value.xianyuQuery);
if(!item)throw new Error('No catalog item with xianyuQuery');
const {browser,context}=await openContext();
try{
  const page=await context.newPage();
  const result=await xianyuCost(page,item,{...settings,maxXianyuDetailChecks:8});
  console.log(JSON.stringify({item:{id:item.id,title:item.title,query:item.xianyuQuery},result},null,2));
  if(result.status!=='ok'||!Number.isFinite(result.averageCNY))process.exitCode=2;
}finally{await browser.close()}
