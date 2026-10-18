import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {decrypt} from './lib/crypto.mjs';
import {summarizeSavedComparisonAudit} from './lib/comparison-audit-summary.mjs';
import {summarizeSavedCardCounterfactual} from './lib/comparison-audit-counterfactual.mjs';

// One fixed, already-published encrypted observation. No marketplace access,
// checkout mutation, scan imports, local state reads/writes or claim operations.
const URL='https://hyx60268-dev.github.io/price-guard/data/state.json.enc';
export const MAX_SAVED_AUDIT_BYTES=128*1024*1024;
const TIMEOUT_MS=10_000;
const REPOSITORY='hyx60268-dev/price-guard';
const BRANCH='fix/read-saved-audit-matrix';
const SAFE_SUMMARY_REASONS=new Set(['invalid_options','state_metadata_invalid','receipt_invalid','audit_metadata_invalid','audit_targets_invalid','audit_time_invalid','audit_rows_invalid','audit_counts_inconsistent','audit_controller_inconsistent','audit_source_inconsistent']);
const SAFE_REASONS=new Set(['invalid_options','untrusted_execution_context','missing_dashboard_key','published_http_denied','published_http_error','published_redirect','published_body_unavailable','published_body_too_large','published_network','published_timeout','state_decryption_failed','state_json_invalid','summary_invalid']);
const fail=reason=>{throw Object.assign(new Error(reason),{diagnosticReason:reason});};
export function savedAuditDiagnosticContext(env={}){
 return env.GITHUB_ACTIONS==='true'&&env.GITHUB_EVENT_NAME==='pull_request'&&env.GITHUB_REPOSITORY===REPOSITORY&&
  env.GITHUB_HEAD_REF===BRANCH&&env.AUDIT_HEAD_REPOSITORY===REPOSITORY&&env.AUDIT_BASE_REF==='main'&&
  env.GITHUB_RUN_ATTEMPT==='1'&&/^[a-f0-9]{40}$/.test(env.AUDIT_HEAD_SHA||'')&&env.CHECKED_OUT_SHA===env.AUDIT_HEAD_SHA;
}
export async function readSavedComparisonAudit({password,env,fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=TIMEOUT_MS,maxBytes=MAX_SAVED_AUDIT_BYTES}={}){
 let networkRequests=0,reader,response,timer,controller;
 const base={version:1,readOnly:true,marketplaceRequests:0,stateWrites:0};
 try{
  if(!savedAuditDiagnosticContext(env))fail('untrusted_execution_context');
  if(typeof password!=='string'||password.length<8)fail('missing_dashboard_key');
  if(typeof fetchImpl!=='function'||typeof now!=='function'||!Number.isFinite(now())||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX_SAVED_AUDIT_BYTES||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>TIMEOUT_MS)fail('invalid_options');
  controller=new AbortController();
  const timedOut=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(Error('timeout'),{diagnosticReason:'published_timeout'}));},timeoutMs);});
  const read=async()=>{
   networkRequests++;
   try{response=await fetchImpl(URL,{method:'GET',credentials:'omit',redirect:'error',cache:'no-store',headers:{'cache-control':'no-cache',pragma:'no-cache'},signal:controller.signal});}
   catch{fail(controller.signal.aborted?'published_timeout':'published_network');}
   if(controller.signal.aborted)fail('published_timeout');
   if(response.redirected||response.url&&response.url!==URL)fail('published_redirect');
   if(!response.ok)fail([401,403,429].includes(response.status)?'published_http_denied':'published_http_error');
   const length=response.headers?.get('content-length');
   if(length&&/^\d+$/.test(length)&&BigInt(length)>BigInt(maxBytes))fail('published_body_too_large');
   reader=response.body?.getReader();if(!reader)fail('published_body_unavailable');
   const chunks=[];let size=0;
   for(;;){const part=await reader.read();if(controller.signal.aborted)fail('published_timeout');if(part.done)break;size+=part.value.byteLength;if(size>maxBytes)fail('published_body_too_large');chunks.push(part.value);}
   return Buffer.concat(chunks,size);
  };
  const bytes=await Promise.race([read(),timedOut]);clearTimeout(timer);timer=null;
  let plain,state;
  try{plain=decrypt(bytes,password);}catch{fail('state_decryption_failed');}
  try{state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));}catch{fail('state_json_invalid');}
  const report=summarizeSavedComparisonAudit(state,{now:now()});
  if(report?.valid!==true)return {...base,valid:false,reason:'summary_invalid',summaryReason:SAFE_SUMMARY_REASONS.has(report?.reason)?report.reason:'unknown_validation_failure',networkRequests};
  const counterfactual=summarizeSavedCardCounterfactual(state,{now:now()});
  if(counterfactual?.valid!==true)return {...base,valid:false,reason:'summary_invalid',summaryReason:'counterfactual_invalid',networkRequests};
  return {...base,valid:true,networkRequests,summary:report,counterfactual};
 }catch(error){return {...base,valid:false,reason:SAFE_REASONS.has(error?.diagnosticReason)?error.diagnosticReason:'summary_invalid',networkRequests};}
 finally{clearTimeout(timer);controller?.abort();try{void (reader?reader.cancel():response?.body?.cancel())?.catch(()=>{});}catch{}}
}
export async function runSavedAuditDiagnosticCli({args=process.argv.slice(2),env=process.env,write=line=>console.log(line),fetchImpl=globalThis.fetch,now=Date.now}={}){
 const result=args.length?{version:1,readOnly:true,valid:false,reason:'invalid_options',networkRequests:0,marketplaceRequests:0,stateWrites:0}:
  await readSavedComparisonAudit({password:env.DASHBOARD_PASSWORD,env,fetchImpl,now});
 write('[SAVED COMPARISON AUDIT SUMMARY] '+JSON.stringify(result));return result.valid?0:1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)process.exitCode=await runSavedAuditDiagnosticCli();
