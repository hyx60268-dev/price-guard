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
