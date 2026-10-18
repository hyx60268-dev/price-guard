import { classifyYahooCardFirst } from './yahoo-card-first.mjs';
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
 */
export async function runYahooComparisonAudit({ controller, ownershipIndex, targets, settings = {},
  readDetail, imageFingerprints, now = Date.now, signal } = {}) {
  requireThat(controller && typeof controller.snapshot === 'function' && typeof controller.freezeCandidates === 'function', 'valid_controller_required');
  requireThat(typeof now === 'function', 'audit_clock_required');
  const prepared = prepareTargets(targets), initial = controller.snapshot();
  const deadlineAt = time(initial.deadlineAt), maxImages = 8;
  let frozenSet = null, stopReason = null, timer, imageChain = Promise.resolve(), imageCalls = 0, imageTransportStarts = 0;
  const cachedBundles = new Map();
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
    if (candidate.sellerId) ownedOffers.yahoo.sellers.add(candidate.sellerId);
    return true;
  }
  function finish() {
    const snapshot = controller.snapshot();
    const reason = stopReason || snapshot.stopped;
    for (const target of prepared) for (const row of target.rows) {
      if (!row.paired && !row.unpairedReason) row.unpairedReason = row.exclusionReason || reason || 'not_selected';
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
      canRecommend: false, procurementCostEligible: false, sourceTimesAreIndependent: true,
      counts: totals, pairedCoverageComplete: Boolean(frozenSet && !reason && totals.eligibleUnpaired === 0 &&
        output.every(target => target.collectionComplete && target.rows.every(row => typeof row.eligible === 'boolean'))),
      imageFingerprintCalls: imageCalls,
      imageTransfers: {started:imageTransportStarts,settled:snapshot.counts.imageFetches,
        pending:Math.max(0,imageTransportStarts-snapshot.counts.imageFetches),metricsComplete:imageTransportStarts===snapshot.counts.imageFetches,
        decodedCompletedBodyBytes:snapshot.counts.imageBytes,settledDurationMs:snapshot.counts.imageWallMs,
        meaning:'Starts are observed before fetch; completion bytes/durations are lower bounds until every started transfer settles. Bytes exclude unfinished bodies and are not wire bytes.'},
      targets: output, controller: snapshot,
      limitations: ['Card observations and later detail observations are different source times, not simultaneous ground truth.',
        'A verifier verdict is an audit result only and creates no accepted pricing candidate, recommendation, or verification clock.',
        'Unpaired, failed, blocked, invalid, and omitted source rows do not establish negative matches or a false-negative rate.',
        'Image totals are supplied observed transfers, not inferred from fingerprint calls.'] });
  }
  try {
    check();
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
      row.lowPrice = row.card.priceKind === 'ordinary' && Number(row.card.price) > 0 && Number(row.card.price) < Number(target.item.ownPrice);
      const own = row.cardObservations.some(excludeOwned);
      const corrected = row.cardObservations.some(card => rejectedByMemory(settings.matchCorrections, target.item, 'yahoo', card));
      const sold = row.cardObservations.some(card => ['SOLD', 'CLOSED'].includes(card.itemStatus));
      row.exclusionReason = own ? 'own_offer' : corrected ? 'saved_user_correction' : sold ? 'not_open' : null;
      row.eligible = !row.exclusionReason;
      const screened = screenYahooCard(target.item, row.card, { ownSellerId: target.item.sellerId, ownCategory: categoryText(target.ownBundle.detail), settings: verifierSettings });
      row.meaningful = Boolean(screened.card);
      row.priority = row.known ? 0 : row.lowPrice ? (row.meaningful ? 1 : 2) : row.meaningful ? 3 : 4;
      if (!row.eligible) { row.cardFirst = { mode: 'excluded', reason: row.exclusionReason, cardId: row.id }; row.unpairedReason = row.exclusionReason; }
    }
    frozenSet = controller.freezeCandidates({ targets: prepared.map(target => ({ targetId: target.item.id,
      candidates: target.rows.map(row => ({ id: row.id, ...(text(row.card.sellerId) ? { sellerId: row.card.sellerId } : {}), url: row.card.url })) })) });
    for (const target of prepared) for (const row of target.rows.filter(row => !row.eligible)) {
      const state = controller.snapshot().targets[target.item.id].candidates.find(candidate => candidate.id === row.id)?.state;
      if (state === 'pending') controller.markCandidateIneligible({ targetId: target.item.id, candidateId: row.id, reason: row.exclusionReason });
    }
    expire();
    const queues = prepared.map(target => target.rows.filter(row => row.eligible).sort((a, b) => a.priority - b.priority || Number(a.card.price) - Number(b.card.price)));
    let turn = 0;
    while (queues.some(queue => queue.length)) {
      const state = check();
      const available = prepared.map((target, index) => {
        const canRead = state.counts.pageReservations < COMPARISON_AUDIT_LIMITS.pageFetches &&
          state.counts.competitorDetailReservations < COMPARISON_AUDIT_LIMITS.competitorDetailFetches &&
          state.targets[target.item.id].detailReservations < state.targets[target.item.id].allowance;
        // An uncached head must not hide an already-observed frozen ID that can
        // still be paired without any additional page reservation.
        return { target, index, row: canRead ? queues[index][0] : queues[index].find(row => cachedBundles.has(row.id)) };
      }).filter(value => value.row);
      if (!available.length) {
        stopReason = state.counts.pageReservations >= COMPARISON_AUDIT_LIMITS.pageFetches ? 'page_budget_exhausted' :
          state.counts.competitorDetailReservations >= COMPARISON_AUDIT_LIMITS.competitorDetailFetches ? 'detail_budget_exhausted' : 'target_allowance_exhausted'; break;
      }
      const known = available.filter(value => value.row.known), pool = known.length ? known : available;
      const selected = pool.find(value => value.index === turn) || pool[0], { target, index, row } = selected;
      queues[index].splice(queues[index].indexOf(row), 1); turn = 1 - index;
      if (!target.ownImages) {
        target.ownImages = [];
        for (const url of imageUrls(target.ownBundle.detail).slice(0, maxImages)) target.ownImages.push(await fingerprint(url));
      }
      const ownObservation = { itemId: target.item.id, sourceUrl: target.ownBundle.sourceUrl, observedAt: iso(target.ownBundle.observedAt) };
      const cardPrimary = row.card.image ? await fingerprint(row.card.image) : null;
      row.cardFirst = classifyYahooCardFirst({ item: target.item, ownDetail: target.ownBundle.detail, ownDetailObservation: ownObservation,
        card: row.card, ownPrimary: target.ownImages[0], cardPrimary, ownImageKind: target.input.ownImageKind || 'unknown',
        cardImageKind: target.input.cardImageKinds?.[row.id] || 'unknown', settings: verifierSettings, now: now() });
      if (row.cardFirst.mode === 'blocked') { row.baseline = { ...unknown(row.cardFirst.reason), status: 'blocked' }; throw fail(row.cardFirst.reason); }
      if (new Set(row.cardObservations.map(card => JSON.stringify([card.title, card.price, card.sellerId, card.image, card.itemStatus]))).size > 1)
        row.cardFirst = { mode: 'detail_required', reason: 'conflicting_card_observations', cardId: row.id };
      let bundle, stage = 'detail_reader';
      try {
        const cached = cachedBundles.get(row.id);
        if (cached) {
          bundle = { ...clone(cached), fromCache: true };
          controller.recordCacheReuse({ targetId: target.item.id, candidateId: row.id, observedAt: bundle.observedAt });
        } else {
          const before = check().requests.length;
          row.detailAttempted = true;
          bundle = await bounded(() => readDetail(row.id, { ...settings,
            yahooRequestPurpose: row.known ? 'known' : 'candidate', yahooRequestTargetId: target.item.id,
            yahooRequestAccountId: target.item.accountId, signal: controller.signal,
            deadlineAt, deadline: deadlineAt, yahooRequestDeadline: deadlineAt, attempts: 1 }));
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
        const evaluation = await bounded(() => evaluateYahooDetail({ item: target.item,
          card: { ...row.card, fromRecommendation: true }, bundle, ownDetail: target.ownBundle.detail,
          ownSellerId: target.item.sellerId, ownConditionText: [target.ownBundle.detail.title, target.ownBundle.detail.description,
            typeof target.ownBundle.detail.condition === 'string' ? target.ownBundle.detail.condition : target.ownBundle.detail.condition?.name || ''].join('\n'),
          ownCategory: categoryText(target.ownBundle.detail), exactQuery: exactQueryFor(target.item.title), maxImages,
          ownFingerprints: target.ownImages.filter(Boolean), ownImageEvidence: target.ownImages, settings: verifierSettings }, { imageFingerprints: fingerprint }));
        requireThat(!detailOwned || evaluation.rejection, 'owned_detail_not_rejected');
        row.baseline = auditVerdict(evaluation, target.item); row.paired = true;
        row.comparison = { provisionalCardLower: row.cardFirst.mode === 'card_observation' && row.cardFirst.observation.lowerPriceAlert,
          laterDetailComparableLower: row.baseline.lowerThanOwn,
          interpretation: 'different_observation_times_not_ground_truth' };
      } catch (error) {
        const current = controller.snapshot();
        const reason = current.stopped || error?.auditReason || (denial(error) ? 'source_denied' : error?.code === 'request_deferred' ? 'source_request_deferred' : `${stage}_failed`);
        row.baseline = { ...unknown(reason), ...(reason === 'source_denied' || reason === 'cancelled' ? { status: 'blocked' } : {}) };
        row.unpairedReason = reason;
        if (current.stopped || ['source_denied', 'source_request_deferred', 'detail_transport_not_counted', 'detail_observation_not_counted', 'owned_detail_not_rejected'].includes(reason)) throw fail(reason);
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
