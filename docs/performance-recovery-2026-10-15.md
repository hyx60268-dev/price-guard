# Interim pricing recovery and complete-cycle acceptance

This repair is not acceptance of the 20-minute full-inventory service target.
All accounts and products remain included. Same-platform comparison is the
requested fallback; reducing the number of sampled products is not completion.

## Observed baseline

Public production run: https://github.com/hyx60268-dev/price-guard/actions/runs/38817801504

- 1,460 active items: melon 97, the other Yahoo accounts 48 and 489, Rakuma 826.
- The price scan reported 797 seconds. Price publication completed at 22:47:40 UTC;
  inline merchant processing then occupied the shared writer until about 23:00:32.
- The known-Yahoo lane admitted 6 of 118 eligible items in 136 seconds.
- Cost verification produced no accepted current supplier reference. A successful
  Pages deployment did not mean that procurement succeeded.
- A 20-minute cron expression does not prove a 20-minute observed start cadence.

## This repair

- Native-platform comparison reduces planned comparison tasks from 4,380 to
  1,460. This is a task-count reduction, not a measured threefold speedup.
- Daily inline merchant catch-up no longer repeats incomplete image/detail work
  inside every price writer. Independent/manual merchant processing remains.
- Identical Yahoo query reads are shared within a run; matching remains local to
  each product/account and the original observation timestamp is preserved.
- Cycle coverage separately counts current-cycle prices and validated actual
  supplier costs for every product. Old caches, request attempts, manual values,
  unsupported sources and failed inventory discovery cannot manufacture success.
- The UI distinguishes valid historical pricing from a completed current cycle.
  Per-account completion gaps are also checked. First full recovery establishes
  the baseline; partial attempts cannot advance it. A fast run after a long gap
  fails the continuous 20-minute acceptance check.
- Xianyu costs require a target-bound payable supplier offer. A price median is
  shown only as a benchmark. Missing stock, currency or freight does not create
  an automatic cost. Account/variant/quantity/condition checks remain mandatory.

## Reproducible public batch experiment

`node scripts/probe-yahoo-batch.mjs p76217154 p73959369`

Measured October 15, 2026, 23:26:37.900–23:27:02.085 UTC:

- melon public seller HTML: 103 records over 2 pages, 97 open, 10.969 seconds.
- Known competitor seller: 28 records on 1 page, 24 open, 13.216 seconds.
- Total 131 listing observations in 24.185 seconds, three page requests.
- Existing 5,000 ms request gate and normal cooldown/retry logic remained in use.
  This is an internal setting, not a documented Yahoo service quota. Xianyu's
  8,000 ms gate is also an internal configuration, not a proven external limit.
- No credentials, unpublished API, CAPTCHA, increased rate or production write.

Cards expose current price, status, seller, title, primary image and condition.
They do not expose sale descriptions, reliable listing revision or per-listing
shipping details. The probe deliberately does not renew identity verification,
create procurement costs or reprice from those cards alone.

Yahoo's official shipping policy offers a possible warm-quote route for proven
small-item bindings, because ordinary shipping is seller-paid:
https://support.yahoo-net.jp/SccPaypayfleamarket/s/article/H000008409
https://paypayfleamarket.yahoo.co.jp/contents/shipping
Large-item optional installation charges and non-Yahoo platforms are outside
that inference. A persisted binding still needs auditable full-detail provenance,
change invalidation and separate identity/quote observation timestamps.

## Validation and rollout gates

Local regression tests cover native-scope queues, stale/error states, owned
inventory, corrections, manual costs, seller/quantity/color exclusions, merchant
skip byte preservation, cycle completeness and scoped employee publication.
The Xianyu pipeline test exercises actual DOM readers, image fingerprints and
matching through storage, publication and consumers using synthetic observed-
layout fixtures. It is not evidence of live Xianyu access or a live supplier.

After authorized deployment, verify the exact deployed SHA, published revision,
all account totals, each account's current-cycle price/cost counts, real start and
publication intervals, request/error rates, and maximum quote age. Separate cold
backlog recovery from steady-state cycles. No production timing is promised by
local tests. Browser launch in the local test environment was blocked; JSDOM
interaction tests passed, but a real-browser/mobile smoke test remains required.

Rollback: revert these code/configuration commits through a reviewed change.
Restoring comparisonMode to cross_platform restores the old three-market scope;
reverting the merchant catch-up commit restores prior scheduling. Saved manual
costs, correction tombstones and inventory records are not migrated or deleted.

## Conditional reads and persistent media computation

A normal public Yahoo detail GET and a subsequent If-None-Match GET were tested
at the same5-second pacing. Both returned200; the HTML ETag changed while the
canonical identity fields and updateDate were unchanged. A304 optimization is
therefore not established for this page. No redirect/challenge workaround was
used.

The examined Yahoo image had no ETag/Last-Modified but declared public max-age
1,209,600 seconds. Persistent fingerprint reuse now follows explicit public
freshness (including Age/Date), capped at24 hours. Original observation time is
retained; URL query variants stay distinct. After expiry, actual downloaded
bytes are hashed before CPU results may be reused. no-store is honored, invalid
or partial reads do not create cache entries, and derived disk entries are bounded.

One-image measurement across separate Node processes at23:43 UTC:

- Cold:109,426 downloaded bytes,75.8 ms fingerprint CPU,5,115.3 ms total.
- Warm restart:0 downloaded bytes,0 fingerprint CPU,1.8 ms total.
- Same content SHA256 and original image observation timestamp.

These numbers measure one media operation, not whole-account or whole-cycle
throughput. Quotes and stock continue to require their own live observations.


Full known-pair processing with the same observed detail bodies, across separate
Node processes at 23:45 UTC, also produced the same accepted match:

- Cold: 10 image downloads, 1,146,716 bytes, 751.6 ms fingerprint CPU, 6,713.6 ms total.
- Warm restart: zero image downloads/bytes/compute, 24.9 ms total.
- This isolates media and matching. It excludes fresh product detail/quote reads.

Regression review found that the old process-level promise map could bypass
HTTP expiry. It now respects the same expiry as the persisted record and only
coalesces in-flight reads for no-cache/no-store images. Changed bytes after expiry,
conflicting headers, malformed saved timestamps and interrupted temporary files
have dedicated regression cases. Failed or incomplete downloads never advance
source observation time.

## Scheduler cadence findings

Three October 15 runs began runner work about six seconds after event creation:

- 15:10:17 event, 15:10:23.547 first log; scan 817 seconds, merchant tail 12m20s.
- 19:17:22 event, 19:17:28.354 first log; scan 861 seconds, merchant tail 11m51s.
- 22:32:26 event, 22:32:32.437 first log; scan 797 seconds, merchant tail 12m35s.

The 3–5-hour event-creation gaps therefore precede runner startup in the sampled
runs. Reducing the shared writer's tail helps runtime but cannot by itself repair
missing event cadence. No workflow condition explains those gaps in the inspected
configuration; the specific upstream cause is unproven. GitHub documents that
scheduled events may be delayed or dropped under load:
https://docs.github.com/en/actions/how-tos/troubleshoot-workflows

A separately reviewed, explicit opt-in finite controller can validate six fixed
20-minute slots using the repository's existing workflow-dispatch capability,
without holding the pages lock during waits. It must record actual runner starts,
publication times and per-account complete coverage, avoid duplicate dispatch,
stop on errors/cancellation, and expose missed slots. This would establish only
the bounded observation window, not an indefinite reliability guarantee. It is
not activated by this repair and requires production approval before execution.

A later bounded throughput experiment at 2026-10-16 00:01 UTC was stopped on its
first normal public detail GET: HTTP 429, no Retry-After header, 7,422 ms response.
This happened in the baseline phase, before any higher-concurrency or shorter-
spacing phase ran. Exactly one request was made, with no retry or alternate
access path. There is therefore no measured faster-throughput result to report.
This is a throttle signal for the research cloud access path, not proof that the
production runner is throttled. Existing production pacing remains unchanged.
