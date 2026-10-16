import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { encrypt,decrypt } from './crypto.mjs';

export const SCAN_INTERVAL_MS=20*60_000;
export const VALIDATION_SLOTS=6;
export const SLOT_LATE_MS=5*60_000;
const stamp=value=>typeof value==='string'?Date.parse(value):NaN;
export function mergeScanAdmission(...records){
 let latest=null;
 for(const row of records){
  if(row==null)continue;
  if(typeof row!=='object'||Array.isArray(row)||row.version!==1||!Number.isFinite(stamp(row.claimedAt))||!/^\d+:\d+$/.test(row.runKey||'')||! /^[a-f0-9]{40}$/.test(row.codeSha||'')||typeof row.slotKey!=='string')throw Error('Invalid scan admission receipt; refusing to reset deduplication');
  if(!latest||stamp(row.claimedAt)>stamp(latest.claimedAt))latest={...row};
 }
 return latest;
}
export function cadenceSlot({epoch,slot,now=Date.now()}={}){
 const start=stamp(epoch),index=Number(slot);
 if(!Number.isFinite(start)||!/^\d$/.test(String(slot))||!Number.isInteger(index)||index<0||index>=VALIDATION_SLOTS)throw Error('Invalid finite cadence slot');
 const dueAt=start+index*SCAN_INTERVAL_MS;
 return {dueAt,expiresAt:dueAt+SLOT_LATE_MS,waitMs:Math.max(0,dueAt-now),expired:now>dueAt+SLOT_LATE_MS,slotKey:`${epoch}:${index}`};
}
export function decideScanAdmission({receipt,previous={},now=Date.now(),epoch='',slot='',expectedSha,currentSha,runKey,codeSha}={}){
 const prior=mergeScanAdmission(receipt,previous.scanAdmission);
 if(!/^\d+:\d+$/.test(runKey||'')||! /^[a-f0-9]{40}$/.test(codeSha||''))throw Error('Missing authenticated workflow run identity');
 if(expectedSha&&(!/^[a-f0-9]{40}$/.test(expectedSha)||currentSha!==expectedSha||codeSha!==expectedSha))return {admitted:false,reason:'obsolete_code'};
 const planned=epoch?cadenceSlot({epoch,slot,now}):null;
 if(planned?.waitMs)return {admitted:false,reason:'slot_not_due'};
 if(planned?.expired)return {admitted:false,reason:'slot_expired'};
 const sameController=planned&&prior?.runKey===runKey&&prior.codeSha===codeSha&&prior.slotKey.startsWith(`${epoch}:`)&&Number(prior.slotKey.split(':').at(-1))<Number(slot);
 const observedStart=stamp(previous.cycleCoverage?.startedAt||previous.scanMeta?.startedAt);
 if(Number.isFinite(observedStart)&&observedStart>now)throw Error('Future source scan start; refusing to reset deduplication');
 const recent=sameController?stamp(prior.claimedAt):Math.max(prior?stamp(prior.claimedAt):0,Number.isFinite(observedStart)?observedStart:0);
 if(recent>now)throw Error('Future scan start/receipt; refusing to reset deduplication');
 if(prior?.slotKey&&planned?.slotKey===prior.slotKey)return {admitted:false,reason:'slot_already_claimed'};
 // Only successive distinct slots of this same controller tolerate startup
 // jitter. Other entrances remain conservative. Actual scan clocks are reported
 // separately and never changed to make the window appear on time.
 const minimumGap=sameController?SCAN_INTERVAL_MS-SLOT_LATE_MS:SCAN_INTERVAL_MS;
 if(recent&&now-recent<minimumGap)return {admitted:false,reason:'recent_scan',nextAllowedAt:new Date(recent+minimumGap).toISOString()};
 return {admitted:true,reason:'due',receipt:{version:1,runKey,codeSha,slotKey:planned?.slotKey||'',claimedAt:new Date(now).toISOString()}};
}
async function readJson(file,{password,encrypted=false}={}){
 try {const bytes=await fs.readFile(file);return JSON.parse(encrypted?decrypt(bytes,password).toString('utf8'):bytes.toString('utf8'))}
 catch(error){if(error.code==='ENOENT')return null;throw Error('Cannot validate scan admission state; refusing to run',{cause:error})}
}
async function atomic(file,bytes){
 await fs.mkdir(path.dirname(file),{recursive:true});const temporary=`${file}.tmp-${randomUUID()}`;
 try{await fs.writeFile(temporary,bytes);await fs.rename(temporary,file)}finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error})}
}
export async function scanAdmissionSnapshot(root){return mergeScanAdmission(await readJson(path.join(root,'state','scan-admission.json')))}
// Called inside the shared pages job lock, after published state restoration.
// The receipt is a deduplication claim, never a source observation or completion.
export async function claimScanAdmission({root,password,...options}){
 if(typeof password!=='string'||password.length<8)throw Error('Dashboard key required to validate current scan state');
 const stateFile=path.join(root,'state','latest.json.enc');
 const previous=await readJson(stateFile,{password,encrypted:true});
 if(!previous||typeof previous!=='object'||Array.isArray(previous))throw Error('Shared full state not restored; refusing to reset scan or source history');
 const decision=decideScanAdmission({...options,previous,receipt:await scanAdmissionSnapshot(root)});
 if(decision.admitted){
  // Failure leaves a conservative claim or stops before any source request.
  await atomic(path.join(root,'state','scan-admission.json'),Buffer.from(JSON.stringify(decision.receipt)));
  await atomic(stateFile,encrypt(Buffer.from(JSON.stringify({...previous,scanAdmission:decision.receipt})),password));
 }
 return decision;
}
