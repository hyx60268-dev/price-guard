# One-time Yahoo comparison audit controller

Status: **local integration, disabled by configuration**. The controller remains
pure; the existing scanner and transport now have an opt-in audit branch. Normal
scans retain their source policy. Audit page redirects are manual and not followed,
so hidden redirect hops cannot escape page accounting. The limits below apply only
to the separately activated diagnostic, not ordinary product scan requirements.

## Responsibilities and prerequisites

`scripts/lib/comparison-audit-control.mjs` is pure state/control logic with one
injected persistence callback. The integration owns all I/O and must:

1. Keep audit configuration disabled until a separate explicit activation.
2. Derive the current full configured Yahoo account list, including aliases,
   from restored, decryptable private state. Never derive it from just the two
   audit targets or a public snapshot timestamp. Rakuma/Mercari refresh is not a
   prerequisite for identifying Yahoo-owned offers.
3. Validate stable Yahoo seller/alias bindings, all retained owned listing IDs,
   and their real source provenance. A missing mapping blocks before any page.
4. Read the current main SHA without writing remotely. Supply trusted event,
   checkout and workflow identities, plus the original run start.
5. Load the complete durable consumption ledger. Missing/corrupt/unreadable
   ledger blocks requested activation. This module **does not initialize it**.
   An initial `{version:1,revision:0,consumed:[]}` may only come from the parent's
   separately validated initialization/migration from restored private state;
   never substitute it on ENOENT, parse, decrypt, restore or publication errors.
6. Perform compare-and-set and durable receipt publication under the existing
   bounded global writer lock before any marketplace request. Keep all consumed
   IDs across restores and publication failures; do not trim the ledger to make
   an old request reusable.
7. Put reservations at the actual Yahoo page transport boundary, after cache
   resolution and existing pacing. All profile, own, search, known-offer and
   candidate-detail attempts share the same controller, including retries and
   individually issued redirect requests. No alternate transport may bypass it.
   The adapter must accurately label page kinds; this pure module cannot inspect
   a network stack or discover an uninstrumented request.
8. Preserve existing rate limits, denial/cooldown persistence, identity/quantity/
   condition gates, ownership exclusions and real quote timestamps. This module
   authorizes neither product matches nor publication nor an extra network path.

## Activation and exactly-once consumption

`comparisonAuditMarker(requestId)` returns the exact marker:

`[price-guard-yahoo-comparison-audit:<requestId>]`

`decideComparisonAuditActivation({activation, context, receipt, now})` is read-only.
`activation` has `enabled`, unique `requestId`, `issuedAt`, `expiresAt`. The expiry
must be later than issuance and no more than two hours later. Times are UTC ISO
strings with whole seconds or three decimal places. Request IDs are 8–128 ASCII
letters/digits/underscore/hyphen, beginning with a letter/digit.

`context` requires:

- `eventName: 'push'`, `ref: 'refs/heads/main'`
- `commitMessage` containing exactly one audit-family marker, matching requestId
- `runId` (positive decimal workflow ID), `runAttempt: 1`
- `expectedSha`, `codeSha`, `eventSha`, `currentMainSha`, all the same 40-character
  lowercase SHA. `expectedSha` is trusted runtime workflow/event context, **not**
  embedded in the activating commit's configuration (which would be self-referential).
- `startedAt`: the original run start, never a new admission/detail clock

The deadline is the earlier of `startedAt + 12 minutes` and activation expiry.
A regular push/cron without the matching explicit marker is inactive even if the
receipt is absent. A matching marker on cron, branch push, rerun, stale SHA,
ambiguous marker, invalid/expired window or consumed ID is blocked. A pure decision
with `admitted:true` is still `active:false`; it cannot create a controller.

`claimComparisonAudit({...options, now, consumeReceipt})` accepts a clock function
(or fixed numeric time for tests). The callback receives `{previousReceipt,
receipt}`. Atomically verify the complete previous receipt, persist the complete
new receipt, and return the exact saved receipt. Return null on conflict or throw
on failure. No admitted controller is returned on missing, failed or unconfirmed
persistence. Delayed persistence cannot reset an expired deadline. A process restart using the persisted state leaves the ID consumed; retry and
restart are intentionally blocked. Local fsync is not a remote durability guarantee:
catastrophic runner loss before cache/artifact publication can lose this local
receipt. Missing restored ledgers fail closed, workflow reruns are blocked, and
current-SHA/expiry checks additionally bound activation. Do not claim global
exactly-once execution across lost storage.

A ledger is `{version:1, revision:N, consumed:[...]}`, with one unique entry per
request and revision equal to entry count. Entries bind requestId, expectedSha,
runId, startedAt, consumedAt and deadlineAt. Keep the returned consumed entry
unchanged. The claim is an in-process capability: a decision, JSON clone, or
consumed receipt cannot impersonate it, and each claim creates at most one
controller (preventing independent 80-page budgets).

## Two-stage ownership and page admission

Create the controller:

```js
const controller = createComparisonAuditController({
  claim, configuredOwnership, expectedAccountIds, sourceStateId,
  targetIds: ['target-a', 'target-b'], now: Date.now, signal: existingRunSignal,
});
```

`configuredOwnership` is:

```js
{
  version: 1,
  sourceStateId: 'verified-restored-private-state-identity',
  accounts: [{
    accountId: 'configured-yahoo-account-or-alias',
    platform: 'yahoo',
    sellerBindingVerified: true,
    sellerIds: ['stable-seller-id'],
    listingIds: ['every-retained-owned-id'],
    provenance: [{
      source: 'actual config/history source reference',
      sourceStateId: 'verified-restored-private-state-identity',
      observedAt: '2026-10-16T12:00:00.000Z',
    }],
  }],
}
```

Every `expectedAccountIds` entry must appear exactly once. The caller must get the
expected set independently from the full current Yahoo configuration. Arrays of
seller IDs are nonempty; listing arrays may be empty only when authoritative
history really is empty. No missing list or provenance is an empty default.

Initially only `kind:'profile'` is admitted, and it needs a configured `accountId`.
Profile reads consume the same 80-page budget. They must finish successfully
before their reservation IDs can prove current ownership. A representative
17-page enumeration leaves **63 total page attempts**, before own/search/detail
reads; the separate 64-detail limit does not create extra page allowance.

Call `controller.setOwnershipIndex(index)` exactly once after full enumeration.
The index has the configured schema above plus `complete:true`, `verifiedAt`, and
for each account `complete:true`, all retained plus currently observed owned IDs,
and:

```js
profile: {
  complete: true,
  observedAt: 'actual earliest original page observation time',
  reservationIds: ['request-id:1', 'request-id:2'],
}
```

The stable seller/alias set must be unchanged. All referenced reservations must be
successful profile reads for the same bound seller; aliases can share the same
actual page evidence. Every successful counted profile page must be represented,
and none may still be in flight. Any failed profile attempt makes the current
enumeration incomplete and blocks finalization; the audit does not repair a
failed page by trusting a caller-provided complete flag. `profile.observedAt` must equal the earliest original source observation among
its referenced pages, matching the existing conservative profile timestamp. It
is never fabricated from transport callback completion. `verifiedAt` is only
assembly time, never a replacement source observation, and cannot predate any
referenced page completion. Both targetIds must belong
to the finalized owned-listing index; the runner must additionally check exact
active target/account binding. Missing/incomplete evidence blocks own/search/known/detail and
candidate freezing. After finalization, no further profile requests are admitted.

`classifyOwnership({id,sellerId,platform:'yahoo'})` returns `owned`, `not_owned`, or
`unknown`. Known owned IDs/sellers are excluded even during bootstrap. It never
returns `not_owned` before ownership is complete or without a seller ID. Unknown
seller candidates can be read to establish identity but are not cleared as external
by this module.

## Immutable candidate set and detail allocation

Once recall and initial eligibility filtering finish, call:

```js
controller.freezeCandidates({
  targets: [
    {targetId:'target-a', candidates:[{id:'candidate-id', sellerId:'seller', url:'source-url'}]},
    {targetId:'target-b', candidates:[]},
  ],
});
```

Exactly two distinct targets must match controller creation. Candidate IDs are
unique within a target. All existing recall requests must have finished. The
controller stamps frozenAt from its actual synchronous freeze clock; omit the
input field. A supplied frozenAt must equal that exact clock instant, otherwise
it is rejected rather than backdated or advanced. The set can only be frozen once. Its stable content hash,
canonical target/candidate ordering, original identities and `frozenAt` are
immutable. Each candidate's later `detailObservedAt` is separate; failures do not
create successful-detail times. New discoveries cannot be added after t0.

- At most 80 actual Yahoo page attempts of all kinds combined.
- At most 64 competitor detail attempts (`known` and `detail` both count).
- Each target starts with 32 detail attempts.
- Only when the other target has no pending **or in-flight** eligible frozen
  candidates may its unused part of 32 transfer. Merely exhausting its own 32
  while unread candidates remain does not release allowance.
- Each target/candidate may be fetched once in this diagnostic. Failed attempts
  remain counted and terminal; this controller does not add a retry policy.
  Cross-target reuse of a shared actual result must use the cache-reuse path.
- `markCandidateIneligible({targetId,candidateId,reason})` records an actual
  exclusion for a pending frozen candidate. Do not use it to manufacture an empty
  donor queue. Already-owned candidates are excluded automatically.
- `recordCacheReuse({targetId,candidateId,observedAt})` resolves an existing cached
  detail without reserving transport; it preserves its original observation time.
  For a non-detail cache reuse, omit both targetId and candidateId. Cache freshness
  and match validity remain the scanner's responsibility.

## Transport-boundary contract

Reserve synchronously immediately before starting transport, after pacing and
cache lookup, with **no await between reservation and transport**:

```js
const permit = controller.reservePageFetch({
  kind: 'detail', transportId: uniqueActualAttemptId,
  targetId: 'target-a', candidateId: 'candidate-id',
});
if (!permit.admitted) return existingBlockedResult(permit.reason);
try {
  const result = await existingTransport();
  controller.finishPageFetch({
    reservationId: permit.reservationId,
    outcome: existingDenialClassifier(result) ? 'denied' : 'ok',
    ...(existingDenialClassifier(result) ? {} : {observedAt: originalPageObservedAt}),
    bytes: measuredBytesOrZero,
  });
  return result;
} catch (error) {
  controller.finishPageFetch({
    reservationId: permit.reservationId,
    outcome: existingCancellationClassifier(error) ? 'cancelled' : 'failed',
  });
  throw error;
}
```

This is a schematic; ensure exactly one finish per reservation, including denial
exceptions, and preserve the existing denial classifier. Transport IDs identify
actual attempts, not callers. Shared cached/in-flight reads must reserve only in
the single actual transport. Duplicate IDs cannot authorize a second fetch.
Pass the original page `observedAt` with successful completion. UTC ISO strings
or numeric epoch milliseconds are preserved without conversion. It must lie
between reservation and callback completion. The separate `finishedAt` records
callback completion only. Missing source time stays null and cannot prove current
profile ownership or a successful detail timestamp. Do not pass source observedAt
for failed/denied/cancelled outcomes. Reservations are never refunded, including
transport errors or source denials.
A rejected admission means no transport starts and is not an attempted page.
If the existing bounds check rejects after reservation but before fetch, complete
that reservation with `{outcome:'cancelled',transportStarted:false}`. Its admission
budget stays spent, but it is not counted as an actual source fetch and cannot
supply ownership evidence. The normal completion default is transportStarted:true.

Call `cancel()` for explicit cancellation. `denied` and `cancelled` completions
stop all subsequent admissions and abort the controller's signal. A valid terminal
outcome for a known pending reservation takes effect before validating ancillary
byte/time metadata. Malformed ancillary metadata is flagged and ignored for that
terminal outcome; it cannot prevent the stop. A caller's
already-aborted signal is checked before each admission. In-flight requests were
already admitted; their results may still be recorded. Forward/merge cancellation
signals and existing original-deadline timeouts into the transport. This module
adds no timer, network collector, concurrency or pacing policy. Every admission
checks the original deadline and fails closed on a regressed/invalid clock.

`snapshot()` returns immutable diagnostics, source-state identity, ownership-ready
state, frozen candidate set, counters, candidate outcomes and request receipts.
`counts.pageReservations` and `competitorDetailReservations` are the conservative
nonrefundable budgets. `pageFetches` and `competitorDetailFetches` count reported
actual transport starts. `byKindReservations` and `byKind` separate those totals;
`outcomes` counts completed reservations, while `actualOutcomes` excludes no-start
reservations. `pendingReservations` is explicit because an in-flight transport
has not yet reported its start status through completion. Each target similarly
exposes detailReservations and actual detailFetches.
`observeImageTransfer({fetches,bytes,durationMs})` records measurements supplied by
existing code only; it never fetches images and does not spend page/detail budget.
These counters and candidate clocks are diagnostic evidence, not quote acceptance.

## Verification

`node --test test/comparison-audit-control.test.mjs` exercises pure, local fixtures
and fake persistence only. No marketplace/source request is used by these tests.
The tests include concurrent claims and reservations, replay prevention, all page
kinds, failed/denied attempts, ownership bootstrap, a 17-page profile enumeration,
full account/alias coverage, budget transfer, cache identity, source-time retention,
stop conditions and observational image metrics. Actual scan/transport/publication coverage is in
`test/scan-comparison-audit-integration.test.mjs`; it uses synthetic network
responses only. Passing local tests does not authorize activation or prove live
market coverage.
