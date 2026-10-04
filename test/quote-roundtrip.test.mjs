import test from 'node:test';
import assert from 'node:assert/strict';
import { compactDashboardResult } from '../scripts/lib/publish.mjs';
import { publicProcurementItem } from './fixtures/procurement-reference.mjs';
import { verifiedPublicProcurementCache } from '../scripts/lib/procurement-reference.mjs';

test('mobile publication preserves the selected purchasable quote and its exact evidence',()=>{
 const now=Date.parse('2026-10-04T14:00:00Z'),item=publicProcurementItem(now);
 const compact=JSON.parse(JSON.stringify(compactDashboardResult({items:[item]}))).items[0];
 assert.deepEqual(compact.procurementSource,item.procurementSource);
 assert.equal(verifiedPublicProcurementCache(compact,{now}).averageCNY,item.procurementSource.averageCNY);
});

test('mobile publication keeps known-detail attempts separate from old full-search observations',()=>{
 const full='2026-10-04T13:00:00Z',attempt='2026-10-04T14:00:00Z';
 for(const failed of [false,true]){
  const yahoo={status:'incomplete',checkedAt:failed?full:attempt,searchCheckedAt:full,lastFullAttemptAt:full,knownLastAttemptAt:attempt,knownRefresh:{mode:failed?'failed':'details_only'},detailQueue:{ownKey:'owned-identity',attempts:[{id:'z2',key:'candidate-identity',at:full}],lastSelection:['z2'],remaining:3},audit:{accountId:'a',ownItemId:'z1',rulesVersion:22},candidates:[]};
  const row=JSON.parse(JSON.stringify(compactDashboardResult({items:[{id:'z1',accountId:'a',yahoo}]}))).items[0];
  assert.equal(row.yahoo.checkedAt,failed?full:attempt);
  assert.equal(row.yahoo.searchCheckedAt,full);assert.equal(row.yahoo.lastFullAttemptAt,full);assert.equal(row.yahoo.knownLastAttemptAt,attempt);
  assert.deepEqual(row.yahoo.audit,yahoo.audit);assert.deepEqual(row.yahoo.knownRefresh,yahoo.knownRefresh);
  assert.deepEqual(row.yahoo.detailQueue,yahoo.detailQueue);
 }
});
