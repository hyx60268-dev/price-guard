import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadXianyuAccess } from '../scripts/lib/xianyu-access.mjs';
import { xianyuSearchExclusion, collectXianyuDetails, detailStateFailure } from '../scripts/lib/xianyu-evidence.mjs';

test('scan block stops discovery and later runs; retry cooldown escalates without forging login success',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'xianyu-access-'));
  let now=Date.now();const options={clock:()=>now};
  try{
    const scan=await loadXianyuAccess(root,'fixture-key',options);
    await scan.record({status:'blocked'});
    const discovery=await loadXianyuAccess(root,'fixture-key',options);
    assert.equal(discovery.access().allowed,false);
    assert.equal(discovery.access().reason,'blocked');
    assert.equal(Date.parse(discovery.access().retryAt)-now,3600000);
    now+=3600000;
    assert.equal(discovery.access().allowed,true);
    // A readable unrelated listing is not sustained recovery.
    await discovery.record({status:'manual_review',accessibleDetailCount:1});
    await discovery.record({status:'blocked'});
    assert.equal(Date.parse(discovery.access().retryAt)-now,7200000);
    const reauthorized=await loadXianyuAccess(root,'different-user-supplied-session',options);
    assert.equal(reauthorized.access().allowed,true);
    now+=7200000;
    await discovery.record({status:'ok',accessibleDetailCount:2});
    assert.equal(discovery.access().reason,null);
    const restored=await loadXianyuAccess(root,'fixture-key',options);
    assert.equal(restored.access().allowed,true);
  }finally{await fs.rm(root,{recursive:true,force:true})}
});

const offer=(id,seller,price=65)=>({id:String(id),url:`https://example.com/${id}`,sellerKey:seller,price,priceSource:'target_detail',accepted:true});
test('stop only after independent coherent verified details; do not visit an unnecessary challenge',async()=>{
  const calls=[];
  const candidates=[offer(1,'seller-a'),offer(2,'seller-a'),offer(3,'seller-b'),{id:'challenge'}];
  const checks=await collectXianyuDetails(candidates,async row=>{
    calls.push(row.id);return row.id==='challenge'?{reason:'detail_blocked'}:row;
  });
  assert.deepEqual(calls,['1','2','3']);assert.equal(checks.length,3);
});
test('rejected identities, search prices and incoherent prices cannot stop verification early',async()=>{
  for(const invalid of [{...offer(1,'a'),accepted:false,reason:'sale_unit_mismatch'},{...offer(1,'a'),priceSource:'search_card'},offer(1,'a',1000)]){
    const rows=[invalid,offer(2,'b'),{reason:'detail_blocked'},offer(4,'c')];
    let count=0;const checks=await collectXianyuDetails(rows,async row=>{count++;return row});
    assert.equal(count,3);assert.equal(checks.at(-1).reason,'detail_blocked');
  }
});
test('short real description is readable but missing description, price or seller still fails',()=>{
  const state={titles:['3Z0163 擎天柱'],text:'全新未拆盒装，仅售擎天柱一件',price:600,sellerKey:'a',images:['https://example.com/item.jpg']};
  assert.ok(state.text.length<20);assert.equal(detailStateFailure(state),null);
  assert.equal(detailStateFailure({...state,text:'   '}),'detail_unreadable');
  assert.equal(detailStateFailure({...state,price:null}),'detail_price_unconfirmed');
  assert.equal(detailStateFailure({...state,sellerKey:''}),'detail_seller_unconfirmed');
});

test('explicit Japan-import cost cards are excluded without requiring word or image similarity',()=>{
  assert.equal(xianyuSearchExclusion({title:'【海外限定】POPMART NARUTO 晓 日本代购'}),'japan_import_not_procurement');
  assert.equal(xianyuSearchExclusion({title:'全新现货 Threezero DLX 变2擎天柱'}),null);
  assert.equal(xianyuSearchExclusion({title:'日本限定 星巴克蓝色豹纹370ml'}),null);
});
