import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { comparisonAuditMarkup, comparisonAuditPresentation } from '../public/comparison-audit-view.js';
import { buildOwnedOffers } from '../public/owned-offers.js';
import { pricingDecision, PRICING_RULES_VERSION } from '../public/pricing-policy.js';

// Offline, synthetic fixtures only. No source reader, fetch, or remote service.
const startedAt = '2026-10-16T12:00:00.000Z';
const observedAt = '2026-10-16T12:00:10.000Z';
const frozenAt = '2026-10-16T12:00:11.000Z';
const detailAt = '2026-10-16T12:00:12.000Z';
const now = Date.parse('2026-10-16T12:01:00.000Z');
const url = id => `https://paypayfleamarket.yahoo.co.jp/item/${id}`;
const title = '検証用 フィギュア 1点';
const account = { id: 'audit-owner-a', sellerId: 'managed-seller-a', platform: 'yahoo' };
function product(size = 1) {
  const item = { id: 'z101', accountId: account.id, platform: 'yahoo_fleamarket', title,
    sellerId: account.sellerId, ownUrl: url('z101'), ownPrice: 10000, image: 'https://example.test/own.jpg',
    checkedAt: '2026-10-15T12:00:00.000Z', averageCNY: 321, manualFeeCNY: 12, purchaseCNY: 321,
    recommendedPrice: 7777, lowestPrice: 7777,
    yahoo: { rulesVersion: PRICING_RULES_VERSION, status: 'cached', candidates: [], searchComplete: false,
      checkedAt: '2026-10-15T12:00:00.000Z', lastAttemptAt: startedAt } };
  const ownObservation = { id: item.id, title, description: '合成テスト用の説明', sourceUrl: item.ownUrl,
    observedAt, sellerId: item.sellerId, priceJPY: item.ownPrice, status: 'OPEN', images: [item.image] };
  const rows = Array.from({ length: size }, (_, i) => {
    const id = `z${201 + i}`, price = 9000 - i;
    const card = { id, url: url(id), title: `合成候補 ${i}`, price, sellerId: `external-${i}`, priceKind: 'ordinary',
      itemStatus: null, observedAt, source: 'recommendation', availabilityEvidence: null };
    const observation = { id, url: card.url, title: card.title, sellerId: card.sellerId, priceJPY: price,
      currency: 'JPY', priceSource: 'current_card_ordinary_price', cardObservedAt: observedAt, ownObservedAt: observedAt,
      availability: 'unconfirmed', unknownTerms: ['availability_not_confirmed', 'sale_description_not_observed'],
      source: 'recommendation_card', detailVerified: false, canRecommend: false, procurementCostEligible: false, lowerPriceAlert: true };
    return { id, cardObservations: [card], eligible: true, lowPrice: true, paired: true,
      cardFirst: { mode: 'card_observation', cardId: id, observation },
      baseline: { status: 'comparable', comparable: true, lowerThanOwn: true, priceJPY: price, currentDetailRead: true,
        reason: 'detail_type_quantity_text_images' },
      detailObservation: { id, sourceUrl: card.url, title: card.title, sellerId: card.sellerId, priceJPY: price,
        description: '合成テスト用の説明', status: 'OPEN', observedAt: detailAt, fromCache: false } };
  });
  const target = { targetId: item.id, accountId: item.accountId, ownObservation, rows, collectionComplete: true,
    counts: { total: size, eligibleLowPrice: size, paired: size, unpaired: 0 },
    recommendationReceipt: { version: 1, requestedItemId: item.id, sourceUrl: item.ownUrl, observedAt,
      cards: rows.flatMap(row => structuredClone(row.cardObservations)), totalCards: size, invalidCards: 0 } };
  item.comparisonAudit = { version: 1, kind: 'standalone_frozen_yahoo_comparison_audit', requestId: 'synthetic-audit-001',
    startedAt, frozenAt, status: 'completed', stopReason: null, ownershipCheckedAtPublication: true,
    counts: { total: 998877, eligibleLowPrice: 998876, paired: 998875, unpaired: 2 }, target };
  return item;
}
const options = (item, extra = {}) => ({ ownershipIndex: buildOwnedOffers([account], [item]), corrections: {}, now, ...extra });
const select = (item, extra = {}) => comparisonAuditPresentation(item, options(item, extra));
function dom(item, extra = {}) { return new JSDOM(comparisonAuditMarkup(item, options(item, extra))); }
function changeCard(item, change) {
  const row = item.comparisonAudit.target.rows[0];
  Object.assign(row.cardObservations[0], change);
  item.comparisonAudit.target.recommendationReceipt.cards[0] = structuredClone(row.cardObservations[0]);
}
function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

test('one-target audit shows frozen counts, source times, and separate lower-price hint without changing pricing or costs', () => {
  const item = product(), before = structuredClone(item), beforeDecision = pricingDecision(item, { now });
  deepFreeze(item);
  const result = select(item), document = dom(item);
  try {
    assert.equal(result.rows.length, 1); assert.equal(result.rows[0].hint, true);
    assert.equal(result.rows[0].cardPriceJPY, 9000); assert.equal(result.rows[0].cardObservedAt, observedAt);
    assert.equal(result.rows[0].detailObservedAt, detailAt); assert.equal(result.rows[0].baselineStatus, 'comparable');
    assert.equal(result.canRecommend, false); assert.equal(result.procurementCostEligible, false);
    const section = document.window.document.querySelector('.comparison-audit'), content = section.textContent;
    assert.match(content, /一次性对照占用了常规扫描时段/);
    assert.match(content, /不生成或替代现有自动调价建议/); assert.match(content, /不计入采购成本和全量核验覆盖/);
    assert.match(content, /候选总数 1 · 可检查低价 1 · 已成对 1 · 未成对 0/);
    assert.match(content, /卡片低价线索/); assert.match(content, /原卡片普通标价：¥9,000/);
    assert.match(content, /不同时间/); assert.match(content, /已成对仅表示两种检查均有结果/);
    assert.match(content, /可购状态未确认/); assert.match(content, /规格、数量、成色、附件/);
    assert.equal(section.querySelector('li a').href, url('z201'));
    assert.equal(section.querySelector('li a').rel, 'noopener noreferrer');
    const stamps = [...section.querySelectorAll('li time')].map(node => node.getAttribute('datetime'));
    assert.deepEqual(stamps, [observedAt, detailAt]); assert.doesNotMatch(content, /998877|998876|998875/);
    assert.deepEqual(item, before); assert.deepEqual(pricingDecision(item, { now }), beforeDecision);
  } finally { document.window.close(); }
});

test('exact target, account, current title, seller, and canonical own URL binding fail closed', () => {
  for (const mutate of [
    item => { item.id = 'z999'; }, item => { item.id = 'z101/<img>'; },
    item => { item.accountId = 'other-account'; }, item => { item.title += '別仕様'; },
    item => { item.comparisonAudit.target.accountId = 'other-account'; },
    item => { item.comparisonAudit.target.targetId = 'z999'; },
    item => { item.comparisonAudit.target.ownObservation.id = 'z999'; },
    item => { item.comparisonAudit.target.ownObservation.title = 'different'; },
    item => { item.comparisonAudit.target.ownObservation.sellerId = 'different'; },
    item => { item.comparisonAudit.target.ownObservation.status = 'SOLD'; },
    item => { item.comparisonAudit.target.ownObservation.sourceUrl = url('z999'); },
    item => { item.ownUrl += '?credential=private'; }, item => { item.url = 'javascript:alert(1)'; },
    item => { item.platform = 'rakuma'; item.ownUrl = undefined; },
  ]) {
    const item = product(); mutate(item); assert.equal(select(item), null); assert.equal(comparisonAuditMarkup(item, options(item)), '');
  }
  // Price changes retain an explicitly historical comparison to the audit's
  // original price, never a fresh lower-than-current assertion.
  const item = product(); item.ownPrice = 5000;
  assert.equal(select(item).rows[0].cardPriceJPY, 9000);
  assert.match(comparisonAuditMarkup(item, options(item)), /相对本次自家原始标价/);
});

test('unpublished ownership checks and unavailable current ownership/corrections suppress every amount', () => {
  for (const value of [undefined, null, false, 'true']) {
    const item = product(); item.comparisonAudit.ownershipCheckedAtPublication = value; assert.equal(select(item), null);
  }
  const item = product();
  for (const index of [undefined, null, {}, buildOwnedOffers([], []), { yahoo: { items: new Set([item.id]), sellers: new Set() } }]) {
    assert.equal(select(item, { ownershipIndex: index }), null);
  }
  for (const corrections of [undefined, null, [], { bad: null }, { bad: 'bad' }, { bad: [] }]) assert.equal(select(item, { corrections }), null);
  assert.equal(select(item).rows.length, 1, 'publication flag does not assert a complete browser index');
});

test('all current owned IDs, seller aliases, self offers and later detail ownership exclude the row', () => {
  for (const owned of [
    { id: 'z201', accountId: 'alias-account', platform: 'yahoo' },
    { id: 'z501', sellerId: 'external-0', accountId: 'alias-account', platform: 'yahoo' },
    { id: 'z501', sourceDetail: { seller: { id: 'external-0' } }, accountId: 'alias-account', platform: 'yahoo' },
  ]) {
    const item = product(); assert.equal(select(item, { ownershipIndex: buildOwnedOffers([account], [item, owned]) }).rows.length, 0);
  }
  const item = product();
  assert.equal(select(item, { ownershipIndex: buildOwnedOffers([account, { id: 'alias', platform: 'yahoo', sellerId: 'external-0' }], [item]) }).rows.length, 0);
  for (const change of [{ sellerId: account.sellerId }, { isOwn: true }, { id: 'z101', url: url('z101') }]) {
    const sample = product(); changeCard(sample, change); assert.equal(select(sample).rows.length, 0);
  }
  const later = product(); later.comparisonAudit.target.rows[0].detailObservation.sellerId = account.sellerId;
  assert.equal(select(later).rows.length, 0);
  const ownDetailId = product(); ownDetailId.comparisonAudit.target.rows[0].detailObservation.id = ownDetailId.id;
  assert.equal(select(ownDetailId).rows.length, 0);
});

test('current account-scoped corrections and relisting exclusions are applied without mutating tombstones', () => {
  const item = product(), correction = { accountId: item.accountId, itemId: item.id, platform: 'yahoo', candidateId: 'z201', updatedAt: detailAt };
  assert.equal(select(item, { corrections: { row: correction } }).rows.length, 0);
  const deleted = { row: { ...correction, deleted: true } }, before = structuredClone(deleted);
  assert.equal(select(item, { corrections: deleted }).rows.length, 1); assert.deepEqual(deleted, before);
  assert.equal(select(item, { corrections: { row: { ...correction, accountId: 'unrelated' } } }).rows.length, 1);
  item.relistedFrom = 'z100';
  assert.equal(select(item, { corrections: { row: { ...correction, itemId: item.relistedFrom, ownTitle: item.title, ownImage: item.image } } }).rows.length, 0);
  for (const mutate of [
    row => { row.eligible = false; }, row => { row.exclusionReason = 'saved_user_correction'; },
    row => { row.cardFirst.mode = 'excluded'; },
  ]) { const item = product(); mutate(item.comparisonAudit.target.rows[0]); assert.equal(select(item, { corrections: deleted }).rows.length, 0); }
});

test('invalid source IDs, unsafe URLs, missing seller, conditional or invalid prices never show amounts', () => {
  for (const change of [
    { id: 'invalid-id', url: url('invalid-id') }, { id: '../z201', url: url('../z201') },
    { url: url('z999') }, { url: 'javascript:alert(1)' }, { url: 'http://paypayfleamarket.yahoo.co.jp/item/z201' },
    { url: 'https://paypayfleamarket.yahoo.co.jp.evil.test/item/z201' },
    { url: 'https://user:pass@paypayfleamarket.yahoo.co.jp/item/z201' },
    { url: `${url('z201')}?secret=private` }, { url: `${url('z201')}#unbound` },
    { sellerId: '' }, { priceKind: 'coupon' }, { price: '9000' }, { price: NaN }, { price: Infinity },
    { price: -1 }, { price: 0 }, { price: 9000.5 }, { price: 10000 }, { price: 12000 },
  ]) {
    const item = product(); changeCard(item, change); assert.equal(select(item).rows.length, 0, JSON.stringify(change));
    assert.doesNotMatch(comparisonAuditMarkup(item, options(item)), /¥/);
  }
});

test('each card must be bound to the exact recommendation receipt and original observation time', () => {
  for (const mutate of [
    target => { target.recommendationReceipt.requestedItemId = 'z999'; },
    target => { target.recommendationReceipt.sourceUrl = url('z999'); },
    target => { target.recommendationReceipt.observedAt = detailAt; },
    target => { target.recommendationReceipt.cards = []; },
    target => { target.recommendationReceipt.cards[0].price = 5000; },
    target => { target.rows[0].cardObservations[0].observedAt = detailAt; },
    target => { target.rows[0].cardObservations = []; },
    target => { target.rows[0].cardObservations.push(null); },
  ]) { const item = product(); mutate(item.comparisonAudit.target); assert.equal(select(item).rows.length, 0); }
});

test('expiry retains the historical audit and both original times without any live freshness promise', () => {
  const item = product(), future = now + 40 * 86400_000, before = structuredClone(item);
  const result = select(item, { now: future }); assert.equal(result.expired, true); assert.equal(result.rows.length, 1);
  const markup = comparisonAuditMarkup(item, options(item, { now: future }));
  assert.match(markup, /历史审计记录（样本已超过 20 分钟，仅供回看）/);
  assert.match(markup, /不承诺当前价格、库存或同款关系有效/);
  assert.match(markup, new RegExp(observedAt)); assert.match(markup, new RegExp(detailAt));
  assert.doesNotMatch(markup, /当前有效|实时价格|已核验同款|已刷新|本轮核验完成/);
  assert.deepEqual(item, before);
});

test('invalid, missing, future and impossible timestamps are never replaced with publication/attempt clocks', () => {
  for (const stamp of [undefined, null, '', 'not-a-date', '2026-10-16', '2026-02-30T12:00:00.000Z', '2026-10-16T12:02:00.000Z']) {
    const item = product(); item.comparisonAudit.target.ownObservation.observedAt = stamp;
    item.checkedAt = detailAt; item.yahoo.checkedAt = detailAt; item.yahoo.lastAttemptAt = detailAt;
    assert.equal(select(item), null, String(stamp));
    const detailItem = product(); detailItem.comparisonAudit.target.rows[0].detailObservation.observedAt = stamp;
    const result = select(detailItem).rows[0]; assert.equal(result.detailObservedAt, null); assert.equal(result.detailPriceJPY, null);
    assert.equal(result.baselineStatus, 'unknown'); assert.equal(result.paired, false);
  }
  for (const field of ['startedAt', 'frozenAt']) { const item = product(); item.comparisonAudit[field] = 'bad'; assert.equal(select(item), null); }
  const notFrozen = product(); notFrozen.comparisonAudit.frozenAt = null;
  assert.equal(select(notFrozen).rows.length, 0); assert.match(comparisonAuditMarkup(notFrozen, options(notFrozen)), /候选尚未冻结/);
});

test('a genuine card hint survives failed baseline only as pending; rejected pairs never become verified matching offers', () => {
  for (const status of ['unknown', 'blocked', 'rejected']) {
    const item = product(), row = item.comparisonAudit.target.rows[0];
    row.baseline = { status, reason: status === 'rejected' ? 'sale_unit_mismatch' : 'detail_reader_failed',
      comparable: status === 'rejected' ? false : null, currentDetailRead: status === 'rejected' };
    row.paired = status === 'rejected';
    if (!row.paired) { row.detailObservation = undefined; row.unpairedReason = 'detail_reader_failed'; }
    const result = select(item).rows[0], markup = comparisonAuditMarkup(item, options(item));
    assert.equal(result.hint, true); assert.equal(result.baselineStatus, status);
    assert.match(markup, /卡片低价线索/); assert.doesNotMatch(markup, /当时详情判定可比|已核验同款/);
    assert.match(markup, status === 'rejected' ? /不能视为同款报价/ : /未知/);
    if (status !== 'rejected') { assert.equal(result.detailObservedAt, null); assert.match(markup, /没有有效的后读详情原始时间/); }
  }
});

test('malformed or unbound card-first proof never manufactures a genuine high-similarity hint', () => {
  for (const mutate of [
    first => { first.cardId = 'z999'; }, first => { first.mode = 'detail_required'; },
    first => { first.observation.id = 'z999'; }, first => { first.observation.sellerId = 'unbound'; },
    first => { first.observation.cardObservedAt = detailAt; }, first => { first.observation.ownObservedAt = detailAt; },
    first => { first.observation.priceJPY = 200; }, first => { first.observation.canRecommend = true; },
    first => { first.observation.detailVerified = true; }, first => { first.observation.procurementCostEligible = true; },
  ]) {
    const item = product(); mutate(item.comparisonAudit.target.rows[0].cardFirst);
    assert.equal(select(item).rows[0].hint, false); assert.match(comparisonAuditMarkup(item, options(item)), /较低卡片标价记录，同款关系待核验/);
  }
  const duplicate = product(), target = duplicate.comparisonAudit.target, different = { ...target.rows[0].cardObservations[0], price: 8500 };
  target.rows[0].cardObservations.push(different); target.recommendationReceipt.cards.push(structuredClone(different));
  assert.equal(select(duplicate).rows[0].hint, false);
  assert.match(comparisonAuditMarkup(duplicate, options(duplicate)), /卡片记录不一致/);
});

test('even claimed comparable baselines need original bound detail, open status, description, and matching amount', () => {
  for (const mutate of [
    row => { row.paired = false; }, row => { row.baseline.comparable = false; }, row => { row.baseline.currentDetailRead = false; },
    row => { row.baseline.priceJPY = 8500; }, row => { row.detailObservation.status = 'SOLD'; },
    row => { row.detailObservation.description = ''; }, row => { row.detailObservation.id = 'z999'; },
    row => { row.detailObservation.sourceUrl = `${url('z201')}?credential=x`; },
    row => { row.detailObservation.sellerId = ''; },
  ]) {
    const item = product(); mutate(item.comparisonAudit.target.rows[0]);
    assert.equal(select(item).rows[0].baselineStatus, 'unknown');
    assert.doesNotMatch(comparisonAuditMarkup(item, options(item)), /当时详情判定可比/);
  }
});

test('unconfirmed availability/specifications stay pending even with optimistic card fields', () => {
  const item = product(); changeCard(item, { itemStatus: 'OPEN' });
  assert.equal(select(item).rows[0].availabilityConfirmedAtCard, false);
  assert.match(comparisonAuditMarkup(item, options(item)), /卡片可购状态未确认，待详情核验/);
  changeCard(item, { availabilityEvidence: { itemId: 'z201', source: 'current_search_card', observedAt } });
  assert.equal(select(item).rows[0].availabilityConfirmedAtCard, true);
  assert.match(comparisonAuditMarkup(item, options(item)), /当前可购状态仍待核验/);
  changeCard(item, { availabilityEvidence: { itemId: 'z201', source: 'current_search_card', observedAt: detailAt } });
  assert.equal(select(item).rows[0].availabilityConfirmedAtCard, false);
});

test('bounded row output is deterministic, deduplicated and preserves frozen counters and source arrays', () => {
  const item = product(12), target = item.comparisonAudit.target;
  target.rows.push(structuredClone(target.rows[0]));
  const before = structuredClone(item), result = select(item), document = dom(item);
  try {
    assert.equal(result.rows.length, 10); assert.equal(result.visibleLowerPriceCount, 12); assert.equal(result.omittedVisibleRows, 2);
    assert.equal(result.rows[0].cardPriceJPY, 8989); assert.equal(result.counts.total, 12);
    assert.equal(document.window.document.querySelectorAll('[data-comparison-audit-id]').length, 10);
    assert.match(document.window.document.body.textContent, /另有 2 条未展开/); assert.deepEqual(item, before);
  } finally { document.window.close(); }
});

test('escaping covers titles, request IDs, reasons and status, while no unvalidated source can become a link', () => {
  const item = product(), attack = '<img src=x onerror="alert(1)"> & <script>alert(2)</script>', row = item.comparisonAudit.target.rows[0];
  changeCard(item, { title: attack }); row.cardFirst.observation.title = attack;
  row.baseline.reason = attack; item.comparisonAudit.requestId = attack; item.comparisonAudit.stopReason = attack;
  const document = dom(item);
  try {
    const doc = document.window.document;
    assert.equal(doc.querySelector('img'), null); assert.equal(doc.querySelector('script'), null);
    assert.equal(doc.querySelector('[onerror]'), null); assert.match(doc.body.textContent, /<img src=x onerror="alert\(1\)">/);
    assert.deepEqual([...doc.querySelectorAll('a')].map(node => node.href), [url('z201')]);
  } finally { document.window.close(); }
});

test('allowlisted presentation cannot leak other targets, seller indexes, controller state, or aggregate inventories', () => {
  const item = product(); Object.assign(item.comparisonAudit, {
    targets: [{ targetId: 'private-other-target', accountId: 'private-other-account', ownObservation: { title: 'PRIVATE OTHER TITLE', priceJPY: 1234567 } }],
    ownershipIndex: { sellerIds: ['PRIVATE OTHER SELLER'] }, controller: { requests: [{ targetId: 'private-other-target' }] },
  });
  const result = select(item), markup = comparisonAuditMarkup(item, options(item));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|private-other|99887/); assert.doesNotMatch(markup, /PRIVATE|private-other|99887|1,234,567/);
  assert.equal(result.targets, undefined); assert.equal(result.controller, undefined); assert.equal(result.ownershipIndex, undefined);
});

test('malformed counters remain unknown and an empty safe result never claims absence of cheaper offers', () => {
  const item = product(); item.comparisonAudit.target.counts = { total: -1, paired: '1', unpaired: Infinity };
  item.comparisonAudit.target.rows = []; item.comparisonAudit.target.collectionComplete = false;
  const markup = comparisonAuditMarkup(item, options(item));
  assert.match(markup, /候选总数 未记录 · 可检查低价 未记录 · 已成对 未记录 · 未成对 未记录/);
  assert.match(markup, /这不代表没有外部低价/); assert.match(markup, /推荐卡片收集不完整/);
  assert.doesNotMatch(markup, /¥/);
});


test('malformed envelopes and row containers fail closed without reading external sources', () => {
  for (const value of [null, false, 'bad', [], {}]) {
    const item = product(); item.comparisonAudit = value; assert.equal(select(item), null);
  }
  for (const value of [null, false, 'bad', {}]) {
    const item = product(); item.comparisonAudit.target.rows = value; assert.equal(select(item), null);
  }
  for (const value of [null, false, 'bad', [], {}]) {
    const item = product(); item.comparisonAudit.target.rows = [value]; assert.equal(select(item).rows.length, 0);
  }
  assert.equal(comparisonAuditPresentation(null, { now }), null);
});


test('lower-price mode exposes target-only skipped and unknown populations without changing pricing',()=>{
 const item=product(),before=pricingDecision(item,{now});item.comparisonAudit.flowMode='lower_price_card_first';
 Object.assign(item.comparisonAudit.target.counts,{confirmedLowerPrice:12,unknownPrice:3,skippedNotLower:7,mainflowCardOnly:4,mainflowDetailPaired:8,baselineValidationPaired:2});
 const result=select(item),view=dom(item);try{
  assert.equal(result.flowMode,'lower_price_card_first');
  const content=view.window.document.querySelector('.comparison-audit').textContent;
  assert.match(content,/确认更低 12/);assert.match(content,/金额或运费未知 3/);assert.match(content,/确认不低而跳过 7/);
  assert.match(content,/主流程卡片提示 4/);assert.match(content,/疑难详情结果 8/);assert.match(content,/另做卡片详情对照 2/);
  assert.match(content,/未配对部分不能当作没有漏报/);assert.doesNotMatch(content,/998877/);
  assert.deepEqual(pricingDecision(item,{now}),before);
 }finally{view.window.close()}
});

test('unknown card price can expose a later bound comparable lower detail without inventing a card quote',()=>{
 const item=product();item.comparisonAudit.flowMode='lower_price_card_first';changeCard(item,{price:null,priceKind:'unknown'});
 item.comparisonAudit.target.rows[0].detailPriceComparison={own:{status:'confirmed',priceJPY:10000},candidate:{status:'confirmed',priceJPY:9000}};
 item.comparisonAudit.target.rows[0].cardFirst={mode:'detail_required',reason:'ordinary_price_unconfirmed',cardId:'z201'};
 const before=pricingDecision(item,{now}),result=select(item),view=dom(item);try{
  assert.equal(result.rows.length,1);assert.equal(result.rows[0].cardPriceJPY,null);assert.equal(result.rows[0].hint,false);
  assert.equal(result.rows[0].detailPriceJPY,9000);assert.equal(result.rows[0].baselineStatus,'comparable');
  assert.match(view.window.document.body.textContent,/原卡片标价未确认/);assert.match(view.window.document.body.textContent,/后读详情低价记录/);
  assert.doesNotMatch(view.window.document.body.textContent,/原卡片普通标价：/);assert.deepEqual(pricingDecision(item,{now}),before);
 }finally{view.window.close()}
 for(const mutate of [row=>{row.paired=false},row=>{row.baseline.status='unknown'},row=>{row.detailObservation.priceJPY=11000;row.baseline.priceJPY=11000}]){
  const copy=structuredClone(item);mutate(copy.comparisonAudit.target.rows[0]);assert.equal(select(copy).rows.length,0);
 }
});


test('newflow cannot display foreign or unconfirmed card/detail amounts as JPY',()=>{
 const item=product();item.comparisonAudit.flowMode='lower_price_card_first';
 const row=item.comparisonAudit.target.rows[0];
 row.priceComparison={status:'confirmed_lower',own:{status:'confirmed',priceJPY:10000},observations:[{status:'confirmed',priceJPY:9000}]};
 row.detailPriceComparison={own:{status:'confirmed',priceJPY:10000},candidate:{status:'confirmed',priceJPY:9000}};
 assert.equal(select(item).rows[0].cardPriceJPY,9000);assert.equal(select(item).rows[0].detailPriceJPY,9000);
 const foreign=structuredClone(item);changeCard(foreign,{currency:'unknown'});
 foreign.comparisonAudit.target.rows[0].priceComparison.observations[0]={status:'unknown',reason:'ordinary_price_unconfirmed'};
 const observed=select(foreign).rows[0];assert.equal(observed.cardPriceJPY,null);assert.equal(observed.detailPriceJPY,9000);assert.equal(observed.hint,false);
 for(const candidate of [{status:'unknown',reason:'ordinary_price_unconfirmed'},{status:'confirmed',priceJPY:8000}]){
  const copy=structuredClone(foreign);copy.comparisonAudit.target.rows[0].detailPriceComparison.candidate=candidate;
  assert.equal(select(copy).rows.length,0);
 }
 const unknownDetail=structuredClone(item);unknownDetail.comparisonAudit.target.rows[0].baseline.status='unknown';
 unknownDetail.comparisonAudit.target.rows[0].detailPriceComparison.candidate={status:'unknown',reason:'ordinary_price_unconfirmed'};
 assert.equal(select(unknownDetail).rows[0].detailPriceJPY,null);
});

test('card currency and shipping remain bound to the frozen producer receipt',()=>{
 for(const patch of [{currency:'JPY'},{shipping:{shippingKnown:true,currency:'JPY',shippingJPY:0}}]){
  const item=product();Object.assign(item.comparisonAudit.target.rows[0].cardObservations[0],patch);
  assert.equal(select(item).rows.length,0);
 }
});
