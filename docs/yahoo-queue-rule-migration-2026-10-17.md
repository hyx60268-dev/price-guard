# Yahoo ordering continuity across matching-rule upgrades

## Verified scope

The production metrics supplied for run `39018346601` / job `117354963683`
show 630 Yahoo tasks, 19 completed broad comparisons, four admitted deferred
comparisons and 607 pre-admission deferrals. Neither Violet listing entered
the broad comparison frontier. Their actual ranks were not observed: only
bounded per-item diagnostics, not a decrypted full inventory, were available.

The source gate ran 144 turns with zero cooldown extensions. At the configured
5,000 ms interval, 144 requests consume approximately the entire 12-minute
admission window. Profile pages, known-offer checks and shared own-detail reads
for other workers use this gate too. Gate wait statistics can overlap other
work; they are not independently reclaimable wall time.

This patch does not change source access, request intervals, deadlines, detail
budgets, scan priorities or price-evidence freshness.

## Narrow queue repair

`yahooQueueOwnKey` includes the matching rules version. Previously a v22 queue
read under v23 lost all inspected and unresolved-attempt ordering, even with
identical current own details and unchanged recalled cards. Existing unresolved
backoff and deferred-checkpoint fixes could not prevent that identity mismatch.

The planner now accepts an explicitly identified historical queue only when:

- Its version is a positive integer older than the current version.
- A complete current OPEN own detail produces exactly the saved historical key
  when hashed with that older version.
- The current candidate key matches each saved row. Scheduling reasons, counts
  and finite retry times pass the existing allowlist and bounds.

The output receives the current queue key and version. Only whitelisted unresolved
`schedulingAttempts` migrate. Historical inspected `attempts` are cleared; they
remain available only with an unchanged current-rule key. No candidate, quote,
recommendation, accepted match, coverage
count or price-observation clock migrates. Changed account, listing, platform,
own titles, sale description/specification, condition, seller, images or category
revoke historical ordering. Changed candidate ID/title/image/seller/price revokes
that candidate's row. Invalid, missing, future or contradictory queue provenance
does not acquire historical compatibility.

Queue provenance is now separate from comparison provenance. A known-only
refresh can produce a current-rule live quote while carrying the untouched
historical broad queue. For a legacy queue without a version, current full own
detail must prove either its current key or its key at the explicitly valid
old comparison version before a version is added. A legacy partial checkpoint
can already have a current key beside an old fallback quote, so blindly copying
the quote version would discard legitimate progress. Unknown keys and explicit
contradictions are never guessed or overwritten. The later broad pass validates
and migrates the old queue independently.

## Regression evidence

`test/yahoo-queue-rule-migration.test.mjs` uses the eight real unresolved
candidate IDs/prices/reasons from the earlier Violet diagnostic fixture.
All detail prose, availability, image fingerprints and the ninth umbrella
candidate ID are controlled; these tests do not establish a live market match.

- The historical queue reaches the missing-description retry plus the unseen
  ninth candidate after 20 minutes, using two calls inside the existing
  eight-detail cap. Without compatibility, all eight old IDs repeat.
- Three managed-account contexts run the actual current `yahooCompare` path.
- Actual historical known-only revalidation produces current-price/current-rule
  evidence while retaining v22 queue provenance, then a broad pass migrates it.
- A legacy current-key/no-version checkpoint beside a v22 fallback quote is
  positively identified as current before known-only and broad continuation.
- A deferred comparison checkpoints migrated rows through encryption, dashboard
  compaction and durable-state reconciliation without changing old quote clocks
  or making historical-rule evidence actionable.
- Own/card identity changes, bad versions/keys, retry bounds, ownership,
  permanent corrections, SOLD and quantity mismatches retain their protections.

## Separate priority starvation finding, not repaired here

`scan.mjs` sorts each account by absolute priority before full-attempt time.
Old-rule rows with an active price signal have priority 1; other old-rule rows
have priority 2. A completed source response followed by deferral advances the
first row's attempt clock but preserves its old rule and price-signal fields.
It therefore stays ahead of every priority-2 row regardless of age.

This is a reproducible starvation condition if recurring priority-1 failures
consume that account's admission share. It is not proof that this condition
caused either Violet listing's specific production rank. Healthy comparisons
that complete under the current rules leave the old-rule priority class.

Read-only reproducer, run from the repository root:

```sh
node --input-type=module <<'NODE'
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {MATCHING_RULES_VERSION} from './scripts/lib/rules.mjs';
import {yahooFullAttemptTime} from './scripts/lib/yahoo-known-refresh.mjs';
import {deferredYahooComparison} from './scripts/lib/pricing-coverage.mjs';
const scan=fs.readFileSync('scripts/scan.mjs','utf8');
const expression=scan.match(/return \{context,item,itemIndex,prior,priority:(.*),lastChecked:Number.isFinite\(checked\)\?checked:0\};/)[1];
const priority=new Function('added','priceChanged','rulesChanged','activePriceSignal','checked','return '+expression);
const at=Date.parse('2026-10-16T00:00:00Z');
const item=(id,active)=>({id,yahoo:{rulesVersion:MATCHING_RULES_VERSION-1,
 underpriced:active,status:'ok',checkedAt:new Date(at).toISOString(),lastFullAttemptAt:new Date(at).toISOString()}});
const target=item('ordinary-old-rule-target',false);
const rows=[...Array.from({length:8},(_,n)=>item('retry-'+n,true)),target];
for(let run=1;run<=5;run++){
 const tasks=rows.map((row,index)=>({row,index,checked:yahooFullAttemptTime(row.yahoo),
  priority:priority(false,false,row.yahoo.rulesVersion!==MATCHING_RULES_VERSION,row.yahoo.underpriced===true,yahooFullAttemptTime(row.yahoo))}))
  .sort((a,b)=>a.priority-b.priority||a.checked-b.checked||a.index-b.index);
 const selected=tasks.slice(0,8);
 assert.equal(tasks.findIndex(task=>task.row===target)+1,9);
 for(const {row} of selected){
  row.yahoo=deferredYahooComparison(row.yahoo,{reason:'request_cooldown_deadline'},row);
  row.yahoo.lastFullAttemptAt=new Date(at+run*20*60000).toISOString();
 }
 console.log(JSON.stringify({run,targetRank:9,selected:selected.map(task=>task.row.id),targetAttempt:target.yahoo.lastFullAttemptAt}));
}
NODE
```

The smallest follow-up design should bound priority boost within each account
and preserve its existing fair account turns: a retry must not retain unlimited
priority over older never-admitted work after it already received a real source
attempt under the current rules. Persist an account/item-bound scheduling-only
attempted-rules marker, or reserve a bounded oldest-unserved turn, and recompute
priority independently from accepted-evidence rules. Do not relabel a failed
quote as current to lower its priority, renew attempts for pre-admission holds,
or solve this by raising request rate/budget. Tests must cover repeated response-
then-deferral, pre-admission holds, ongoing new arrivals, real price changes,
account fairness and unchanged price-evidence clocks. No scheduler change is
included in this patch.
