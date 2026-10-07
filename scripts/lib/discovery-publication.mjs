import fs from 'node:fs/promises';
import path from 'node:path';
import { decrypt,encrypt } from './crypto.mjs';
import { curateMerchantProducts } from './merchant-curation.mjs';
import { merchantProducts } from './merchant-monitor.mjs';
import { imageCoverage,IMAGE_LOOKUP_VERSION } from './merchant-image-jobs.mjs';

const readOptional=async file=>{try{return await fs.readFile(file)}catch(error){if(error.code==='ENOENT')return null;throw error}};

export function recurateMerchantDiscovery(discovery,dashboard,now=Date.now()){
 if(discovery.mode!=='merchant_monitor')return discovery;
 const configured=new Set((dashboard.merchantMonitors||[]).filter(m=>m.enabled).map(m=>m.key));
 // Bundle expansion and cached fingerprint attachment may mutate their inputs.
 // Derive products from a copy, preserving original observations and dates.
 const records=structuredClone(discovery.merchantListings||{});
 const raw=discovery.merchantListings?merchantProducts(Object.fromEntries(Object.entries(records).filter(([,r])=>configured.has(r.merchant?.key))),now):
  structuredClone(discovery.products||[]).flatMap(p=>p.observations||[p]);
 const curated=curateMerchantProducts(raw,{...structuredClone(dashboard),merchantPrimaryImages:structuredClone(discovery.merchantPrimaryImages||{})});
 return {...discovery,products:curated.products,stats:{...discovery.stats,total:curated.products.length,
  excludedOwned:curated.excludedOwned,mergedListings:curated.mergedListings,images:imageCoverage(curated.products),imagePolicyVersion:IMAGE_LOOKUP_VERSION}};
}

export async function publishStoredDiscovery({root,password,dashboard,now=Date.now()}){
 const state=path.join(root,'state'),publicData=path.join(root,'public','data');
 const source=await readOptional(path.join(state,'discovery.json.enc'));
 if(!source)return {mode:'absent',updated:false};
 if(!password||password.length<8)throw new Error('DASHBOARD_PASSWORD 至少需要 8 个字符');
 const discovery=JSON.parse(decrypt(source,password).toString('utf8'));
 const savedStatus=await readOptional(path.join(state,'discovery-status.json'));
 let sealed=source,status=savedStatus,updated=false;
 if(discovery.mode==='merchant_monitor'){
  const current=dashboard??JSON.parse(decrypt(await fs.readFile(path.join(state,'latest.json.enc')),password).toString('utf8'));
  const priorStatus=savedStatus?JSON.parse(savedStatus.toString('utf8')):{};
  const refreshed=recurateMerchantDiscovery(discovery,current,now);
  sealed=encrypt(Buffer.from(JSON.stringify(refreshed)),password);
  status=Buffer.from(JSON.stringify({...priorStatus,version:refreshed.version,mode:refreshed.mode,
   checkedAt:refreshed.checkedAt,codeSha:refreshed.codeSha??priorStatus.codeSha??null,total:refreshed.products.length,
   sourceStats:refreshed.stats,errors:refreshed.errors||[],merchants:refreshed.merchants||[]}));
  updated=true;
 }
 // Finish every read, decrypt and derivation before any persistent write.
 // This only publishes discovery; scan changes and notifications are untouched.
 await fs.mkdir(publicData,{recursive:true});
 const writes=[fs.writeFile(path.join(publicData,'discovery.json.enc'),sealed)];
 if(status)writes.push(fs.writeFile(path.join(publicData,'discovery-status.json'),status));
 if(updated){writes.push(fs.writeFile(path.join(state,'discovery.json.enc'),sealed));if(status)writes.push(fs.writeFile(path.join(state,'discovery-status.json'),status))}
 await Promise.all(writes);
 return {mode:discovery.mode,updated};
}
