import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintSimilarity,imageFingerprints,imageSetSimilarity } from '../scripts/lib/image.mjs';

const image=color=>`data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22100%22%3E%3Crect width=%22100%22 height=%22100%22 fill=%22${color}%22/%3E%3C/svg%3E`;

test('multi-fingerprint similarity rewards the same image and notices a color-only mismatch',async()=>{
  const red=await imageFingerprints(image('red')),same=await imageFingerprints(image('red')),blue=await imageFingerprints(image('blue'));
  assert.equal(fingerprintSimilarity(red,same),1);
  assert.ok(fingerprintSimilarity(red,blue)<.85);
  assert.equal(imageSetSimilarity([red],[blue,same]),1);
});
