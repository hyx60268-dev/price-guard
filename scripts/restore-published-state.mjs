import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decrypt,encrypt } from './lib/crypto.mjs';
import { reconcileDurableState } from './lib/state.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'..');
const password=process.env.DASHBOARD_PASSWORD;
if(!password||password.length<8)throw new Error('DASHBOARD_PASSWORD 至少需要 8 个字符');
const repository=process.env.GITHUB_REPOSITORY||'';
const [owner,name]=repository.split('/');
const base=(process.env.PUBLISHED_BASE_URL||`https://${owner}.github.io/${name}/data`).replace(/\/$/,'');
const stateDir=path.join(root,'state');
await fs.mkdir(stateDir,{recursive:true});

async function localJson(filename){
  try{return JSON.parse(decrypt(await fs.readFile(path.join(stateDir,filename)),password).toString('utf8'))}catch{return null}
}
async function remoteBytes(filename){
  try{
    const response=await fetch(`${base}/${filename}?restore=${Date.now()}`,{headers:{'cache-control':'no-cache'}});
    return response.ok?Buffer.from(await response.arrayBuffer()):null;
  }catch{return null}
}

const publishedBytes=await remoteBytes('latest.json.enc');
if(publishedBytes){
  try{
    const published=JSON.parse(decrypt(publishedBytes,password).toString('utf8'));
    const cache=await localJson('latest.json.enc')||{};
    const reconciled=reconcileDurableState(cache,published);
    await fs.writeFile(path.join(stateDir,'latest.json.enc'),encrypt(Buffer.from(JSON.stringify(reconciled)),password));
    console.log(`已合并发布状态：${reconciled.managedAccounts?.length||0} 个动态账号，${Object.keys(reconciled.manualCosts||{}).length} 条成本`);
  }catch(error){console.warn(`发布状态校验失败，沿用缓存：${String(error)}`)}
}else console.log('尚无可下载的发布状态，沿用缓存');

for(const filename of ['discovery.json.enc','discovery-status.json']){
  const bytes=await remoteBytes(filename);if(!bytes)continue;
  if(filename.endsWith('.enc')){try{decrypt(bytes,password)}catch{continue}}
  await fs.writeFile(path.join(stateDir,filename),bytes);
}
