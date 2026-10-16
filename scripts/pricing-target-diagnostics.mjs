import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {decrypt} from './lib/crypto.mjs';
import {pricingTargetDiagnostics} from './lib/pricing-target-diagnostics.mjs';

// Offline: uses only state already restored by the protected production job.
// No marketplace imports, fetches, mutations, new evidence clocks or secrets in logs.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const locations=['state/latest.json.enc','public/data/state.json.enc','public/data/latest.json.enc'];
let input,source;
for(const relative of locations){
  try{input=await fs.readFile(path.join(root,relative));source=relative;break;}
  catch(error){if(error.code!=='ENOENT')throw new Error('Saved pricing diagnostic state could not be read');}
}
if(!input)throw new Error('Saved pricing diagnostic state is unavailable; no source request was attempted');
const password=process.env.DASHBOARD_PASSWORD;
if(!password)throw new Error('Saved pricing diagnostic state requires the existing dashboard key');
let state;
try{state=JSON.parse(decrypt(input,password).toString('utf8'));}
catch{throw new Error('Saved pricing diagnostic state could not be decoded');}
console.log('[目标比价离线诊断]',JSON.stringify(pricingTargetDiagnostics(state,{source})));
