import test from 'node:test';
import assert from 'node:assert/strict';
import {xianyuAccessObservation} from '../scripts/lib/xianyu-access.mjs';
test('source cooldown logs project only original atomic public operational fields',()=>{
 const input={allowed:false,reason:'login_required',retryAt:'2026-10-16T20:08:03.647Z',failures:4};
 assert.deepEqual(xianyuAccessObservation(input),input);assert.equal(xianyuAccessObservation(input).retryAt,input.retryAt);
 const malicious={allowed:'yes',reason:{secret:'PRIVATE'},retryAt:{secret:'PRIVATE'},failures:{secret:'PRIVATE'},extra:'PRIVATE'};
 const before=structuredClone(malicious),logged=xianyuAccessObservation(malicious);
 assert.deepEqual(logged,{allowed:false,reason:null,retryAt:null,failures:null});assert.deepEqual(malicious,before);
 assert.doesNotMatch(JSON.stringify(logged),/PRIVATE/);
 for(const retryAt of ['not a time','2026-10-16 (PRIVATE)',null,Infinity])assert.equal(xianyuAccessObservation({retryAt}).retryAt,null);
});
