import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudCostStatus } from '../scripts/lib/cloud-cost-status.mjs';
import { XIANYU_VERIFICATION } from '../scripts/lib/xianyu-evidence.mjs';

const now = Date.parse('2026-09-23T12:00:00Z');
const item = () => ({ averageCNY: 95, xianyu: { verification: XIANYU_VERIFICATION, checkedAt: new Date(now).toISOString(),
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
