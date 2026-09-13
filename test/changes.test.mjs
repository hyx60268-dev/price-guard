import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSnapshots } from '../scripts/lib/changes.mjs';

test('first snapshot establishes baseline without alert',()=>{
  assert.equal(compareSnapshots(null,{items:[{id:'a'}]}).hasChanges,false);
});

test('detects add remove and tracked field update',()=>{
  const old={items:[{accountId:'m',id:'a',title:'A',ownPrice:100},{accountId:'m',id:'b',title:'B',ownPrice:200}]};
  const now={items:[{accountId:'m',id:'a',title:'A',ownPrice:90},{accountId:'m',id:'c',title:'C',ownPrice:300}]};
  const result=compareSnapshots(old,now);
  assert.deepEqual({total:result.total,added:result.added,removed:result.removed,updated:result.updated},{total:3,added:1,removed:1,updated:1});
});

test('does not alert when the checked price stays exactly the same',()=>{
  const old={items:[{accountId:'m',id:'a',title:'A',ownPrice:4099,lowestPrice:2999,recommendedPrice:2998}]};
  const same={items:[{accountId:'m',id:'a',title:'A',ownPrice:4099,lowestPrice:2999,recommendedPrice:2998}]};
  const changed={items:[{accountId:'m',id:'a',title:'A',ownPrice:4099,lowestPrice:2998,recommendedPrice:2997}]};
  assert.equal(compareSnapshots(old,same).hasChanges,false);
  assert.equal(compareSnapshots(old,changed).hasChanges,true);
});
