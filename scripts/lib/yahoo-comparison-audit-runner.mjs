import { classifyYahooCardFirst, YAHOO_BUYER_SHIPPING_POLICY } from './yahoo-card-first.mjs';
import { categoryText, evaluateYahooDetail, exactQueryFor, screenYahooCard } from './yahoo.mjs';
import { rejectedByMemory } from '../../public/match-memory.js';
import { COMPARISON_AUDIT_LIMITS } from './comparison-audit-control.mjs';

// This module owns neither transport nor persistence. The injected reader must
// call the supplied transport hooks at the actual network boundary. Those same
// hooks already count profile and own-page reads in the supplied controller.
// No candidate returned by the production verifier escapes as a pricing quote.
const urlFor = id => `https://paypayfleamarket.yahoo.co.jp/item/${id}`;
const time = value => typeof value === 'number' ? value : Date.parse(value || '');
const iso = value => new Date(time(value)).toISOString();
const text = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => structuredClone(value);
const imageUrls = detail => (detail?.images || []).map(row => typeof row === 'string' ? row : row?.url).filter(text);
const seller = detail => String(detail?.seller?.id || detail?.sellerId || '').trim();
const freeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};
const fail = reason => Object.assign(new Error(reason), { auditReason: reason });
const requireThat = (condition, reason) => { if (!condition) throw fail(reason); };
const denial = error => [401, 403, 429].includes(error?.httpStatus) || error?.auditReason === 'source_denied';
const unknown = reason => ({ status: 'unknown', reason, comparable: null, lowerThanOwn: null });

// This policy applies only to exact Yahoo Fleamarket item URLs. Explicit
// uncertain/conflicting shipping never silently falls back to free shipping.
function deliveredPrice(observation) {
  const { id, url, price, priceKind = 'ordinary', currency, shipping } = observation;
  const uncertain = reason => ({ status: 'unknown', reason, deliveredPriceJPY: null });
  if (!text(id) || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || url !== urlFor(id)) return uncertain('buyer_shipping_platform_unconfirmed');
  if (priceKind !== 'ordinary' || !['number', 'string'].includes(typeof price) ||
    typeof price === 'string' && !/^\d+(?:\.\d+)?$/.test(price) ||
    !Number.isFinite(Number(price)) || Number(price) <= 0 || currency !== undefined && currency !== 'JPY')
    return uncertain('ordinary_price_unconfirmed');
  if (Object.hasOwn(observation, 'shipping') &&
    (shipping?.shippingKnown !== true || shipping.currency !== 'JPY' || shipping.shippingJPY !== 0))
    return uncertain('buyer_shipping_unconfirmed_or_conflicting');
  return { status: 'confirmed', priceJPY: Number(price), deliveredPriceJPY: Number(price),
    shipping: shipping ? clone(shipping) : { ...YAHOO_BUYER_SHIPPING_POLICY, shippingKnown: true },
    shippingBasis: shipping ? 'explicit_current_observation' : 'yahoo_fleamarket_buyer_shipping_policy' };
}

function compareCardPrices(target, row) {
  const own = deliveredPrice({ id: target.item.id, url: target.ownBundle.sourceUrl,
    price: target.ownBundle.detail.price, priceKind: Object.hasOwn(target.ownBundle.detail, 'priceKind') ? target.ownBundle.detail.priceKind ?? 'unknown' : 'ordinary',
    currency: target.ownBundle.detail.currency, ...(Object.hasOwn(target.ownBundle, 'shipping') ? { shipping: target.ownBundle.shipping } : {}) });
  const observations = row.cardObservations.map(card => deliveredPrice({ ...card, priceKind: card.priceKind || 'unknown' }));
  const unconfirmed = observations.find(value => value.status !== 'confirmed');
  const statuses = observations.map(value => value.deliveredPriceJPY < own.deliveredPriceJPY ? 'confirmed_lower' : 'confirmed_not_lower');
  const status = own.status !== 'confirmed' || unconfirmed || new Set(statuses).size !== 1 ? 'unknown' : statuses[0];
  return { status, reason: own.status !== 'confirmed' ? `own_${own.reason}` : unconfirmed?.reason ||
    (status === 'unknown' ? 'conflicting_card_price_observations' : 'ordinary_delivered_price_compared'), own, observations };
}

function countRows(target) {
  const rows = target.rows;
  return {
    raw: target.receipt?.totalCards ?? null,
    retainedRaw: target.receipt?.cards?.length ?? 0,
    invalidRaw: target.receipt?.invalidCards ?? null,
    omittedRaw: Number.isSafeInteger(target.receipt?.totalCards) ? Math.max(0, target.receipt.totalCards - (target.receipt.cards?.length || 0)) : null,
    total: rows.length, duplicates: rows.reduce((sum, row) => sum + row.cardObservations.length - 1, 0),
    eligible: rows.filter(row => row.eligible).length,
    eligibleLowPrice: rows.filter(row => row.eligible && row.lowPrice).length,
    frozenPopulation: rows.length,
    confirmedLowerPrice: rows.filter(row => row.priceComparison?.status === 'confirmed_lower').length,
    unknownPrice: rows.filter(row => row.priceComparison?.status === 'unknown').length,
    skippedNotLower: rows.filter(row => row.exclusionReason === 'confirmed_not_lower_delivered_price').length,
    mainflowCardOnly: rows.filter(row => row.mainflow?.mode === 'card_only').length,
    mainflowDetailRequired: rows.filter(row => row.mainflow?.mode === 'detail_required').length,
    mainflowDetailPaired: rows.filter(row => row.detailPhase === 'newflow' && row.paired).length,
    baselineValidationPaired: rows.filter(row => row.detailPhase === 'baseline_validation' && row.paired).length,
    baselineValidationUnpaired: rows.filter(row => row.mainflow?.mode === 'card_only' && !row.paired).length,
    excluded: rows.filter(row => row.eligible === false).length,
    paired: rows.filter(row => row.paired).length,
    unpaired: rows.filter(row => !row.paired).length,
    eligibleUnpaired: rows.filter(row => row.eligible && !row.paired).length,
    detailAttempted: rows.filter(row => row.detailAttempted).length,
    detailObserved: rows.filter(row => row.detailObservation).length,
    comparable: rows.filter(row => row.baseline?.status === 'comparable').length,
    rejected: rows.filter(row => row.baseline?.status === 'rejected').length,
    unknown: rows.filter(row => row.baseline?.status === 'unknown').length,
    blocked: rows.filter(row => row.baseline?.status === 'blocked').length,
  };
}

function prepareTargets(targets) {
  requireThat(Array.isArray(targets) && targets.length === 2, 'exactly_two_targets_required');
  requireThat(targets.every(row => text(row?.item?.id)) && new Set(targets.map(row => row.item.id)).size === 2, 'distinct_target_ids_required');
  return targets.map(input => {
    const row = clone(input), receipt = row.recommendationReceipt || row.ownBundle?.recommendationReceipt;
    const unique = new Map(), cards = Array.isArray(receipt?.cards) ? receipt.cards : [];
    for (const card of cards) {
      requireThat(text(card?.id), 'invalid_frozen_card');
      if (!unique.has(card.id)) unique.set(card.id, { id: card.id, cardObservations: [], paired: false, detailAttempted: false, eligible: null });
      unique.get(card.id).cardObservations.push(freeze(clone(card)));
    }
    return { input: row, item: row.item, ownBundle: row.ownBundle, receipt: receipt ? freeze(clone(receipt)) : null,
      rows: [...unique.values()], known: new Set(row.knownCandidateIds || []), ownImages: null };
  });
}

function validateOwn(target, snapshot, now) {
  const { item, ownBundle: bundle, receipt } = target, detail = bundle?.detail;
  const original = time(bundle?.observedAt), started = time(snapshot.startedAt);
  requireThat(item.platform === 'yahoo' && text(item.accountId) && text(item.sellerId), 'own_target_binding_missing');
  requireThat(detail?.id === item.id && bundle.sourceUrl === urlFor(item.id) && bundle.fromCache === false &&
    Number.isFinite(original) && original >= started && original <= now, 'own_source_unbound_or_not_current');
  requireThat(detail.status === 'OPEN' && text(detail.title) && detail.title === item.title && text(detail.description) &&
    seller(detail) === item.sellerId && Number(detail.price) > 0 && Number(detail.price) === Number(item.ownPrice), 'own_sale_terms_unconfirmed');
  requireThat(imageUrls(detail).length > 0, 'own_primary_image_missing');
  requireThat(receipt?.version === 1 && receipt.requestedItemId === item.id && receipt.sourceUrl === bundle.sourceUrl &&
    time(receipt.observedAt) === original && Array.isArray(receipt.cards) && Number.isSafeInteger(receipt.totalCards) &&
    receipt.totalCards >= receipt.cards.length && Number.isSafeInteger(receipt.invalidCards) && receipt.invalidCards >= 0 &&
    receipt.invalidCards <= receipt.totalCards, 'recommendation_receipt_unbound');
  for (const card of receipt.cards) requireThat(card.url === urlFor(card.id) && time(card.observedAt) === original, 'card_observation_unbound');
  // Verify observation accounting without inventing a fresh observation time.
  return snapshot.requests.find(request => request.kind === 'own' && request.outcome === 'ok' &&
    request.transportStarted && time(request.observedAt) === original &&
    (!bundle.auditReservationId || request.reservationId === bundle.auditReservationId));
}

function detailObservation(bundle) {
  const detail = bundle?.detail;
  return freeze({ sourceUrl: bundle?.sourceUrl ?? null, observedAt: Number.isFinite(time(bundle?.observedAt)) ? iso(bundle.observedAt) : null,
    fromCache: bundle?.fromCache === true, id: detail?.id ?? null, title: detail?.title ?? null,
    description: detail?.description ?? null, priceJPY: Number(detail?.price) > 0 ? Number(detail.price) : null,
    sellerId: seller(detail) || null, status: detail?.status ?? null,
    images: imageUrls(detail), shipping: bundle?.shipping ? clone(bundle.shipping) : null });
}

function auditVerdict(evaluation, item) {
  if (evaluation?.rejection && evaluation.currentDetailRead !== true) return { ...unknown(evaluation.rejection.reason), currentDetailRead: false };
  if (evaluation?.rejection) return { status: 'rejected', reason: evaluation.rejection.reason,
    comparable: false, lowerThanOwn: false, priceJPY: Number.isFinite(evaluation.rejection.price) ? evaluation.rejection.price : null,
    currentDetailRead: evaluation.currentDetailRead === true, primaryImageScore: evaluation.currentPrimaryImageScore ?? null };
  const accepted = evaluation?.candidate;
  if (!accepted) return unknown('verifier_result_unavailable');
  return { status: 'comparable', reason: accepted.matchMethod, comparable: true, lowerThanOwn: accepted.price < item.ownPrice,
    priceJPY: accepted.price, imageScore: accepted.imageScore ?? null, primaryImageScore: accepted.primaryImageScore ?? null,
    currentDetailRead: evaluation.currentDetailRead === true };
}

/**
 * targets: [{item, ownBundle, recommendationReceipt?, knownCandidateIds?,
 *            ownImageKind?, cardImageKinds?: {[candidateId]: 'photo'|'official'}}]
 * readDetail(id, settings) is the existing bundle reader, with unchanged parent
 * beforeYahooTransport/afterYahooTransport hooks. imageFingerprints(url, context)
 * receives the original deadline, controller signal, and observeImageTransfer.
 * Only that callback's actual transfer metrics count; function calls/cache hits
 * never pretend to be image network requests. Source readers are never defaults.
 * flowMode defaults to the historical paired_baseline. lower_price_card_first
 * skips only confirmed non-lower delivered prices and keeps strong cards
 * provisional. baselineValidation (default true) spends the SAME remaining
 * controller budget on a separate validation pass; false disables that pass.
 */
export async function runYahooComparisonAudit({ controller, ownershipIndex, targets, settings = {},
  readDetail, imageFingerprints, now = Date.now, signal, flowMode = 'paired_baseline', baselineValidation = true } = {}) {
  requireThat(controller && typeof controller.snapshot === 'function' && typeof controller.freezeCandidates === 'function', 'valid_controller_required');
  requireThat(typeof now === 'function', 'audit_clock_required');
  const prepared = prepareTargets(targets), initial = controller.snapshot();
  const deadlineAt = time(initial.deadlineAt), maxImages = 8;
  let frozenSet = null, stopReason = null, cardPassCompletedAt = null, timer, imageChain = Promise.resolve(), imageCalls = 0, imageTransportStarts = 0;
  const cachedBundles = new Map(), requestPhases = new Map();
  const lowerPriceFirst = flowMode === 'lower_price_card_first';
  const phaseTimings = Object.fromEntries(['card_pass', 'ambiguity_detail_pass', 'baseline_validation_pass'].map(phase =>
    [phase, { elapsedMs: 0, intervals: 0, clockValid: true, interrupted: false }]));
  async function measurePhase(phase, operation) {
    const began = now(), timing = phaseTimings[phase];
    timing.intervals++;
    try { return await operation(); }
    catch (error) { timing.interrupted = true; throw error; }
    finally {
      const ended = now();
      if (Number.isFinite(began) && Number.isFinite(ended) && ended >= began) timing.elapsedMs += ended - began;
      else timing.clockValid = false;
    }
  }
  const cancellationSignals = [...new Set([signal, settings.signal].filter(value => value && value !== controller.signal))];
  const cancel = () => controller.cancel();
  for (const inputSignal of cancellationSignals) { inputSignal.addEventListener('abort', cancel, { once: true }); if (inputSignal.aborted) cancel(); }
  function check() {
    if (stopReason) throw fail(stopReason);
    const snapshot = controller.snapshot();
    if (snapshot.stopped) throw fail(snapshot.stopped);
    requireThat(Number.isFinite(now()) && now() < deadlineAt, 'deadline_exceeded');
    return snapshot;
  }
  // Enforce the same original deadline even if an injected reader ignores abort.
  const expire = () => {
    const remaining = deadlineAt - now();
    if (remaining <= 0) { controller.snapshot(); return; }
    timer = setTimeout(expire, Math.min(2_147_483_647, remaining));
  };
  async function bounded(operation) {
    check();
    let abort;
    const stopped = new Promise((_, reject) => {
      abort = () => reject(fail(controller.snapshot().stopped || 'cancelled'));
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const value = await Promise.race([Promise.resolve().then(() => { check(); return operation(); }), stopped]);
      check(); return value;
    }
    finally { controller.signal.removeEventListener('abort', abort); }
  }
  const fingerprint = url => {
    const operation = imageChain.then(async () => {
      check(); imageCalls++;
      try {
        return await bounded(() => imageFingerprints(url, { signal: controller.signal, deadlineAt, deadline: deadlineAt, now,
          observeImageTransferStart: () => { imageTransportStarts++; },
          observeImageTransfer: metrics => controller.observeImageTransfer(metrics) }));
      } catch (error) {
        if (denial(error)) { stopReason = 'source_denied'; throw fail(stopReason); }
        throw error;
      }
    });
    // Promise.all in the existing verifier schedules calls together. This queue
    // serializes the underlying image reader, including errors and cache calls.
    imageChain = operation.catch(() => {});
    return operation;
  };
  const ownedOffers = { yahoo: { items: new Set(), sellers: new Set() } };
  function excludeOwned(candidate) {
    if (controller.classifyOwnership(candidate) !== 'owned') return false;
    ownedOffers.yahoo.items.add(candidate.id);
    // An owned listing ID does not authenticate a card's seller field. Never
    // promote an unrelated seller into the complete owned-seller index.
    if (candidate.sellerId && controller.classifyOwnership({ id: '__audit_seller_binding_probe__', sellerId: candidate.sellerId }) === 'owned')
      ownedOffers.yahoo.sellers.add(candidate.sellerId);
    return true;
  }
  function finish() {
    const snapshot = clone(controller.snapshot());
    for (const request of snapshot.requests) request.phase = requestPhases.get(request.reservationId) ||
      (['profile', 'own'].includes(request.kind) ? 'prerequisite' : 'unattributed');
    const phases = Object.fromEntries(['prerequisite', 'paired_baseline', 'newflow', 'baseline_validation', 'unattributed'].map(phase => {
      const requests = snapshot.requests.filter(request => request.phase === phase);
      return [phase, { pageReservations: requests.length, pageFetches: requests.filter(request => request.transportStarted === true).length,
        pendingReservations: requests.filter(request => request.outcome === null).length,
        detailPageFetches: requests.filter(request => ['known', 'detail'].includes(request.kind) && request.transportStarted === true).length,
        successfulDetailObservations: requests.filter(request => ['known', 'detail'].includes(request.kind) && request.transportStarted === true && request.outcome === 'ok' && request.observedAt !== null).length }];
    }));
    const reason = stopReason || snapshot.stopped;
    for (const target of prepared) for (const row of target.rows) {
      if (!row.paired && (!row.unpairedReason || row.unpairedReason === 'baseline_validation_pending')) row.unpairedReason = row.exclusionReason || reason || 'not_selected';
      delete row.card;
      delete row.priority;
    }
    const output = prepared.map(target => ({ targetId: target.item.id, accountId: target.item.accountId,
      ownObservation: target.ownBundle ? detailObservation(target.ownBundle) : null,
      recommendationReceipt: target.receipt, counts: countRows(target),
      collectionComplete: Boolean(target.receipt && !target.receipt.truncated && !target.receipt.sectionsTruncated &&
        target.receipt.invalidCards === 0 && target.receipt.totalCards === target.receipt.cards?.length),
      knownNotInFrozenSet: [...target.known].filter(id => !target.rows.some(row => row.id === id)), rows: target.rows }));
    const keys = Object.keys(output[0].counts);
    const totals = Object.fromEntries(keys.map(key => [key, output.every(target => target.counts[key] !== null) ? output.reduce((sum, target) => sum + target.counts[key], 0) : null]));
    return freeze({ version: 1, kind: 'standalone_frozen_yahoo_comparison_audit', requestId: snapshot.requestId,
      startedAt: snapshot.startedAt, deadlineAt: snapshot.deadlineAt, frozenAt: frozenSet?.frozenAt ?? null,
      candidateSetIdentity: frozenSet?.identity ?? null, status: reason ? 'incomplete' : 'completed', stopReason: reason || null,
      flowMode, cardPassCompletedAt, baselineValidationEnabled: lowerPriceFirst && baselineValidation,
      canRecommend: false, procurementCostEligible: false, sourceTimesAreIndependent: true,
      requestPhases: phases,
      phaseTimings: lowerPriceFirst ? phaseTimings : null,
      phaseTimingMeaning: 'Sequential non-overlapping measured intervals from the injected clock, including awaited I/O; not CPU time. Detail phases sum their work intervals. Prerequisite collection and scheduling outside intervals are excluded.',
      mainflowComplete: lowerPriceFirst ? Boolean(frozenSet && output.every(target => target.collectionComplete && target.rows.every(row =>
        row.eligible === false || row.mainflow?.mode === 'card_only' || row.detailPhase === 'newflow' && row.paired))) : null,
      counts: totals, pairedCoverageComplete: Boolean(frozenSet && !reason && (lowerPriceFirst ? totals.unpaired === 0 : totals.eligibleUnpaired === 0) &&
        output.every(target => target.collectionComplete && target.rows.every(row => typeof row.eligible === 'boolean'))),
      pairedCoverageScope: lowerPriceFirst ? 'entire_frozen_population' : 'eligible_frozen_population',
      imageFingerprintCalls: imageCalls,
      imageTransfers: {started:imageTransportStarts,settled:snapshot.counts.imageFetches,
        pending:Math.max(0,imageTransportStarts-snapshot.counts.imageFetches),metricsComplete:imageTransportStarts===snapshot.counts.imageFetches,
        decodedCompletedBodyBytes:snapshot.counts.imageBytes,settledDurationMs:snapshot.counts.imageWallMs,
        meaning:'Starts are observed before fetch; completion bytes/durations are lower bounds until every started transfer settles. Bytes exclude unfinished bodies and are not wire bytes.'},
      targets: output, controller: snapshot,
      limitations: ['Card observations and later detail observations are different source times, not simultaneous ground truth.',
        'A verifier verdict is an audit result only and creates no accepted pricing candidate, recommendation, or verification clock.',
        'Unpaired, failed, blocked, invalid, and omitted source rows do not establish negative matches or a false-negative rate.',
        'Image totals are supplied observed transfers, not inferred from fingerprint calls.',
        ...(lowerPriceFirst ? ['Skipped non-lower cards remain in the frozen denominator and have no baseline match verdict.',
          'Mainflow ambiguity details reuse the strict verifier observation; only baseline_validation denotes a separate later validation pass.'] : [])] });
  }
  try {
    check();
    requireThat(['paired_baseline', 'lower_price_card_first'].includes(flowMode) && typeof baselineValidation === 'boolean', 'invalid_audit_flow_mode');
    requireThat(typeof readDetail === 'function' && typeof imageFingerprints === 'function', 'injected_source_readers_required');
    requireThat(typeof settings.beforeYahooTransport === 'function' && typeof settings.afterYahooTransport === 'function', 'parent_transport_hooks_required');
    if (!initial.ownershipReady) {
      try { controller.setOwnershipIndex(ownershipIndex); } catch { throw fail('complete_ownership_required'); }
    }
    const snapshot = check();
    requireThat(snapshot.ownershipReady && !snapshot.candidateSet && snapshot.counts.pendingReservations === 0, 'fresh_complete_controller_required');
    requireThat(ownershipIndex?.version === 1 && ownershipIndex.complete === true &&
      ownershipIndex.sourceStateId === snapshot.ownershipSourceStateId && Array.isArray(ownershipIndex.accounts) &&
      time(ownershipIndex.verifiedAt) >= time(snapshot.startedAt) && time(ownershipIndex.verifiedAt) <= now(), 'complete_ownership_required');
    requireThat(JSON.stringify(Object.keys(snapshot.targets).sort()) === JSON.stringify(prepared.map(target => target.item.id).sort()), 'controller_target_mismatch');
    for (const account of ownershipIndex.accounts) {
      for (const id of account.listingIds || []) {
        requireThat(controller.classifyOwnership({ id }) === 'owned', 'ownership_index_mismatch');
        ownedOffers.yahoo.items.add(id);
      }
      for (const id of account.sellerIds || []) {
        requireThat(controller.classifyOwnership({ id: '__audit_seller_binding_probe__', sellerId: id }) === 'owned', 'ownership_index_mismatch');
        ownedOffers.yahoo.sellers.add(id);
      }
    }
    const ownRequests = new Set();
    for (const target of prepared) {
      const ownAccount = ownershipIndex.accounts.find(account => account.accountId === target.item.accountId);
      requireThat(ownAccount?.platform === 'yahoo' && ownAccount.complete === true && ownAccount.sellerBindingVerified === true &&
        ownAccount.sellerIds?.includes(target.item.sellerId) && ownAccount.listingIds?.includes(target.item.id), 'own_account_binding_missing');
      requireThat(excludeOwned({ id: target.item.id, sellerId: target.item.sellerId }), 'own_target_not_indexed');
      requireThat(controller.classifyOwnership({ id: '__audit_seller_binding_probe__', sellerId: target.item.sellerId }) === 'owned', 'own_seller_not_indexed');
      const request = validateOwn(target, snapshot, now());
      // Two observations can legitimately share a millisecond; choose distinct
      // matching counted reads rather than assigning new timestamps to them.
      const counted = request && snapshot.requests.find(row => row.kind === 'own' && row.outcome === 'ok' && row.transportStarted &&
        time(row.observedAt) === time(target.ownBundle.observedAt) && !ownRequests.has(row.reservationId) &&
        (!target.ownBundle.auditReservationId || row.reservationId === target.ownBundle.auditReservationId));
      requireThat(counted, 'own_page_not_counted'); ownRequests.add(counted.reservationId);
      ownedOffers.yahoo.items.add(target.item.id); ownedOffers.yahoo.sellers.add(target.item.sellerId);
    }
    const verifierSettings = { ...settings, ownedOffers, ownedOffersComplete: true };
    for (const target of prepared) for (const row of target.rows) {
      row.card = row.cardObservations[0]; row.known = target.known.has(row.id);
      if (lowerPriceFirst) row.priceComparison = compareCardPrices(target, row);
      row.lowPrice = lowerPriceFirst ? row.priceComparison.status === 'confirmed_lower' :
        row.card.priceKind === 'ordinary' && Number(row.card.price) > 0 && Number(row.card.price) < Number(target.item.ownPrice);
      // Preserve every frozen row, including higher prices. They are discarded
      // only from processing, before ownership/title screening or any image I/O.
      if (lowerPriceFirst && row.priceComparison.status === 'confirmed_not_lower') {
        row.eligible = false; row.exclusionReason = 'confirmed_not_lower_delivered_price';
      } else {
        const own = row.cardObservations.some(excludeOwned);
        const corrected = row.cardObservations.some(card => rejectedByMemory(settings.matchCorrections, target.item, 'yahoo', card));
        const sold = row.cardObservations.some(card => ['SOLD', 'CLOSED'].includes(card.itemStatus));
        row.exclusionReason = own ? 'own_offer' : corrected ? 'saved_user_correction' : sold ? 'not_open' : null;
        row.eligible = !row.exclusionReason;
        const screened = screenYahooCard(target.item, row.card, { ownSellerId: target.item.sellerId, ownCategory: categoryText(target.ownBundle.detail), settings: verifierSettings });
        row.meaningful = Boolean(screened.card);
      }
      row.priority = lowerPriceFirst ? (row.lowPrice ? 0 : 1) : row.known ? 0 : row.lowPrice ? (row.meaningful ? 1 : 2) : row.meaningful ? 3 : 4;
      if (!row.eligible) {
        row.cardFirst = { mode: 'excluded', reason: row.exclusionReason, cardId: row.id }; row.unpairedReason = row.exclusionReason;
        if (lowerPriceFirst) row.mainflow = { mode: 'excluded', reason: row.exclusionReason };
      }
    }
    frozenSet = controller.freezeCandidates({ targets: prepared.map(target => ({ targetId: target.item.id,
      candidates: target.rows.map(row => ({ id: row.id, ...(text(row.card.sellerId) ? { sellerId: row.card.sellerId } : {}), url: row.card.url })) })) });
    for (const target of prepared) for (const row of target.rows.filter(row => !row.eligible)) {
      const state = controller.snapshot().targets[target.item.id].candidates.find(candidate => candidate.id === row.id)?.state;
      if (state === 'pending') controller.markCandidateIneligible({ targetId: target.item.id, candidateId: row.id, reason: row.exclusionReason });
    }
    expire();
    const queues = prepared.map(target => target.rows.filter(row => row.eligible).sort((a, b) => a.priority - b.priority || Number(a.card.price) - Number(b.card.price)));
    const canRead = (state, target, row) => cachedBundles.has(row.id) ||
      state.counts.pageReservations < COMPARISON_AUDIT_LIMITS.pageFetches &&
      state.counts.competitorDetailReservations < COMPARISON_AUDIT_LIMITS.competitorDetailFetches &&
      state.targets[target.item.id].detailReservations < state.targets[target.item.id].allowance;
    const budgetReason = state => state.counts.pageReservations >= COMPARISON_AUDIT_LIMITS.pageFetches ? 'page_budget_exhausted' :
      state.counts.competitorDetailReservations >= COMPARISON_AUDIT_LIMITS.competitorDetailFetches ? 'detail_budget_exhausted' : 'target_allowance_exhausted';
    async function classifyRow(target, row) {
      if (!target.ownImages) {
        target.ownImages = [];
        for (const url of imageUrls(target.ownBundle.detail).slice(0, lowerPriceFirst ? 1 : maxImages)) target.ownImages.push(await fingerprint(url));
      }
      const ownObservation = { itemId: target.item.id, sourceUrl: target.ownBundle.sourceUrl, observedAt: iso(target.ownBundle.observedAt) };
      const cardPrimary = row.card.image ? await fingerprint(row.card.image) : null;
      row.cardFirst = classifyYahooCardFirst({ item: target.item, ownDetail: target.ownBundle.detail, ownDetailObservation: ownObservation,
        card: row.card, ownPrimary: target.ownImages[0], cardPrimary, ownImageKind: target.input.ownImageKind || 'unknown',
        cardImageKind: target.input.cardImageKinds?.[row.id] || 'unknown', settings: verifierSettings, now: now() });
      if (row.cardFirst.mode === 'blocked') { row.baseline = { ...unknown(row.cardFirst.reason), status: 'blocked' }; throw fail(row.cardFirst.reason); }
      if (new Set(row.cardObservations.map(card => JSON.stringify([card.title, card.price, card.sellerId, card.image, card.itemStatus]))).size > 1)
        row.cardFirst = { mode: 'detail_required', reason: 'conflicting_card_observations', cardId: row.id };
      if (lowerPriceFirst && row.priceComparison.status === 'unknown' && row.cardFirst.mode !== 'excluded')
        row.cardFirst = { mode: 'detail_required', reason: row.priceComparison.reason, cardId: row.id };
    }
    async function verifyRow(target, row, phase) {
      let bundle, stage = 'detail_reader';
      row.detailPhase = phase;
      try {
        const cached = cachedBundles.get(row.id);
        if (cached) {
          bundle = { ...clone(cached), fromCache: true };
          controller.recordCacheReuse({ targetId: target.item.id, candidateId: row.id, observedAt: bundle.observedAt });
        } else {
          const before = check().requests.length;
          row.detailAttempted = true;
          try { bundle = await bounded(() => readDetail(row.id, { ...settings,
            yahooRequestPurpose: row.known ? 'known' : 'candidate', yahooRequestTargetId: target.item.id,
            yahooRequestAccountId: target.item.accountId, signal: controller.signal,
            deadlineAt, deadline: deadlineAt, yahooRequestDeadline: deadlineAt, attempts: 1, yahooAuditPhase: phase })); }
          finally {
            for (const request of controller.snapshot().requests.slice(before)) requestPhases.set(request.reservationId, phase);
          }
          const requests = controller.snapshot().requests.slice(before);
          requireThat(requests.length > 0 && requests.every(request => request.targetId === target.item.id && request.candidateId === row.id &&
            ['known', 'detail'].includes(request.kind) && request.outcome !== null), 'detail_transport_not_counted');
          requireThat(requests.some(request => request.outcome === 'ok' && time(request.observedAt) === time(bundle?.observedAt)), 'detail_observation_not_counted');
        }
        row.detailObservation = detailObservation(bundle);
        requireThat(bundle?.detail?.id === row.id, 'detail_id_mismatch');
        requireThat(bundle.sourceUrl === urlFor(row.id) && Number.isFinite(time(bundle.observedAt)) &&
          time(bundle.observedAt) >= time(frozenSet.frozenAt) && time(bundle.observedAt) <= now(), 'detail_source_unbound_or_not_current');
        requireThat(seller(bundle.detail), 'detail_seller_missing');
        if (!cached) cachedBundles.set(row.id, freeze(clone(bundle)));
        const detailOwned = excludeOwned({ id: row.id, sellerId: seller(bundle.detail) });
        stage = 'verifier';
        for (const url of imageUrls(target.ownBundle.detail).slice(target.ownImages.length, maxImages)) target.ownImages.push(await fingerprint(url));
        const evaluation = await bounded(() => evaluateYahooDetail({ item: target.item,
          card: { ...row.card, fromRecommendation: true }, bundle, ownDetail: target.ownBundle.detail,
          ownSellerId: target.item.sellerId, ownConditionText: [target.ownBundle.detail.title, target.ownBundle.detail.description,
            typeof target.ownBundle.detail.condition === 'string' ? target.ownBundle.detail.condition : target.ownBundle.detail.condition?.name || ''].join('\n'),
          ownCategory: categoryText(target.ownBundle.detail), exactQuery: exactQueryFor(target.item.title), maxImages,
          ownFingerprints: target.ownImages.filter(Boolean), ownImageEvidence: target.ownImages, settings: verifierSettings }, { imageFingerprints: fingerprint }));
        requireThat(!detailOwned || evaluation.rejection, 'owned_detail_not_rejected');
        row.baseline = auditVerdict(evaluation, target.item);
        if (lowerPriceFirst && row.baseline.status === 'comparable') {
          const detailPrice = deliveredPrice({ id: row.id, url: bundle.sourceUrl, price: bundle.detail.price,
            priceKind: Object.hasOwn(bundle.detail, 'priceKind') ? bundle.detail.priceKind ?? 'unknown' : 'ordinary',
            currency: bundle.detail.currency, ...(Object.hasOwn(bundle, 'shipping') ? { shipping: bundle.shipping } : {}) });
          const ownPrice = row.priceComparison.own;
          row.detailPriceComparison = { own: ownPrice, candidate: detailPrice };
          if (detailPrice.status !== 'confirmed' || ownPrice.status !== 'confirmed')
            row.baseline = unknown(detailPrice.status !== 'confirmed' ? detailPrice.reason : `own_${ownPrice.reason}`);
          else row.baseline.lowerThanOwn = detailPrice.deliveredPriceJPY < ownPrice.deliveredPriceJPY;
        }
        row.paired = true;
        row.comparison = { provisionalCardLower: row.cardFirst.mode === 'card_observation' && row.cardFirst.observation.lowerPriceAlert,
          laterDetailComparableLower: row.baseline.lowerThanOwn,
          interpretation: 'different_observation_times_not_ground_truth',
          ...(lowerPriceFirst ? { detailPhase: phase,
            pairingKind: phase === 'newflow' ? 'mainflow_detail_shared_verifier_observation' : 'later_card_only_baseline_validation' } : {}) };
      } catch (error) {
        const current = controller.snapshot();
        const reason = current.stopped || error?.auditReason || (denial(error) ? 'source_denied' : error?.code === 'request_deferred' ? 'source_request_deferred' : `${stage}_failed`);
        row.baseline = { ...unknown(reason), ...(reason === 'source_denied' || reason === 'cancelled' ? { status: 'blocked' } : {}) };
        row.unpairedReason = reason;
        if (current.stopped || ['source_denied', 'source_request_deferred', 'detail_transport_not_counted', 'detail_observation_not_counted', 'owned_detail_not_rejected'].includes(reason)) throw fail(reason);
      }
    }
    let turn = 0;
    if (lowerPriceFirst) {
      // Classification is independent of detail-page admission: a full page
      // budget must not hide provisional card observations still in the set.
      await measurePhase('card_pass', async () => {
        while (queues.some(queue => queue.length)) {
          check();
          const available = queues.map((queue, index) => ({ target: prepared[index], index, row: queue[0] })).filter(value => value.row);
          const priority = Math.min(...available.map(value => value.row.priority));
          const pool = available.filter(value => value.row.priority === priority);
          const { target, index, row } = pool.find(value => value.index === turn) || pool[0];
          queues[index].shift(); turn = 1 - index;
          await classifyRow(target, row);
          if (row.cardFirst.mode === 'card_observation') {
            row.mainflow = { mode: 'card_only', provisional: true, detailVerified: false };
            row.unpairedReason = baselineValidation ? 'baseline_validation_pending' : 'baseline_validation_disabled';
            // Without validation this card has no pending detail work. Release
            // its controller quota, without changing its provisional eligibility.
            if (!baselineValidation) controller.markCandidateIneligible({ targetId: target.item.id, candidateId: row.id, reason: 'card_only_no_baseline_validation' });
          } else if (row.cardFirst.mode === 'excluded') {
            row.eligible = false; row.exclusionReason = row.cardFirst.reason; row.unpairedReason = row.exclusionReason;
            row.mainflow = { mode: 'excluded', reason: row.exclusionReason };
            controller.markCandidateIneligible({ targetId: target.item.id, candidateId: row.id, reason: row.exclusionReason });
          } else {
            row.mainflow = { mode: 'detail_required', reason: row.cardFirst.reason };
          }
        }
        cardPassCompletedAt = iso(now());
      });
      // All card decisions precede detail work. Prioritize ambiguity details;
      // optional baseline validation never blocks the card pass. Retry deferred
      // ambiguity work first; validation may release the other target's quota.
      const remaining = prepared.map(target => target.rows.filter(row => row.eligible && !row.detailPhase &&
        (row.mainflow?.mode === 'detail_required' || baselineValidation && row.mainflow?.mode === 'card_only'))
        .sort((a, b) => a.priority - b.priority || Number(a.card.price) - Number(b.card.price)));
      while (remaining.some(queue => queue.length)) {
        const state = check();
        const available = remaining.flatMap((queue, index) => queue.filter(row => canRead(state, prepared[index], row))
          .map(row => ({ target: prepared[index], index, row })));
        if (!available.length) { stopReason = budgetReason(state); break; }
        const ambiguity = available.filter(value => value.row.mainflow.mode === 'detail_required');
        const candidates = ambiguity.length ? ambiguity : available;
        const priority = Math.min(...candidates.map(value => value.row.priority));
        const pool = candidates.filter(value => value.row.priority === priority);
        const { target, index, row } = pool.find(value => value.index === turn) || pool[0];
        remaining[index].splice(remaining[index].indexOf(row), 1); turn = 1 - index;
        delete row.unpairedReason;
        const detailRequired = row.mainflow.mode === 'detail_required';
        await measurePhase(detailRequired ? 'ambiguity_detail_pass' : 'baseline_validation_pass',
          () => verifyRow(target, row, detailRequired ? 'newflow' : 'baseline_validation'));
      }
      if (stopReason) for (const target of prepared) for (const row of target.rows)
        if (row.unpairedReason === 'baseline_validation_pending') row.unpairedReason = stopReason;
    } else {
      // Existing paired-baseline scheduling remains the default, including its
      // known-ID preference and cache reuse when page quotas are exhausted.
      while (queues.some(queue => queue.length)) {
        const state = check();
        const available = prepared.map((target, index) => ({ target, index,
          row: queues[index].find(row => canRead(state, target, row)) })).filter(value => value.row);
        if (!available.length) { stopReason = budgetReason(state); break; }
        const known = available.filter(value => value.row.known), pool = known.length ? known : available;
        const { target, index, row } = pool.find(value => value.index === turn) || pool[0];
        queues[index].splice(queues[index].indexOf(row), 1); turn = 1 - index;
        await classifyRow(target, row);
        await verifyRow(target, row, 'paired_baseline');
      }
    }
  } catch (error) { stopReason = stopReason || controller.snapshot().stopped || error?.auditReason || 'audit_validation_failed'; }
  finally {
    // Promise.all rejects on its first failed image, but the verifier may have
    // already enqueued more images. Settle that queue while the original timer
    // remains armed, before freezing transfer metrics or returning to caller.
    await imageChain;
    clearTimeout(timer);
    for (const inputSignal of cancellationSignals) inputSignal.removeEventListener('abort', cancel);
  }
  return finish();
}
