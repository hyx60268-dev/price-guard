import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { decrypt } from './lib/crypto.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'..');
const password=process.env.DASHBOARD_PASSWORD;
if(!password||password.length<8)throw new Error('DASHBOARD_PASSWORD 至少需要 8 个字符');
const outputDir=path.join(root,'public','data','share-images');
const manifestPath=path.join(root,'state','share-images-manifest.json');
await Promise.all([fs.mkdir(outputDir,{recursive:true}),fs.mkdir(path.dirname(manifestPath),{recursive:true})]);
const previousManifest=await fs.readFile(manifestPath,'utf8').then(JSON.parse).catch(()=>({}));

function safeKey(value=''){
  return String(value).replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,120)||'image';
}

async function encryptedJson(candidates){
  for(const file of candidates){
    try{return JSON.parse(decrypt(await fs.readFile(file),password).toString('utf8'))}catch{}
  }
  return null;
}

async function download(url){
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),12000);
  try{
    const response=await fetch(url,{headers:{'user-agent':'Mozilla/5.0','accept':'image/avif,image/webp,image/*,*/*;q=0.8'},signal:controller.signal});
    if(!response.ok)return null;
    const length=Number(response.headers.get('content-length'));if(Number.isFinite(length)&&length>12_000_000)return null;
    const buffer=Buffer.from(await response.arrayBuffer());return buffer.length<=12_000_000?buffer:null;
  }catch{return null}finally{clearTimeout(timeout)}
}

async function mapLimit(values,limit,worker){
  let cursor=0;
  async function runner(){while(true){const index=cursor++;if(index>=values.length)return;await worker(values[index])}}
  await Promise.all(Array.from({length:Math.min(limit,values.length)},runner));
}

const latest=await encryptedJson([path.join(root,'public','data','latest.json.enc'),path.join(root,'state','latest.json.enc')]);
const discovery=await encryptedJson([path.join(root,'public','data','discovery.json.enc'),path.join(root,'state','discovery.json.enc')]);
const jobs=[];
for(const item of latest?.items||[]){
  const url=item.image||item.yahoo?.ownImages?.[0];if(url)jobs.push({filename:`item-${safeKey(item.id)}.jpg`,url});
}
for(const item of discovery?.products||[]){
  const url=[...(item.sourceImages||[]),...(item.images||[])].find(Boolean);if(url)jobs.push({filename:`discovery-${safeKey(item.id)}.jpg`,url});
}
const unique=[...new Map(jobs.map(job=>[job.filename,job])).values()];
const wanted=new Set(unique.map(job=>job.filename));
for(const entry of await fs.readdir(outputDir,{withFileTypes:true}))if(entry.isFile()&&entry.name.endsWith('.jpg')&&!wanted.has(entry.name))await fs.unlink(path.join(outputDir,entry.name));
const nextManifest={};let downloaded=0,reused=0,failed=0;
await mapLimit(unique,8,async job=>{
  const target=path.join(outputDir,job.filename);
  if(previousManifest[job.filename]===job.url&&await fs.stat(target).then(()=>true).catch(()=>false)){
    nextManifest[job.filename]=job.url;reused++;return;
  }
  const input=await download(job.url);if(!input){failed++;return}
  try{
    const output=await sharp(input).rotate().resize({width:1000,height:1000,fit:'inside',withoutEnlargement:true})
      .flatten({background:'#ffffff'}).jpeg({quality:80,mozjpeg:true}).toBuffer();
    await fs.writeFile(target,output);nextManifest[job.filename]=job.url;downloaded++;
  }catch{failed++}
});
await fs.writeFile(manifestPath,JSON.stringify(nextManifest,null,2));
console.log(`手机搜图图片已准备：新下载 ${downloaded}、复用 ${reused}、失败 ${failed}，共 ${unique.length}`);
