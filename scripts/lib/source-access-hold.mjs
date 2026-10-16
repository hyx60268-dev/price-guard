import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { retryAfterDeadline } from './request-cooldown.mjs';

const observedDeadline=hold=>hold?.retryAt==='indefinite'?Infinity:hold?.retryAt||0;
export const sourceHoldDeadline=hold=>hold?.stateUnavailable?Infinity:observedDeadline(hold);
export function canonicalRetryAfter(value){
 const raw=String(value??'').trim();
 if(/^\d+(?:\.\d+)?$/.test(raw))return raw;
 const date=Date.parse(raw);
 return raw&&Number.isFinite(date)?new Date(date).toUTCString():null;
}

// Deadlines beyond exact epoch-millisecond representation stay fail-closed.
const serverRetryAt=(header,observedAt)=>{const deadline=retryAfterDeadline(header,observedAt);return deadline>Number.MAX_SAFE_INTEGER?Infinity:deadline};

function validateHold(value){
 if(value===null||value===undefined)return null;
 if(value?.stateUnavailable===true){
  const {stateUnavailable,...observation}=value;
  return {...(Object.keys(observation).length?validateHold(observation):null),stateUnavailable};
 }
 if(!value||typeof value!=='object'||Array.isArray(value)||
   ![401,403,429].includes(value.httpStatus)||
   !(value.retryAfter===null||typeof value.retryAfter==='string'&&canonicalRetryAfter(value.retryAfter)===value.retryAfter)||
   typeof value.observedAt!=='string'||!Number.isFinite(Date.parse(value.observedAt))||
   new Date(value.observedAt).toISOString()!==value.observedAt||
   !(value.retryAt==='indefinite'||typeof value.retryAt==='number'&&Number.isFinite(value.retryAt)&&value.retryAt>Date.parse(value.observedAt))||
   !['retry_after','internal_fallback'].includes(value.holdReason))throw Error('Invalid source access hold');
 const serverDeadline=serverRetryAt(value.retryAfter,Date.parse(value.observedAt));
 if(value.holdReason==='retry_after'&&(serverDeadline===null||sourceHoldDeadline(value)!==serverDeadline)||
   value.holdReason==='internal_fallback'&&serverDeadline!==null)throw Error('Invalid source access hold deadline');
 // Deliberately retain only source status/timing, never URLs, bodies or headers.
 const {httpStatus,retryAfter,observedAt,retryAt,holdReason}=value;
 return {httpStatus,retryAfter,observedAt,retryAt,holdReason};
}
export function mergeSourceAccessHolds(...sources){
 let longest=null,unavailable=false;
 for(const source of sources){
  const hold=validateHold(source);if(!hold)continue;
  unavailable||=hold.stateUnavailable===true;
  if(observedDeadline(hold)>observedDeadline(longest)||observedDeadline(hold)===observedDeadline(longest)&&Date.parse(hold.observedAt)<Date.parse(longest?.observedAt))longest=hold;
 }
 return unavailable?{...longest,stateUnavailable:true}:longest?{...longest}:null;
}

export function sourceAccessHoldFromCheckpoint(value,source){
 if(!value||value.version!==1||value.source!==source||!Object.hasOwn(value,'hold'))throw Error('Invalid source access state');
 return validateHold(value.hold);
}

// The existing workflows serialize state writers and cache the whole state/
// directory. Reads also recheck the local file before admission. A synchronous
// checkpoint makes the observed denial durable before any queued microtask can
// proceed, including headers arriving after the caller's deadline.
export function createPersistentSourceAccessHold({filename,source,fallbackMs,now=()=>Date.now(),io=fs,initial,restore=()=>undefined}={}){
 if(!filename||!source||!Number.isFinite(fallbackMs)||fallbackMs<=0)throw Error('Source access hold configuration required');
 const directory=path.dirname(filename),lock=filename+'.pending';
 let state=null,failure=null,restored=false;
 const fail=cause=>{
  failure??=Object.assign(new Error('Source access state unavailable; requests remain blocked',{cause}),{code:'SOURCE_ACCESS_STATE_UNAVAILABLE'});
  throw failure;
 };
 const read=({writing=false}={})=>{
  if(!writing&&io.existsSync(lock))throw Error('Incomplete source access checkpoint');
  let content;
  try{content=io.readFileSync(filename,'utf8')}catch(error){if(error.code==='ENOENT')return null;throw error}
  return sourceAccessHoldFromCheckpoint(JSON.parse(content),source);
 };
 const refresh=()=>{
  if(failure)throw failure;
  try{
   if(!restored){state=mergeSourceAccessHolds(state,initial,restore());restored=true}
   state=mergeSourceAccessHolds(state,read());
   if(state?.holdReason==='internal_fallback'&&observedDeadline(state)<Date.parse(state.observedAt)+fallbackMs)throw Error('Invalid internal safety hold');
   return state?{...state}:null;
  }catch(error){return fail(error)}
 };
 return {
  snapshot:refresh,
  active(){const hold=refresh();return sourceHoldDeadline(hold)>now()?hold:null},
  // Even after a write failure, diagnostics keep the original observation.
  observed(){return state?{...state}:null},
  block({httpStatus,retryAfter,observedAt=now()}){
   if(failure)throw failure;
   try{
    const header=canonicalRetryAfter(retryAfter),serverDeadline=serverRetryAt(header,observedAt);
    const retryAt=serverDeadline??observedAt+fallbackMs;
    const incoming=validateHold({httpStatus,retryAfter:header,observedAt:new Date(observedAt).toISOString(),
     retryAt:retryAt===Infinity?'indefinite':retryAt,holdReason:serverDeadline===null?'internal_fallback':'retry_after'});
    state=mergeSourceAccessHolds(state,incoming);
    refresh();
    io.mkdirSync(directory,{recursive:true});
    // Exclusive pending marker prevents concurrent writes losing a longer hold.
    // A crash/failed checkpoint leaves it behind, so a restart fails closed.
    const marker=io.openSync(lock,'wx',0o600);io.closeSync(marker);
    const temporary=filename+'.tmp-'+randomUUID();let fd;
    try{
     state=mergeSourceAccessHolds(state,read({writing:true}));
     fd=io.openSync(temporary,'wx',0o600);
     io.writeFileSync(fd,JSON.stringify({version:1,source,hold:state}));io.fsyncSync(fd);io.closeSync(fd);fd=undefined;
     io.renameSync(temporary,filename);
     io.unlinkSync(lock);
    }finally{
     if(fd!==undefined)io.closeSync(fd);
     try{io.unlinkSync(temporary)}catch(error){if(error.code!=='ENOENT')throw error}
    }
    return {...state};
   }catch(error){return fail(error)}
  }
 };
}
