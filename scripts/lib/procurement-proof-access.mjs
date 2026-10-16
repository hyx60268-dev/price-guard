import fs from 'node:fs/promises';
import path from 'node:path';
import {decrypt} from './crypto.mjs';
import {initializeYahooRequestAccess} from './yahoo.mjs';
import {mergeYahooRequestAccess,yahooRetryAt} from './yahoo-request-access.mjs';
import {initializeExternalSearchAccess} from './external-images.mjs';
import {mergeExternalSearchAccess} from './search-access.mjs';

// A standalone proof is not a new source-access permission. The controlled
// caller must first restore the shared full state under its normal writer lock.
// Merely having a password, an old fixture or a public target URL is insufficient.
export async function requireRestoredYahooProofAccess({root,password,restored=false,now=Date.now(),initialize=initializeYahooRequestAccess}={}){
 if(restored!==true)throw Error('shared_source_state_not_restored');
 if(!root||typeof password!=='string'||password.length<8)throw Error('shared_source_state_unverifiable');
 let saved;
 try{saved=JSON.parse(decrypt(await fs.readFile(path.join(root,'state','latest.json.enc')),password).toString('utf8'))}
 catch{throw Error('shared_source_state_unverifiable')}
 if(!saved||typeof saved!=='object'||Array.isArray(saved)||!Object.hasOwn(saved,'yahooRequestAccess'))throw Error('shared_source_access_record_missing');
 const initial=mergeYahooRequestAccess(saved.yahooRequestAccess);
 const access=mergeYahooRequestAccess(await initialize({root,password,initial}));
 if(yahooRetryAt(access)>now)throw Error('shared_yahoo_source_hold_active');
 return {restored:true,source:'yahoo'};
}

function strictSearchAccess(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('shared_search_access_record_invalid');
 for(const [provider,hold] of Object.entries(value)){
  const until=Date.parse(hold?.retryUntil);
  if(!['bing','bing_web','duckduckgo'].includes(provider)||!['search_challenge','search_response_unavailable'].includes(hold?.reason)||
   typeof hold?.retryUntil!=='string'||!Number.isFinite(until)||new Date(until).toISOString()!==hold.retryUntil)throw Error('shared_search_access_record_invalid');
 }
 return value;
}
export async function requireRestoredSearchProofAccess({root,password,restored=false,now=Date.now(),initialize=initializeExternalSearchAccess}={}){
 if(restored!==true)throw Error('shared_source_state_not_restored');
 if(!root||typeof password!=='string'||password.length<8)throw Error('shared_source_state_unverifiable');
 const read=async name=>{try{return JSON.parse(decrypt(await fs.readFile(path.join(root,'state',name)),password).toString('utf8'))}catch(error){if(error.code==='ENOENT')return undefined;throw Error('shared_source_state_unverifiable')}};
 const latest=await read('latest.json.enc');
 if(!latest||typeof latest!=='object'||Array.isArray(latest)||!Object.hasOwn(latest,'externalSearchAccess'))throw Error('shared_search_access_record_missing');
 const rows=[strictSearchAccess(latest.externalSearchAccess)],discovery=await read('discovery.json.enc'),dedicated=await read('search-access.json.enc');
 if(discovery!==undefined){
  if(!discovery||typeof discovery!=='object'||Array.isArray(discovery))throw Error('shared_source_state_unverifiable');
  if(Object.hasOwn(discovery,'externalSearchAccess'))rows.push(strictSearchAccess(discovery.externalSearchAccess));
 }
 if(dedicated!==undefined)rows.push(strictSearchAccess(dedicated));
 const initial=mergeExternalSearchAccess(...rows);
 const access=strictSearchAccess(await initialize({root,password,initial}));
 if(Object.values(access).some(hold=>Date.parse(hold.retryUntil)>now))throw Error('shared_search_source_hold_active');
 return {restored:true,source:'external_search'};
}
