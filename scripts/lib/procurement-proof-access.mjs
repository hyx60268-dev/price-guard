import fs from 'node:fs/promises';
import path from 'node:path';
import {decrypt} from './crypto.mjs';
import {initializeYahooRequestAccess} from './yahoo.mjs';
import {mergeYahooRequestAccess,yahooRetryAt} from './yahoo-request-access.mjs';

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
