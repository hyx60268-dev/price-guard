import { claimComparisonAudit, comparisonAuditMarker, createComparisonAuditController } from '../../scripts/lib/comparison-audit-control.mjs';
import { runYahooComparisonAudit } from '../../scripts/lib/yahoo-comparison-audit-runner.mjs';
import { SAVED_COMPARISON_AUDIT as P } from '../../scripts/lib/comparison-audit-summary.mjs';

// Synthetic inventory and transports, with the reviewed public pins only.
// Executes the genuine controller, runner, classifier and full verifier offline.
export async function createSavedComparisonAuditFixture({ overflow = false, configureTargets } = {}) {
  const START = Date.parse('2026-10-18T02:30:00.000Z');
  const iso = at => new Date(at).toISOString(), sourceUrl = id => `https://paypayfleamarket.yahoo.co.jp/item/${id}`;
  let at = START, serial = 0;
  const now = () => at;
  const title = 'APEX ヴァイオレット・エヴァーガーデン 自動手記人形Ver. 1/7 フィギュア 新品 未使用 1点';
  const description = '新品 未使用 フィギュア1点';
  const primary = { dHash: '00ff00ff00ff00ff', aHash: '00ff00ff00ff00ff', centerHash: '00ff00ff00ff00ff',
    color: [100, 100, 100], colorGrid: Array(768).fill(100) };
  const configured = { version: 1, sourceStateId: 'synthetic-private-state', accounts: [{ accountId: 'melon',
    platform: 'yahoo', sellerBindingVerified: true, sellerIds: ['synthetic-owner'], listingIds: [...P.targetIds],
    provenance: [{ source: 'synthetic fixture', sourceStateId: 'synthetic-private-state', observedAt: iso(START - 1000) }] }] };
  const claim = await claimComparisonAudit({ activation: { enabled: true, requestId: P.requestId,
    issuedAt: iso(START - 1000), expiresAt: iso(START + 3_600_000) },
    context: { eventName: 'push', ref: 'refs/heads/main', runId: P.runId, runAttempt: 1,
      expectedSha: P.codeSha, codeSha: P.codeSha, eventSha: P.codeSha, currentMainSha: P.codeSha,
      startedAt: iso(START), commitMessage: comparisonAuditMarker(P.requestId) },
    receipt: { version: 1, revision: 0, consumed: [] }, consumeReceipt: async ({ receipt }) => receipt, now });
  const controller = createComparisonAuditController({ claim, configuredOwnership: configured,
    expectedAccountIds: ['melon'], sourceStateId: configured.sourceStateId, targetIds: P.targetIds, now });
  const profile = controller.reservePageFetch({ kind: 'profile', accountId: 'melon', transportId: 'synthetic-profile' });
  at++;
  controller.finishPageFetch({ reservationId: profile.reservationId, outcome: 'ok', observedAt: at, bytes: 10 });
  const ownershipIndex = { ...configured, complete: true, verifiedAt: iso(at), accounts: configured.accounts.map(account => ({
    ...account, complete: true, profile: { complete: true, observedAt: iso(at), reservationIds: [profile.reservationId] } })) };
  controller.setOwnershipIndex(ownershipIndex);
  const bundles = new Map();
  const targets = P.targetIds.map((id, index) => {
    const item = { id, platform: 'yahoo', accountId: 'melon', sellerId: 'synthetic-owner', title, ownPrice: 10000 };
    const own = controller.reservePageFetch({ kind: 'own', transportId: `synthetic-own-${index}` }); at++;
    controller.finishPageFetch({ reservationId: own.reservationId, outcome: 'ok', observedAt: at, bytes: 10 });
    const observedAt = at;
    const definitions = overflow ? Array.from({ length: 40 }, (_, number) => ({ id: `synthetic-${index}-${number}`, price: 2000 + number })) :
      [{ id: P.knownCandidateId, price: 2000 }, { id: 'synthetic-shared', price: 5000 },
        { id: `synthetic-only-${index}`, price: index ? 2500 : 7500 }, { id: `synthetic-higher-${index}`, price: 10000 }];
    const cards = definitions.map(({ id: candidateId, price }) => {
      const image = `https://synthetic.invalid/${candidateId}.jpg`;
      const card = { id: candidateId, url: sourceUrl(candidateId), title, text: title, price,
        sellerId: 'synthetic-external', image, itemStatus: null, priceKind: 'ordinary',
        observedAt: iso(observedAt), source: 'recommendation', recommendationScore: 1 };
      bundles.set(candidateId, { detail: { id: candidateId, title, description: candidateId === 'synthetic-shared' ?
        '新品 未使用 フィギュア2点セット' : description, status: candidateId === P.knownCandidateId ? 'SOLD' : 'OPEN',
        price, seller: { id: 'synthetic-external' }, images: [image] } });
      return card;
    });
    const recommendationReceipt = { version: 1, requestedItemId: id, sourceUrl: sourceUrl(id), observedAt: iso(observedAt),
      totalCards: cards.length, invalidCards: 0, truncated: false, sectionsTruncated: false, cards };
    return { item, ownBundle: { sourceUrl: sourceUrl(id), observedAt, fromCache: false, auditReservationId: own.reservationId,
      detail: { id, title, description, status: 'OPEN', price: 10000, seller: { id: 'synthetic-owner' },
        images: [`https://synthetic.invalid/${id}.jpg`] }, recommendationReceipt },
      ownImageKind: 'photo', cardImageKinds: Object.fromEntries(cards.map(card => [card.id, 'photo'])) };
  });
  if (configureTargets) configureTargets(targets);
  const settings = {
    beforeYahooTransport({ url, purpose, targetId }) {
      const permit = controller.reservePageFetch({ kind: purpose === 'known' ? 'known' : 'detail', targetId,
        candidateId: new URL(url).pathname.split('/').at(-1), transportId: `synthetic-detail-${++serial}` });
      if (!permit.admitted) throw Object.assign(new Error(permit.reason), { auditReason: permit.reason });
      return permit;
    },
    afterYahooTransport({ reservation, observedAt }) {
      return controller.finishPageFetch({ reservationId: reservation.reservationId, outcome: 'ok',
        transportStarted: true, observedAt, bytes: 10 });
    },
  };
  const report = await runYahooComparisonAudit({ controller, ownershipIndex, targets, settings, now,
    flowMode: 'lower_price_card_first', baselineValidation: true,
    async readDetail(id, options) {
      const reservation = options.beforeYahooTransport({ url: sourceUrl(id), purpose: options.yahooRequestPurpose,
        targetId: options.yahooRequestTargetId }); at += 10;
      options.afterYahooTransport({ reservation, observedAt: at });
      return { ...structuredClone(bundles.get(id)), observedAt: at, sourceUrl: sourceUrl(id), fromCache: false };
    },
    async imageFingerprints(url, context) {
      context.observeImageTransferStart(); at++;
      context.observeImageTransfer({ fetches: 1, bytes: 10, durationMs: 1 });
      return { ...primary, url, contentSha256: 'a'.repeat(64), imageObservedAt: iso(at) };
    },
  });
  return structuredClone({ version: 6, checkedAt: P.snapshotAt, dataRevision: P.snapshotAt,
    cycleCoverage: { finishedAt: P.snapshotAt }, scanMeta: { codeSha: P.codeSha, startedAt: iso(START) },
    items: targets.map(target => target.item), comparisonAuditReceipt: claim.receipt, comparisonAudit: report });
}
