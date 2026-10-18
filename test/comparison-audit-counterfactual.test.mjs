import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeSavedCardCounterfactual} from '../scripts/lib/comparison-audit-counterfactual.mjs';
import {createSavedComparisonAuditFixture} from './fixtures/saved-comparison-audit.fixture.mjs';
const now=Date.parse('2026-10-18T03:00:00.000Z');
const read=state=>summarizeSavedCardCounterfactual(state,{now});

test('counterfactual preserves saved source clocks and state, and does not equate pairs with requests',async()=>{
 const state=await createSavedComparisonAuditFixture(),before=structuredClone(state),result=read(state);
 assert.equal(result.valid,true);assert.deepEqual(state,before);assert.equal(result.sourceRequestsMade,0);assert.equal(result.stateWrites,0);assert.equal(result.canRecommend,false);
 assert.equal(result.originalUniqueDetailRequests,4);assert.equal(result.originalDetailAttempts,4);
 assert.equal(result.planned.prerequisitePageReads,3);assert.ok(result.planned.uniqueDetailPages<=64);
 assert.ok(result.planned.selectedTargetRows>=result.planned.uniqueDetailPages);
 assert.equal(result.source.checkedAt,state.checkedAt);assert.equal(result.source.frozenAt,state.comparisonAudit.frozenAt);
 for(const target of result.targets)assert.equal(Object.values(target.retainedReasons).reduce((sum,count)=>sum+count,0),target.counts.retained);
 assert.match(result.interpretation.join(' '),/does not prove lossless recall/);
});
test('a card conflict contradicted by later strict detail is counted, never hidden as zero loss',async()=>{
 const state=await createSavedComparisonAuditFixture({configureTargets(targets){
  for(const target of targets){const card=target.ownBundle.recommendationReceipt.cards.find(card=>card.id.startsWith('synthetic-only'));
   card.title=card.title.replace('1点','2点セット');card.text=card.title;}
 }});
 const result=read(state);assert.equal(result.valid,true);
 assert.equal(result.targets.reduce((sum,target)=>sum+target.counts.excludedPreviouslyStrictComparable,0),2);
 assert.equal(result.targets.reduce((sum,target)=>sum+target.counts.excludedPreviouslyStrictLower,0),2);
 assert.equal(result.potentiallyAvoidableUniqueDetailRequests,2);
});
test('a shared page is not counted as avoidable when another eligible target still needs it',async()=>{
 const state=await createSavedComparisonAuditFixture({configureTargets(targets){
  const card=targets[0].ownBundle.recommendationReceipt.cards.find(card=>card.id==='synthetic-shared');
  card.title=card.title.replace('1点','2点セット');card.text=card.title;
 }});
 const result=read(state);assert.equal(result.valid,true);
 assert.equal(result.targets[0].counts.definitiveConflict,1);assert.equal(result.targets[1].counts.definitiveConflict,0);
 assert.equal(result.potentiallyAvoidableUniqueDetailRequests,0);
});
test('mixed repeated card observations keep the candidate when any observation is unresolved',async()=>{
 const state=await createSavedComparisonAuditFixture({configureTargets(targets){
  for(const target of targets){const card=target.ownBundle.recommendationReceipt.cards.find(card=>card.id.startsWith('synthetic-only'));
   const conflict=structuredClone(card);conflict.title=conflict.title.replace('1点','2点セット');conflict.text=conflict.title;
   target.ownBundle.recommendationReceipt.cards.push(conflict);target.ownBundle.recommendationReceipt.totalCards++;
  }
 }});
 const result=read(state);assert.equal(result.valid,true);
 assert.equal(result.targets.reduce((sum,target)=>sum+target.counts.definitiveConflict,0),0);
 assert.equal(result.potentiallyAvoidableUniqueDetailRequests,0);
});
test('unpaired exclusions remain explicitly unknown and the original page ceiling is retained',async()=>{
 const state=await createSavedComparisonAuditFixture({overflow:true,configureTargets(targets){
  for(const target of targets)for(const card of target.ownBundle.recommendationReceipt.cards)if(Number(card.id.split('-').at(-1))>=35){
   card.title=card.title.replace('1点','2点セット');card.text=card.title;
  }
 }});
 const result=read(state);assert.equal(result.valid,true);
 assert.equal(result.targets.reduce((sum,target)=>sum+target.counts.excludedPreviouslyUnpairedUnknown,0),10);
 assert.ok(result.planned.uniqueDetailPages<=64);assert.ok(result.planned.prerequisitePageReads+result.planned.uniqueDetailPages<=80);
 for(const target of result.targets)assert.ok(target.planned.newPageReads<=32);
});
test('invalid saved pins produce no counterfactual or private fields',async()=>{
 const state=await createSavedComparisonAuditFixture();state.scanMeta.codeSha='PRIVATE_VALUE';
 assert.deepEqual(read(state),{valid:false,reason:'saved_audit_invalid'});
});
