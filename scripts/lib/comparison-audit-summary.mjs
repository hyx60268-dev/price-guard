import { createHash } from 'node:crypto';

// Pure projection of one already-decrypted, pinned saved audit. No filesystem,
// source readers, environment access, verifier calls, or persistence. All output
// strings are constants, verified public pins, or explicit reason-code allowlists.
export const SAVED_COMPARISON_AUDIT = Object.freeze({
  requestId: 'lp-card-20261018-once-v1',
  codeSha: '1208088efe7c84dc1aa584f331aa0ee662b92b49',
  runId: '39090203784',
  snapshotAt: '2026-10-18T02:38:18.255Z',
  targetIds: Object.freeze(['z705310958', 'z705438862']),
  knownCandidateId: 'z704300094',
});
const P = SAVED_COMPARISON_AUDIT;
const reasonCodes = new Set(`
strong_card_similarity missing_target_or_card complete_owned_index_required own_source_unbound_or_stale
own_sale_terms_unconfirmed own_offer own_seller saved_user_correction unbound_source_url
missing_or_stale_card_observation not_open seller_unconfirmed own_primary_image_receipt_unbound
primary_image_receipt_unbound ordinary_price_unconfirmed price_outlier official_photo_mismatch
primary_image_uncertain product_type_uncertain identity_title_uncertain bonus_terms_uncertain
sale_quantity_unconfirmed sale_unit_mismatch sale_description_unavailable defect description_color_mismatch
explicit_variant_mismatch condition_or_packaging_mismatch physical_product_type_unconfirmed
primary_variant_unconfirmed bonus_terms_inconsistent bonus_terms_mismatch bonus_terms_unconfirmed
no_hard_identity_conflict variant_mismatch weak_anchors product_mismatch matched weak_title title_rejected
conflicting_card_observations buyer_shipping_platform_unconfirmed buyer_shipping_unconfirmed_or_conflicting
own_buyer_shipping_platform_unconfirmed own_buyer_shipping_unconfirmed_or_conflicting own_ordinary_price_unconfirmed
conflicting_card_price_observations ordinary_delivered_price_compared confirmed_not_lower_delivered_price
baseline_validation_pending baseline_validation_disabled card_only_no_baseline_validation not_selected
page_budget_exhausted detail_budget_exhausted target_allowance_exhausted deadline_exceeded
invalid_or_regressed_clock cancelled source_denied source_request_deferred detail_reader_failed verifier_failed
verifier_result_unavailable detail_id_mismatch detail_images_unavailable shipping_unconfirmed
sale_description_unavailable detail_price_unavailable detail_seller_changed_or_missing
collectible_variant_image_unconfirmed lottery_series_unconfirmed detail_mismatch weak_detail_title
physical_image_unconfirmed reviewed_sealed_box_identity same_sealed_single_box_primary
lottery_release_prize_character same_packaging_assortment exact_bidirectional_title_identity
strong_visual_primary_product detail_type_quantity_equivalent_text detail_type_quantity_text_images
detail_source_unbound_or_not_current detail_seller_missing detail_transport_not_counted
detail_observation_not_counted owned_detail_not_rejected audit_validation_failed audit_prerequisite_failed
`.trim().split(/\s+/));
const failureCodes = new Set(['invalid_options', 'state_metadata_invalid', 'receipt_invalid', 'audit_metadata_invalid',
  'audit_targets_invalid', 'audit_time_invalid', 'audit_rows_invalid', 'audit_counts_inconsistent',
  'audit_controller_inconsistent', 'audit_source_inconsistent']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const bool = value => typeof value === 'boolean';
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const urlFor = value => `https://paypayfleamarket.yahoo.co.jp/item/${value}`;
const fail = code => { throw Object.assign(new Error(code), { summaryReason: code }); };
const requireThat = (condition, code) => { if (!condition) fail(code); };
const reason = value => reasonCodes.has(value) ? value : 'unknown_reason';
const isoTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value ? Date.parse(value) : NaN;
const observationTime = value => integer(value) ? value : isoTime(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const setSame = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
  new Set(a).size === a.length && same([...a].sort(), [...b].sort());
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function increment(output, key) { output[key] = (output[key] || 0) + 1; }
function histogram(rows, select) { const result = {}; for (const row of rows) increment(result, select(row)); return result; }
function countsEqual(actual, expected) {
  requireThat(plain(actual) && Object.entries(expected).every(([key, value]) => actual[key] === value), 'audit_counts_inconsistent');
}

// Mirrors countRows in the pinned producer, deliberately without importing the
// runner (and its marketplace/image dependencies) into this read-only module.
function countRows(target) {
  const rows = target.rows, receipt = target.recommendationReceipt;
  const cardHint = row => row.cardFirst?.mode === 'card_observation' && row.cardFirst.observation?.lowerPriceAlert === true;
  const strictLower = row => row.paired === true && row.baseline?.status === 'comparable' && row.baseline.lowerThanOwn === true;
  const verdictKnown = row => row.paired === true && ['comparable', 'rejected'].includes(row.baseline?.status);
  const priceChanged = row => row.paired === true && row.detailPriceComparison?.candidate?.status === 'confirmed' &&
    row.priceComparison?.observations?.length > 0 && row.priceComparison.observations.every(value => value.status === 'confirmed') &&
    row.priceComparison.observations.some(value => value.deliveredPriceJPY !== row.detailPriceComparison.candidate.deliveredPriceJPY);
  const count = predicate => rows.filter(predicate).length;
  return {
    raw: receipt.totalCards, retainedRaw: receipt.cards.length, invalidRaw: receipt.invalidCards,
    omittedRaw: Math.max(0, receipt.totalCards - receipt.cards.length), total: rows.length,
    duplicates: rows.reduce((sum, row) => sum + row.cardObservations.length - 1, 0),
    eligible: count(row => row.eligible), eligibleLowPrice: count(row => row.eligible && row.lowPrice),
    frozenPopulation: rows.length, confirmedLowerPrice: count(row => row.priceComparison?.status === 'confirmed_lower'),
    unknownPrice: count(row => row.priceComparison?.status === 'unknown'),
    skippedNotLower: count(row => row.exclusionReason === 'confirmed_not_lower_delivered_price'),
    mainflowCardOnly: count(row => row.mainflow?.mode === 'card_only'),
    mainflowDetailRequired: count(row => row.mainflow?.mode === 'detail_required'),
    mainflowDetailPaired: count(row => row.detailPhase === 'newflow' && row.paired),
    baselineValidationPaired: count(row => row.detailPhase === 'baseline_validation' && row.paired),
    baselineValidationUnpaired: count(row => row.mainflow?.mode === 'card_only' && !row.paired),
    excluded: count(row => row.eligible === false), paired: count(row => row.paired), unpaired: count(row => !row.paired),
    eligibleUnpaired: count(row => row.eligible && !row.paired), detailAttempted: count(row => row.detailAttempted),
    detailObserved: count(row => row.detailObservation), comparable: count(row => row.baseline?.status === 'comparable'),
    rejected: count(row => row.baseline?.status === 'rejected'), unknown: count(row => row.baseline?.status === 'unknown'),
    blocked: count(row => row.baseline?.status === 'blocked'), cardLowerHints: count(cardHint),
    cardLowerHintsPaired: count(row => cardHint(row) && row.paired),
    cardLowerHintsStrictLower: count(row => cardHint(row) && strictLower(row)),
    cardLowerHintsStrictRejected: count(row => cardHint(row) && row.paired && row.baseline?.status === 'rejected'),
    cardLowerHintsStrictNotLower: count(row => cardHint(row) && row.paired && row.baseline?.status === 'comparable' && row.baseline.lowerThanOwn === false),
    cardLowerHintsUnresolved: count(row => cardHint(row) && !verdictKnown(row)),
    cardLowerHintsUnpaired: count(row => cardHint(row) && !row.paired),
    strictLowerWithoutCardHint: count(row => strictLower(row) && !cardHint(row)),
    strictLowerWithoutCardHintDetailRequired: count(row => strictLower(row) && !cardHint(row) && row.mainflow?.mode === 'detail_required'),
    strictLowerWithoutCardHintUnknownCardPrice: count(row => strictLower(row) && !cardHint(row) && row.priceComparison?.status === 'unknown'),
    comparablePriceChanged: count(priceChanged), cardLowerHintsPriceChanged: count(row => cardHint(row) && priceChanged(row)),
    pairedVerdictUnknown: count(row => row.paired && !verdictKnown(row)),
    detailNotObserved: count(row => !row.detailObservation),
    detailAttemptedWithoutObservation: count(row => row.detailAttempted && !row.detailObservation),
  };
}

function validateTimes(report, ceiling) {
  // Inspect only the audit, not unrelated private state. Validate known temporal
  // schema fields even on nested image/card evidence, but never return content.
  const fields = new Set(['observedAt', 'cardObservedAt', 'ownObservedAt', 'startedAt', 'finishedAt',
    'consumedAt', 'frozenAt', 'cardPassCompletedAt', 'detailObservedAt', 'imageObservedAt',
    'detailCheckedAt', 'identityVerifiedAt', 'verifiedAt']);
  const seen = new Set();
  function visit(value, depth = 0) {
    if (!value || typeof value !== 'object') return;
    requireThat(depth < 50 && !seen.has(value), 'audit_time_invalid'); seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (fields.has(key) && child !== null) requireThat(Number.isFinite(observationTime(child)) && observationTime(child) <= ceiling, 'audit_time_invalid');
      if (child && typeof child === 'object') visit(child, depth + 1);
    }
    seen.delete(value);
  }
  visit(report);
}

function validateController(report) {
  const controller = report.controller, frozen = controller?.candidateSet, counts = controller?.counts;
  requireThat(plain(controller) && controller.version === 1 && controller.requestId === P.requestId &&
    controller.startedAt === report.startedAt && controller.deadlineAt === report.deadlineAt &&
    controller.ownershipReady === true && plain(counts) && Array.isArray(controller.requests) &&
    plain(controller.targets) && setSame(Object.keys(controller.targets), P.targetIds), 'audit_controller_inconsistent');
  requireThat(plain(frozen) && frozen.version === 1 && frozen.frozenAt === report.frozenAt &&
    frozen.identity === report.candidateSetIdentity && Array.isArray(frozen.targets) &&
    setSame(frozen.targets.map(row => row.targetId), P.targetIds) &&
    frozen.identity === hash({ version: frozen.version, frozenAt: frozen.frozenAt, targets: frozen.targets }), 'audit_controller_inconsistent');
  const requests = controller.requests, kinds = ['profile', 'own', 'search', 'known', 'detail'];
  const outcomes = ['ok', 'failed', 'denied', 'cancelled'];
  requireThat(setSame(requests.map(row => row.reservationId), [...new Set(requests.map(row => row.reservationId))]), 'audit_controller_inconsistent');
  for (const request of requests) {
    requireThat(plain(request) && kinds.includes(request.kind) && outcomes.includes(request.outcome) &&
      bool(request.transportStarted) && integer(request.bytes) && Number.isFinite(isoTime(request.startedAt)) &&
      Number.isFinite(isoTime(request.finishedAt)) && isoTime(request.finishedAt) >= isoTime(request.startedAt) &&
      isoTime(request.startedAt) >= isoTime(report.startedAt) &&
      (request.observedAt === null || request.outcome === 'ok' && request.transportStarted &&
        observationTime(request.observedAt) >= isoTime(request.startedAt) && observationTime(request.observedAt) <= isoTime(request.finishedAt)), 'audit_controller_inconsistent');
    if (['known', 'detail'].includes(request.kind)) requireThat(P.targetIds.includes(request.targetId) && id(request.candidateId), 'audit_controller_inconsistent');
  }
  const transports = requests.filter(row => row.transportStarted), details = row => ['known', 'detail'].includes(row.kind);
  const expected = { pageReservations: requests.length, pageFetches: transports.length,
    competitorDetailReservations: requests.filter(details).length, competitorDetailFetches: transports.filter(details).length,
    pageBytes: requests.reduce((sum, row) => sum + row.bytes, 0),
    pageWallMs: transports.reduce((sum, row) => sum + isoTime(row.finishedAt) - isoTime(row.startedAt), 0), pendingReservations: 0 };
  countsEqual(counts, expected);
  for (const [name, subset] of [['byKindReservations', requests], ['byKind', transports], ['outcomes', requests], ['actualOutcomes', transports]]) {
    const keys = name.startsWith('byKind') ? kinds : outcomes, property = name.startsWith('byKind') ? 'kind' : 'outcome';
    countsEqual(counts[name], Object.fromEntries(keys.map(key => [key, subset.filter(row => row[property] === key).length])));
  }
  for (const key of ['cacheReuses', 'imageFetches', 'imageBytes']) requireThat(integer(counts[key]), 'audit_controller_inconsistent');
  requireThat(Number.isFinite(counts.imageWallMs) && counts.imageWallMs >= 0, 'audit_controller_inconsistent');
  let caches = 0;
  for (const target of report.targets) {
    const current = controller.targets[target.targetId], frozenTarget = frozen.targets.find(row => row.targetId === target.targetId);
    requireThat(plain(current) && Array.isArray(current.candidates) && Array.isArray(frozenTarget.candidates) &&
      setSame(current.candidates.map(row => row.id), target.rows.map(row => row.id)) &&
      setSame(frozenTarget.candidates.map(row => row.id), target.rows.map(row => row.id)), 'audit_controller_inconsistent');
    const targetRequests = requests.filter(row => row.targetId === target.targetId);
    countsEqual(current, { detailReservations: targetRequests.length, detailFetches: targetRequests.filter(row => row.transportStarted).length,
      remainingEligible: current.candidates.filter(row => ['pending', 'in_flight'].includes(row.state)).length });
    for (const candidate of current.candidates) {
      const row = target.rows.find(row => row.id === candidate.id), matching = targetRequests.filter(request => request.candidateId === row.id);
      requireThat(['pending', 'ineligible', 'cached', ...outcomes].includes(candidate.state), 'audit_controller_inconsistent');
      if (candidate.state === 'cached') {
        caches++;
        requireThat(row.detailAttempted === false && row.detailObservation?.fromCache === true &&
          observationTime(candidate.detailObservedAt) === isoTime(row.detailObservation.observedAt) &&
          requests.some(request => request.candidateId === row.id && request.outcome === 'ok' &&
            observationTime(request.observedAt) === observationTime(candidate.detailObservedAt)), 'audit_controller_inconsistent');
      }
      if (row.paired) requireThat(['ok', 'cached'].includes(candidate.state), 'audit_controller_inconsistent');
      if (matching.length) requireThat(row.detailAttempted && candidate.state === matching.at(-1).outcome, 'audit_controller_inconsistent');
      if (row.detailObservation && candidate.state === 'ok') requireThat(matching.some(request => request.outcome === 'ok' &&
        observationTime(request.observedAt) === isoTime(row.detailObservation.observedAt)), 'audit_controller_inconsistent');
    }
  }
  requireThat(counts.cacheReuses === caches, 'audit_controller_inconsistent');
  return { ...expected, cacheReuses: counts.cacheReuses, imageFetches: counts.imageFetches,
    imageBytes: counts.imageBytes, imageWallMs: counts.imageWallMs };
}

function validateTarget(target, report) {
  const own = target.ownObservation, receipt = target.recommendationReceipt;
  requireThat(target.accountId === 'melon' && P.targetIds.includes(target.targetId) && plain(own) && own.id === target.targetId &&
    own.sourceUrl === urlFor(target.targetId) && own.fromCache === false && own.status === 'OPEN' && positive(own.priceJPY) &&
    isoTime(own.observedAt) >= isoTime(report.startedAt) && isoTime(own.observedAt) <= isoTime(report.frozenAt), 'audit_targets_invalid');
  requireThat(plain(receipt) && receipt.version === 1 && receipt.requestedItemId === target.targetId &&
    receipt.sourceUrl === own.sourceUrl && observationTime(receipt.observedAt) === isoTime(own.observedAt) &&
    Array.isArray(receipt.cards) && integer(receipt.totalCards) && receipt.totalCards >= receipt.cards.length &&
    integer(receipt.invalidCards) && receipt.invalidCards <= receipt.totalCards && Array.isArray(target.rows), 'audit_source_inconsistent');
  requireThat(setSame(target.rows.map(row => row.id), [...new Set(receipt.cards.map(card => card.id))]), 'audit_source_inconsistent');
  const complete = !receipt.truncated && !receipt.sectionsTruncated && receipt.invalidCards === 0 && receipt.totalCards === receipt.cards.length;
  requireThat(target.collectionComplete === complete, 'audit_source_inconsistent');
  for (const row of target.rows) {
    requireThat(plain(row) && id(row.id) && bool(row.eligible) && bool(row.paired) && bool(row.detailAttempted) && bool(row.lowPrice) &&
      Array.isArray(row.cardObservations) && row.cardObservations.length > 0 &&
      same(row.cardObservations, receipt.cards.filter(card => card.id === row.id)), 'audit_rows_invalid');
    for (const card of row.cardObservations) requireThat(card.id === row.id && card.url === urlFor(row.id) &&
      observationTime(card.observedAt) === isoTime(own.observedAt), 'audit_source_inconsistent');
    const price = row.priceComparison;
    requireThat(plain(price) && ['confirmed_lower', 'confirmed_not_lower', 'unknown'].includes(price.status) &&
      plain(price.own) && Array.isArray(price.observations) && price.observations.length === row.cardObservations.length &&
      (price.own.status !== 'confirmed' || price.own.priceJPY === own.priceJPY && price.own.deliveredPriceJPY === own.priceJPY) &&
      row.lowPrice === (price.status === 'confirmed_lower'), 'audit_rows_invalid');
    for (const observation of [price.own, ...price.observations]) requireThat(plain(observation) &&
      ['confirmed', 'unknown'].includes(observation.status) && (observation.status !== 'confirmed' ||
        positive(observation.priceJPY) && observation.deliveredPriceJPY === observation.priceJPY), 'audit_rows_invalid');
    requireThat(plain(row.cardFirst) &&
      ['card_observation', 'detail_required', 'excluded', 'blocked'].includes(row.cardFirst.mode) &&
      typeof row.cardFirst.reason === 'string' && row.cardFirst.reason.length > 0 &&
      (row.cardFirst.mode !== 'card_observation' || plain(row.cardFirst.observation) && bool(row.cardFirst.observation.lowerPriceAlert)), 'audit_rows_invalid');
    requireThat(plain(row.mainflow) && ['card_only', 'detail_required', 'excluded'].includes(row.mainflow.mode) &&
      row.mainflow.mode === ({ card_observation: 'card_only', detail_required: 'detail_required', excluded: 'excluded' })[row.cardFirst.mode] &&
      (row.mainflow.mode === 'excluded' ? row.eligible === false && typeof row.exclusionReason === 'string' : row.eligible === true), 'audit_rows_invalid');
    if (row.baseline !== undefined) requireThat(plain(row.baseline) && ['comparable', 'rejected', 'unknown', 'blocked'].includes(row.baseline.status) &&
      typeof row.baseline.reason === 'string' && row.baseline.reason.length > 0 &&
      (row.baseline.status !== 'comparable' || row.paired && row.baseline.comparable === true && bool(row.baseline.lowerThanOwn)) &&
      (row.baseline.status !== 'rejected' || row.paired && row.baseline.comparable === false), 'audit_rows_invalid');
    if (row.detailObservation) requireThat(plain(row.detailObservation) && bool(row.detailObservation.fromCache) &&
      Number.isFinite(isoTime(row.detailObservation.observedAt)) && isoTime(row.detailObservation.observedAt) >= isoTime(report.frozenAt), 'audit_source_inconsistent');
    if (row.paired) requireThat(row.eligible && row.baseline && row.detailObservation?.id === row.id &&
      row.detailObservation.sourceUrl === urlFor(row.id) && ['newflow', 'baseline_validation'].includes(row.detailPhase), 'audit_rows_invalid');
    else requireThat(typeof row.unpairedReason === 'string' && row.unpairedReason.length > 0, 'audit_rows_invalid');
  }
}

function priceBands(rows) {
  const keys = ['below_25_percent', '25_to_below_50_percent', '50_to_below_75_percent', '75_to_below_100_percent',
    'confirmed_not_lower', 'unresolved_price_or_band'];
  const output = Object.fromEntries(keys.map(key => [key, { total: 0, eligible: 0, paired: 0, unpaired: 0,
    eligibleUnpaired: 0, detailAttempted: 0, strictRejected: 0, strictComparable: 0 }]));
  for (const row of rows) {
    const price = row.priceComparison;
    let key = 'unresolved_price_or_band';
    if (price.status === 'confirmed_not_lower') key = 'confirmed_not_lower';
    else if (price.status === 'confirmed_lower' && price.own.status === 'confirmed' && price.observations.every(value => value.status === 'confirmed')) {
      const bands = price.observations.map(value => {
        const ratio = value.deliveredPriceJPY / price.own.deliveredPriceJPY;
        return ratio < .25 ? keys[0] : ratio < .5 ? keys[1] : ratio < .75 ? keys[2] : ratio < 1 ? keys[3] : keys[5];
      });
      if (new Set(bands).size === 1) key = bands[0];
    }
    const band = output[key]; band.total++; band[row.paired ? 'paired' : 'unpaired']++;
    if (row.eligible) band.eligible++;
    if (row.eligible && !row.paired) band.eligibleUnpaired++;
    if (row.detailAttempted) band.detailAttempted++;
    if (row.baseline?.status === 'rejected') band.strictRejected++;
    if (row.baseline?.status === 'comparable') band.strictComparable++;
  }
  return output;
}
function knownCandidate(target) {
  const row = target.rows.find(row => row.id === P.knownCandidateId);
  if (!row) return { present: false };
  return { present: true, id: P.knownCandidateId, eligible: row.eligible, paired: row.paired, detailAttempted: row.detailAttempted,
    cardMode: row.cardFirst?.mode ?? 'not_classified', cardReason: row.cardFirst ? reason(row.cardFirst.reason) : 'not_recorded',
    cardObservations: row.cardObservations.map((card, index) => ({
      priceJPY: row.priceComparison.observations[index].status === 'confirmed' ? row.priceComparison.observations[index].priceJPY : null,
      priceStatus: row.priceComparison.observations[index].status,
      observedAt: new Date(observationTime(card.observedAt)).toISOString() })),
    detailObservation: row.detailObservation ? { priceJPY: positive(row.detailObservation.priceJPY) ? row.detailObservation.priceJPY : null,
      observedAt: row.detailObservation.observedAt, fromCache: row.detailObservation.fromCache,
      status: ['OPEN', 'SOLD', 'CLOSED'].includes(row.detailObservation.status) ? row.detailObservation.status : 'unknown_status' } : null,
    baselineStatus: row.baseline?.status ?? 'not_observed', baselineReason: row.baseline ? reason(row.baseline.reason) : 'not_recorded',
    unpairedReason: row.paired ? null : reason(row.unpairedReason) };
}

export function summarizeSavedComparisonAudit(state, options = {}) {
  try {
    requireThat(plain(options), 'invalid_options');
    const now = options.now === undefined ? Date.now() : options.now;
    requireThat(Number.isFinite(now), 'invalid_options');
    requireThat(plain(state) && state.version === 6 && Array.isArray(state.items) && state.scanMeta?.codeSha === P.codeSha &&
      state.checkedAt === P.snapshotAt && state.dataRevision === P.snapshotAt && state.cycleCoverage?.finishedAt === P.snapshotAt &&
      isoTime(P.snapshotAt) <= now, 'state_metadata_invalid');
    const report = state.comparisonAudit, ledger = state.comparisonAuditReceipt;
    requireThat(plain(ledger) && ledger.version === 1 && ledger.revision === 1 && Array.isArray(ledger.consumed) && ledger.consumed.length === 1, 'receipt_invalid');
    const consumed = ledger.consumed[0];
    requireThat(plain(consumed) && consumed.requestId === P.requestId && consumed.expectedSha === P.codeSha && consumed.runId === P.runId &&
      Number.isFinite(isoTime(consumed.startedAt)) && Number.isFinite(isoTime(consumed.consumedAt)) &&
      isoTime(consumed.startedAt) <= isoTime(consumed.consumedAt) && isoTime(consumed.consumedAt) <= isoTime(P.snapshotAt) &&
      Number.isFinite(isoTime(consumed.deadlineAt)) && isoTime(consumed.deadlineAt) > isoTime(consumed.consumedAt) &&
      isoTime(consumed.deadlineAt) <= isoTime(consumed.startedAt) + 720_000, 'receipt_invalid');
    requireThat(plain(report) && report.version === 1 && report.kind === 'standalone_frozen_yahoo_comparison_audit' &&
      report.requestId === P.requestId && report.flowMode === 'lower_price_card_first' && report.baselineValidationEnabled === true &&
      report.canRecommend === false && report.procurementCostEligible === false && report.sourceTimesAreIndependent === true &&
      ['completed', 'incomplete'].includes(report.status) && (report.status === 'completed' ? report.stopReason === null : typeof report.stopReason === 'string') &&
      report.startedAt === consumed.startedAt && report.deadlineAt === consumed.deadlineAt &&
      state.scanMeta.startedAt === consumed.startedAt, 'audit_metadata_invalid');
    requireThat(Array.isArray(report.targets) && setSame(report.targets.map(target => target?.targetId), P.targetIds), 'audit_targets_invalid');
    validateTimes(report, isoTime(P.snapshotAt));
    requireThat(isoTime(report.frozenAt) >= isoTime(report.startedAt) &&
      isoTime(report.cardPassCompletedAt) >= isoTime(report.frozenAt) && isoTime(report.cardPassCompletedAt) <= isoTime(P.snapshotAt), 'audit_time_invalid');
    for (const target of report.targets) {
      requireThat(state.items.filter(item => item?.id === target.targetId && item.accountId === 'melon' && item.platform === 'yahoo').length === 1, 'audit_targets_invalid');
      validateTarget(target, report);
    }
    const computed = report.targets.map(target => countRows(target));
    report.targets.forEach((target, index) => countsEqual(target.counts, computed[index]));
    const totals = Object.fromEntries(Object.keys(computed[0]).map(key => [key, computed.reduce((sum, counts) => sum + counts[key], 0)]));
    countsEqual(report.counts, totals);
    const transport = validateController(report);
    const ownReads = report.controller.requests.filter(request => request.kind === 'own' && request.outcome === 'ok' && request.transportStarted);
    for (const target of report.targets) {
      const index = ownReads.findIndex(request => observationTime(request.observedAt) === isoTime(target.ownObservation.observedAt));
      requireThat(index >= 0, 'audit_source_inconsistent'); ownReads.splice(index, 1);
    }
    const targets = P.targetIds.map(targetId => {
      const target = report.targets.find(value => value.targetId === targetId), rows = target.rows;
      return { targetId, ownPriceJPY: target.ownObservation.priceJPY, ownObservedAt: target.ownObservation.observedAt,
        collectionComplete: target.collectionComplete, counts: countRows(target),
        cardFirst: { modeHistogram: histogram(rows, row => row.cardFirst?.mode ?? 'not_classified'),
          reasonHistogram: histogram(rows, row => row.cardFirst ? reason(row.cardFirst.reason) : 'not_recorded') },
        baseline: { statusHistogram: histogram(rows, row => row.baseline?.status ?? 'not_observed'),
          reasonHistogram: histogram(rows, row => row.baseline ? reason(row.baseline.reason) : 'not_recorded'),
          rejectedReasonHistogram: histogram(rows.filter(row => row.baseline?.status === 'rejected'), row => reason(row.baseline.reason)) },
        unpairedReasonHistogram: histogram(rows.filter(row => !row.paired), row => reason(row.unpairedReason)),
        lowPriceBands: priceBands(rows), knownCandidate: knownCandidate(target) };
    });
    const [left, right] = P.targetIds.map(targetId => report.targets.find(target => target.targetId === targetId).rows);
    const rightById = new Map(right.map(row => [row.id, row])), intersection = left.filter(row => rightById.has(row.id));
    return { valid: true, version: 1, readOnly: true,
      source: { requestId: P.requestId, codeSha: P.codeSha, runId: P.runId, checkedAt: P.snapshotAt, dataRevision: P.snapshotAt,
        cycleFinishedAt: P.snapshotAt, startedAt: report.startedAt, deadlineAt: report.deadlineAt, frozenAt: report.frozenAt,
        cardPassCompletedAt: report.cardPassCompletedAt }, status: report.status, stopReason: report.stopReason === null ? null : reason(report.stopReason),
      counts: totals, targets, crossTarget: { duplicateCandidateIds: intersection.length,
        eligibleIntersectionCandidateIds: intersection.filter(row => row.eligible && rightById.get(row.id).eligible).length,
        pairedIntersectionCandidateIds: intersection.filter(row => row.paired && rightById.get(row.id).paired).length,
        uniqueCandidateIds: left.length + right.length - intersection.length }, transport,
      interpretation: [
        'Same candidate ID means shared source listing only; it does not establish product identity with either target.',
        'Cache reuse is the recorded controller count; overlapping IDs alone do not prove reuse.',
        'Detail attempts and paired verifier results are separate counts; cache reuse can pair without another detail attempt.',
        'Strict rejection reasons include later not-open status, identity conflicts, and insufficient evidence; they are not all false positives.',
        'Unpaired rows are unresolved. No precision, recall, false-positive rate, or false-negative rate is established.',
        'Card and detail source times are original independent observations. Summary time creates no fresh market verification.',
        'Price bands use recorded delivered-price comparisons; conflicting or unknown prices remain unresolved.',
      ] };
  } catch (error) {
    return { valid: false, reason: failureCodes.has(error?.summaryReason) ? error.summaryReason : 'audit_rows_invalid' };
  }
}
