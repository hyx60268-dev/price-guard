import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {canonicalRetryAfter,createPersistentSourceAccessHold,sourceHoldDeadline,sourceAccessHoldFromCheckpoint} from '../scripts/lib/source-access-hold.mjs';

const START=Date.parse('2026-10-16T00:00:00Z'),fallbackMs=3600000;
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'source-hold-')),filename=path.join(root,'state','rakuma-request-access.json');
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let clock=START;
 const create=(options={})=>createPersistentSourceAccessHold({filename,source:'rakuma',fallbackMs,now:()=>clock,...options});
 return {filename,create,setTime:value=>{clock=value},read:()=>JSON.parse(fs.readFileSync(filename,'utf8'))};
}
const denied=(retryAfter='180',httpStatus=429)=>({httpStatus,retryAfter});
const unavailable=error=>error.code==='SOURCE_ACCESS_STATE_UNAVAILABLE';

test('an absent checkpoint is empty and a denial persists only minimal original provenance',t=>{
 const f=fixture(t),store=f.create();assert.equal(store.active(),null);assert.equal(fs.existsSync(f.filename),false);
 const hold=store.block({...denied(),url:'https://private.example/item',body:'private response',cookie:'secret'});
 assert.deepEqual(hold,{httpStatus:429,retryAfter:'180',observedAt:new Date(START).toISOString(),retryAt:START+180000,holdReason:'retry_after'});
 assert.deepEqual(f.read(),{version:1,source:'rakuma',hold});assert.deepEqual(f.create().active(),hold);
 assert.equal(fs.existsSync(f.filename+'.pending'),false);assert.deepEqual(fs.readdirSync(path.dirname(f.filename)),['rakuma-request-access.json']);
 assert.equal(fs.statSync(f.filename).mode&0o777,0o600);
 assert.doesNotMatch(JSON.stringify(f.read()),/private|cookie|secret/);
 hold.retryAt=0;assert.equal(store.active().retryAt,START+180000);
});

for(const [label,header,deadline] of [
 ['numeric','3600',START+3600000],['HTTP-date',new Date(START+7200000).toUTCString(),START+7200000],
 ['fractional','1.5',START+1500],['beyond timer range','2147484',START+2147484000],
 ['unsafe finite','99999999999999999',Infinity],['overflow','9'.repeat(400),Infinity]
])test(`restored ${label} Retry-After is honored in full without shifting the observation`,t=>{
 const f=fixture(t),hold=f.create().block(denied(header));
 f.setTime(START+1000);const restored=f.create();assert.deepEqual(restored.active(),hold);
 assert.equal(sourceHoldDeadline(hold),deadline);assert.equal(hold.retryAfter,header);assert.equal(hold.observedAt,new Date(START).toISOString());
 if(Number.isFinite(deadline)){f.setTime(deadline-1);assert.notEqual(restored.active(),null);f.setTime(deadline);assert.equal(restored.active(),null);assert.deepEqual(restored.snapshot(),hold)}
 else {f.setTime(START+100*365*86400000);assert.notEqual(restored.active(),null);assert.equal(f.read().hold.retryAt,'indefinite')}
});
for(const header of [null,'','bad header','0','-1',new Date(START-1000).toUTCString()])test(`unusable Retry-After ${JSON.stringify(header)} uses explicit internal fallback policy`,t=>{
 const f=fixture(t),hold=f.create().block(denied(header,403));
 assert.equal(hold.retryAt,START+fallbackMs);assert.equal(hold.holdReason,'internal_fallback');
 f.setTime(START+fallbackMs-1);assert.notEqual(f.create().active(),null);f.setTime(START+fallbackMs);assert.equal(f.create().active(),null);
});

test('canonicalization removes arbitrary comments and does not persist private header text',()=>{
 assert.equal(canonicalRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT (private comment)'),'Wed, 21 Oct 2015 07:28:00 GMT');
 assert.equal(canonicalRetryAfter('private header'),null);
});

test('shorter later denials and restored snapshots never shorten a hold or re-date original provenance',t=>{
 const f=fixture(t),first=f.create(),other=f.create(),long=first.block(denied('3600'));
 f.setTime(START+10000);assert.deepEqual(other.block(denied('60',403)),long);assert.deepEqual(first.active(),long);
 f.setTime(START+20000);const extended=other.block(denied('7200',401));
 assert.equal(extended.httpStatus,401);assert.equal(extended.retryAt,START+7220000);
 assert.deepEqual(first.active(),extended);assert.deepEqual(f.read().hold,extended);
});

test('a successful observation after expiration can establish a new hold without reusing old time',t=>{
 const f=fixture(t),store=f.create();store.block(denied('1'));
 f.setTime(START+1000);assert.equal(store.active(),null);
 const next=store.block(denied('180'));assert.equal(next.observedAt,new Date(START+1000).toISOString());assert.equal(next.retryAt,START+181000);
});

for(const corrupt of ['not-json','null','{}',JSON.stringify({version:2,source:'rakuma',hold:null}),JSON.stringify({version:1,source:'other',hold:null}),JSON.stringify({version:1,source:'rakuma',hold:{httpStatus:429,retryAt:0}})])test(`corrupt checkpoint fails closed and remains untouched (${corrupt})`,t=>{
 const f=fixture(t);fs.mkdirSync(path.dirname(f.filename));fs.writeFileSync(f.filename,corrupt);
 const store=f.create();assert.throws(()=>store.active(),unavailable);assert.equal(fs.readFileSync(f.filename,'utf8'),corrupt);
 fs.unlinkSync(f.filename);assert.throws(()=>store.active(),unavailable,'failure stays latched in this worker');
});

test('malformed provenance or a shortened server hold fails validation even if the deadline looks valid',t=>{
 const f=fixture(t),hold=f.create().block(denied('3600'));
 for(const changed of [{observedAt:'garbage'},{retryAt:START+10000},{holdReason:'internal_fallback'},{retryAfter:[]},{httpStatus:500}]){
  fs.writeFileSync(f.filename,JSON.stringify({version:1,source:'rakuma',hold:{...hold,...changed}}));
  assert.throws(()=>f.create().active(),unavailable);
 }
});

for(const operation of ['readFileSync','mkdirSync','openSync','writeFileSync','fsyncSync','renameSync','unlinkSync'])test(`filesystem ${operation} failure blocks the worker and never replaces the old hold with an empty state`,t=>{
 const f=fixture(t),original=f.create().block(denied('180')),before=fs.readFileSync(f.filename,'utf8');
 const io={...fs,[operation](){throw Object.assign(Error('fixture I/O failure'),{code:'EACCES'})}},store=f.create({io});
 assert.throws(()=>store.block(denied('3600')),unavailable);assert.throws(()=>store.active(),unavailable);
 assert.ok(sourceHoldDeadline(store.observed())>=sourceHoldDeadline(original));
 if(operation!=='unlinkSync')assert.equal(fs.readFileSync(f.filename,'utf8'),before);
 if(!['readFileSync','mkdirSync','openSync'].includes(operation)){
  assert.equal(fs.existsSync(f.filename+'.pending'),true,'checkpoint failure leaves a restart-safe fail-closed marker');
  assert.throws(()=>f.create().active(),unavailable);
 }
});

test('an incomplete/concurrent checkpoint cannot be overwritten or treated as absence on restart',t=>{
 const f=fixture(t);fs.mkdirSync(path.dirname(f.filename),{recursive:true});fs.writeFileSync(f.filename+'.pending','');
 assert.throws(()=>f.create().active(),unavailable);assert.throws(()=>f.create().block(denied()),unavailable);
 assert.equal(fs.existsSync(f.filename),false);assert.equal(fs.existsSync(f.filename+'.pending'),true);
});


test('staged artifact checkpoint extraction validates its envelope before exposing a mergeable snapshot',t=>{
 const f=fixture(t),hold=f.create().block(denied('3600'));
 assert.deepEqual(sourceAccessHoldFromCheckpoint(f.read(),'rakuma'),hold);
 for(const value of [null,{}, {version:1,source:'rakuma'}, {version:1,source:'yahoo',hold}, {version:2,source:'rakuma',hold}])
  assert.throws(()=>sourceAccessHoldFromCheckpoint(value,'rakuma'),/Invalid source access state/);
});


test('first checkpoint merges its initial published hold even before an explicit snapshot read',t=>{
 const f=fixture(t),long=f.create().block(denied('3600'));fs.unlinkSync(f.filename);
 f.setTime(START+1000);
 const store=f.create({initial:long});assert.deepEqual(store.block(denied('60',403)),long);assert.deepEqual(f.read().hold,long);
});
