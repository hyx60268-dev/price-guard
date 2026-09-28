import test from 'node:test';
import assert from 'node:assert/strict';
import { syncHandoff,copySyncBody } from '../public/sync-handoff.js';
test('merchant-sized sync includes the exact encrypted body without clipboard access',()=>{
 const body='<!-- PRICE_GUARD_SYNC_V1\nabc-_123\n-->\n完整内容';
 const result=syncHandoff({repo:'owner/repo',username:'admin',body});
 assert.equal(result.prefilled,true);assert.equal(new URL(result.url).searchParams.get('body'),body);
});
test('large sync preserves visible full content instead of pretending an empty issue has the body',()=>{
 const body='x'.repeat(9000),result=syncHandoff({repo:'owner/repo',username:'admin',body});
 assert.equal(result.prefilled,false);assert.equal(result.body,body);assert.equal(new URL(result.url).searchParams.has('body'),false);
});
test('clipboard unavailable and rejected both report failure; success awaits actual write',async()=>{
 assert.equal(await copySyncBody('body',undefined),false);
 assert.equal(await copySyncBody('body',{writeText:async()=>{throw Error('permission denied')}}),false);
 let copied;assert.equal(await copySyncBody('body',{writeText:async text=>{copied=text}}),true);assert.equal(copied,'body');
});
