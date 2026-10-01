import test from 'node:test';
import assert from 'node:assert/strict';
import { runMerchantImageJobs,imageCoverage,IMAGE_LOOKUP_VERSION } from '../scripts/lib/merchant-image-jobs.mjs';
import { merchantRetryDelay } from '../scripts/lib/merchant-scheduling.mjs';
import { reviewedProductImages } from '../scripts/lib/reviewed-product-images.mjs';
const complete=reviewedProductImages({title:'【中国限定】Anker AeroClip 2 ワイヤレスイヤホン 張凌赫 コラボ 限定ギフトボックス レッド'});
const now=Date.parse('2026-10-01T13:00:00Z'),photo={url:'https://img.test/a.jpg',sourceUrl:'https://brand.test/product'};

test('bounded image workers recover legacy failures without rescanning verified evidence; one error cannot stop peers',async()=>{
 const items=[{key:'saved',webImages:complete},{key:'old',webImageVersion:2,webImageStatus:'error',webImageRetryAt:new Date(now+86400000).toISOString()},{key:'break'},{key:'third'}];
 let active=0,maxActive=0;const called=[];
 await runMerchantImageJobs(items,{now:()=>now,deadline:now+120000,inspect:async p=>{
  called.push(p.key);active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,5));active--;
  if(p.key==='break')throw Error('transport down');return {photos:complete,status:'verified',reason:'image_match'};
 }});
 assert.equal(maxActive,2);assert.deepEqual(called.sort(),['break','old','third']);assert.equal(items[1].webImageStatus,'verified');assert.equal(items[2].webImageStatus,'error');
 assert.equal(items[1].webImageVersion,IMAGE_LOOKUP_VERSION);assert.equal(items[1].webImageRetryAt,null);
 assert.deepEqual(imageCoverage(items),{total:4,verified:3,partial:0,pending:0,failed:1,unmatched:0,officialReady:3,photosReady:3});
});

test('no image result stays visible and due for retry even with complete merchant profiles',async()=>{
 const items=[{key:'no-match'},{key:'error'},{key:'budget'}];
 await runMerchantImageJobs(items,{now:()=>now,deadline:now+120000,inspect:async p=>({photos:[],status:p.key==='no-match'?'not_found':p.key==='budget'?'deferred':'error',reason:p.key})});
 assert.deepEqual(imageCoverage(items),{total:3,verified:0,partial:0,pending:1,failed:1,unmatched:1,officialReady:0,photosReady:0});
 const result={checkedAt:new Date(now).toISOString(),products:items,merchants:[{status:'ok'}]};
 assert.equal(merchantRetryDelay(result,now),20*60000);
 assert.equal(merchantRetryDelay({...result,products:[items[0]]},now),6*3600000);
 const logs=[];await runMerchantImageJobs(items,{now:()=>now,deadline:now+120000,inspect:async()=>{throw Error('should wait')},log:r=>logs.push(r)});assert.equal(logs.length,0);
});
