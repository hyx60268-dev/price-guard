# Bounded shared-evidence own-root scheduler candidate

Status: enabled local release candidate, not a production measurement. The new setting is true in this candidate; the previously deployed configuration does not contain it. The product goal remains every account and every current item, including genuine procurement cost, within each 20-minute cycle. Six roots is a narrow safety/benefit validation limit, not a replacement acceptance criterion.

## What changes

Normal Yahoo reads already retain current, original detail bodies and recommendation cards. A low-priced candidate may have been read for one target while another current own listing still lacks its body. This candidate schedules one missing own-body read rather than automatically beginning that second target's search and up to eight candidate-detail reads.

Admission requires a complete current ownership index, a current OPEN own profile card consistent with the target, an unchanged current low-price candidate body, and already-available original candidate image fingerprints. The original strict per-target matcher still checks actual current sale terms, quantity, condition, colour, variant, bonus, ownership and correction records. Raw cards and historical hints never become accepted candidates.

The lane is gated by all three settings:

- `yahooObserveNormalPageRails === true`
- `yahooSharedDetailOffers === true`
- `yahooSharedOwnRootReads === true` (new, opt-in; absent means off)

It uses the existing source deadline and global Yahoo request gate. It does not add a workflow, request ID, credential, rate, scan budget or audit window.

## Scheduling and resource bounds

- At most six missing own roots per scan, at most two per account; a root is reserved once even if its action fails.
- Each account earns a shared action only after two ordinary tasks have actually consumed source input. A fresh-cache hit or pre-admission deferral earns no credit. Source input can itself be an already-current memoized read; transport counts remain separate.
- Accounts rotate. Every second ordinary claim reserves an established no-hit discovery task when available. In-flight claims count toward that reservation, preventing completion-race starvation. Unknown or partially mapped targets are not called no-hit.
- A shared action never removes an ordinary discovery obligation or changes its old comparison/search/attempt clocks. The original task remains queued. The existing age-based ordinary ordering is retained.
- One shared action may be in flight globally, and it cannot overlap an ordinary task for that same own target. Normal concurrency is unchanged.
- At most one own HTML transport attempt per action. The existing loader may reuse it later. No candidate-detail or search transport is available inside this action.
- Original own-image processing remains bounded by `maxYahooImages` (existing default eight, maximum ten), sequentially. Candidate images must already be available. Own-image GETs can increase; they are separately counted, together with completed decoded bytes, aggregate duration and unknown-body transfers.
- New own terms that are sold/changed/missing stop before any image work. Candidate-body eviction/change, current profile/rail conflict, unavailable candidate fingerprints and source holds are rechecked before and during own-image processing.
- The planner has a cumulative one-second local allowance covering construction, claim, recall and candidate rechecks. The directed strict verifier has a separate cumulative one-second allowance including waits for an existing ordinary strict check. Neither resets within the scan; six strict admissions maximum. These cooperative checks cannot preempt one synchronous hash already running.
- `runtime.localDurationMs` includes synchronous planner work invoked during consume. `planningDurationMs` is also reported separately and overlaps it. Do not sum those as disjoint CPU time. Root and image wall times may overlap ordinary workers and must not be summed into scan wall time.
- Access denial, cancellation, deadline and partial image work yield no accepted new quote. A current failed re-verification withdraws that pair's earlier shared offer. Late local cache completion cannot restore it.

## Output and privacy

Successful results use the existing independent `sharedYahooOffers` field with original body/image source times and cryptographic binding. The UI labels the independently verified quote and incomplete market-discovery scope. This lane cannot advance complete-comparison coverage, change automatic recommendations or provide procurement cost. Ordinary `yahoo.candidates` is untouched.

Operational output contains fixed reasons and numerical counters. Per-account operational rows use ordinals, since scan metadata is also retained in member projections. Current own/competitor IDs, source text, raw bytes and URLs are not included in these added logs.

## Explicit offline equal-HTML model

The real scanner, original parser/gate/loader, strict matcher, encryption and member publication run against controlled HTTP fixtures. There are 90 Yahoo targets (three ordinary seeds, 81 no-hit discovery obligations, six deferred exact targets) and one retained Rakuma target. Every HTML response consumes five simulated seconds. Both runs consume 144 HTML transports and 720 simulated seconds.

| Metric | Original | Candidate |
| --- | ---: | ---: |
| Useful strict quote targets | 3 | 9 |
| Ordinary source-observed targets | 71 | 68 |
| Current complete price comparisons | 70 | 67 |
| Complete price-and-cost targets | 0 | 0 |
| Profile HTML | 3 | 3 |
| Own HTML | 71 | 74 |
| Search HTML | 69 | 66 |
| Candidate HTML | 1 | 1 |
| Model cold image GETs | 72 | 117 |
| Model completed image bytes | 8,856 | 14,391 |

Each of the three Yahoo accounts gets two additional independent strict quotes. The six still-queued ordinary root tasks retain old checked/search/attempt clocks and remain incomplete. Model complete price comparisons by account change 24/23/23 to 23/22/22.

This is a trade-off, not an all-metric improvement. The extra 45 image GETs may reduce capacity under real image latency. The model's fingerprints are synthetic and each modeled image is 123 bytes; no actual image network, throughput, false-negative rate or production gain is established. The synthetic known-match targets demonstrate missed useful reads in this fixture, not recall over the user's entire inventory.

## Tests and review scope

Real scan tests cover enabled/disabled request paths, all-account denominators, account rotation, no-hit discovery, cached-task exclusion, current and mid-scan source holds, source deadline, incomplete ownership, image absence, changed own status/title/price, quantity and explicit bonus rejection, independent output/automatic-price isolation, encryption and member scoping. Pure/concurrent tests additionally cover duplicate pairs, claimed-root limits, candidate eviction/change, image access denial, cancellation, strict mutual exclusion, withdrawal after a failed re-verification, late completion, successful-pair deduplication and cumulative local/wait ledgers.

A separately discovered existing parser gap for phrases such as `特典も付属します` remains outside this scheduling change. Supported explicit included/absent bonus terms are used for this candidate's rejection tests. This is not evidence that all possible sale descriptions are recognized.

## Proposed production validation and rollback

No deployment is performed by this document. The parent approved preparing the enabled candidate for exact-tree tests/review and a checked ordinary release. Retain the original gate/deadline and observe only its normal production run. There is no new audit window.

Collect actual source/image counts, bytes, root/image/strict time, per-account ordinary coverage, retained obligations, independently verified output pairs, overlap with ordinary stored/eligible quotes, current source holds and end-to-end publication time. Compare with a clearly identified normal baseline; different inventory/candidate cohorts prevent causal claims from counts alone.

If no useful extra eligible quote is produced or the image/processing cost materially harms the normal run, turn `yahooSharedOwnRootReads` false or remove it through a checked rollback. This restores the prior ordinary dispatcher while preserving the existing zero-new-GET shared consumer. No stored quote clock is refreshed or deleted merely by switching the feature off.
