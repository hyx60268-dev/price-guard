# Deadline-safe Yahoo deferral

This change is a local reliability preparation. It does not establish the product
requirement of all items' prices and purchasable costs checked within 20 minutes.
No marketplace requests or remote changes are part of its verification.
Persistence wiring covers the production scan and merchant writers; standalone
diagnostic scripts that do not restore encrypted state are unchanged.

## Why it is needed

The process-wide Yahoo gate correctly retains full numeric and HTTP-date
Retry-After deadlines, including later extensions. Previously it had no caller
budget, and profile discovery happened before the scanner created its deadline.
A long server hold could therefore prevent the scan from reaching publication.

## Admission and observation semantics

- Compute the existing scan deadline from `startedAt` before profile discovery.
  Normal scans retain their configured 12-minute budget. The explicit maintenance
  full-audit option retains its existing budget; this change does not expand it.
- Pass that deadline to Yahoo profile, own-detail, search and competitor-detail
  reads. Merchant reads use their existing merchant sub-budget.
- Reject a held request if it cannot be admitted before its caller's deadline.
  An extension wakes the active gate wait so incompatible finite callers drain
  promptly. A shorter caller also times out while queued behind a longer one.
  Admission tickets are revalidated at fetch start against every newly observed
  active hold, including holds shorter than the reserved spacing interval.
- Never shorten the hold. Requests whose full wait fits the budget still wait
  through it. Fetch start rechecks the deadline and persistence-failure latch.
  Fetch and body-read timeouts use the remaining run budget; finally aborts the
  transport so an unread error body cannot keep the request alive.
- Propagate `request_cooldown_deadline` or `request_deadline` instead of converting
  the failed read into a new comparison. Record `deferredReason` and `retryAt`.
- Preserve the old quote and broad-search timestamps, candidate evidence and
  separate attempt clocks. Mark retained comparison evidence `request_error`,
  which existing pricing and cycle checks already reject for current coverage or
  repricing. A new item without accepted evidence retains a null quote time.
- Profiles deferred by the hold retain inventory and remain non-live. No sales or
  removals can be inferred from a deferred profile observation.

This bounds Yahoo network admission/waiting, not every other task in the workflow.
Other platform work, image processing, output generation, setup and deployment
still have their own time bounds and can keep total elapsed time above 20 minutes.

## Cross-process and cross-workflow hold

A small encrypted `state/yahoo-request-access.json.enc` checkpoint contains only
`reason: http_429` and the full `retryAt` epoch deadline. It contains no URL,
query, account, response body or additional credentials. `indefinite` explicitly
represents overflowing server durations; JSON null must not reset that hold.

Each observed 429 updates the in-memory gate immediately and atomically saves the
maximum deadline before retrying. Persistence errors fail Yahoo reads closed.
Malformed nonempty holds fail closed; missing fields in legacy state remain valid.
Scan and merchant processes restore the maximum across this file, the encrypted
full scanner snapshot, and encrypted discovery snapshot. Snapshot reconciliation
also merges by maximum, so a restored older snapshot cannot shorten a newer hold.
Expired holds need not be renewed or rewritten to allow future admission.

The existing shared `pages` writer lock and state cache are reused. An `always()`
checkpoint immediately after scanning saves the hold before publication; final
price-writer and standalone merchant cache saves also run on failure. Cache keys
include the run attempt so reruns do not silently retain an immutable old cache.
Successful publication carries the hold in the existing encrypted full scanner
and discovery state, allowing restoration after a workflow cache miss.

This does not promise durability if the runner is destroyed before its cache can
be saved and before any containing snapshot is published. Eliminating that loss
window would require a separately durable external write during the HTTP response
path, outside this local preparation's authorized scope. An indefinite hold has
no automatic expiry; source/operator evidence would be needed to replace it.

## Verification

Offline tests cover long numeric/date/indefinite holds, concurrent extensions,
queued caller expiry, preserved spacing/retries, deadline-limited request time,
encrypted restart with zero premature requests, max-merge and corrupt-state
behavior, unchanged accepted timestamps, compact publication of reasons, and
explicit incomplete pricing/cycle coverage. Existing match and data-preservation
regressions remain in the aggregate suite.
