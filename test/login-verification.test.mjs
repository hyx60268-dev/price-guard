import test from 'node:test';
import assert from 'node:assert/strict';
import { captureVerifiedSession } from '../scripts/lib/login-verification.mjs';
const state=token=>({cookies:[{domain:'.goofish.com',name:'session',value:token}],origins:[{origin:'https://www.goofish.com',indexedDB:[{name:'auth',version:1,stores:[]}]}]});
test('both login capture paths retain IndexedDB and the state refreshed by a real detail read',async()=>{
 const calls=[];let refreshed=false;
 const context={storageState:async options=>{calls.push(options);return state(refreshed?'after':'before')}};
 const actual=await captureVerifiedSession(context,async()=>{refreshed=true});
 assert.deepEqual(calls,[{indexedDB:true},{indexedDB:true}]);assert.equal(actual.cookies[0].value,'after');assert.equal(actual.origins[0].indexedDB.length,1);
});
test('failed authentication or a challenge cannot produce a new session snapshot',async()=>{
 let reads=0;const context={storageState:async()=>{reads++;return state('before')}};
 await assert.rejects(captureVerifiedSession(context,async()=>{throw Error('challenge')}),/challenge/);assert.equal(reads,1);
});
test('missing session cookies before or after verification stop capture',async()=>{
 let verified=false;
 await assert.rejects(captureVerifiedSession({storageState:async()=>({cookies:[]})},async()=>{verified=true}),/Cookie/);assert.equal(verified,false);
 let reads=0;await assert.rejects(captureVerifiedSession({storageState:async()=>++reads===1?state('before'):{cookies:[]}},async()=>{}),/丢失/);
});
