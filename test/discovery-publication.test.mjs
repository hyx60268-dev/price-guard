import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { decrypt,encrypt } from '../scripts/lib/crypto.mjs';
import { publishStoredDiscovery,recurateMerchantDiscovery } from '../scripts/lib/discovery-publication.mjs';

const exec=promisify(execFile),password='discovery-publication-test';
const sourceRoot=fileURLToPath(new URL('../',import.meta.url));
const merchant={key:'yahoo:p59959877',id:'p59959877',platform:'yahoo',enabled:true};
const own={id:'z686783784',accountId:'boss-yahoo',sellerId:'p6579087',itemStatus:'SOLD',title:'中国限定 Anker AeroClip 2 ワイヤレスイヤホン 張凌赫 限定ギフトボックス レッド'};
function fixture(){
 const checkedAt=new Date(Date.now()-10*86400000).toISOString();
 const red={id:'z692051952',key:merchant.key+':z692051952',merchant,title:'【中国限定】 Anker ワイヤレスイヤホン 張凌赫 コラボ ギフトボックスセット AeroClip2 レッドイヤホン',price:29900,status:'SOLD',soldAt:checkedAt,firstSeenAt:checkedAt,url:'https://paypayfleamarket.yahoo.co.jp/item/z692051952'};
 const white={...red,id:'fixture-white',key:merchant.key+':fixture-white',title:red.title.replace('レッド','ホワイト'),url:'https://fixture.test/white'};
 const bundle={id:'m57886391722',key:'mercari:378316315:m57886391722',merchant:{key:'mercari:378316315',id:'378316315',platform:'mercari'},title:'みそ様 リクエスト 2件 まとめ商品',status:'SOLD',price:10000,firstSeenAt:checkedAt,components:[{id:'unresolved'}],bundleComplete:false};
 return {dashboard:{checkedAt:new Date().toISOString(),merchantMonitors:[merchant,bundle.merchant].map(m=>({...m,enabled:true})),listingHistory:{'boss-yahoo:z686783784':own},items:[],changes:{total:2,changes:[{id:'notification-event'}]}},
  discovery:{version:22,mode:'merchant_monitor',checkedAt,codeSha:'original-market-scan',configDigest:'unchanged-config',merchantListings:{[red.key]:red,[white.key]:white,[bundle.key]:bundle},merchantPrimaryImages:{},products:[{sourceId:red.id},{sourceId:white.id}],stats:{total:2,details:27,publicImageLookups:5,excludedOwned:0},errors:['prior-market-note'],merchants:[{...merchant,status:'partial'}],changes:{total:3,changes:[{id:'discovery-event'}]}},
  status:{version:22,mode:'merchant_monitor',checkedAt,codeSha:'original-market-scan',total:2,traceField:'preserved'}};
}
const encoded=value=>encrypt(Buffer.from(JSON.stringify(value)),password);
async function temporary(run){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'price-guard-publication-'));
 try{for(const dir of ['state','public/data','data','scripts'])await fs.mkdir(path.join(root,dir),{recursive:true});await run(root)}
 finally{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'price-guard-publication-'));await fs.rm(root,{recursive:true,force:true})}
}
async function seed(root,value=fixture()){
 await fs.writeFile(path.join(root,'state/discovery.json.enc'),encoded(value.discovery));
 await fs.writeFile(path.join(root,'state/discovery-status.json'),JSON.stringify(value.status));
 await fs.writeFile(path.join(root,'state/latest.json.enc'),encoded(value.dashboard));
 return value;
}
const readEncrypted=async file=>JSON.parse(decrypt(await fs.readFile(file),password).toString('utf8'));

test('pure recuration removes the historical own red box and preserves original records, timestamps and changes',()=>{
 const value=fixture(),before=structuredClone(value);
 const updated=recurateMerchantDiscovery(value.discovery,value.dashboard);
 assert.deepEqual(updated.products.map(p=>p.sourceId),['fixture-white']);assert.equal(updated.stats.excludedOwned,1);
 assert.equal(updated.checkedAt,before.discovery.checkedAt);assert.equal(updated.codeSha,before.discovery.codeSha);
 assert.equal(updated.stats.details,27);assert.equal(updated.stats.publicImageLookups,5);
 assert.deepEqual(updated.merchantListings,before.discovery.merchantListings);assert.deepEqual(updated.changes,before.discovery.changes);
 assert.deepEqual(value,before,'curation and bundle expansion must not mutate source records or the dashboard');
});

test('prepare-publication immediately publishes filtering from latest encrypted history without resetting scan notifications',async()=>temporary(async root=>{
 const value=await seed(root),protectedFiles={
  'public/data/latest.json.enc':encoded({changes:{total:2,changes:[{id:'published-event'}]}}),
  'public/data/state.json.enc':encoded(value.dashboard),
  'data/change-summary.json':Buffer.from('{"total":2,"changes":[{"id":"notification-event"}]}'),
  'data/discovery-change-summary.json':Buffer.from('{"total":3,"changes":[{"id":"discovery-event"}]}')
 };
 for(const [name,bytes] of Object.entries(protectedFiles))await fs.writeFile(path.join(root,name),bytes);
 protectedFiles['state/latest.json.enc']=await fs.readFile(path.join(root,'state/latest.json.enc'));
 await fs.copyFile(path.join(sourceRoot,'scripts/prepare-publication.mjs'),path.join(root,'scripts/prepare-publication.mjs'));
 await fs.symlink(path.join(sourceRoot,'scripts/lib'),path.join(root,'scripts/lib'),process.platform==='win32'?'junction':'dir');
 await fs.writeFile(path.join(root,'no-network.mjs'),'globalThis.fetch=()=>{throw new Error("Unexpected market request during publication")};');
 await exec(process.execPath,['--import',pathToFileURL(path.join(root,'no-network.mjs')).href,path.join(root,'scripts/prepare-publication.mjs')],{env:{...process.env,DASHBOARD_PASSWORD:password,GITHUB_SHA:'new-code-not-a-new-market-observation'}});
 const published=await readEncrypted(path.join(root,'public/data/discovery.json.enc'));
 assert.deepEqual(published.products.map(p=>p.sourceId),['fixture-white']);assert.equal(published.stats.excludedOwned,1);
 assert.deepEqual(published.merchantListings,value.discovery.merchantListings);assert.deepEqual(published.changes,value.discovery.changes);
 assert.equal(published.checkedAt,value.discovery.checkedAt);assert.equal(published.codeSha,'original-market-scan');
 assert.deepEqual(await fs.readFile(path.join(root,'state/discovery.json.enc')),await fs.readFile(path.join(root,'public/data/discovery.json.enc')));
 const status=JSON.parse(await fs.readFile(path.join(root,'public/data/discovery-status.json'),'utf8'));
 assert.equal(status.total,1);assert.equal(status.sourceStats.total,1);assert.equal(status.sourceStats.excludedOwned,1);
 assert.equal(status.checkedAt,value.discovery.checkedAt);assert.equal(status.codeSha,'original-market-scan');assert.equal(status.traceField,'preserved');
 for(const [name,bytes] of Object.entries(protectedFiles))assert.deepEqual(await fs.readFile(path.join(root,name)),bytes,name+' must be untouched');
}));

test('a discovery or dashboard decryption failure leaves all existing discovery files unchanged',async()=>{
 for(const corrupt of ['discovery.json.enc','latest.json.enc'])await temporary(async root=>{
  await seed(root);await fs.writeFile(path.join(root,'state',corrupt),Buffer.from('invalid encrypted state'));
  await fs.writeFile(path.join(root,'public/data/discovery.json.enc'),Buffer.from('previous public discovery'));
  await fs.writeFile(path.join(root,'public/data/discovery-status.json'),Buffer.from('previous public status'));
  const paths=['state/discovery.json.enc','state/discovery-status.json','public/data/discovery.json.enc','public/data/discovery-status.json'];
  const before=await Promise.all(paths.map(name=>fs.readFile(path.join(root,name))));
  await assert.rejects(publishStoredDiscovery({root,password}),/加密文件/);
  for(const [index,name] of paths.entries())assert.deepEqual(await fs.readFile(path.join(root,name)),before[index]);
 });
});

test('non-merchant discovery is copied byte-for-byte without reading a dashboard or recalculating its results',async()=>temporary(async root=>{
 const discovery={mode:'other_discovery',checkedAt:'2026-09-01T00:00:00Z',codeSha:'old',products:[{sourceId:'keep'}],changes:{total:8}};
 const bytes=encoded(discovery),status=Buffer.from('{ "mode": "other_discovery", "total": 1, "custom": true }');
 await fs.writeFile(path.join(root,'state/discovery.json.enc'),bytes);await fs.writeFile(path.join(root,'state/discovery-status.json'),status);
 const result=await publishStoredDiscovery({root,password});assert.equal(result.updated,false);
 for(const dir of ['state','public/data']){assert.deepEqual(await fs.readFile(path.join(root,dir,'discovery.json.enc')),bytes);assert.deepEqual(await fs.readFile(path.join(root,dir,'discovery-status.json')),status)}
}));
