import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundSimilarity,coherentIndependentImages,fingerprintSimilarity,imageFingerprints,imageSetSimilarity } from '../scripts/lib/image.mjs';

const image=color=>`data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22100%22%3E%3Crect width=%22100%22 height=%22100%22 fill=%22${color}%22/%3E%3C/svg%3E`;

test('multi-fingerprint similarity rewards the same image and notices a color-only mismatch',async()=>{
  const red=await imageFingerprints(image('red')),same=await imageFingerprints(image('red')),blue=await imageFingerprints(image('blue'));
  assert.equal(fingerprintSimilarity(red,same),1);
  assert.ok(fingerprintSimilarity(red,blue)<.85);
  assert.equal(imageSetSimilarity([red],[blue,same]),1);
});
test('selects coherent real photos while excluding copied source images',()=>{
  const source={url:'source',dHash:'0000000000000000',aHash:'0000000000000000',centerHash:'0000000000000000',color:[230,230,230],background:[230,230,230],backgroundSpread:[10,10,10],aspectRatio:1};
  const copied={...source,url:'copied'};
  const a={url:'a',dHash:'ffffffffffffffff',aHash:'ffffffffffffffff',centerHash:'ffffffffffffffff',color:[200,190,180],background:[240,235,230],backgroundSpread:[12,11,10],aspectRatio:1};
  const b={...a,url:'b',dHash:'ffffffffffffff00'};
  assert.ok(backgroundSimilarity(a,b)>.9);
  assert.deepEqual(coherentIndependentImages([copied,a,b],[source],2),['a','b']);
});
