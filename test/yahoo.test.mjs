import test from 'node:test';
import assert from 'node:assert/strict';
import { extractNextData } from '../scripts/lib/yahoo.mjs';

test('extractNextData accepts Yahoo nonce attribute',()=>{
  const value={props:{initialState:{searchState:{search:{result:{items:[]}}}}}};
  const html=`<html><script id="__NEXT_DATA__" type="application/json" nonce="">${JSON.stringify(value)}</script></html>`;
  assert.deepEqual(extractNextData(html),value);
});

test('extractNextData rejects a challenge page',()=>{
  assert.throws(()=>extractNextData('<html>challenge</html>'),/__NEXT_DATA__/);
});
