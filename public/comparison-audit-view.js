import { isOwnedOffer, isSelfOffer, normalizeOfferPlatform } from './owned-offers.js';
import { rejectedByMemory } from './match-memory.js';

// Presentation only. Consume the publisher's single-target projection, never a
// full report/ownership ledger or cross-account inventory totals. Nothing from
// this lane becomes pricing evidence.
const KIND = 'standalone_frozen_yahoo_comparison_audit';
const MAX_ROWS = 10;
const HISTORY_AFTER_MS = 20 * 60_000;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value.trim() : '';
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const price = value => Number.isSafeInteger(value) && value > 0;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const timestamp = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return NaN;
  const result = Date.parse(value);
  return Number.isFinite(result) && new Date(result).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z') ? result : NaN;
};
function canonicalYahoo(id, url) {
  if (typeof id !== 'string' || !/^z\d+$/.test(id)) return null;
  const canonical = `https://paypayfleamarket.yahoo.co.jp/item/${id}`;
  return url === canonical ? canonical : null;
}
function counts(value) {
  return Object.fromEntries(['total', 'eligibleLowPrice', 'paired', 'unpaired', 'confirmedLowerPrice', 'unknownPrice',
    'skippedNotLower', 'mainflowCardOnly', 'mainflowDetailPaired', 'baselineValidationPaired'].map(key => [key, count(value?.[key])]));
}
function currentOwnership(index, item) {
  const yahoo = index?.yahoo;
  return yahoo?.items instanceof Set && yahoo?.sellers instanceof Set && yahoo.items.has(item.id) &&
    text(item.sellerId) && yahoo.sellers.has(item.sellerId);
}
function rejected(item, row, options) {
  return row.isOwn === true || isSelfOffer(item, 'yahoo', row) || isOwnedOffer(options.ownershipIndex, 'yahoo', row) ||
    [item.sellerId, item.sourceDetail?.sellerId, item.sourceDetail?.seller?.id].some(id => id && String(id) === row.sellerId) ||
    Boolean(rejectedByMemory(options.corrections, item, 'yahoo', row));
}
function sameCard(left, right) {
  return ['id', 'url', 'title', 'price', 'sellerId', 'itemStatus', 'priceKind', 'currency', 'observedAt'].every(key => left[key] === right[key]) &&
    Object.hasOwn(left, 'shipping') === Object.hasOwn(right, 'shipping') && JSON.stringify(left.shipping) === JSON.stringify(right.shipping);
}
function validDetail(detail, id, frozenAt, now) {
  const at = timestamp(detail?.observedAt);
  return plain(detail) && detail.id === id && canonicalYahoo(id, detail.sourceUrl) && text(detail.sellerId) &&
    Number.isFinite(at) && at >= frozenAt && at <= now;
}
function genuineHint(row, card, own) {
  const first = row.cardFirst, hint = first?.observation;
  return first?.mode === 'card_observation' && first.cardId === row.id && plain(hint) &&
    hint.id === card.id && hint.url === card.url && hint.title === card.title && hint.sellerId === card.sellerId &&
    hint.priceJPY === card.price && hint.currency === 'JPY' && hint.priceSource === 'current_card_ordinary_price' &&
    timestamp(hint.cardObservedAt) === timestamp(card.observedAt) && timestamp(hint.ownObservedAt) === timestamp(own.observedAt) &&
    hint.source === 'recommendation_card' && hint.lowerPriceAlert === true && hint.detailVerified === false &&
    hint.canRecommend === false && hint.procurementCostEligible === false;
}

/**
 * item.comparisonAudit = { version, kind, requestId, startedAt, frozenAt,
 *   status, stopReason, ownershipCheckedAtPublication: true, target: oneReportTarget }.
 * The publisher must exclude ALL owned accounts before setting its ownership
 * flag. Call with the CURRENT visible ownership index and current corrections;
 * the browser does not pretend that a member-visible index is a full index.
 * Expiry is a historical label, not a deletion or renewed freshness window.
 * Returned fields are an allowlist; cross-account report fields never escape.
 */
export function comparisonAuditPresentation(item = {}, options = {}) {
  const { ownershipIndex, corrections, now = Date.now() } = options;
  if (!plain(item) || !Number.isFinite(now) || !text(item.accountId) || !text(item.title) ||
    normalizeOfferPlatform(item.platform, item.ownUrl || item.url) !== 'yahoo' || !currentOwnership(ownershipIndex, item) ||
    !plain(corrections) || Object.values(corrections).some(value => !plain(value))) return null;
  const audit = item.comparisonAudit, target = audit?.target, own = target?.ownObservation;
  const lowerPriceMode = audit?.flowMode === 'lower_price_card_first';
  const started = timestamp(audit?.startedAt), frozen = timestamp(audit?.frozenAt), observed = timestamp(own?.observedAt);
  if (!plain(audit) || audit.version !== 1 || audit.kind !== KIND || audit.ownershipCheckedAtPublication !== true || !text(audit.requestId) || !plain(target) ||
    target.targetId !== item.id || target.accountId !== item.accountId || !plain(own) || own.id !== item.id || own.title !== item.title ||
    !canonicalYahoo(item.id, own.sourceUrl) || own.sellerId !== item.sellerId || own.status !== 'OPEN' || !price(own.priceJPY) ||
    !Number.isFinite(started) || started > now || !Number.isFinite(observed) || observed < started || observed > now ||
    (audit.frozenAt !== null && (!Number.isFinite(frozen) || frozen < observed || frozen > now)) ||
    !Array.isArray(target.rows)) return null;
  // Exact current URL binding when present. Missing URLs do not manufacture one.
  if ([item.ownUrl, item.url].some(url => url !== undefined && url !== null && !canonicalYahoo(item.id, url))) return null;
  const receipt = target.recommendationReceipt;
  const boundReceipt = plain(receipt) && receipt.version === 1 && receipt.requestedItemId === item.id &&
    receipt.sourceUrl === own.sourceUrl && timestamp(receipt.observedAt) === observed && Array.isArray(receipt.cards);
  const visible = [], seen = new Set();
  if (boundReceipt && Number.isFinite(frozen)) for (const row of target.rows) {
    if (!plain(row) || seen.has(row.id)) continue;
    seen.add(row.id);
    // Frozen exclusions and current exclusions both matter. A deletion tombstone
    // never turns a previously unclassified/excluded sample into accepted proof.
    if (row.eligible !== true || row.exclusionReason || row.cardFirst?.mode === 'excluded' ||
      !Array.isArray(row.cardObservations) || row.cardObservations.length === 0) continue;
    const cards = row.cardObservations;
    if (cards.some(card => !plain(card) || card.id !== row.id || !canonicalYahoo(card.id, card.url) ||
      !text(card.title) || !text(card.sellerId) || !(price(card.price) && card.priceKind === 'ordinary' || lowerPriceMode && card.price === null && card.priceKind === 'unknown') ||
      timestamp(card.observedAt) !== observed || rejected(item, card, { ownershipIndex, corrections }) ||
      !receipt.cards.some(saved => plain(saved) && sameCard(card, saved)))) continue;
    const card = cards[0];
    const cardPriceKnown = price(card.price) && card.priceKind === 'ordinary' && (card.currency === undefined || card.currency === 'JPY') &&
      (!Object.hasOwn(card, 'shipping') || card.shipping?.shippingKnown === true && card.shipping.currency === 'JPY' && card.shipping.shippingJPY === 0) &&
      (!lowerPriceMode || row.priceComparison?.own?.status === 'confirmed' && row.priceComparison.own.priceJPY === own.priceJPY &&
        Array.isArray(row.priceComparison.observations) && row.priceComparison.observations.length === cards.length &&
        row.priceComparison.observations.every((value,index) => value?.status === 'confirmed' && value.priceJPY === cards[index].price));
    const detail = row.detailObservation;
    // Any observed seller/ID that is now owned excludes the entire row, even if
    // the card originally identified an outside seller. Never hide that evidence.
    if (plain(detail) && rejected(item, { ...detail, url: detail.sourceUrl }, { ownershipIndex, corrections })) continue;
    const detailBound = validDetail(detail, row.id, frozen, now);
    const baseline = row.baseline;
    const detailPriceConfirmed = !lowerPriceMode || row.detailPriceComparison?.candidate?.status === 'confirmed' &&
      row.detailPriceComparison.candidate.priceJPY === detail?.priceJPY && row.detailPriceComparison?.own?.status === 'confirmed' &&
      row.detailPriceComparison.own.priceJPY === own.priceJPY;
    const paired = row.paired === true && detailBound;
    const comparable = paired && detailPriceConfirmed && baseline?.status === 'comparable' && baseline.comparable === true &&
      baseline.currentDetailRead === true && detail.status === 'OPEN' && text(detail.description) &&
      price(detail.priceJPY) && baseline.priceJPY === detail.priceJPY;
    const rejectedBaseline = paired && baseline?.status === 'rejected' && baseline.comparable === false && baseline.currentDetailRead === true;
    if (!(cardPriceKnown && card.price < own.priceJPY) && !(!cardPriceKnown && lowerPriceMode && comparable && detail.priceJPY < own.priceJPY)) continue;
    const conflict = cards.some(value => !sameCard(value, card));
    const hint = cardPriceKnown && !conflict && genuineHint(row, card, own);
    const available = !conflict && card.itemStatus === 'OPEN' && card.availabilityEvidence?.itemId === card.id &&
      ['current_search_card', 'current_seller_card', 'current_detail'].includes(card.availabilityEvidence?.source) &&
      timestamp(card.availabilityEvidence.observedAt) === observed;
    visible.push({ id: card.id, url: card.url, title: card.title, cardPriceJPY: cardPriceKnown ? card.price : null, cardObservedAt: card.observedAt,
      hint, conflictingCards: conflict, availabilityConfirmedAtCard: available,
      cardSold: cards.some(value => ['SOLD', 'CLOSED'].includes(value.itemStatus)),
      baselineStatus: comparable ? 'comparable' : rejectedBaseline ? 'rejected' : baseline?.status === 'blocked' ? 'blocked' : 'unknown',
      baselineReason: text(baseline?.reason || row.unpairedReason || row.cardFirst?.reason).slice(0, 240),
      paired, detailObservedAt: detailBound ? detail.observedAt : null,
      detailPriceJPY: detailBound && detailPriceConfirmed && price(detail.priceJPY) ? detail.priceJPY : null,
      expired: now - observed > HISTORY_AFTER_MS });
  }
  visible.sort((a, b) => (a.cardPriceJPY ?? a.detailPriceJPY) - (b.cardPriceJPY ?? b.detailPriceJPY) || a.id.localeCompare(b.id));
  return { requestId: audit.requestId, startedAt: audit.startedAt, frozenAt: Number.isFinite(frozen) ? audit.frozenAt : null,
    flowMode: audit.flowMode === 'lower_price_card_first' ? 'lower_price_card_first' : 'paired_baseline',
    status: audit.status === 'completed' ? 'completed' : 'incomplete', stopReason: text(audit.stopReason).slice(0, 240),
    counts: counts(target.counts), collectionComplete: target.collectionComplete === true,
    historical: true, expired: now - observed > HISTORY_AFTER_MS, originalOwnObservedAt: own.observedAt,
    visibleLowerPriceCount: visible.length, omittedVisibleRows: Math.max(0, visible.length - MAX_ROWS), rows: visible.slice(0, MAX_ROWS),
    canRecommend: false, procurementCostEligible: false };
}
const timeMarkup = value => `<time datetime="${escape(value)}">${escape(value)}</time>`;
const yen = value => `¥${value.toLocaleString('ja-JP')}`;
const countMarkup = (label, value) => `<p class="muted">${label}：候选总数 ${value.total ?? '未记录'} · 可检查低价 ${value.eligibleLowPrice ?? '未记录'} · 已成对 ${value.paired ?? '未记录'} · 未成对 ${value.unpaired ?? '未记录'}</p>`;
function rowMarkup(row) {
  const later = row.baselineStatus === 'comparable' ? '当时详情判定可比，仅为历史对照结果' :
    row.baselineStatus === 'rejected' ? '后读详情未通过可比性检查，不能视为同款报价' :
      row.baselineStatus === 'blocked' ? '详情检查受阻，结果未知，不能视为同款报价' : '详情检查未完成或结果未知，同款、规格与可购状态待核验';
  return `<li data-comparison-audit-id="${escape(row.id)}" data-audit-baseline="${escape(row.baselineStatus)}">
    <a target="_blank" rel="noopener noreferrer" href="${escape(row.url)}">${escape(row.title)} ↗</a>
    <strong>${row.hint ? '卡片低价线索：图片与标题高度相似，未详情核实' : row.cardPriceJPY === null ? '后读详情低价记录，保留原始核验时间' : '较低卡片标价记录，同款关系待核验'}</strong>
    <span>${row.cardPriceJPY === null ? '原卡片标价未确认，保留后进入详情检查' : `原卡片普通标价：${yen(row.cardPriceJPY)}（相对本次自家原始标价）`}</span>
    <span>卡片原始读取时间：${timeMarkup(row.cardObservedAt)}</span>
    <span>${row.cardSold ? '卡片记录非在售，不能视为可购报价' : row.availabilityConfirmedAtCard ? '卡片当时有在售证据；当前可购状态仍待核验' : '卡片可购状态未确认，待详情核验'}；当前规格、数量、成色、附件与销售说明待核验。</span>
    ${row.conflictingCards ? '<span>同一候选的卡片记录不一致，不能认定为高相似度线索。</span>' : ''}
    <span>${later}</span>
    ${row.detailObservedAt ? `<span>后读详情原始读取时间：${timeMarkup(row.detailObservedAt)}${row.detailPriceJPY !== null ? ` · 当时详情标价 ${yen(row.detailPriceJPY)}` : ' · 详情金额未确认'}</span>` : '<span>没有有效的后读详情原始时间；未用卡片、尝试或页面发布时间代替。</span>'}
    ${row.baselineReason ? `<span>对照记录原因：${escape(row.baselineReason)}</span>` : ''}
  </li>`;
}
export function comparisonAuditMarkup(item = {}, options = {}) {
  const audit = comparisonAuditPresentation(item, options);
  if (!audit) return '';
  return `<section class="manualbox comparison-audit" aria-label="一次性卡片与详情对照审计">
    <h3>一次性卡片与详情对照审计</h3>
    <p>本次一次性对照占用了常规扫描时段；这些记录单独展示，不生成或替代现有自动调价建议，也不计入采购成本和全量核验覆盖。</p>
    <p>历史审计记录${audit.expired ? '（样本已超过 20 分钟，仅供回看）' : '（仅供回看）'}：不承诺当前价格、库存或同款关系有效。</p>
    <p class="muted">请求 ${escape(audit.requestId)} · 开始 ${timeMarkup(audit.startedAt)}${audit.frozenAt ? ` · 候选冻结 ${timeMarkup(audit.frozenAt)}` : ' · 候选尚未冻结'} · ${audit.status === 'completed' ? '对照执行结束' : '对照未完整结束'}${audit.stopReason ? `（${escape(audit.stopReason)}）` : ''}</p>
    ${countMarkup('本商品冻结口径', audit.counts)}
    ${audit.flowMode === 'lower_price_card_first' ? `<p class="muted">本次先比较到手价：确认更低 ${audit.counts.confirmedLowerPrice ?? '未记录'} · 金额或运费未知 ${audit.counts.unknownPrice ?? '未记录'} · 确认不低而跳过 ${audit.counts.skippedNotLower ?? '未记录'}。未知项保留待查，跳过项仍计入冻结总数。</p>
    <p class="muted">主流程卡片提示 ${audit.counts.mainflowCardOnly ?? '未记录'} · 疑难详情结果 ${audit.counts.mainflowDetailPaired ?? '未记录'} · 另做卡片详情对照 ${audit.counts.baselineValidationPaired ?? '未记录'}。卡片提示不会自动调价；未配对部分不能当作没有漏报。</p>` : ''}
    <p class="muted">以上为冻结样本计数，保留原口径；下方已重新排除当前自有账号与纠错记录。已成对仅表示两种检查均有结果，不表示核实同款。${audit.collectionComplete ? '' : '推荐卡片收集不完整，未收集或未成对部分不能当作没有低价。'}</p>
    <p class="muted">卡片与后读详情来自不同时间，不能当作同时刻的价格真值，也不能据此推算漏判率。当前价格、库存与规格仍需重新核验。</p>
    ${audit.rows.length ? `<ul class="samples">${audit.rows.map(rowMarkup).join('')}</ul>` : '<p>没有可安全展示的较低卡片标价记录；这不代表没有外部低价。</p>'}
    ${audit.omittedVisibleRows ? `<p class="muted">仅展示前 ${MAX_ROWS} 条较低卡片标价记录，另有 ${audit.omittedVisibleRows} 条未展开。</p>` : ''}
  </section>`;
}
