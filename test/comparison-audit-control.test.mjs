import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPARISON_AUDIT_LIMITS as LIMITS,
  comparisonAuditMarker, decideComparisonAuditActivation, claimComparisonAudit,
  createComparisonAuditController, freezeComparisonAuditCandidates,
} from '../scripts/lib/comparison-audit-control.mjs';

const START = Date.parse('2026-10-16T12:00:00Z');
const iso = value => new Date(value).toISOString();
const SHA = 'a'.repeat(40), SOURCE = 'restored-private-state:fixture-1';
const activation = () => ({ enabled: true, requestId: 'fixture-audit-20261016', issuedAt: iso(START - 60_000), expiresAt: iso(START + 60 * 60_000) });
const context = () => ({ eventName: 'push', ref: 'refs/heads/main', runId: '123', runAttempt: 1, expectedSha: SHA, codeSha: SHA, eventSha: SHA, currentMainSha: SHA, startedAt: iso(START), commitMessage: `fixture ${comparisonAuditMarker(activation().requestId)}` });
const receipt = () => ({ version: 1, revision: 0, consumed: [] });
const options = () => ({ activation: activation(), context: context(), receipt: receipt(), now: START });
const accountIds = ['yahoo-a', 'yahoo-b', 'yahoo-alias'];
const configured = () => ({ version: 1, sourceStateId: SOURCE, accounts: accountIds.map((accountId, i) => ({ accountId, platform: 'yahoo', sellerBindingVerified: true, sellerIds: [`own-seller-${i}`], listingIds: [`retained-own-${i}`, ...(i === 0 ? ['a'] : i === 1 ? ['b'] : [])], provenance: [{ source: 'restored configuration and owned-listing history', sourceStateId: SOURCE, observedAt: iso(START - 3_600_000) }] })) });
const candidates = (a = 40, b = 40) => ({ frozenAt: iso(START), targets: [{ targetId: 'a', candidates: Array.from({ length: a }, (_, i) => ({ id: `a-${i}`, sellerId: 'external-a' })) }, { targetId: 'b', candidates: Array.from({ length: b }, (_, i) => ({ id: `b-${i}`, sellerId: 'external-b' })) }] });
async function bootstrap({ clock = () => START, signal, mapping = configured() } = {}) {
  const claim = await claimComparisonAudit({ ...options(), now: clock, consumeReceipt: async ({ receipt: next }) => next });
  const controller = createComparisonAuditController({ claim, configuredOwnership: mapping, expectedAccountIds: accountIds, sourceStateId: SOURCE, targetIds: ['a', 'b'], now: clock, signal });
  return { controller, claim };
}
function profileIndex(controller, mapping = configured(), pages = [1, 1, 1]) {
  return { ...mapping, complete: true, verifiedAt: iso(START), accounts: mapping.accounts.map((account, i) => {
    const reservationIds = [];
    for (let p = 0; p < pages[i]; p++) {
      const permit = controller.reservePageFetch({ kind: 'profile', accountId: account.accountId, transportId: `profile-${i}-${p}` });
      assert.equal(permit.admitted, true);
      controller.finishPageFetch({ reservationId: permit.reservationId, outcome: 'ok', observedAt: iso(START) });
      reservationIds.push(permit.reservationId);
    }
    return { ...account, complete: true, listingIds: [...account.listingIds, `current-own-${i}`], profile: { complete: true, observedAt: iso(START), reservationIds } };
  }) };
}
async function ready({ a = 40, b = 40, ...opts } = {}) {
  const result = await bootstrap(opts);
  result.controller.setOwnershipIndex(profileIndex(result.controller));
  result.controller.freezeCandidates(candidates(a, b));
  return result.controller;
}
function detail(controller, targetId, i, outcome = 'ok', kind = 'detail') {
  const permit = controller.reservePageFetch({ kind, targetId, candidateId: `${targetId}-${i}`, transportId: `${kind}-${targetId}-${i}` });
  if (permit.admitted) controller.finishPageFetch({ reservationId: permit.reservationId, outcome, ...(outcome === 'ok' ? { observedAt: controller.snapshot().requests.find(request => request.reservationId === permit.reservationId).startedAt } : {}) });
  return permit;
}

test('configuration is opt-in and ordinary cron/push without a matching marker remains inactive even with broken receipt', () => {
  for (const eventName of ['schedule', 'push', 'workflow_dispatch']) {
    const result = decideComparisonAuditActivation({ ...options(), context: { ...context(), eventName, commitMessage: 'ordinary change' }, receipt: null });
    assert.equal(result.requested, false); assert.equal(result.reason, 'no_matching_marker');
  }
  assert.equal(decideComparisonAuditActivation({ ...options(), activation: { ...activation(), enabled: false } }).reason, 'disabled');
  assert.equal(decideComparisonAuditActivation({ ...options(), context: { ...context(), commitMessage: comparisonAuditMarker('unrelated-request') } }).requested, false);
});

test('one matching unique marker, initial push run and exact current main SHA are all mandatory', () => {
  const base = options();
  assert.equal(decideComparisonAuditActivation(base).admitted, true);
  for (const commitMessage of [context().commitMessage.repeat(2), `${context().commitMessage} ${comparisonAuditMarker('another-request')}`, `${context().commitMessage} [price-guard-yahoo-comparison-audit:broken`]) assert.equal(decideComparisonAuditActivation({ ...base, context: { ...context(), commitMessage } }).reason, 'ambiguous_marker');
  for (const changes of [{ eventName: 'schedule' }, { eventName: 'workflow_dispatch' }, { ref: 'refs/heads/topic' }]) assert.equal(decideComparisonAuditActivation({ ...base, context: { ...context(), ...changes } }).reason, 'not_main_push');
  for (const runAttempt of [2, '2', 0, null, '01']) assert.equal(decideComparisonAuditActivation({ ...base, context: { ...context(), runAttempt } }).reason, 'rerun_forbidden');
  for (const field of ['expectedSha', 'codeSha', 'eventSha', 'currentMainSha']) assert.equal(decideComparisonAuditActivation({ ...base, context: { ...context(), [field]: 'b'.repeat(40) } }).reason, 'unexpected_main_sha');
});

test('activation expires within two hours and original twelve-minute deadline never resets', () => {
  assert.equal(LIMITS.durationMs, 720_000); assert.equal(LIMITS.activationTtlMs, 7_200_000);
  for (const changes of [{ expiresAt: iso(START + 3 * 3_600_000) }, { expiresAt: 'bad' }, { issuedAt: '2026-02-30T12:00:00Z' }]) assert.equal(decideComparisonAuditActivation({ ...options(), activation: { ...activation(), ...changes } }).reason, 'invalid_activation_window');
  assert.equal(decideComparisonAuditActivation({ ...options(), now: START + LIMITS.durationMs }).reason, 'deadline_exceeded');
  assert.equal(decideComparisonAuditActivation({ ...options(), context: { ...context(), startedAt: iso(START + 1) } }).reason, 'invalid_original_start');
  assert.equal(decideComparisonAuditActivation({ ...options(), activation: { ...activation(), expiresAt: iso(START + 100) } }).audit.deadlineAt, iso(START + 100));
});

test('missing/corrupt receipt blocks requested activation and no empty-on-error initialization exists', async () => {
  for (const prior of [undefined, null, {}, [], { version: 1, revision: 1, consumed: [] }, { version: 1, revision: 0, consumed: null }]) {
    let writes = 0;
    const result = await claimComparisonAudit({ ...options(), receipt: prior, consumeReceipt: () => { writes++; } });
    assert.equal(result.reason, 'missing_or_corrupt_receipt'); assert.equal(writes, 0);
  }
});

test('durable consumption gates controller creation and persisted receipt prevents reuse across SHA/run changes', async () => {
  const proposal = decideComparisonAuditActivation(options());
  assert.throws(() => createComparisonAuditController({ claim: proposal }), /durably consumed/);
  assert.equal((await claimComparisonAudit(options())).reason, 'receipt_persistence_required');
  assert.equal((await claimComparisonAudit({ ...options(), consumeReceipt: async () => { throw Error('disk error'); } })).reason, 'receipt_persistence_failed');
  for (const saved of [null, receipt(), { ...proposal.receipt, revision: 99 }]) assert.equal((await claimComparisonAudit({ ...options(), consumeReceipt: async () => saved })).reason, 'receipt_persistence_unconfirmed');
  const claimed = await claimComparisonAudit({ ...options(), consumeReceipt: async ({ receipt: next }) => next });
  assert.equal(claimed.active, true);
  assert.equal(decideComparisonAuditActivation({ ...options(), receipt: claimed.receipt, context: { ...context(), runId: '124' } }).reason, 'request_already_consumed');
  const newer = 'b'.repeat(40);
  assert.equal(decideComparisonAuditActivation({ ...options(), receipt: claimed.receipt, context: { ...context(), expectedSha: newer, codeSha: newer, eventSha: newer, currentMainSha: newer } }).reason, 'request_already_consumed');
});

test('atomic compare-and-set admits only one concurrent claimant; delayed persistence cannot restart deadline', async () => {
  let stored = receipt();
  const consumeReceipt = async ({ previousReceipt, receipt: next }) => { if (JSON.stringify(stored) !== JSON.stringify(previousReceipt)) return null; stored = next; return next; };
  const results = await Promise.all([claimComparisonAudit({ ...options(), consumeReceipt }), claimComparisonAudit({ ...options(), consumeReceipt })]);
  assert.equal(results.filter(row => row.active).length, 1);
  let clock = START;
  const delayed = await claimComparisonAudit({ ...options(), now: () => clock, consumeReceipt: async ({ receipt: next }) => { clock += LIMITS.durationMs; return next; } });
  assert.equal(delayed.active, false); assert.equal(delayed.consumed, true);
});

test('a claim cannot create two independent eighty-page controllers', async () => {
  const { claim } = await bootstrap();
  assert.throws(() => createComparisonAuditController({ claim, configuredOwnership: configured(), expectedAccountIds: accountIds, sourceStateId: SOURCE, targetIds: ['a', 'b'], now: () => START }), /fresh durably consumed/);
});

test('full configured Yahoo seller and alias mapping is required before even profile admission', async () => {
  for (const mutate of [mapping => { mapping.accounts.pop(); }, mapping => { mapping.accounts[0].platform = 'unknown'; }, mapping => { mapping.accounts[0].sellerIds = []; }, mapping => { mapping.accounts[0].sellerBindingVerified = false; }, mapping => { mapping.accounts[0].provenance = []; }, mapping => { mapping.sourceStateId = 'public-snapshot-time'; }]) {
    const mapping = configured(); mutate(mapping);
    await assert.rejects(bootstrap({ mapping }), /ownership|Ownership|mapping|provenance/);
  }
});

test('bootstrap admits and counts profile pages only; seventeen pages remain inside eighty', async () => {
  const { controller } = await bootstrap();
  assert.equal(controller.classifyOwnership({ id: 'external', sellerId: 'external' }), 'unknown');
  assert.equal(controller.classifyOwnership({ id: 'retained-own-0' }), 'owned');
  for (const kind of ['own', 'search', 'known', 'detail']) assert.equal(controller.reservePageFetch({ kind, transportId: kind }).reason, 'ownership_incomplete');
  assert.equal(controller.reservePageFetch({ kind: 'profile', transportId: 'unknown', accountId: 'not-configured' }).reason, 'unknown_profile_account');
  assert.throws(() => controller.freezeCandidates(candidates()), /Complete ownership/);
  const index = profileIndex(controller, configured(), [6, 6, 5]);
  assert.equal(controller.snapshot().counts.pageFetches, 17);
  controller.setOwnershipIndex(index);
  assert.equal(controller.snapshot().ownershipReady, true);
  assert.equal(controller.classifyOwnership({ id: 'external', sellerId: 'external' }), 'not_owned');
  assert.equal(controller.classifyOwnership({ id: 'current-own-1' }), 'owned');
  assert.equal(controller.reservePageFetch({ kind: 'profile', accountId: accountIds[0], transportId: 'late-profile' }).reason, 'ownership_already_finalized');
});

test('ownership cannot omit aliases/history or fake current profile evidence outside counted fetches', async () => {
  const { controller } = await bootstrap();
  const index = profileIndex(controller);
  for (const mutate of [copy => { copy.complete = false; }, copy => { copy.accounts.pop(); }, copy => { copy.accounts[0].listingIds = []; }, copy => { copy.accounts[0].sellerIds = ['different-seller']; }, copy => { copy.accounts[0].profile.complete = false; }, copy => { copy.accounts[0].profile.observedAt = iso(START - 1); }, copy => { copy.accounts[0].profile.reservationIds = ['made-up']; }, copy => { copy.accounts[0].profile.reservationIds = index.accounts[1].profile.reservationIds; }]) {
    const copy = structuredClone(index); mutate(copy);
    assert.throws(() => controller.setOwnershipIndex(copy));
    assert.equal(controller.snapshot().ownershipReady, false);
  }
  controller.setOwnershipIndex(index);
  assert.throws(() => controller.setOwnershipIndex(index), /already finalized/);
});

test('failed or omitted profile pages cannot masquerade as full current evidence', async () => {
  const { controller } = await bootstrap();
  const index = profileIndex(controller);
  const extra = controller.reservePageFetch({ kind: 'profile', transportId: 'extra-profile', accountId: accountIds[0] });
  assert.throws(() => controller.setOwnershipIndex(index), /in flight/);
  controller.finishPageFetch({ reservationId: extra.reservationId, outcome: 'ok', observedAt: iso(START) });
  assert.throws(() => controller.setOwnershipIndex(index), /omitted/);
  index.accounts[0].profile.reservationIds.push(extra.reservationId);
  controller.setOwnershipIndex(index);
  assert.equal(controller.snapshot().counts.pageFetches, 4);
});

test('all actual page paths including errors share eighty reservations; cache reuse does not count', async () => {
  const controller = await ready();
  controller.recordCacheReuse({ observedAt: iso(START - 60_000) });
  for (let i = 0; i < 10; i++) assert.equal(detail(controller, 'a', i, i % 2 ? 'failed' : 'ok', i % 2 ? 'known' : 'detail').admitted, true);
  for (let i = 0; i < 67; i++) {
    const permit = controller.reservePageFetch({ kind: i % 2 ? 'own' : 'search', transportId: `other-${i}` });
    assert.equal(permit.admitted, true);
    controller.finishPageFetch({ reservationId: permit.reservationId, outcome: i % 2 ? 'ok' : 'failed' });
  }
  const snap = controller.snapshot();
  assert.equal(snap.counts.pageFetches, 80); assert.equal(snap.counts.competitorDetailFetches, 10); assert.equal(snap.counts.cacheReuses, 1);
  assert.equal(Object.values(snap.counts.byKind).reduce((a, b) => a + b), 80);
  assert.equal(controller.reservePageFetch({ kind: 'search', transportId: 'over-budget' }).reason, 'page_budget_exhausted');
  assert.equal(controller.snapshot().counts.pageFetches, 80);
});

test('synchronous reservations cannot overshoot a budget under overlapping async transports', async () => {
  const controller = await ready();
  const permits = await Promise.all(Array.from({ length: 100 }, async (_, i) => controller.reservePageFetch({ kind: 'search', transportId: `parallel-${i}` })));
  assert.equal(permits.filter(row => row.admitted).length, 77);
  assert.equal(controller.snapshot().counts.pageReservations, 80);
  assert.equal(controller.snapshot().counts.pageFetches, 3);
  assert.equal(controller.snapshot().counts.pendingReservations, 77);
});

test('both targets start at thirty-two and transfer only after the other has no eligible candidates or in-flight fetches', async () => {
  const controller = await ready({ a: 64, b: 2 });
  for (let i = 0; i < 32; i++) assert.equal(detail(controller, 'a', i).admitted, true);
  assert.equal(detail(controller, 'a', 32).reason, 'target_allowance_exhausted');
  detail(controller, 'b', 0);
  const inFlight = controller.reservePageFetch({ kind: 'known', targetId: 'b', candidateId: 'b-1', transportId: 'b-last' });
  assert.equal(detail(controller, 'a', 32).reason, 'target_allowance_exhausted');
  controller.finishPageFetch({ reservationId: inFlight.reservationId, outcome: 'ok' });
  for (let i = 32; i < 62; i++) assert.equal(detail(controller, 'a', i).admitted, true);
  assert.equal(detail(controller, 'a', 62).reason, 'detail_budget_exhausted');
  const snap = controller.snapshot();
  assert.equal(snap.counts.competitorDetailFetches, 64); assert.equal(snap.targets.a.allowance, 62); assert.equal(snap.targets.b.detailFetches, 2);
});

test('unread candidates prevent transfer even when donor exhausted its own thirty-two', async () => {
  const controller = await ready();
  for (const target of ['a', 'b']) for (let i = 0; i < 32; i++) detail(controller, target, i);
  assert.equal(controller.snapshot().targets.a.allowance, 32);
  assert.equal(controller.snapshot().targets.b.remainingEligible, 8);
  assert.equal(detail(controller, 'a', 32).reason, 'detail_budget_exhausted');
});

test('cached/ineligible/owned candidates consume no fetch and can release unused allowance', async () => {
  const { controller } = await bootstrap();
  controller.setOwnershipIndex(profileIndex(controller));
  const set = candidates(64, 3); set.targets[1].candidates[0].sellerId = 'own-seller-2';
  controller.freezeCandidates(set);
  assert.equal(detail(controller, 'b', 0).reason, 'candidate_not_eligible');
  controller.markCandidateIneligible({ targetId: 'b', candidateId: 'b-1', reason: 'wrong quantity after title exclusion' });
  controller.recordCacheReuse({ targetId: 'b', candidateId: 'b-2', observedAt: iso(START - 60_000) });
  for (let i = 0; i < 64; i++) assert.equal(detail(controller, 'a', i).admitted, true);
  const snap = controller.snapshot();
  assert.equal(snap.counts.pageFetches, 67); assert.equal(snap.counts.competitorDetailFetches, 64);
  assert.equal(snap.targets.b.candidates[2].detailObservedAt, iso(START - 60_000));
});

test('frozen identity and t0 remain distinct from later actual detail times and input mutation', async () => {
  let at = START;
  const controller = await ready({ clock: () => at });
  const original = controller.snapshot().candidateSet;
  at += 10_000; detail(controller, 'a', 0);
  const later = controller.snapshot();
  assert.deepEqual(later.candidateSet, original);
  assert.equal(later.candidateSet.frozenAt, iso(START));
  assert.equal(later.targets.a.candidates[0].detailObservedAt, iso(at));
  assert.throws(() => controller.freezeCandidates(candidates()), /already frozen/);
  assert.throws(() => { later.candidateSet.targets[0].candidates[0].id = 'mutated'; }, TypeError);
  assert.equal(controller.reservePageFetch({ kind: 'detail', targetId: 'a', candidateId: 'new-discovered-after-t0', transportId: 'unfrozen' }).reason, 'candidate_not_frozen');
  assert.equal(freezeComparisonAuditCandidates(candidates()).identity, freezeComparisonAuditCandidates({ ...candidates(), targets: candidates().targets.reverse() }).identity);
});

test('same transport/candidate cannot reserve twice and a failed attempt never refunds admission', async () => {
  const controller = await ready();
  detail(controller, 'a', 0, 'failed');
  assert.equal(detail(controller, 'a', 0).reason, 'duplicate_transport_id');
  assert.equal(controller.reservePageFetch({ kind: 'known', targetId: 'a', candidateId: 'a-0', transportId: 'retry' }).reason, 'candidate_not_eligible');
  assert.equal(controller.snapshot().counts.competitorDetailFetches, 1);
  assert.equal(controller.reservePageFetch({ kind: 'search', targetId: 'a', candidateId: 'a-1', transportId: 'wrong-kind' }).reason, 'misclassified_competitor_detail');
});

test('source denial and cancellation count attempted request then stop all subsequent admissions', async () => {
  for (const outcome of ['denied', 'cancelled']) {
    const controller = await ready(); detail(controller, 'a', 0, outcome);
    const snap = controller.snapshot();
    assert.equal(snap.counts.pageFetches, 4); assert.equal(snap.counts.outcomes[outcome], 1); assert.equal(controller.signal.aborted, true);
    assert.equal(controller.reservePageFetch({ kind: 'search', transportId: 'after-stop' }).admitted, false);
  }
  const outer = new AbortController(); const controller = await ready({ signal: outer.signal });
  outer.abort(); assert.equal(controller.reservePageFetch({ kind: 'search', transportId: 'after-external-cancel' }).reason, 'cancelled');
  assert.equal(controller.snapshot().counts.pageFetches, 3);
});

test('original deadline and backwards/invalid clock fail closed without moving source dates', async () => {
  let at = START; const controller = await ready({ clock: () => at });
  at = START + LIMITS.durationMs;
  assert.equal(controller.reservePageFetch({ kind: 'search', transportId: 'late' }).reason, 'deadline_exceeded');
  assert.equal(controller.snapshot().candidateSet.frozenAt, iso(START));
  let backward = START; const regressed = await ready({ clock: () => backward }); backward--;
  assert.equal(regressed.reservePageFetch({ kind: 'search', transportId: 'backwards' }).reason, 'invalid_or_regressed_clock');
});

test('observational image metrics do not implement fetching or change page/detail admission', async () => {
  const controller = await ready();
  controller.observeImageTransfer({ fetches: 2, bytes: 5000, durationMs: 20 });
  const snap = controller.snapshot();
  assert.equal(snap.counts.imageFetches, 2); assert.equal(snap.counts.imageBytes, 5000); assert.equal(snap.counts.imageWallMs, 20); assert.equal(snap.counts.pageFetches, 3);
  assert.throws(() => controller.observeImageTransfer({ bytes: -1 }), /Invalid image/);
});


test('request IDs cannot change type to replay the identical textual commit marker', async () => {
  assert.throws(() => comparisonAuditMarker(12345678), /Invalid/);
  const bad = { ...activation(), requestId: 12345678 };
  const run = { ...context(), commitMessage: '[price-guard-yahoo-comparison-audit:12345678]' };
  assert.equal(decideComparisonAuditActivation({ ...options(), activation: bad, context: run }).reason, 'invalid_activation');
  const numericPrior = { version: 1, revision: 1, consumed: [{ requestId: 12345678, expectedSha: SHA, runId: '123', startedAt: iso(START), consumedAt: iso(START), deadlineAt: iso(START + LIMITS.durationMs) }] };
  assert.equal(decideComparisonAuditActivation({ ...options(), activation: { ...bad, requestId: '12345678' }, context: run, receipt: numericPrior }).reason, 'missing_or_corrupt_receipt');
});

test('an omitted failed profile page blocks complete ownership even if other pages succeeded', async () => {
  const { controller } = await bootstrap();
  const index = profileIndex(controller);
  const failed = controller.reservePageFetch({ kind: 'profile', transportId: 'failed-profile-page', accountId: accountIds[0] });
  controller.finishPageFetch({ reservationId: failed.reservationId, outcome: 'failed' });
  assert.throws(() => controller.setOwnershipIndex(index), /Failed profile enumeration/);
  assert.equal(controller.reservePageFetch({ kind: 'search', transportId: 'after-incomplete-enumeration' }).reason, 'ownership_incomplete');
  assert.equal(controller.snapshot().counts.pageFetches, 4);
});


test('candidate t0 is the actual synchronous freeze after recall, never a backdated run-start clock', async () => {
  let at = START; const { controller } = await bootstrap({ clock: () => at });
  controller.setOwnershipIndex(profileIndex(controller));
  const pending = controller.reservePageFetch({ kind: 'search', transportId: 'pending-recall' });
  assert.throws(() => controller.freezeCandidates(candidates()), /still in flight/);
  at += 10_000; controller.finishPageFetch({ reservationId: pending.reservationId, outcome: 'ok' });
  assert.throws(() => controller.freezeCandidates(candidates()), /backdated/);
  const frozen = controller.freezeCandidates({ targets: candidates().targets });
  assert.equal(frozen.frozenAt, iso(at));
  at += 1000; detail(controller, 'a', 0);
  assert.equal(controller.snapshot().candidateSet.frozenAt, iso(START + 10_000));
  assert.equal(controller.snapshot().targets.a.candidates[0].detailObservedAt, iso(at));
});


test('profile time preserves earliest original source observation rather than callback completion', async () => {
  let at = START; const { controller } = await bootstrap({ clock: () => at });
  const mapping = configured();
  const index = { ...mapping, complete: true, accounts: mapping.accounts.map((account, i) => {
    const reservationIds = []; let earliest = Infinity;
    for (let p = 0; p < (i === 0 ? 2 : 1); p++) {
      const permit = controller.reservePageFetch({ kind: 'profile', accountId: account.accountId, transportId: `timed-profile-${i}-${p}` });
      at += 100; const observedAt = at; earliest = Math.min(earliest, observedAt);
      at += 50; controller.finishPageFetch({ reservationId: permit.reservationId, outcome: 'ok', observedAt });
      reservationIds.push(permit.reservationId);
    }
    return { ...account, complete: true, profile: { complete: true, observedAt: earliest, reservationIds } };
  }) };
  index.verifiedAt = iso(at);
  const wrong = structuredClone(index); wrong.accounts[0].profile.observedAt = START + 300;
  assert.throws(() => controller.setOwnershipIndex(wrong), /earliest original/);
  controller.setOwnershipIndex(index);
  const requests = controller.snapshot().requests;
  assert.equal(requests[0].observedAt, START + 100);
  assert.equal(requests[0].finishedAt, iso(START + 150));
  assert.equal(index.accounts[0].profile.observedAt, START + 100);
});

test('missing original profile observation cannot be replaced by finish or verification time', async () => {
  const { controller } = await bootstrap(); const index = profileIndex(controller);
  const permit = controller.reservePageFetch({ kind: 'profile', accountId: accountIds[0], transportId: 'missing-source-time' });
  controller.finishPageFetch({ reservationId: permit.reservationId, outcome: 'ok' });
  index.accounts[0].profile.reservationIds.push(permit.reservationId);
  assert.throws(() => controller.setOwnershipIndex(index), /successful counted account read/);
});

test('arbitrary external targets cannot pass the owned-target prerequisite', async () => {
  const claim = await claimComparisonAudit({ ...options(), consumeReceipt: async ({ receipt: next }) => next });
  const controller = createComparisonAuditController({ claim, configuredOwnership: configured(), expectedAccountIds: accountIds, sourceStateId: SOURCE, targetIds: ['a', 'external-target'], now: () => START });
  assert.throws(() => controller.setOwnershipIndex(profileIndex(controller)), /targets must belong/);
  assert.equal(controller.snapshot().ownershipReady, false);
});


test('denial/cancellation latches before malformed ancillary source times or byte metrics', async () => {
  for (const outcome of ['denied', 'cancelled']) for (const metadata of [{ observedAt: iso(START) }, { bytes: -1 }, { bytes: NaN, observedAt: 'bad' }]) {
    const controller = await ready();
    const permit = controller.reservePageFetch({ kind: 'detail', targetId: 'a', candidateId: 'a-0', transportId: 'terminal-with-metadata' });
    const result = controller.finishPageFetch({ reservationId: permit.reservationId, outcome, ...metadata });
    assert.equal(result.outcome, outcome); assert.equal(result.observedAt, null); assert.equal(result.invalidAncillaryMetadata, true);
    assert.equal(controller.signal.aborted, true);
    assert.equal(controller.reservePageFetch({ kind: 'search', transportId: 'after-terminal' }).admitted, false);
    assert.equal(controller.snapshot().counts.outcomes[outcome], 1);
    assert.equal(controller.snapshot().counts.pageFetches, 4);
  }
});

test('ownership assembly time cannot predate the later profile page completion', async () => {
  let at = START; const { controller } = await bootstrap({ clock: () => at });
  const index = profileIndex(controller);
  const permit = controller.reservePageFetch({ kind: 'profile', accountId: accountIds[0], transportId: 'later-page' });
  at += 1000; controller.finishPageFetch({ reservationId: permit.reservationId, outcome: 'ok', observedAt: at });
  index.accounts[0].profile.reservationIds.push(permit.reservationId);
  assert.throws(() => controller.setOwnershipIndex(index), /verification predates/);
  index.verifiedAt = iso(at); controller.setOwnershipIndex(index);
  assert.equal(index.accounts[0].profile.observedAt, iso(START));
});


test('a reservation cancelled before transport stays spent but is not called a real fetch', async () => {
  let at = START; const controller = await ready({ clock: () => at });
  const permit = controller.reservePageFetch({ kind: 'detail', targetId: 'a', candidateId: 'a-0', transportId: 'deadline-during-hook' });
  at += LIMITS.durationMs;
  const result = controller.finishPageFetch({ reservationId: permit.reservationId, outcome: 'cancelled', transportStarted: false });
  const snap = controller.snapshot();
  assert.equal(result.transportStarted, false); assert.equal(result.observedAt, null);
  assert.equal(snap.counts.pageReservations, 4); assert.equal(snap.counts.pageFetches, 3);
  assert.equal(snap.counts.competitorDetailReservations, 1); assert.equal(snap.counts.competitorDetailFetches, 0);
  assert.equal(snap.counts.byKindReservations.detail, 1); assert.equal(snap.counts.byKind.detail, 0);
  assert.equal(snap.counts.outcomes.cancelled, 1); assert.equal(snap.counts.actualOutcomes.cancelled, 0);
  assert.equal(snap.targets.a.detailReservations, 1); assert.equal(snap.targets.a.detailFetches, 0);
  assert.equal(snap.counts.pendingReservations, 0);
  assert.equal(controller.reservePageFetch({ kind: 'search', transportId: 'after-no-transport' }).admitted, false);
});

test('a never-started profile reservation cannot claim successful source evidence', async () => {
  const { controller } = await bootstrap();
  const permit = controller.reservePageFetch({ kind: 'profile', accountId: accountIds[0], transportId: 'no-profile-transport' });
  assert.throws(() => controller.finishPageFetch({ reservationId: permit.reservationId, outcome: 'ok', transportStarted: false, observedAt: iso(START) }), /without transport/);
  controller.finishPageFetch({ reservationId: permit.reservationId, outcome: 'cancelled', transportStarted: false });
  assert.equal(controller.snapshot().counts.pageReservations, 1);
  assert.equal(controller.snapshot().counts.pageFetches, 0);
});
