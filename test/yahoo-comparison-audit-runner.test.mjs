import test from 'node:test';
import assert from 'node:assert/strict';
import { claimComparisonAudit, comparisonAuditMarker, createComparisonAuditController } from '../scripts/lib/comparison-audit-control.mjs';
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
    log.push({ id, targetId: options.yahooRequestTargetId, purpose: options.yahooRequestPurpose });
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
const run = (context, changes = {}) => runYahooComparisonAudit({ ...context, ...changes });

test('uses real full verifier for every pair, including cards that would skip detail; observations keep independent source times', async () => {
  const context = await setup(), original = structuredClone(context.targets);
  const report = await run(context);
  assert.equal(report.status, 'completed'); assert.equal(report.counts.total, 4); assert.equal(report.counts.paired, 4);
  assert.equal(report.counts.comparable, 4); assert.equal(context.log.length, 4);
  for (const target of report.targets) for (const row of target.rows) {
    assert.equal(row.cardFirst.mode, 'card_observation'); assert.equal(row.baseline.status, 'comparable');
    assert.ok(time(row.detailObservation.observedAt) > time(row.cardObservations[0].observedAt));
    assert.equal(row.cardObservations[0].observedAt, target.recommendationReceipt.observedAt);
    assert.equal(row.comparison.interpretation, 'different_observation_times_not_ground_truth');
    assert.equal(row.baseline.candidate, undefined); assert.equal(row.baseline.checkedAt, undefined);
  }
  assert.equal(report.canRecommend, false); assert.equal(report.procurementCostEligible, false);
  assert.equal(report.checkedAt, undefined); assert.equal(report.candidates, undefined);
  assert.deepEqual(context.targets, original); assert.ok(Object.isFrozen(report.targets[0].recommendationReceipt.cards));
  assert.equal(report.controller.counts.pageFetches, 9);
  assert.equal(report.controller.counts.imageFetches, context.metrics().imageCalls);
  assert.equal(report.imageTransfers.started,context.metrics().imageCalls);assert.equal(report.imageTransfers.pending,0);assert.equal(report.imageTransfers.metricsComplete,true);assert.equal(report.imageTransfers.settledDurationMs,context.metrics().imageCalls);
  assert.equal(report.controller.counts.imageBytes, context.metrics().imageCalls * 20);
  assert.equal(context.metrics().maxImageActive, 1); assert.equal(context.metrics().maxDetailActive, 1);
});

const time = value => Date.parse(value);

test('strict ID binding and full verifier reject hidden sold/unit conflicts without producing audit prices', async () => {
  const context = await setup({ sizes: [3, 0] });
  const cards = context.targets[0].ownBundle.recommendationReceipt.cards;
  context.bundles.get(cards[0].id).detail.status = 'SOLD';
  context.bundles.get(cards[1].id).detail.description = '新品 未使用 フィギュア2点セット';
  context.bundles.get(cards[2].id).detail.id = 'synthetic-wrong-id';
  const report = await run(context), rows = report.targets[0].rows;
  assert.equal(rows[0].baseline.reason, 'not_open'); assert.equal(rows[1].baseline.reason, 'sale_unit_mismatch');
  assert.equal(rows[2].baseline.reason, 'detail_id_mismatch'); assert.equal(rows[2].paired, false);
  assert.equal(report.counts.paired, 2); assert.equal(report.counts.unpaired, 1); assert.equal(report.counts.comparable, 0);
  assert.equal(context.imageLog.filter(url => url === cards[2].image).length, 1, 'wrong detail never reaches verifier image I/O');
});

test('eighty includes all profile and own preconsumption; remaining eligible rows are explicitly counted', async () => {
  const context = await setup({ sizes: [40, 40], profiles: 17 }), report = await run(context);
  assert.equal(report.controller.counts.pageFetches, 80); assert.equal(report.controller.counts.competitorDetailFetches, 61);
  assert.equal(report.stopReason, 'page_budget_exhausted'); assert.equal(report.counts.paired, 61); assert.equal(report.counts.unpaired, 19);
  assert.equal(report.counts.eligibleUnpaired, 19);
  assert.ok(report.targets.flatMap(target => target.rows).filter(row => !row.paired).every(row => row.unpairedReason === 'page_budget_exhausted'));
  const counts = report.targets.map(target => target.counts.paired); assert.ok(Math.abs(counts[0] - counts[1]) <= 1);
});

test('sixty-four detail cap and fair initial thirty-two quotas remain unchanged', async () => {
  const context = await setup({ sizes: [40, 40] }), report = await run(context);
  assert.equal(report.controller.counts.competitorDetailFetches, 64); assert.equal(report.controller.counts.pageFetches, 69);
  assert.equal(report.stopReason, 'detail_budget_exhausted'); assert.deepEqual(report.targets.map(target => target.counts.paired), [32, 32]);
  assert.equal(report.counts.unpaired, 16);
});

test('unused detail quota transfers only after the smaller target is exhausted', async () => {
  const context = await setup({ sizes: [70, 2] }), report = await run(context);
  assert.deepEqual(report.targets.map(target => target.counts.paired), [62, 2]);
  assert.equal(report.controller.targets[targetIds[0]].allowance, 62);
  assert.deepEqual(context.log.slice(0, 4).map(row => row.targetId), [targetIds[0], targetIds[1], targetIds[0], targetIds[1]]);
});

test('known frozen competitor is first, then meaningful low prices fairly across both targets; absent known IDs are not injected', async () => {
  const context = await setup({ sizes: [3, 3] });
  const known = context.targets[1].ownBundle.recommendationReceipt.cards[2].id;
  context.targets[1].knownCandidateIds = [known, 'synthetic-not-in-recommendations'];
  const report = await run(context);
  assert.equal(context.log[0].id, known); assert.equal(context.log[0].purpose, 'known');
  assert.deepEqual(context.log.slice(1, 5).map(row => row.targetId), [targetIds[0], targetIds[1], targetIds[0], targetIds[1]]);
  assert.deepEqual(report.targets[1].knownNotInFrozenSet, ['synthetic-not-in-recommendations']);
  assert.equal(report.counts.total, 6);
});

test('incomplete all-account ownership and missing own detail/status/binding stop before any source I/O', async () => {
  const incomplete = await setup({ ready: false });
  const blocked = await run(incomplete);
  assert.equal(blocked.stopReason, 'complete_ownership_required'); assert.equal(incomplete.log.length, 0); assert.equal(incomplete.metrics().imageCalls, 0);
  for (const mutate of [
    target => { target.ownBundle.detail.description = ''; },
    target => { target.ownBundle.detail.status = 'SOLD'; },
    target => { target.ownBundle.detail.id = 'synthetic-wrong'; },
    target => { target.ownBundle.sourceUrl = sourceUrl('synthetic-other'); },
    target => { target.ownBundle.observedAt = START - 1; },
    target => { target.ownBundle.fromCache = true; },
    target => { target.ownBundle.recommendationReceipt.requestedItemId = 'synthetic-other'; },
  ]) {
    const context = await setup(); mutate(context.targets[1]);
    const result = await run(context); assert.equal(result.status, 'incomplete'); assert.equal(context.log.length, 0); assert.equal(context.metrics().imageCalls, 0);
  }
});

test('all owned aliases/listing history, sold cards, and permanent corrections exclude before detail or card-image reads', async () => {
  const context = await setup({ sizes: [5, 0] }), target = context.targets[0], receipt = target.ownBundle.recommendationReceipt;
  receipt.cards[0].sellerId = 'synthetic-owner-2'; receipt.cards[1].id = 'synthetic-historical-own'; receipt.cards[1].url = sourceUrl(receipt.cards[1].id);
  receipt.cards[2].itemStatus = 'SOLD';
  context.settings.matchCorrections = { active: { accountId: target.item.accountId, itemId: target.item.id, platform: 'yahoo', candidateId: receipt.cards[3].id },
    tombstone: { accountId: target.item.accountId, itemId: target.item.id, platform: 'yahoo', candidateId: receipt.cards[4].id, deleted: true } };
  const report = await run(context);
  assert.equal(report.counts.excluded, 4); assert.equal(report.counts.eligible, 1); assert.equal(report.counts.paired, 1);
  assert.equal(context.log.length, 1); assert.equal(context.log[0].id, receipt.cards[4].id);
  assert.deepEqual(report.targets[0].rows.slice(0, 4).map(row => row.exclusionReason), ['own_offer', 'own_offer', 'not_open', 'saved_user_correction']);
});

test('later detail seller from a managed alias is still rejected by the actual verifier', async () => {
  const context = await setup({ sizes: [1, 0] }), card = context.targets[0].ownBundle.recommendationReceipt.cards[0];
  context.bundles.get(card.id).detail.seller.id = 'synthetic-owner-2';
  const report = await run(context);
  assert.equal(report.counts.paired, 1); assert.equal(report.targets[0].rows[0].baseline.reason, 'own_seller');
  assert.equal(report.counts.comparable, 0);
});

test('deduplication preserves each raw card observation, omissions, and every remaining unpaired row', async () => {
  const context = await setup({ sizes: [2, 0] }), receipt = context.targets[0].ownBundle.recommendationReceipt;
  receipt.cards.push({ ...receipt.cards[0], price: 8000 }); receipt.totalCards = 6; receipt.invalidCards = 1; receipt.truncated = true;
  const report = await run(context);
  assert.equal(report.counts.raw, 6); assert.equal(report.counts.retainedRaw, 3); assert.equal(report.counts.total, 2);
  assert.equal(report.counts.duplicates, 1); assert.equal(report.counts.omittedRaw, 3); assert.equal(report.counts.invalidRaw, 1);
  assert.equal(report.targets[0].rows[0].cardObservations.length, 2);
  assert.equal(report.targets[0].rows[0].cardFirst.reason, 'conflicting_card_observations');
  assert.equal(report.targets[0].collectionComplete, false);
  assert.equal(context.log.length, 2);
});

test('shared candidate raw detail is reused across targets without a new transport or observation time', async () => {
  const context = await setup({ sizes: [1, 1] }), first = context.targets[0].ownBundle.recommendationReceipt.cards[0], second = context.targets[1].ownBundle.recommendationReceipt;
  second.cards[0] = { ...first, observedAt: second.observedAt };
  const report = await run(context), [a, b] = report.targets.map(target => target.rows[0]);
  assert.equal(report.counts.paired, 2); assert.equal(context.log.length, 1); assert.equal(report.controller.counts.cacheReuses, 1);
  assert.equal(a.detailObservation.observedAt, b.detailObservation.observedAt); assert.equal(b.detailObservation.fromCache, true);
  assert.notEqual(a.cardObservations[0].observedAt, b.cardObservations[0].observedAt);
});

test('failed details remain unknown and do not turn into negative evidence; later candidates continue', async () => {
  const context = await setup({ sizes: [2, 0] }), normal = context.readDetail; let calls = 0;
  const report = await run(context, { readDetail: async (id, settings) => {
    if (calls++) return normal(id, settings);
    const reservation = settings.beforeYahooTransport({ url: sourceUrl(id), targetId: settings.yahooRequestTargetId, purpose: settings.yahooRequestPurpose });
    settings.afterYahooTransport({ reservation, completed: false, httpStatus: 503 }); throw Error('Synthetic network failure');
  } });
  assert.equal(report.counts.paired, 1); assert.equal(report.counts.unpaired, 1); assert.equal(report.counts.unknown, 1);
  assert.equal(report.targets[0].rows[0].baseline.reason, 'detail_reader_failed'); assert.equal(report.controller.counts.competitorDetailFetches, 2);
});

test('source denial stops all later detail and image I/O, keeping every unpaired candidate explicit', async () => {
  const context = await setup({ sizes: [2, 2] }); let calls = 0;
  const report = await run(context, { readDetail: async (id, settings) => {
    calls++; const reservation = settings.beforeYahooTransport({ url: sourceUrl(id), targetId: settings.yahooRequestTargetId, purpose: settings.yahooRequestPurpose });
    settings.afterYahooTransport({ reservation, completed: false, httpStatus: 429 }); throw Object.assign(Error('Synthetic denial'), { httpStatus: 429 });
  } });
  assert.equal(report.stopReason, 'source_denied'); assert.equal(calls, 1); assert.equal(report.counts.unpaired, 4);
  assert.equal(report.controller.counts.competitorDetailFetches, 1);
  assert.ok(report.targets.flatMap(target => target.rows).every(row => row.unpairedReason === 'source_denied'));
});

test('original deadline cannot restart after earlier profile/own work and prevents further I/O', async () => {
  const context = await setup({ sizes: [2, 2] }), normal = context.readDetail; let calls = 0;
  const report = await run(context, { readDetail: async (id, settings) => { calls++; const bundle = await normal(id, settings); context.advance(720_000); return bundle; } });
  assert.equal(report.stopReason, 'deadline_exceeded'); assert.equal(report.deadlineAt, iso(START + 720_000)); assert.equal(calls, 1);
  assert.equal(report.counts.paired, 0); assert.equal(report.counts.unpaired, 4);
});

test('cancellation aborts an uncooperative reader and prevents any subsequent I/O', async () => {
  const abort = new AbortController(), context = await setup({ sizes: [2, 2], externalSignal: abort.signal }); let calls = 0;
  const report = await run(context, { signal: abort.signal, readDetail: async () => {
    calls++; queueMicrotask(() => abort.abort()); return new Promise(() => {});
  } });
  assert.equal(report.stopReason, 'cancelled'); assert.equal(calls, 1); assert.equal(report.counts.unpaired, 4);
});

test('a reader that fails to use actual transport hooks cannot emit a paired result', async () => {
  const context = await setup({ sizes: [2, 2] }); let calls = 0;
  const report = await run(context, { readDetail: async id => { calls++; return { ...context.bundles.get(id), observedAt: context.now(), sourceUrl: sourceUrl(id), fromCache: false }; } });
  assert.equal(report.stopReason, 'detail_transport_not_counted'); assert.equal(calls, 1); assert.equal(report.counts.paired, 0);
});

test('verifier Promise.all image work is serialized even for several distinct detail images', async () => {
  const context = await setup({ sizes: [1, 0] }), card = context.targets[0].ownBundle.recommendationReceipt.cards[0];
  context.bundles.get(card.id).detail.images.push('https://synthetic.invalid/second.jpg', 'https://synthetic.invalid/third.jpg');
  const report = await run(context); assert.equal(report.counts.paired, 1); assert.equal(context.metrics().maxImageActive, 1);
  assert.equal(report.controller.counts.imageFetches, 5);
});

test('deadline timer ends an uncooperative reader at the original bound', async () => {
  const context = await setup({ sizes: [1, 1] }); let reads = 0;
  context.advance(START + 720_000 - context.now() - 80); context.enableWallClock();
  const report = await run(context, { readDetail: async () => { reads++; return new Promise(() => {}); } });
  assert.equal(reads, 1); assert.equal(report.stopReason, 'deadline_exceeded');
  assert.equal(report.counts.paired, 0); assert.equal(report.counts.unpaired, 2);
});

test('source image denial and pre-transport source holds stop safely without later I/O', async () => {
  const context = await setup(); let calls = 0;
  const report = await run(context, { imageFingerprints: async () => { calls++; throw Object.assign(Error('Synthetic image denial'), { httpStatus: 403 }); } });
  assert.equal(report.stopReason, 'source_denied'); assert.equal(calls, 1); assert.equal(context.log.length, 0);
  const held = await setup(); let reads = 0;
  const result = await run(held, { readDetail: async () => { reads++; throw Object.assign(Error('Synthetic source hold'), { code: 'request_deferred' }); } });
  assert.equal(result.stopReason, 'source_request_deferred'); assert.equal(reads, 1); assert.equal(result.counts.paired, 0);
});

test('missing detail fields stay unknown, and unindexed own seller bindings block with zero I/O', async () => {
  const context = await setup({ sizes: [1, 0] });
  context.bundles.values().next().value.detail.description = '';
  const report = await run(context); assert.equal(report.targets[0].rows[0].baseline.status, 'unknown');
  assert.equal(report.targets[0].rows[0].baseline.reason, 'sale_description_unavailable');
  const bad = await setup(); bad.targets[1].item.sellerId = bad.targets[1].ownBundle.detail.seller.id = 'synthetic-unmapped-owner';
  const result = await run(bad); assert.equal(result.stopReason, 'own_account_binding_missing'); assert.equal(bad.log.length, 0); assert.equal(bad.metrics().imageCalls, 0);
});

test('missing full index or cross-account own identity binding blocks before I/O even with a finalized controller', async () => {
  const missing = await setup(), report = await run(missing, { ownershipIndex: undefined });
  assert.equal(report.stopReason, 'complete_ownership_required'); assert.equal(missing.metrics().imageCalls, 0);
  const wrongAccount = await setup(); wrongAccount.targets[1].item.accountId = accountIds[0];
  const wrong = await run(wrongAccount); assert.equal(wrong.stopReason, 'own_account_binding_missing'); assert.equal(wrongAccount.metrics().imageCalls, 0);
});

test('prerequisite failures and unreported raw omissions never claim complete paired coverage', async () => {
  const bad = await setup(); bad.targets[0].ownBundle.detail.description = '';
  const blocked = await run(bad); assert.equal(blocked.counts.paired, 0); assert.equal(blocked.pairedCoverageComplete, false);
  const omitted = await setup({ sizes: [2, 0] }); omitted.targets[0].ownBundle.recommendationReceipt.totalCards = 100;
  const report = await run(omitted); assert.equal(report.counts.omittedRaw, 98); assert.equal(report.targets[0].collectionComplete, false);
  assert.equal(report.pairedCoverageComplete, false);
  const valid = await setup(); assert.equal((await run(valid)).pairedCoverageComplete, true);
});

test('a failed verifier image drains its already-queued image jobs before returning final metrics', async () => {
  const context = await setup({ sizes: [1, 0] }), card = context.targets[0].ownBundle.recommendationReceipt.cards[0];
  context.bundles.get(card.id).detail.images.push('https://synthetic.invalid/second.jpg', 'https://synthetic.invalid/third.jpg');
  let calls = 0;
  const report = await run(context, { imageFingerprints: async (url, options) => {
    if (++calls === 3) throw Error('Synthetic first verifier image failure');
    return context.imageFingerprints(url, options);
  } });
  assert.equal(report.targets[0].rows[0].baseline.reason, 'verifier_failed'); assert.equal(report.counts.paired, 0);
  assert.equal(calls, 5); assert.equal(report.controller.counts.imageFetches, 4);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls, 5); assert.equal(context.controller.snapshot().counts.imageFetches, report.controller.counts.imageFetches);
});

test('quota-blocked queue heads do not conceal cached frozen IDs that need no additional detail page', async () => {
  const context = await setup({ sizes: [34, 34] }), first = context.targets[0].ownBundle.recommendationReceipt.cards[0], second = context.targets[1].ownBundle.recommendationReceipt;
  second.cards[33] = { ...second.cards[33], id: first.id, url: first.url, image: first.image };
  const report = await run(context);
  assert.equal(report.controller.counts.competitorDetailFetches, 64); assert.equal(report.controller.counts.cacheReuses, 1);
  assert.equal(report.counts.paired, 65); assert.equal(report.counts.unpaired, 3);
  assert.equal(report.targets[1].rows.find(row => row.id === first.id).paired, true);
});

test('image fingerprint cache hits do not invent image transfers, bytes, or duration', async () => {
  const context = await setup({ sizes: [1, 0] });
  const report = await run(context, { imageFingerprints: async (url, options) => {
    options.observeImageTransfer({ fetches: 0, bytes: 0, durationMs: 0 });
    return { ...PRIMARY, url, contentSha256: 'b'.repeat(64), imageObservedAt: iso(context.now()) };
  } });
  assert.equal(report.counts.paired, 1); assert.equal(report.imageFingerprintCalls, 3);
  assert.equal(report.controller.counts.imageFetches, 0); assert.equal(report.controller.counts.imageBytes, 0); assert.equal(report.controller.counts.imageWallMs, 0);
});

test('unrecognized lower-price cards remain before higher-price title matches in the fixed audit', async () => {
  const context=await setup({sizes:[2,0]}),cards=context.targets[0].ownBundle.recommendationReceipt.cards;
  cards[0].price=11000;context.bundles.get(cards[0].id).detail.price=11000;
  cards[1].title=cards[1].text='説明省略';cards[1].price=8000;context.bundles.get(cards[1].id).detail.price=8000;
  const report=await run(context);
  assert.deepEqual(context.log.map(row=>row.id),[cards[1].id,cards[0].id]);
  assert.equal(report.targets[0].rows.find(row=>row.id===cards[1].id).meaningful,false);
  assert.equal(report.counts.paired,2);
});

test('an aborted image transport reports pending actual start rather than a complete zero', async () => {
  const context=await setup();
  const report=await run(context,{imageFingerprints:async (_url,options)=>{
    options.observeImageTransferStart();context.controller.cancel();return null;
  }});
  assert.equal(report.status,'incomplete');assert.equal(report.imageTransfers.started,1);
  assert.equal(report.imageTransfers.settled,0);assert.equal(report.imageTransfers.pending,1);
  assert.equal(report.imageTransfers.metricsComplete,false);
});
