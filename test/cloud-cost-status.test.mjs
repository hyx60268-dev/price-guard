import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudCostStatus } from '../scripts/lib/cloud-cost-status.mjs';
import { XIANYU_VERIFICATION } from '../scripts/lib/xianyu-evidence.mjs';

const now = Date.parse('2026-09-23T12:00:00Z');
const item = () => ({ averageCNY: 95, xianyu: { verification: XIANYU_VERIFICATION, checkedAt: new Date(now).toISOString(), reviewedAt: new Date(now).toISOString(), reviewVersion: XIANYU_VERIFICATION,
  samples: [{ id: '1', sellerKey: 'a', priceSource: 'target_detail', price: 90 }, { id: '2', sellerKey: 'b', priceSource: 'target_detail', price: 100 }] } });

test('cloud cost does not accept search success, manual costs or zero references', () => {
  const result = { manualCosts: { a: { purchaseCNY: 95 } }, items: [{ averageCNY: 95 }], accounts: [{ scanStats: { xianyuScanned: 1 } }] };
  assert.equal(cloudCostStatus(result, now).status, 'no_verified_cost');
  assert.equal(cloudCostStatus(result, now).accepted, false);
});
test('fresh independent detail evidence passes without requiring a new cost every round', () => {
  const result = cloudCostStatus({ items: [item()] }, now);
  assert.equal(result.accepted, true);
  assert.equal(result.verifiedReferences, 1);
  assert.equal(result.newlyVerified, 0);
});
test('expired, duplicate seller, old contract and altered price cannot pass acceptance', () => {
  for (const change of [i => i.xianyu.checkedAt = '2026-09-01', i => i.xianyu.checkedAt = '2026-10-01',
    i => i.xianyu.samples[1].sellerKey = 'a', i => i.xianyu.verification = 'old', i => i.averageCNY = 1]) {
    const i = item(); change(i);
    assert.equal(cloudCostStatus({ items: [i] }, now).accepted, false);
  }
});
test('a source failure remains failed even with historical valid references', () => {
  for (const status of ['blocked', 'login_required']) {
    const result = cloudCostStatus({ items: [item()], accounts: [{ scanStats: { xianyuScanned: 1, xianyuStatuses: { [status]: 1 } } }] }, now);
    assert.equal(result.status, status);
    assert.equal(result.accepted, false);
    assert.equal(result.verifiedReferences, 1);
  }
});

test('a verified cost cannot declare full coverage while other listings remain unreviewed',()=>{
  const result=cloudCostStatus({items:[item(),{id:'pending',xianyu:{status:'deferred_limit'}}]},now);
  assert.equal(result.status,'partial');assert.equal(result.accepted,false);
  assert.deepEqual(result.coverage,{total:2,reviewed:1,remaining:1,complete:false});
});
test('source errors cannot declare successful acceptance, and missing inventory profiles block full coverage',()=>{
  assert.equal(cloudCostStatus({items:[item()],accounts:[{profileStatus:'live',scanStats:{xianyuStatuses:{detail_inaccessible:1}}}]},now).status,'detail_inaccessible');
  assert.equal(cloudCostStatus({items:[item()],accounts:[{profileStatus:'error'}]},now).accepted,false);
});

test('access cooldown is reported truthfully, keeps prior references and never counts as completion',()=>{
  const access={allowed:false,reason:'blocked',retryAt:'2026-09-23T13:00:00Z'};
  const result=cloudCostStatus({items:[item(),{id:'pending'}],login:{xianyuAccess:access},accounts:[{scanStats:{xianyuStatuses:{deferred_access:1}}}]},now);
  assert.equal(result.status,'access_cooldown');assert.equal(result.accepted,false);
  assert.equal(result.verifiedReferences,1);assert.equal(result.attempted,0);
  assert.deepEqual(result.access,access);assert.equal(result.coverage.remaining,1);
});

import { publicProcurementItem } from './fixtures/procurement-reference.mjs';

test('independent public procurement can pass while Xianyu remains in its own access cooldown',()=>{
 const access={allowed:false,reason:'login_required',retryAt:new Date(now+3600000).toISOString()};
 const result=cloudCostStatus({items:[publicProcurementItem(now)],login:{xianyuAccess:access},accounts:[{profileStatus:'live',scanStats:{procurementScanned:1,procurementVerifiedNew:1,procurementStatuses:{ok:1}}}]},now);
 assert.equal(result.accepted,true);assert.equal(result.status,'verified');assert.equal(result.verifiedReferences,1);
 assert.equal(result.attempted,1);assert.equal(result.newlyVerified,1);
 assert.equal(result.sources.xianyu.status,'access_cooldown');assert.equal(result.sources.xianyu.accepted,false);
 assert.equal(result.sources.xianyu.verifiedReferences,0);assert.deepEqual(result.sources.xianyu.access,access);
 assert.equal(result.sources.public_cn.verifiedReferences,1);assert.equal(result.sources.public_cn.accepted,true);
});

test('public success does not hide incomplete overall inventory or turn a retry into a new reference',()=>{
 const result=cloudCostStatus({items:[publicProcurementItem(now),{id:'still-pending'}],accounts:[{profileStatus:'live',scanStats:{procurementStatuses:{cached_verified:1}}}]},now);
 assert.equal(result.status,'partial');assert.equal(result.accepted,false);assert.equal(result.newlyVerified,0);
 assert.equal(result.coverage.total,2);assert.equal(result.coverage.reviewed,1);assert.equal(result.coverage.remaining,1);
});

test('public source errors, unverified cards and changed display amounts cannot pass overall acceptance',()=>{
 const good=publicProcurementItem(now);
 const failure=cloudCostStatus({items:[good],accounts:[{profileStatus:'live',scanStats:{procurementScanned:1,procurementStatuses:{unavailable:1}}}]},now);
 assert.equal(failure.sources.public_cn.status,'source_failed');assert.equal(failure.accepted,false);
 const unverified=publicProcurementItem(now);unverified.procurementSource.samples[0].priceSource='search_card';
 assert.equal(cloudCostStatus({items:[unverified]},now).accepted,false);
 const altered=publicProcurementItem(now);altered.averageCNY=1;
 assert.equal(cloudCostStatus({items:[altered]},now).accepted,false);
 const future=publicProcurementItem(now);future.procurementSource.checkedAt=new Date(now+3600000).toISOString();
 assert.equal(cloudCostStatus({items:[future]},now).accepted,false);
});

test('another procurement source failure cannot downgrade a fully accepted Xianyu reference',()=>{
 const combined={...publicProcurementItem(now),...item(),referenceProvider:'xianyu'};combined.xianyu.averageCNY=95;
 for(const status of ['unavailable','error']){
  const result=cloudCostStatus({items:[combined],accounts:[{profileStatus:'live',scanStats:{procurementScanned:1,procurementStatuses:{[status]:1},procurementRejectedReasons:{source_timeout:1}}}]},now);
  assert.equal(result.accepted,true);assert.equal(result.status,'verified');assert.equal(result.verifiedReferences,1);
  assert.equal(result.coverage.complete,true);assert.equal(result.sources.xianyu.accepted,true);
  assert.equal(result.sources.public_cn.accepted,false);assert.equal(result.sources.public_cn.status,'source_failed');
  assert.equal(result.sources.public_cn.statuses[status],1);assert.equal(result.sources.public_cn.reasons.source_timeout,1);
  assert.equal(result.sources.public_cn.attempted,1);
 }
});

test('independent-source acceptance still requires complete coverage, valid evidence and matching displayed cost',()=>{
 const combined={...publicProcurementItem(now),...item(),referenceProvider:'xianyu'};combined.xianyu.averageCNY=95;
 const scenario=()=>({items:[structuredClone(combined)],accounts:[{profileStatus:'live',scanStats:{procurementScanned:1,procurementStatuses:{unavailable:1}}}]});
 for(const change of [
  result=>result.items.push({id:'unreviewed'}),
  result=>result.accounts[0].profileStatus='error',
  result=>result.items[0].xianyu.samples[1].sellerKey='a',
  result=>result.items[0].xianyu.checkedAt='2026-09-01',
  result=>result.items[0].averageCNY=1,
  result=>result.accounts[0].scanStats.xianyuStatuses={blocked:1}]){
  const result=scenario();change(result);assert.equal(cloudCostStatus(result,now).accepted,false);
 }
});

test('Xianyu-only overall acceptance also checks the displayed amount when source evidence has its own amount',()=>{
 for(const value of [1,null,undefined]){
  const row=item();row.xianyu.averageCNY=95;row.referenceProvider='xianyu';row.averageCNY=value;
  const result=cloudCostStatus({items:[row],accounts:[{profileStatus:'live'}]},now);
  assert.equal(result.sources.xianyu.accepted,true,'independent source evidence is retained');
  assert.equal(result.accepted,false);assert.equal(result.status,'no_verified_cost');assert.equal(result.verifiedReferences,0);
 }
 const row=item();row.xianyu.averageCNY=95;row.referenceProvider='xianyu';
 assert.equal(cloudCostStatus({items:[row],accounts:[{profileStatus:'live'}]},now).accepted,true);
});
