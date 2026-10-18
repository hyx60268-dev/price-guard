import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {decrypt} from './lib/crypto.mjs';
import {validateComparisonAuditReceipt} from './lib/comparison-audit-state.mjs';

// Independent readback only. No state writes, receipt initialization/consumption,
// marketplace reads, credentials in requests, redirects, or retry loops.
const PUBLISHED_STATE='https://hyx60268-dev.github.io/price-guard/data/state.json.enc';
const MAX_BYTES=32*1024*1024,TIMEOUT_MS=10_000;
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=reason=>{throw Object.assign(new Error(reason),{receiptReason:reason});};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const SAFE_REASONS=new Set(['invalid_options','missing_dashboard_key','state_unreadable','state_too_large','state_decryption_failed','state_json_invalid','state_metadata_invalid','receipt_invalid','expected_code_sha_required','local_code_sha_mismatch','published_revision_mismatch','published_receipt_mismatch','published_http_denied','published_http_error','published_body_unavailable','published_body_too_large','published_network','published_timeout']);

function inspect(bytes,password,now){
 if(bytes.length>MAX_BYTES)fail('state_too_large');
 let plaintext,state,receipt;
 try{plaintext=decrypt(bytes,password);}catch{fail('state_decryption_failed');}
 try{state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext));}catch{fail('state_json_invalid');}
 if(!plain(state)||!Array.isArray(state.items)||!sha(state.scanMeta?.codeSha)||!iso(state.checkedAt)||Date.parse(state.checkedAt)>now||!iso(state.dataRevision)||Date.parse(state.dataRevision)>now)fail('state_metadata_invalid');
 try{receipt=validateComparisonAuditReceipt(state.comparisonAuditReceipt,{now});}catch{fail('receipt_invalid');}
 return {receipt,codeSha:state.scanMeta.codeSha,revision:{checkedAt:state.checkedAt,dataRevision:state.dataRevision,finishedAt:state.cycleCoverage?.finishedAt??null}};
}

async function readLocal(filename){
 try{const stat=await fs.stat(filename);if(!stat.isFile())fail('state_unreadable');if(stat.size>MAX_BYTES)fail('state_too_large');return await fs.readFile(filename);}
 catch(error){if(SAFE_REASONS.has(error?.receiptReason))throw error;fail('state_unreadable');}
}

async function readPublished(fetchImpl,timeoutMs,onStart){
 const controller=new AbortController();let reader,response,timer;
 const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(new Error('timeout'),{receiptReason:'published_timeout'}));},timeoutMs);});
 const read=async()=>{
  onStart();
  try{response=await fetchImpl(PUBLISHED_STATE,{redirect:'error',cache:'no-store',headers:{'cache-control':'no-cache',pragma:'no-cache'},signal:controller.signal});}
  catch{fail(controller.signal.aborted?'published_timeout':'published_network');}
  if(controller.signal.aborted)fail('published_timeout');
  if(!response.ok)fail([401,403,429].includes(response.status)?'published_http_denied':'published_http_error');
  const length=response.headers?.get('content-length');
  if(length&&/^\d+$/.test(length)&&Number(length)>MAX_BYTES)fail('published_body_too_large');
  reader=response.body?.getReader();if(!reader)fail('published_body_unavailable');
  const chunks=[];let size=0;
  for(;;){const row=await reader.read();if(controller.signal.aborted)fail('published_timeout');if(row.done)break;size+=row.value.byteLength;if(size>MAX_BYTES)fail('published_body_too_large');chunks.push(row.value);}
  return Buffer.concat(chunks,size);
 };
 try{return await Promise.race([read(),expired]);}
 catch(error){if(SAFE_REASONS.has(error?.receiptReason))throw error;fail(controller.signal.aborted?'published_timeout':'published_network');}
 finally{clearTimeout(timer);controller.abort();try{void (reader?reader.cancel():response?.body?.cancel())?.catch(()=>{});}catch{}}
}

export async function checkComparisonAuditReceipt({root,password,mode='restored',expectedCodeSha,fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=TIMEOUT_MS}={}){
 let networkRequests=0;
 const base={version:1,readOnly:true,mode:['restored','published'].includes(mode)?mode:'invalid'};
 try{
  if(typeof root!=='string'||!path.isAbsolute(root)||!['restored','published'].includes(mode)||typeof now!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>TIMEOUT_MS)fail('invalid_options');
  if(typeof password!=='string'||password.length<8)fail('missing_dashboard_key');
  const observedAt=now();if(!Number.isFinite(observedAt))fail('invalid_options');
  if(mode==='published'&&!sha(expectedCodeSha))fail('expected_code_sha_required');
  const filename=mode==='published'?path.join(root,'public/data/state.json.enc'):path.join(root,'state/latest.json.enc');
  const expected=inspect(await readLocal(filename),password,observedAt);
  if(mode==='published'){
   if(expected.codeSha!==expectedCodeSha)fail('local_code_sha_mismatch');
   if(!iso(expected.revision.finishedAt)||Date.parse(expected.revision.finishedAt)>observedAt)fail('state_metadata_invalid');
   const published=inspect(await readPublished(fetchImpl,timeoutMs,()=>networkRequests++),password,observedAt);
   if(published.codeSha!==expectedCodeSha||hash(published.revision)!==hash(expected.revision))fail('published_revision_mismatch');
   if(hash(published.receipt)!==hash(expected.receipt))fail('published_receipt_mismatch');
  }
  const verifiedAt=now();if(!Number.isFinite(verifiedAt)||verifiedAt<observedAt)fail('invalid_options');
  // Same-SHA historical local/public artifacts can agree. This establishes
  // receipt parity, not cache lineage, a fresh scan, or complete replay history.
  return {...base,valid:true,evidenceScope:mode==='published'?'local_publication_receipt_parity':'restored_receipt_validation',codeSha:expected.codeSha,receipt:{version:expected.receipt.version,revision:expected.receipt.revision,consumedCount:expected.receipt.consumed.length},networkRequests,diagnosticObservedAt:new Date(verifiedAt).toISOString()};
 }catch(error){return {...base,valid:false,reason:SAFE_REASONS.has(error?.receiptReason)?error.receiptReason:'invalid_options',networkRequests};}
}

export async function runReceiptCheckCli({args=process.argv.slice(2),env=process.env,root=fileURLToPath(new URL('..',import.meta.url)),write=line=>console.log(line)}={}){
 const validArgs=args.length===0||(args.length===1&&args[0]==='--published');
 const report=await checkComparisonAuditReceipt({root,password:env.DASHBOARD_PASSWORD,mode:validArgs?(args.length?'published':'restored'):'invalid',expectedCodeSha:env.GITHUB_SHA});
 write('[COMPARISON AUDIT RECEIPT] '+JSON.stringify(report));
 return report.valid?0:1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)process.exitCode=await runReceiptCheckCli();
