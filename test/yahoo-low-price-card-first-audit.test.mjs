import test from 'node:test';
import assert from 'node:assert/strict';
import { claimComparisonAudit, comparisonAuditMarker, createComparisonAuditController } from '../scripts/lib/comparison-audit-control.mjs';
import { yahooRecommendationReceipt } from '../scripts/lib/yahoo-recommendation-receipt.mjs';
import { runYahooComparisonAudit } from '../scripts/lib/yahoo-comparison-audit-runner.mjs';

// Entirely synthetic IDs, inventory, source observations, and image evidence.
// These tests make no network requests and are not claims about live inventory.
const START = Date.parse('2026-10-16T12:00:00.000Z');
const iso = at => new Date(at).toISOString();
const sourceUrl = id => `https://paypayfleamarket.yahoo.co.jp/item/${id}`;
const TITLE = 'APEX ヴァイオレット・エヴァーガーデン 自動手記人形Ver. 1/7 フィギュア 新品 未使用 1点';
const DESCRIPTION = '新品 未使用 フィギュア1点';
const PRIMARY = { dHash: '00ff00ff00ff00ff', aHash: '00ff00ff00ff00ff', centerHash: '00ff00ff00ff00ff', color: [100, 100, 100], colorGrid: Array(768).fill(100) };
const targetIds = ['synthetic-own-a', 'synthetic-own-b'];
const accountIds = ['synthetic-account-a', 'synthetic-account-b', 'synthetic-account-alias'];

async function setup({ sizes = [2, 2], profiles = 3, ready = true, externalSignal } = {}) {
  let at = START, imageActive = 0, maxImageActive = 0, imageCalls = 0, detailActive = 0, maxDetailActive = 0, serial = 0;
  let wallAnchor = null;
  const now = () => at + (wallAnchor === null ? 0 : Date.now() - wallAnchor);
  const log = [], imageLog = [], bundles = new Map(), sha = 'a'.repeat(40), requestId = 'synthetic-audit-request';
  const configured = { version: 1, sourceStateId: 'synthetic-restored-state', accounts: accountIds.map((accountId, i) => ({ accountId,
    platform: 'yahoo', sellerBindingVerified: true, sellerIds: [`synthetic-owner-${i}`],
    listingIds: [targetIds[i] || 'synthetic-historical-own'],
    provenance: [{ source: 'synthetic persisted ownership', sourceStateId: 'synthetic-restored-state', observedAt: iso(START - 60_000) }] })) };
  const claim = await claimComparisonAudit({ activation: { enabled: true, requestId, issuedAt: iso(START - 1000), expiresAt: iso(START + 3_600_000) },
    context: { eventName: 'push', ref: 'refs/heads/main', runId: '123', runAttempt: 1, expectedSha: sha, codeSha: sha, eventSha: sha,
      currentMainSha: sha, startedAt: iso(START), commitMessage: comparisonAuditMarker(requestId) },
    receipt: { version: 1, revision: 0, consumed: [] }, consumeReceipt: async ({ receipt }) => receipt, now });
  const controller = createComparisonAuditController({ claim, configuredOwnership: configured, expectedAccountIds: accountIds,
    sourceStateId: configured.sourceStateId, targetIds, now, signal: externalSignal });
  const accounts = configured.accounts.map(account => ({ ...account, complete: true, profile: { complete: true, observedAt: null, reservationIds: [] } }));
  if (ready) {
    for (let i = 0; i < profiles; i++) {
      const account = accounts[i % accounts.length];
      const permit = controller.reservePageFetch({ kind: 'profile', accountId: account.accountId, transportId: `synthetic-profile-${i}` });
      at++;
      controller.finishPageFetch({ reservationId: permit.reservationId, outcome: 'ok', observedAt: at, bytes: 10 });
      account.profile.reservationIds.push(permit.reservationId);
      account.profile.observedAt ??= iso(at);
    }
  }
  const ownershipIndex = { ...configured, accounts, complete: true, verifiedAt: iso(at) };
  if (ready) controller.setOwnershipIndex(ownershipIndex);
  const targets = targetIds.map((id, i) => {
    const item = { id, platform: 'yahoo', accountId: accountIds[i], sellerId: `synthetic-owner-${i}`, title: TITLE, ownPrice: 10000,
      image: `https://synthetic.invalid/${id}.jpg` };
    const detail = { id, title: item.title, description: DESCRIPTION, status: 'OPEN', price: item.ownPrice,
      seller: { id: item.sellerId }, images: [item.image] };
    let ownReservation;
    if (ready) {
      ownReservation = controller.reservePageFetch({ kind: 'own', transportId: `synthetic-own-read-${i}` }); at++;
      controller.finishPageFetch({ reservationId: ownReservation.reservationId, outcome: 'ok', observedAt: at, bytes: 25 });
    }
    const observedAt = at;
    const cards = Array.from({ length: sizes[i] }, (_, j) => {
      const candidateId = `synthetic-candidate-${i}-${j}`;
      const card = { id: candidateId, url: sourceUrl(candidateId), title: TITLE, text: TITLE, price: 9000 + j, sellerId: 'synthetic-external',
        image: `https://synthetic.invalid/${candidateId}.jpg`, itemStatus: null, priceKind: 'ordinary',
        observedAt: iso(observedAt), source: 'recommendation', recommendationScore: 1 };
      bundles.set(candidateId, { detail: { id: candidateId, title: card.title, description: DESCRIPTION, price: card.price,
        seller: { id: card.sellerId }, images: [card.image], status: 'OPEN' }, shipping: { shippingKnown: true, currency: 'JPY', shippingJPY: 0 } });
      return card;
    });
    const recommendationReceipt = { version: 1, requestedItemId: id, sourceUrl: sourceUrl(id), observedAt: iso(observedAt),
      cards, totalCards: cards.length, invalidCards: 0, truncated: false, sectionsTruncated: false, identityVerified: false, fullCoverage: false };
    return { item, ownBundle: { detail, observedAt, sourceUrl: sourceUrl(id), fromCache: false, recommendationReceipt,
      ...(ownReservation ? { auditReservationId: ownReservation.reservationId } : {}) }, ownImageKind: 'photo',
      cardImageKinds: Object.fromEntries(cards.map(card => [card.id, 'photo'])) };
  });
  const settings = {
    beforeYahooTransport({ url, purpose, targetId, accountId }) {
      const id = new URL(url).pathname.split('/').at(-1);
      const permit = controller.reservePageFetch({ kind: purpose === 'known' ? 'known' : 'detail', targetId, candidateId: id,
        accountId, transportId: `synthetic-detail-${++serial}` });
      if (!permit.admitted) throw Object.assign(new Error(permit.reason), { auditReason: permit.reason });
      return permit;
    },
    afterYahooTransport({ reservation, httpStatus, completed, transportStarted = true, observedAt, decodedBodyBytes = 0 }) {
      const outcome = [401, 403, 429].includes(httpStatus) ? 'denied' : !transportStarted || controller.signal.aborted ? 'cancelled' : completed ? 'ok' : 'failed';
      return controller.finishPageFetch({ reservationId: reservation.reservationId, outcome, transportStarted,
        ...(outcome === 'ok' ? { observedAt } : {}), bytes: decodedBodyBytes });
    },
  };
  async function readDetail(id, options) {
    assert.equal(options.beforeYahooTransport, settings.beforeYahooTransport);
    assert.equal(options.afterYahooTransport, settings.afterYahooTransport);
    assert.equal(options.signal, controller.signal);
    assert.equal(options.deadlineAt, START + 720_000);
    assert.equal(options.attempts, 1);
    detailActive++; maxDetailActive = Math.max(maxDetailActive, detailActive);
    const reservation = options.beforeYahooTransport({ url: sourceUrl(id), purpose: options.yahooRequestPurpose,
      targetId: options.yahooRequestTargetId, accountId: options.yahooRequestAccountId, attempt: 1 });
    log.push({ id, targetId: options.yahooRequestTargetId, purpose: options.yahooRequestPurpose, phase: options.yahooAuditPhase });
    at += 10;
    options.afterYahooTransport({ reservation, completed: true, transportStarted: true, httpStatus: 200, observedAt: at, decodedBodyBytes: 100 });
    detailActive--;
    return { ...structuredClone(bundles.get(id)), observedAt: at, sourceUrl: sourceUrl(id), fromCache: false };
  }
  async function imageFingerprints(url, context) {
    context.observeImageTransferStart();
    imageCalls++; imageActive++; maxImageActive = Math.max(maxImageActive, imageActive); imageLog.push(url);
    assert.equal(context.signal, controller.signal); assert.equal(context.deadlineAt, START + 720_000);
    await new Promise(resolve => setTimeout(resolve, 1)); at++;
    context.observeImageTransfer({ fetches: 1, bytes: 20, durationMs: 1 }); imageActive--;
    return { ...PRIMARY, url, contentSha256: 'a'.repeat(64), imageObservedAt: iso(at) };
  }
  return { controller, targets, settings, ownershipIndex, readDetail, imageFingerprints, bundles, log, imageLog, now,
    advance: amount => { at += amount; }, enableWallClock: () => { wallAnchor = Date.now(); }, metrics: () => ({ imageCalls, maxImageActive, maxDetailActive }) };
}
const run = (context, changes = {}) => runYahooComparisonAudit({ ...context, flowMode: 'lower_price_card_first', ...changes });

const cardsFor = (context, index = 0) => context.targets[index].ownBundle.recommendationReceipt.cards;
const rowsFor = (report, index = 0) => report.targets[index].rows;
const makeAmbiguous = card => { card.title = card.text = 'ヴァイオレット フィギュア'; };

// These fixtures execute the production recommendation receipt producer, card
// classifier, physical-offer identity guard and full detail verifier. Only the
// local image/network transports are synthetic; no marketplace I/O is allowed.
test('real recommendation producer supports price-first skips and provisional cards without invented shipping fields', async () => {
  const context = await setup({ sizes: [3, 0] }), target = context.targets[0], cards = cardsFor(context);
  cards[0].price = 11000; cards[1].price = 10000;
  const raw = cards.map(card => ({ itemId: card.id, title: card.title, price: card.price,
    image: { url: card.image }, seller: { id: card.sellerId }, log: { rctype: 'vector', rcsm: .99 } }));
  const nextData = { props: { initialState: { itemsState: { items: { item: target.ownBundle.detail } },
    recommendsState: { recommends: { recommends: {
      similar: { recommendItems: { items: raw.slice(0, 2) } }, viewed: { recommendItems: { items: raw.slice(2) } },
    } } } } } };
  target.ownBundle.recommendationReceipt = yahooRecommendationReceipt(nextData, { requestedItemId: target.item.id,
    sourceUrl: sourceUrl(target.item.id), observedAt: target.ownBundle.observedAt, now: context.now() });
  const original = structuredClone(context.targets), report = await run(context, { baselineValidation: false });
  assert.equal(report.status, 'completed'); assert.equal(report.mainflowComplete, true);
  assert.equal(report.counts.frozenPopulation, 3); assert.equal(report.counts.skippedNotLower, 2);
  assert.equal(report.counts.confirmedLowerPrice, 1); assert.equal(report.counts.mainflowCardOnly, 1);
  assert.equal(report.counts.mainflowDetailRequired, 0); assert.equal(report.counts.unpaired, 3);
  assert.equal(report.pairedCoverageComplete, false); assert.equal(context.log.length, 0);
  assert.equal(report.imageFingerprintCalls, 2); assert.equal(report.controller.counts.pageFetches, 5);
  for (const row of rowsFor(report).slice(0, 2)) {
    assert.equal(row.meaningful, undefined); assert.equal(row.detailAttempted, false);
    assert.equal(context.imageLog.includes(row.cardObservations[0].image), false);
    assert.equal(row.priceComparison.observations[0].shippingBasis, 'yahoo_fleamarket_buyer_shipping_policy');
    assert.match(row.priceComparison.observations[0].shipping.sourceUrl, /support.yahoo-net.jp/);
    assert.equal(row.baseline, undefined);
  }
  const observation = rowsFor(report)[2].cardFirst.observation;
  assert.equal(observation.lowerPriceAlert, true); assert.equal(observation.detailVerified, false);
  assert.equal(observation.canRecommend, false); assert.equal(observation.procurementCostEligible, false);
  assert.equal(observation.detailCheckedAt, null); assert.equal(observation.availability, 'unconfirmed');
  assert.equal(report.canRecommend, false); assert.equal(report.procurementCostEligible, false);
  assert.deepEqual(context.targets, original);
});

test('all confirmed higher or equal cards incur zero fingerprint calls and zero competitor details', async () => {
  const context = await setup({ sizes: [3, 2] });
  for (const target of context.targets) for (const card of target.ownBundle.recommendationReceipt.cards) card.price = 10000;
  const report = await run(context);
  assert.equal(report.counts.skippedNotLower, 5); assert.equal(report.counts.total, 5);
  assert.equal(report.counts.paired, 0); assert.equal(report.counts.unpaired, 5);
  assert.equal(report.imageFingerprintCalls, 0); assert.equal(context.log.length, 0);
  assert.equal(report.requestPhases.newflow.detailPageFetches, 0);
  assert.equal(report.requestPhases.baseline_validation.detailPageFetches, 0);
  assert.equal(report.pairedCoverageComplete, false);
});

test('unknown, conditional and conflicting prices are never thrown away as not cheaper', async () => {
  const variants = [
    card => { delete card.price; }, card => { card.price = null; }, card => { card.price = NaN; },
    card => { card.price = Infinity; }, card => { card.price = true; }, card => { card.price = 0; },
    card => { card.price = -10; }, card => { card.price = '9,000'; }, card => { card.price = 12000; card.priceKind = 'coupon'; },
    card => { card.price = 12000; delete card.priceKind; }, card => { card.price = 12000; card.currency = 'USD'; },
    card => { card.price = 12000; card.shipping = { shippingKnown: false, shippingJPY: null }; },
    card => { card.price = 12000; card.shipping = { shippingKnown: true, currency: 'JPY', shippingJPY: 500 }; },
  ];
  const context = await setup({ sizes: [variants.length, 0] });
  cardsFor(context).forEach((card, index) => variants[index](card));
  const report = await run(context, { baselineValidation: false });
  assert.equal(report.counts.unknownPrice, variants.length); assert.equal(report.counts.skippedNotLower, 0);
  assert.equal(report.counts.mainflowDetailRequired, variants.length); assert.equal(report.counts.mainflowCardOnly, 0);
  assert.equal(report.requestPhases.newflow.detailPageFetches, variants.length);
  assert.ok(rowsFor(report).every(row => row.eligible && row.cardFirst.mode === 'detail_required'));
  assert.equal(report.requestPhases.baseline_validation.detailPageFetches, 0);
});

test('conflicting duplicate card observations remain frozen and require details; uniformly high duplicates are skipped', async () => {
  const context = await setup({ sizes: [2, 0] }), receipt = context.targets[0].ownBundle.recommendationReceipt;
  receipt.cards[0].price = 11000; receipt.cards[1].price = 12000;
  receipt.cards.push({ ...receipt.cards[0], price: 8000 }, { ...receipt.cards[1], price: 13000 }); receipt.totalCards = 4;
  const report = await run(context, { baselineValidation: false });
  assert.equal(report.counts.total, 2); assert.equal(report.counts.raw, 4); assert.equal(report.counts.duplicates, 2);
  assert.equal(report.counts.unknownPrice, 1); assert.equal(report.counts.skippedNotLower, 1);
  assert.equal(rowsFor(report)[0].cardFirst.mode, 'detail_required'); assert.equal(rowsFor(report)[0].paired, true);
  assert.equal(rowsFor(report)[1].detailAttempted, false); assert.equal(context.log.length, 1);
});

test('explicit unknown own shipping cannot classify higher sticker prices as confirmed non-lower', async () => {
  const context = await setup({ sizes: [1, 0] }); cardsFor(context)[0].price = 12000;
  context.targets[0].ownBundle.shipping = { shippingKnown: false, shippingJPY: null, currency: null };
  const report = await run(context, { baselineValidation: false }), row = rowsFor(report)[0];
  assert.equal(report.counts.unknownPrice, 1); assert.equal(report.counts.skippedNotLower, 0);
  assert.equal(row.cardFirst.mode, 'detail_required'); assert.equal(row.baseline.status, 'unknown');
  assert.equal(row.baseline.lowerThanOwn, null); assert.equal(context.log.length, 1);
  assert.equal(report.counts.pairedVerdictUnknown, 1); assert.equal(report.counts.strictLowerWithoutCardHint, 0);
  assert.equal(report.counts.detailNotObserved, 0); assert.equal(report.counts.paired, 1);
});

test('foreign or ambiguous item URLs are blocked before applying the Yahoo shipping rule or doing I/O', async () => {
  for (const url of ['https://example.invalid/item/candidate', 'https://paypayfleamarket.yahoo.co.jp/item/candidate?coupon=1']) {
    const context = await setup({ sizes: [1, 0] }); cardsFor(context)[0].url = url;
    const report = await run(context);
    assert.equal(report.stopReason, 'card_observation_unbound'); assert.equal(report.counts.skippedNotLower, 0);
    assert.equal(context.log.length, 0); assert.equal(context.imageLog.length, 0);
  }
});

test('known IDs never override lower-price mainflow ordering and known higher prices are skipped', async () => {
  const context = await setup({ sizes: [2, 1] }), first = cardsFor(context), other = cardsFor(context, 1)[0];
  first[0].price = 11000; first[1].price = 8000; makeAmbiguous(first[1]);
  other.priceKind = 'coupon';
  context.targets[0].knownCandidateIds = [first[0].id]; context.targets[1].knownCandidateIds = [other.id];
  const report = await run(context, { baselineValidation: false });
  assert.deepEqual(context.log.map(row => row.id), [first[1].id, other.id]);
  assert.equal(report.counts.skippedNotLower, 1); assert.equal(context.imageLog.includes(first[0].image), false);
  assert.ok(context.log.every(row => row.phase === 'newflow'));
});

test('all-account ownership, closed listings and live corrections still exclude before images; tombstones do not', async () => {
  const context = await setup({ sizes: [5, 0] }), target = context.targets[0], cards = cardsFor(context);
  cards[0].sellerId = 'synthetic-owner-2'; cards[1].id = 'synthetic-historical-own'; cards[1].url = sourceUrl(cards[1].id);
  cards[2].itemStatus = 'CLOSED';
  context.settings.matchCorrections = {
    active: { accountId: target.item.accountId, itemId: target.item.id, platform: 'yahoo', candidateId: cards[3].id },
    removed: { accountId: target.item.accountId, itemId: target.item.id, platform: 'yahoo', candidateId: cards[4].id, deleted: true },
  };
  const report = await run(context, { baselineValidation: false });
  assert.deepEqual(rowsFor(report).slice(0, 4).map(row => row.exclusionReason), ['own_offer', 'own_offer', 'not_open', 'saved_user_correction']);
  assert.equal(report.counts.excluded, 4, JSON.stringify(rowsFor(report).map(row => [row.id, row.exclusionReason, row.cardFirst]))); assert.equal(report.counts.mainflowCardOnly, 1);
  assert.equal(context.log.length, 0); assert.equal(context.imageLog.length, 2);
});

test('only ambiguous cards read details in mainflow; optional validation is a separately tagged later pass', async () => {
  const context = await setup({ sizes: [4, 0] }), cards = cardsFor(context);
  makeAmbiguous(cards[1]);
  cards[2].title += ' 特典付き'; cards[2].text = cards[2].title;
  context.bundles.get(cards[3].id).detail.description = '新品 未使用 フィギュア2点セット';
  const report = await run(context);
  assert.equal(report.counts.mainflowCardOnly, 2); assert.equal(report.counts.mainflowDetailRequired, 2);
  assert.equal(report.requestPhases.newflow.detailPageFetches, 2);
  assert.equal(report.requestPhases.baseline_validation.detailPageFetches, 2);
  assert.deepEqual(context.log.map(row => row.phase), ['newflow', 'newflow', 'baseline_validation', 'baseline_validation']);
  assert.equal(rowsFor(report)[2].cardFirst.reason, 'bonus_terms_uncertain');
  assert.equal(rowsFor(report)[3].baseline.reason, 'sale_unit_mismatch');
  assert.equal(rowsFor(report)[3].mainflow.mode, 'card_only');
  assert.equal(rowsFor(report)[3].cardFirst.observation.detailVerified, false);
  assert.equal(rowsFor(report)[3].comparison.interpretation, 'different_observation_times_not_ground_truth');
  assert.equal(report.mainflowComplete, true); assert.equal(report.counts.baselineValidationPaired, 2);
  assert.equal(report.counts.cardLowerHints, 2); assert.equal(report.counts.cardLowerHintsPaired, 2);
  assert.equal(report.counts.cardLowerHintsStrictLower, 1); assert.equal(report.counts.cardLowerHintsStrictRejected, 1);
  assert.equal(report.counts.cardLowerHintsUnresolved, 0); assert.equal(report.counts.cardLowerHintsStrictNotLower, 0);
  assert.equal(report.counts.strictLowerWithoutCardHint, 2); assert.equal(report.counts.strictLowerWithoutCardHintDetailRequired, 2);
  assert.equal(report.counts.comparablePriceChanged, 0); assert.equal(report.counts.detailNotObserved, 0);
  assert.deepEqual(report.targets[0].counts, report.counts);

  for (const request of report.controller.requests.filter(row => row.candidateId)) assert.ok(['newflow', 'baseline_validation'].includes(request.phase));
});

test('quantity ambiguity and hidden later own-seller/sold details use the production strict verifier', async () => {
  const context = await setup({ sizes: [3, 0] }), cards = cardsFor(context);
  cards[0].title = cards[0].text = cards[0].title.replace('1点', '2点セット');
  context.bundles.get(cards[0].id).detail.title = cards[0].title;
  context.bundles.get(cards[0].id).detail.description = '新品 未使用 フィギュア2点セット';
  context.bundles.get(cards[1].id).detail.seller.id = 'synthetic-owner-2';
  context.bundles.get(cards[2].id).detail.status = 'SOLD';
  const report = await run(context), rows = rowsFor(report);
  assert.equal(rows[0].mainflow.mode, 'detail_required'); assert.equal(rows[0].baseline.reason, 'sale_unit_mismatch');
  assert.equal(rows[1].baseline.reason, 'own_seller'); assert.equal(rows[2].baseline.reason, 'not_open');
  assert.equal(report.counts.comparable, 0); assert.equal(report.counts.mainflowDetailPaired, 1);
  assert.equal(report.counts.baselineValidationPaired, 2); assert.equal(report.candidates, undefined);
});

test('validation shares the original eighty-page budget including all seventeen profiles and two own pages', async () => {
  const context = await setup({ sizes: [40, 40], profiles: 17 }), report = await run(context);
  assert.equal(report.controller.counts.pageFetches, 80); assert.equal(report.controller.counts.competitorDetailFetches, 61);
  assert.equal(report.requestPhases.prerequisite.pageFetches, 19); assert.equal(report.requestPhases.newflow.detailPageFetches, 0);
  assert.equal(report.requestPhases.baseline_validation.detailPageFetches, 61);
  assert.equal(report.counts.mainflowCardOnly, 80); assert.equal(report.counts.baselineValidationPaired, 61);
  assert.equal(report.counts.baselineValidationUnpaired, 19); assert.equal(report.counts.unpaired, 19);
  assert.equal(report.mainflowComplete, true); assert.equal(report.pairedCoverageComplete, false);
  assert.equal(report.stopReason, 'page_budget_exhausted');
  assert.ok(report.targets.flatMap(target => target.rows).filter(row => !row.paired).every(row => row.unpairedReason === 'page_budget_exhausted'));
  assert.equal(Object.values(report.requestPhases).reduce((sum, phase) => sum + phase.pageFetches, 0), 80);
  assert.equal(context.metrics().maxImageActive, 1); assert.equal(context.metrics().maxDetailActive, 1);
});

test('full page budget still permits card classification without inventing available detail capacity', async () => {
  const context = await setup({ sizes: [1, 1], profiles: 78 }), report = await run(context);
  assert.equal(report.counts.mainflowCardOnly, 2); assert.equal(report.mainflowComplete, true);
  assert.equal(report.stopReason, 'page_budget_exhausted'); assert.equal(context.log.length, 0);
  assert.equal(report.counts.paired, 0); assert.equal(report.counts.baselineValidationUnpaired, 2);
  assert.equal(report.controller.counts.pageFetches, 80);
});

test('same-controller sixty-four detail cap and fair target quotas hold across both phases', async () => {
  const context = await setup({ sizes: [70, 2] }), cards = cardsFor(context);
  cards.forEach(makeAmbiguous);
  const report = await run(context);
  assert.equal(report.controller.counts.competitorDetailFetches, 64); assert.equal(report.controller.counts.pageFetches, 69);
  assert.deepEqual(report.targets.map(target => target.counts.paired), [62, 2]);
  assert.equal(report.requestPhases.newflow.detailPageFetches, 62);
  assert.equal(report.requestPhases.baseline_validation.detailPageFetches, 2);
  assert.equal(report.counts.unpaired, 8); assert.equal(report.mainflowComplete, false);
  assert.equal(report.stopReason, 'detail_budget_exhausted');
});

test('cached baseline validation of a shared ID counts paired rows without inventing a second page fetch', async () => {
  const context = await setup({ sizes: [1, 1] }), first = cardsFor(context)[0], second = context.targets[1].ownBundle.recommendationReceipt;
  second.cards[0] = { ...first, observedAt: second.observedAt };
  const report = await run(context);
  assert.equal(report.counts.baselineValidationPaired, 2); assert.equal(report.requestPhases.baseline_validation.detailPageFetches, 1);
  assert.equal(report.controller.counts.cacheReuses, 1); assert.equal(context.log.length, 1);
  assert.equal(rowsFor(report)[0].detailObservation.observedAt, rowsFor(report, 1)[0].detailObservation.observedAt);
});

test('partial source omissions remain explicit and do not establish mainflow or paired coverage', async () => {
  const context = await setup({ sizes: [1, 0] }), receipt = context.targets[0].ownBundle.recommendationReceipt;
  receipt.totalCards = 9; receipt.invalidCards = 2; receipt.truncated = true;
  const report = await run(context, { baselineValidation: false });
  assert.equal(report.counts.omittedRaw, 8); assert.equal(report.counts.invalidRaw, 2);
  assert.equal(report.counts.mainflowCardOnly, 1); assert.equal(report.mainflowComplete, false);
  assert.equal(report.pairedCoverageComplete, false); assert.equal(report.counts.unpaired, 1);
});

test('source denial stops mainflow and baseline validation immediately and keeps pending cards unpaired', async () => {
  const context = await setup({ sizes: [3, 1] }); makeAmbiguous(cardsFor(context)[1]);
  let calls = 0;
  const report = await run(context, { readDetail: async (id, options) => {
    calls++; const reservation = options.beforeYahooTransport({ url: sourceUrl(id), purpose: options.yahooRequestPurpose, targetId: options.yahooRequestTargetId });
    options.afterYahooTransport({ reservation, completed: false, httpStatus: 429 });
    throw Object.assign(Error('Synthetic denial'), { httpStatus: 429 });
  } });
  assert.equal(report.stopReason, 'source_denied'); assert.equal(calls, 1);
  assert.equal(report.requestPhases.newflow.detailPageFetches, 1); assert.equal(report.requestPhases.baseline_validation.detailPageFetches, 0);
  assert.equal(report.counts.unpaired, 4); assert.equal(report.counts.paired, 0);
  assert.ok(report.targets.flatMap(target => target.rows).every(row => row.unpairedReason === 'source_denied'));
});

test('cancelled or uncounted readers cannot invent actual network attempts or paired results', async () => {
  const context = await setup({ sizes: [1, 0] }); makeAmbiguous(cardsFor(context)[0]);
  const report = await run(context, { readDetail: async () => {
    queueMicrotask(() => context.controller.cancel()); return new Promise(() => {});
  } });
  assert.equal(report.stopReason, 'cancelled'); assert.equal(report.counts.detailAttempted, 1);
  assert.equal(report.requestPhases.newflow.pageFetches, 0); assert.equal(report.requestPhases.newflow.pageReservations, 0);
  assert.equal(report.counts.paired, 0);
  const uncounted = await setup({ sizes: [1, 0] }); makeAmbiguous(cardsFor(uncounted)[0]);
  const result = await run(uncounted, { readDetail: async id => ({ ...uncounted.bundles.get(id), observedAt: uncounted.now(), sourceUrl: sourceUrl(id), fromCache: false }) });
  assert.equal(result.stopReason, 'detail_transport_not_counted'); assert.equal(result.requestPhases.newflow.pageFetches, 0);
});

test('original deadline, source holds and image cancellation preserve bounded partial reporting', async () => {
  const context = await setup({ sizes: [1, 1] }); makeAmbiguous(cardsFor(context)[0]);
  const normal = context.readDetail;
  const report = await run(context, { readDetail: async (...args) => { const bundle = await normal(...args); context.advance(720_000); return bundle; } });
  assert.equal(report.stopReason, 'deadline_exceeded'); assert.equal(report.deadlineAt, iso(START + 720_000));
  assert.equal(report.requestPhases.newflow.detailPageFetches, 1); assert.equal(report.counts.paired, 0);
  const held = await setup({ sizes: [1, 0] }); makeAmbiguous(cardsFor(held)[0]);
  const hold = await run(held, { readDetail: async () => { throw Object.assign(Error('Synthetic hold'), { code: 'request_deferred' }); } });
  assert.equal(hold.stopReason, 'source_request_deferred'); assert.equal(hold.requestPhases.newflow.pageFetches, 0);
  const aborted = await setup({ sizes: [1, 0] });
  const cancelled = await run(aborted, { imageFingerprints: async (_url, options) => { options.observeImageTransferStart(); aborted.controller.cancel(); return null; } });
  assert.equal(cancelled.stopReason, 'cancelled'); assert.equal(cancelled.imageTransfers.started, 1);
  assert.equal(cancelled.imageTransfers.settled, 0); assert.equal(cancelled.imageTransfers.pending, 1);
});

test('fingerprint cache calls remain distinct from actual image transfers in the optional mode', async () => {
  const context = await setup({ sizes: [1, 0] });
  const report = await run(context, { baselineValidation: false, imageFingerprints: async (url, options) => {
    options.observeImageTransfer({ fetches: 0, bytes: 0, durationMs: 0 });
    return { ...PRIMARY, url, contentSha256: 'b'.repeat(64), imageObservedAt: iso(context.now()) };
  } });
  assert.equal(report.imageFingerprintCalls, 2); assert.equal(report.controller.counts.imageFetches, 0);
  assert.equal(report.imageTransfers.started, 0); assert.equal(report.imageTransfers.decodedCompletedBodyBytes, 0);
  assert.equal(report.counts.mainflowCardOnly, 1); assert.equal(report.counts.paired, 0);
});

test('prerequisite ownership failure and unknown flow modes stop before all source I/O', async () => {
  const context = await setup({ ready: false }); const report = await run(context);
  assert.equal(report.stopReason, 'complete_ownership_required'); assert.equal(context.imageLog.length, 0);
  const invalid = await setup(), result = await run(invalid, { flowMode: 'typo' });
  assert.equal(result.stopReason, 'invalid_audit_flow_mode'); assert.equal(invalid.imageLog.length, 0); assert.equal(invalid.log.length, 0);
});

test('pending cancelled transport reservations are tagged without claiming a completed network fetch', async () => {
  const context = await setup({ sizes: [1, 0] }); makeAmbiguous(cardsFor(context)[0]);
  const report = await run(context, { readDetail: async (id, options) => {
    options.beforeYahooTransport({ url: sourceUrl(id), purpose: options.yahooRequestPurpose, targetId: options.yahooRequestTargetId });
    queueMicrotask(() => context.controller.cancel()); return new Promise(() => {});
  } });
  assert.equal(report.stopReason, 'cancelled'); assert.equal(report.requestPhases.newflow.pageReservations, 1);
  assert.equal(report.requestPhases.newflow.pendingReservations, 1); assert.equal(report.requestPhases.newflow.pageFetches, 0);
  assert.equal(report.controller.requests.at(-1).phase, 'newflow'); assert.equal(report.controller.requests.at(-1).transportStarted, null);
  assert.equal(report.counts.paired, 0);
});

test('an altered caller ownership index cannot promote a new seller past the validated controller index', async () => {
  const context = await setup();
  const ownershipIndex = structuredClone(context.ownershipIndex);
  ownershipIndex.accounts[0].sellerIds.push('synthetic-external');
  const report = await run(context, { ownershipIndex });
  assert.equal(report.stopReason, 'ownership_index_mismatch'); assert.equal(context.imageLog.length, 0); assert.equal(context.log.length, 0);
});

test('failed validation remains an unpaired unknown and cannot negate the original provisional card', async () => {
  const context = await setup({ sizes: [2, 0] }), normal = context.readDetail; let calls = 0;
  const report = await run(context, { readDetail: async (id, options) => {
    if (calls++) return normal(id, options);
    const reservation = options.beforeYahooTransport({ url: sourceUrl(id), purpose: options.yahooRequestPurpose, targetId: options.yahooRequestTargetId });
    options.afterYahooTransport({ reservation, completed: false, httpStatus: 503 }); throw Error('Synthetic connection failure');
  } });
  assert.equal(report.mainflowComplete, true); assert.equal(report.counts.mainflowCardOnly, 2);
  assert.equal(report.counts.baselineValidationPaired, 1); assert.equal(report.counts.baselineValidationUnpaired, 1);
  assert.equal(rowsFor(report)[0].baseline.status, 'unknown'); assert.equal(rowsFor(report)[0].baseline.lowerThanOwn, null);
  assert.equal(rowsFor(report)[0].cardFirst.observation.lowerPriceAlert, true);
  assert.equal(report.requestPhases.baseline_validation.detailPageFetches, 2);
  assert.equal(report.pairedCoverageComplete, false);
});

test('the entire card pass precedes the first detail, so a later strong-card hint survives a detail deadline', async () => {
  const context = await setup({ sizes: [11, 0] }), cards = cardsFor(context), normal = context.readDetail;
  cards.slice(0, -1).forEach((card, index) => { makeAmbiguous(card); card.price = 8000 + index; });
  const strong = cards.at(-1); strong.price = 9900;
  let detailCalls = 0;
  const report = await run(context, { readDetail: async (...args) => {
    detailCalls++;
    assert.ok(context.imageLog.includes(strong.image), 'later strong card was classified before slow detail work began');
    assert.ok(cards.every(card => context.imageLog.includes(card.image)), 'all card images precede the first detail');
    const bundle = await normal(...args); context.advance(720_000); return bundle;
  } });
  assert.equal(detailCalls, 1); assert.equal(report.stopReason, 'deadline_exceeded');
  assert.equal(report.counts.mainflowDetailRequired, 10); assert.equal(report.counts.mainflowCardOnly, 1);
  assert.equal(rowsFor(report).at(-1).cardFirst.observation.lowerPriceAlert, true);
  assert.equal(rowsFor(report).at(-1).cardFirst.observation.detailVerified, false);
  assert.equal(rowsFor(report).at(-1).unpairedReason, 'deadline_exceeded');
  assert.ok(Date.parse(report.cardPassCompletedAt) <= Date.parse(report.controller.requests.find(request => request.phase === 'newflow').startedAt));
  assert.equal(report.requestPhases.newflow.detailPageFetches, 1); assert.equal(report.requestPhases.baseline_validation.detailPageFetches, 0);
});

test('raw producer unknown prices survive receipt, freezing, selection and strict detail verification', async () => {
  const variants = [undefined, null, 0, -1, NaN, Infinity, '相談', { secret: 'never-retain-price-payload' }];
  const context = await setup({ sizes: [variants.length + 1, 0] }), target = context.targets[0], cards = cardsFor(context);
  const raw = cards.map((card, index) => ({ itemId: card.id, title: card.title,
    price: index < variants.length ? variants[index] : 12000, ...(index === variants.length ? { priceKind: 'coupon' } : {}),
    image: { url: card.image }, seller: { id: card.sellerId }, log: { rctype: 'vector', rcsm: .99 } }));
  const nextData = { props: { initialState: { itemsState: { items: { item: target.ownBundle.detail } },
    recommendsState: { recommends: { recommends: { similar: { recommendItems: { items: raw } } } } } } } };
  target.ownBundle.recommendationReceipt = yahooRecommendationReceipt(nextData, { requestedItemId: target.item.id,
    sourceUrl: sourceUrl(target.item.id), observedAt: target.ownBundle.observedAt, now: context.now() });
  const report = await run(context, { baselineValidation: false });
  assert.equal(report.counts.raw, 9); assert.equal(report.counts.total, 9); assert.equal(report.counts.invalidRaw, 0);
  assert.equal(report.counts.omittedRaw, 0); assert.equal(report.counts.unknownPrice, 9); assert.equal(report.counts.skippedNotLower, 0);
  assert.equal(report.counts.mainflowDetailRequired, 9); assert.equal(report.requestPhases.newflow.detailPageFetches, 9);
  assert.equal(report.counts.comparable, 9); assert.equal(report.counts.paired, 9);
  assert.equal(report.counts.mainflowCardOnly, 0); assert.equal(report.counts.baselineValidationPaired, 0);
  assert.ok(rowsFor(report).every(row => row.cardObservations[0].price === null && row.cardObservations[0].priceKind === 'unknown'));
  assert.equal(JSON.stringify(report).includes('never-retain-price-payload'), false);
});

test('card-only candidates release unused target detail quota when baseline validation is disabled', async () => {
  const context = await setup({ sizes: [40, 1] }); cardsFor(context).forEach(makeAmbiguous);
  const report = await run(context, { baselineValidation: false });
  assert.equal(report.stopReason, null); assert.equal(report.mainflowComplete, true);
  assert.equal(report.requestPhases.newflow.detailPageFetches, 40); assert.equal(report.controller.counts.pageFetches, 45);
  assert.equal(report.requestPhases.baseline_validation.detailPageFetches, 0);
  assert.equal(report.counts.mainflowDetailPaired, 40); assert.equal(report.counts.mainflowCardOnly, 1);
  assert.equal(report.counts.baselineValidationUnpaired, 1); assert.equal(rowsFor(report, 1)[0].eligible, true);
  assert.equal(report.controller.targets[targetIds[1]].candidates[0].reason, 'card_only_no_baseline_validation');
});

test('explicit null shipping and conditional own/detail prices stay unknown instead of becoming price verdicts', async () => {
  const shipping = await setup({ sizes: [1, 0] }); cardsFor(shipping)[0].price = 12000; cardsFor(shipping)[0].shipping = null;
  const unknownShipping = await run(shipping, { baselineValidation: false });
  assert.equal(unknownShipping.counts.skippedNotLower, 0); assert.equal(unknownShipping.counts.unknownPrice, 1);
  assert.equal(unknownShipping.counts.mainflowDetailRequired, 1);
  const own = await setup({ sizes: [1, 0] }); cardsFor(own)[0].price = 12000; own.targets[0].ownBundle.detail.priceKind = 'coupon';
  const conditionalOwn = await run(own, { baselineValidation: false });
  assert.equal(conditionalOwn.counts.skippedNotLower, 0); assert.equal(rowsFor(conditionalOwn)[0].baseline.status, 'unknown');
  assert.equal(rowsFor(conditionalOwn)[0].baseline.lowerThanOwn, null);
  const detail = await setup({ sizes: [1, 0] }); detail.bundles.get(cardsFor(detail)[0].id).detail.priceKind = 'coupon';
  const conditionalDetail = await run(detail);
  assert.equal(rowsFor(conditionalDetail)[0].baseline.status, 'unknown'); assert.equal(rowsFor(conditionalDetail)[0].baseline.lowerThanOwn, null);
});

test('producer shipping/currency conflicts stay unknown through the actual runner', async () => {
  const context = await setup({ sizes: [4, 0] }), target = context.targets[0], cards = cardsFor(context);
  const conflicts = [{ shipping: null }, { shipping: { shippingKnown: true, currency: 'JPY', shippingJPY: 500 } },
    { currency: 'USD' }, { currency: { secret: 'never-retain-currency-payload' } }];
  const raw = cards.map((card, index) => ({ itemId: card.id, title: card.title, price: 12000, ...conflicts[index],
    image: { url: card.image }, seller: { id: card.sellerId } }));
  const nextData = { props: { initialState: { itemsState: { items: { item: target.ownBundle.detail } },
    recommendsState: { recommends: { recommends: { similar: { recommendItems: { items: raw } } } } } } } };
  target.ownBundle.recommendationReceipt = yahooRecommendationReceipt(nextData, { requestedItemId: target.item.id,
    sourceUrl: sourceUrl(target.item.id), observedAt: target.ownBundle.observedAt, now: context.now() });
  const report = await run(context, { baselineValidation: false });
  assert.equal(report.counts.unknownPrice, 4); assert.equal(report.counts.skippedNotLower, 0);
  assert.equal(report.requestPhases.newflow.detailPageFetches, 4);
  assert.equal(JSON.stringify(report).includes('never-retain-currency-payload'), false);
});

test('phase wall timings measure separate awaited intervals and retain interrupted partial elapsed time', async () => {
  const context = await setup({ sizes: [2, 0] }); makeAmbiguous(cardsFor(context)[0]); const began = context.now();
  const report = await run(context), timings = report.phaseTimings;
  assert.equal(timings.card_pass.intervals, 1); assert.equal(timings.ambiguity_detail_pass.intervals, 1);
  assert.equal(timings.baseline_validation_pass.intervals, 1);
  assert.ok(Object.values(timings).every(timing => timing.elapsedMs > 0 && timing.clockValid && !timing.interrupted));
  assert.equal(Object.values(timings).reduce((total, timing) => total + timing.elapsedMs, 0), context.now() - began);
  assert.match(report.phaseTimingMeaning, /including awaited I\/O; not CPU time/);
  const interrupted = await setup({ sizes: [1, 0] }); makeAmbiguous(cardsFor(interrupted)[0]);
  const normal = interrupted.readDetail;
  const partial = await run(interrupted, { readDetail: async (...args) => { const bundle = await normal(...args); interrupted.advance(720_000); return bundle; } });
  assert.equal(partial.phaseTimings.card_pass.interrupted, false);
  assert.equal(partial.phaseTimings.ambiguity_detail_pass.interrupted, true);
  assert.ok(partial.phaseTimings.ambiguity_detail_pass.elapsedMs >= 720_000);
  assert.equal(partial.phaseTimings.baseline_validation_pass.elapsedMs, 0);
});


test('audit intersections separate changed later price, unresolved hints and mainflow detail recovery', async () => {
  const changed = await setup({ sizes: [2, 0] }), changedCards = cardsFor(changed);
  changed.bundles.get(changedCards[0].id).detail.price = 11000;
  delete changedCards[1].price;
  const observed = await run(changed);
  assert.equal(observed.counts.paired, 2); assert.equal(observed.counts.cardLowerHints, 1);
  assert.equal(observed.counts.cardLowerHintsStrictNotLower, 1); assert.equal(observed.counts.cardLowerHintsStrictRejected, 0);
  assert.equal(observed.counts.cardLowerHintsPriceChanged, 1); assert.equal(observed.counts.comparablePriceChanged, 1);
  assert.equal(observed.counts.strictLowerWithoutCardHint, 1);
  assert.equal(observed.counts.strictLowerWithoutCardHintDetailRequired, 1);
  assert.equal(observed.counts.strictLowerWithoutCardHintUnknownCardPrice, 1);
  assert.equal(observed.counts.cardLowerHintsUnresolved, 0);
  const unread = await setup({ sizes: [1, 1] }), skipped = await run(unread, { baselineValidation: false });
  assert.equal(skipped.counts.cardLowerHints, 2); assert.equal(skipped.counts.cardLowerHintsUnresolved, 2);
  assert.equal(skipped.counts.cardLowerHintsUnpaired, 2); assert.equal(skipped.counts.cardLowerHintsPaired, 0);
  assert.equal(skipped.counts.cardLowerHintsStrictLower, 0); assert.equal(skipped.counts.cardLowerHintsStrictRejected, 0);
  assert.equal(skipped.counts.detailNotObserved, 2); assert.equal(skipped.counts.detailAttemptedWithoutObservation, 0);
  assert.deepEqual(skipped.targets.map(target => target.counts.cardLowerHintsUnresolved), [1, 1]);
  const denied = await setup({ sizes: [1, 0] }), deniedResult = await run(denied, { readDetail: async (id, options) => {
    const reservation = options.beforeYahooTransport({ url: sourceUrl(id), purpose: options.yahooRequestPurpose, targetId: options.yahooRequestTargetId });
    options.afterYahooTransport({ reservation, completed: false, httpStatus: 403 });
    throw Object.assign(Error('Synthetic denial'), { httpStatus: 403 });
  } });
  assert.equal(deniedResult.counts.cardLowerHintsUnresolved, 1); assert.equal(deniedResult.counts.cardLowerHintsUnpaired, 1);
  assert.equal(deniedResult.counts.detailAttemptedWithoutObservation, 1); assert.equal(deniedResult.counts.blocked, 1);
  assert.equal(deniedResult.counts.cardLowerHintsStrictRejected, 0);
});
