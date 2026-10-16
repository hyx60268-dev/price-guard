import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cadenceActivation } from './lib/cadence-window.mjs';
import { cadenceSlot,claimScanAdmission } from './lib/scan-admission.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const mode=process.argv[2]||'admit',env=process.env;
async function output(values){
 console.log('[SCAN ADMISSION]',JSON.stringify(values));
 if(env.GITHUB_OUTPUT)await fs.appendFile(env.GITHUB_OUTPUT,Object.entries(values).map(([key,value])=>`${key}=${value}`).join('\n')+'\n');
}
async function currentMain(){
 if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY||''))throw Error('Invalid repository');
 const response=await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/branches/main`,{headers:{authorization:`Bearer ${env.GITHUB_TOKEN}`,accept:'application/vnd.github+json'},signal:AbortSignal.timeout(20_000)});
 if(!response.ok)throw Error(`Cannot verify current main: HTTP ${response.status}`);
 const sha=(await response.json()).commit?.sha;if(!/^[a-f0-9]{40}$/.test(sha||''))throw Error('Missing current main SHA');return sha;
}
async function activationInput(){
 const config=JSON.parse(await fs.readFile(path.join(root,'config/cadence-validation.json'),'utf8'));
 const event=env.GITHUB_EVENT_PATH?JSON.parse(await fs.readFile(env.GITHUB_EVENT_PATH,'utf8')):{};
 return {event:env.GITHUB_EVENT_NAME,config,message:event.head_commit?.message||'',attempt:env.GITHUB_RUN_ATTEMPT};
}
if(mode==='anchor'){
 const enabled=cadenceActivation(await activationInput());
 if(enabled){
  if(env.GITHUB_REF!=='refs/heads/main'||await currentMain()!==env.GITHUB_SHA)throw Error('Finite cadence must begin on current main');
  await output({enabled:true,epoch:new Date().toISOString(),code_sha:env.GITHUB_SHA});
 }else await output({enabled:false});
}else if(mode==='wait'){
 const slot=cadenceSlot({epoch:env.CADENCE_EPOCH,slot:env.CADENCE_SLOT});
 if(slot.waitMs>20*60_000)throw Error('Refusing unexpectedly long slot wait');
 if(slot.waitMs)await new Promise(resolve=>setTimeout(resolve,slot.waitMs));
 const ready=cadenceSlot({epoch:env.CADENCE_EPOCH,slot:env.CADENCE_SLOT});
 const current=await currentMain();
 if(current!==env.CADENCE_EXPECTED_SHA)throw Error('Obsolete main; stopping the finite window');
 await output({ready:!ready.expired&&current===env.CADENCE_EXPECTED_SHA,reason:ready.expired?'slot_expired':current!==env.CADENCE_EXPECTED_SHA?'obsolete_code':'due'});
}else if(mode==='admit'){
 const expectedSha=env.CADENCE_EXPECTED_SHA||env.GITHUB_SHA;
 const currentSha=await currentMain();
 if(currentSha!==expectedSha||env.GITHUB_SHA!==expectedSha)throw Error('Obsolete main inside writer lock; stopping window');
 // The explicit activation push has one scan owner. Its ordinary push writer
 // may republish UI, but must not race the finite controller's first slot.
 const ownedByCadence=!env.CADENCE_EPOCH&&env.GITHUB_EVENT_NAME==='push'&&cadenceActivation({...await activationInput(),attempt:'1'});
 const decision=ownedByCadence?{admitted:false,reason:'finite_controller_owns_push'}:await claimScanAdmission({root,password:env.DASHBOARD_PASSWORD,epoch:env.CADENCE_EPOCH||'',slot:env.CADENCE_SLOT||'',expectedSha,
  currentSha,runKey:`${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}`,codeSha:env.GITHUB_SHA});
 if(decision.reason==='obsolete_code')throw Error('Obsolete main inside writer lock; stopping window');
 await output(decision);
}else throw Error('Unknown admission mode');
