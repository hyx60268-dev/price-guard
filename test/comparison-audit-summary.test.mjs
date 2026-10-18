import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { summarizeSavedComparisonAudit, SAVED_COMPARISON_AUDIT as P } from '../scripts/lib/comparison-audit-summary.mjs';
import { createSavedComparisonAuditFixture } from './fixtures/saved-comparison-audit.fixture.mjs';

const NOW = Date.parse('2026-10-18T02:43:00.000Z');
const summarize = state => summarizeSavedComparisonAudit(state, { now: NOW });
const original = await createSavedComparisonAuditFixture();
const copy = () => structuredClone(original);
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

// The fixture uses the real control/runner/classifier/verifier pipeline, with
// wholly synthetic observations and no network, filesystem, or credential input.
test('genuine saved runner report yields original counts and separate cache, attempt, and paired evidence', () => {
  const state = copy(), before = structuredClone(state), result = summarize(freeze(state));
  assert.equal(result.valid, true);
  assert.deepEqual(state, before, 'must not mutate or freeze supplied data');
  assert.deepEqual(result.counts, state.comparisonAudit.counts);
  assert.equal(result.counts.total, 8); assert.equal(result.counts.paired, 6);
  assert.equal(result.counts.detailAttempted, 4); assert.equal(result.counts.unpaired, 2);
  assert.equal(result.transport.competitorDetailFetches, 4); assert.equal(result.transport.cacheReuses, 2);
  assert.deepEqual(result.crossTarget, { duplicateCandidateIds: 2, eligibleIntersectionCandidateIds: 2,
    pairedIntersectionCandidateIds: 2, uniqueCandidateIds: 6 });
  assert.deepEqual(result.targets.map(target => target.targetId), P.targetIds);
  for (const target of result.targets) {
    assert.deepEqual(target.baseline.rejectedReasonHistogram, { not_open: 1, sale_unit_mismatch: 1 });
    assert.equal(Object.values(target.cardFirst.reasonHistogram).reduce((a, b) => a + b, 0), target.counts.total);
    assert.equal(Object.values(target.lowPriceBands).reduce((sum, band) => sum + band.total, 0), target.counts.total);
  }
  const [left, right] = result.targets.map(target => target.knownCandidate);
  assert.equal(left.id, P.knownCandidateId); assert.equal(left.baselineReason, 'not_open');
  assert.equal(right.detailAttempted, false); assert.equal(right.paired, true);
  assert.equal(right.detailObservation.fromCache, true);
  assert.equal(left.detailObservation.observedAt, right.detailObservation.observedAt);
  assert.notEqual(left.cardObservations[0].observedAt, left.detailObservation.observedAt);
  assert.equal(result.source.checkedAt, P.snapshotAt);
  assert.equal(result.checkedAt, undefined); assert.equal(result.diagnosticObservedAt, undefined);
  assert.match(result.interpretation.join(' '), /shared source listing only/);
  assert.match(result.interpretation.join(' '), /No precision, recall/);
});

test('does not freeze mutable input or return aliases into private state', () => {
  const state = copy(), result = summarize(state);
  assert.equal(Object.isFrozen(state), false); assert.equal(Object.isFrozen(state.comparisonAudit), false);
  result.counts.total = -1; result.targets[0].counts.total = -1; result.source.checkedAt = 'changed';
  assert.deepEqual(state, original);
});

test('genuine budget exhaustion stays unresolved and does not fabricate precision or recall', async () => {
  const state = await createSavedComparisonAuditFixture({ overflow: true }), result = summarize(state);
  assert.equal(result.valid, true); assert.equal(result.status, 'incomplete');
  assert.equal(result.stopReason, 'detail_budget_exhausted'); assert.equal(result.counts.paired, 64);
  assert.equal(result.counts.eligibleUnpaired, 16); assert.equal(result.counts.detailAttempted, 64);
  for (const target of result.targets) {
    assert.deepEqual(target.knownCandidate, { present: false });
    assert.equal(target.unpairedReasonHistogram.detail_budget_exhausted, 8);
    assert.equal(target.lowPriceBands.below_25_percent.eligibleUnpaired, 8);
  }
  const forbidden = ['precision', 'recall', 'falsePositiveRate', 'falseNegativeRate'];
  for (const key of forbidden) assert.equal(result[key], undefined);
});

test('band boundaries preserve recorded lower status; unknown and conflicting bands stay unresolved', async () => {
  const result = summarize(await createSavedComparisonAuditFixture({ configureTargets(targets) {
    const first = targets[0].ownBundle.recommendationReceipt;
    first.cards.push({ ...first.cards[0], price: 4000 }); first.totalCards++;
    const second = targets[1].ownBundle.recommendationReceipt;
    second.cards[0].priceKind = 'coupon';
  } }));
  assert.equal(result.valid, true);
  assert.equal(result.targets[0].counts.duplicates, 1);
  assert.equal(result.targets[0].lowPriceBands.unresolved_price_or_band.total, 1);
  assert.equal(result.targets[1].lowPriceBands.unresolved_price_or_band.total, 1);
  assert.equal(result.targets[1].lowPriceBands['25_to_below_50_percent'].total, 1);
  assert.equal(result.targets[0].lowPriceBands['50_to_below_75_percent'].total, 1);
  assert.equal(result.targets[0].lowPriceBands['75_to_below_100_percent'].total, 1);
  assert.equal(result.targets[0].lowPriceBands.confirmed_not_lower.total, 1);
});

test('unknown reason codes and malicious descriptions/headers cannot leak through safe aggregates', () => {
  const state = copy(), sentinel = 'PRIVATE_SECRET_ACCOUNT_HEADER_DESCRIPTION';
  const report = state.comparisonAudit;
  state.secret = sentinel; state.accounts = [{ id: sentinel, sellerIds: [sentinel] }];
  report.headers = { authorization: sentinel }; report.limitations = [sentinel]; report.phaseTimingMeaning = sentinel;
  report.counts[sentinel] = sentinel; report.controller.counts[sentinel] = sentinel;
  for (const target of report.targets) {
    target.ownObservation.description = sentinel; target.ownObservation.title = sentinel;
    for (const card of target.recommendationReceipt.cards) card.title = card.text = sentinel;
    for (const row of target.rows) {
      for (const card of row.cardObservations) card.title = card.text = sentinel;
      if (row.cardFirst) { row.cardFirst.reason = sentinel; if (row.cardFirst.observation) row.cardFirst.observation.title = sentinel; }
      if (row.baseline) row.baseline.reason = sentinel;
      if (row.detailObservation) row.detailObservation.description = row.detailObservation.title = sentinel;
      if (!row.paired) row.unpairedReason = sentinel;
    }
  }
  const result = summarize(state), output = JSON.stringify(result);
  assert.equal(result.valid, true); assert.equal(output.includes(sentinel), false);
  assert.equal(output.includes('synthetic-external'), false); assert.equal(output.includes('synthetic-shared'), false);
  assert.equal(output.includes('synthetic-owner'), false); assert.equal(output.includes('authorization'), false);
  assert.equal(result.targets[0].cardFirst.reasonHistogram.unknown_reason, 4);
  assert.equal(result.targets[0].baseline.rejectedReasonHistogram.unknown_reason, 2);
  assert.equal(result.targets[0].knownCandidate.baselineReason, 'unknown_reason');
});

test('prototype-looking reasons are data, never output keys', () => {
  const state = copy();
  state.comparisonAudit.targets[0].rows[0].cardFirst.reason = '__proto__';
  state.comparisonAudit.targets[0].rows[0].baseline.reason = 'constructor';
  const result = summarize(state);
  assert.equal(result.valid, true); assert.equal(result.targets[0].cardFirst.reasonHistogram.unknown_reason, 1);
  assert.equal(Object.hasOwn(result.targets[0].cardFirst.reasonHistogram, '__proto__'), false);
});

const invalidCases = [
  ['missing state', () => null], ['missing items', state => { delete state.items; }],
  ['wrong code SHA', state => { state.scanMeta.codeSha = 'b'.repeat(40); }],
  ['wrong request', state => { state.comparisonAudit.requestId = 'wrong-request'; }],
  ['wrong checkedAt', state => { state.checkedAt = '2026-10-18T02:38:18.256Z'; }],
  ['wrong dataRevision', state => { state.dataRevision = '2026-10-18T02:38:18.256Z'; }],
  ['wrong cycle finishedAt', state => { state.cycleCoverage.finishedAt = '2026-10-18T02:38:18.256Z'; }],
  ['wrong target ID', state => { state.comparisonAudit.targets[0].targetId = 'unrelated'; }],
  ['wrong target account', state => { state.comparisonAudit.targets[0].accountId = 'unrelated'; }],
  ['duplicate target', state => { state.comparisonAudit.targets[1] = structuredClone(state.comparisonAudit.targets[0]); }],
  ['missing ledger', state => { delete state.comparisonAuditReceipt; }],
  ['null ledger', state => { state.comparisonAuditReceipt = null; }],
  ['wrong revision', state => { state.comparisonAuditReceipt.revision = 0; }],
  ['wrong receipt request', state => { state.comparisonAuditReceipt.consumed[0].requestId = 'wrong-request'; }],
  ['wrong receipt SHA', state => { state.comparisonAuditReceipt.consumed[0].expectedSha = 'b'.repeat(40); }],
  ['wrong run', state => { state.comparisonAuditReceipt.consumed[0].runId = '123'; }],
  ['duplicate consumption', state => { state.comparisonAuditReceipt.consumed.push(state.comparisonAuditReceipt.consumed[0]); }],
  ['reversed ledger time', state => { state.comparisonAuditReceipt.consumed[0].consumedAt = '2026-10-18T02:29:59.000Z'; }],
  ['overlong deadline', state => { state.comparisonAuditReceipt.consumed[0].deadlineAt = '2026-10-18T02:50:00.000Z'; }],
  ['unbound original start', state => { state.scanMeta.startedAt = '2026-10-18T02:29:59.000Z'; }],
  ['wrong flow', state => { state.comparisonAudit.flowMode = 'paired_baseline'; }],
  ['missing own observation', state => { delete state.comparisonAudit.targets[0].ownObservation; }],
  ['missing card-first decision', state => { delete state.comparisonAudit.targets[0].rows[0].cardFirst; }],
  ['missing mainflow decision', state => { delete state.comparisonAudit.targets[0].rows[0].mainflow; }],
  ['missing own inventory', state => { state.items = []; }],
  ['wrong own observation', state => { state.comparisonAudit.targets[0].ownObservation.id = 'unrelated'; }],
  ['missing row observations', state => { delete state.comparisonAudit.targets[0].rows[0].cardObservations; }],
  ['inconsistent raw receipt', state => { state.comparisonAudit.targets[0].recommendationReceipt.cards.pop(); }],
  ['mismatched row source', state => { state.comparisonAudit.targets[0].rows[0].cardObservations[0].url = 'https://invalid.example'; }],
  ['missing card pass', state => { delete state.comparisonAudit.cardPassCompletedAt; }],
  ['future freeze', state => { state.comparisonAudit.frozenAt = '2099-01-01T00:00:00.000Z'; }],
  ['future card observation', state => { state.comparisonAudit.targets[0].rows[0].cardObservations[0].observedAt = '2099-01-01T00:00:00.000Z'; }],
  ['future detail observation', state => { state.comparisonAudit.targets[0].rows[0].detailObservation.observedAt = '2099-01-01T00:00:00.000Z'; }],
  ['future nested image evidence', state => { state.comparisonAudit.targets[0].rows[2].cardFirst.observation.imageEvidence.own.observedAt = '2099-01-01T00:00:00.000Z'; }],
  ['after snapshot but before diagnostic', state => { state.comparisonAudit.targets[0].rows[0].detailObservation.observedAt = '2026-10-18T02:39:00.000Z'; }],
  ['unknown card mode', state => { state.comparisonAudit.targets[0].rows[0].cardFirst.mode = 'PRIVATE'; }],
  ['unknown baseline status', state => { state.comparisonAudit.targets[0].rows[0].baseline.status = 'PRIVATE'; }],
  ['missing target count', state => { delete state.comparisonAudit.targets[0].counts.paired; }],
  ['wrong report count', state => { state.comparisonAudit.counts.paired++; }],
  ['wrong target count', state => { state.comparisonAudit.targets[0].counts.paired++; }],
  ['changed candidate hash', state => { state.comparisonAudit.controller.candidateSet.identity = '0'.repeat(64); }],
  ['wrong controller requests', state => { state.comparisonAudit.controller.requests.pop(); }],
  ['wrong controller cache reuse', state => { state.comparisonAudit.controller.counts.cacheReuses++; }],
  ['wrong cached observation', state => { state.comparisonAudit.targets[1].rows[0].detailObservation.fromCache = false; }],
  ['wrong transport count', state => { state.comparisonAudit.controller.counts.byKind.detail++; }],
  ['wrong attempt type', state => { state.comparisonAudit.targets[0].rows[0].detailAttempted = 'yes'; }],
];
for (const [name, mutate] of invalidCases) test(`fails closed: ${name}`, () => {
  const state = copy(), changed = mutate(state), result = summarize(changed === null ? null : state);
  assert.equal(result.valid, false); assert.deepEqual(Object.keys(result), ['valid', 'reason']);
  assert.match(result.reason, /^(state_metadata_invalid|receipt_invalid|audit_[a-z_]+)$/);
});

test('all target and total producer counts are independently cross-validated', () => {
  for (const key of Object.keys(original.comparisonAudit.counts)) {
    for (const scope of ['total', 'target']) {
      const state = copy(), counts = scope === 'total' ? state.comparisonAudit.counts : state.comparisonAudit.targets[0].counts;
      counts[key]++;
      assert.deepEqual(summarize(state), { valid: false, reason: 'audit_counts_inconsistent' }, `${scope}.${key}`);
    }
  }
});

test('invalid now, future snapshot, getters, and arbitrary errors return only fixed reasons', () => {
  assert.deepEqual(summarizeSavedComparisonAudit(copy(), null), { valid: false, reason: 'invalid_options' });
  assert.deepEqual(summarizeSavedComparisonAudit(copy(), { now: NaN }), { valid: false, reason: 'invalid_options' });
  assert.equal(summarizeSavedComparisonAudit(copy(), { now: Date.parse(P.snapshotAt) - 1 }).valid, false);
  const state = copy(); Object.defineProperty(state, 'comparisonAudit', { get() { throw new Error('PRIVATE_SECRET'); } });
  assert.deepEqual(summarize(state), { valid: false, reason: 'audit_rows_invalid' });
});

test('summary module has only a pure standard-library hash dependency', async () => {
  const source = await readFile(new URL('../scripts/lib/comparison-audit-summary.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import .*?from '(.*?)';$/gm)].map(match => match[1]);
  assert.deepEqual(imports, ['node:crypto']);
  assert.doesNotMatch(source, /\b(?:fetch|readFile|writeFile|decrypt|encrypt|process\.env|runYahooComparisonAudit)\s*\(/);
});
