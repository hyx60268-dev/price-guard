// Scheduling only: these cards still require the caller's ownership, correction,
// explicit-variant and full-detail checks. Price proximity is not identity proof.
const MAX_REALLOCATED = 4;
const KNOWN_SOURCES = new Set(['search', 'recommendation', 'prior_verified']);

function data(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor && !Object.hasOwn(descriptor, 'value')) throw new TypeError('Accessor input');
  return descriptor?.value;
}

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function arrayValues(value) {
  if (!Array.isArray(value)) throw new TypeError('Array required');
  const length = data(value, 'length'), result = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Dense data array required');
    result.push(descriptor.value);
  }
  return result;
}

function cardData(card) {
  if (!record(card)) throw new TypeError('Card record required');
  const id = data(card, 'id'), image = data(card, 'image'), price = data(card, 'price');
  if (typeof id !== 'string' || !id || id.trim() !== id ||
      typeof image !== 'string' || !image.trim()) throw new TypeError('Bound card and image required');
  const rawSources = data(card, 'sources'), source = data(card, 'source');
  const sources = rawSources === undefined ? [] : arrayValues(rawSources);
  if (sources.some(value => typeof value !== 'string') ||
      (source !== undefined && typeof source !== 'string')) throw new TypeError('Invalid source');
  if (source) sources.push(source);
  const categories = [...new Set(sources.map(value => KNOWN_SOURCES.has(value) ? value : 'unknown'))];
  if (!categories.length) categories.push('unknown');
  return {
    card, id, image, price,
    knownPrice: typeof price === 'number' && Number.isFinite(price) && price > 0,
    categories,
    recommendation: sources.includes('recommendation'),
  };
}

/**
 * Reallocate a small part of an existing thumbnail budget without expanding it.
 * `baseline` is the caller's already ordered, already bounded old work list.
 * `candidates` is an already cheap-screened, managed-offer-excluded pool; it may
 * include preliminary candidates. The caller owns all product/seller guards.
 *
 * Unknown baseline prices and source representation stay protected. Distinct
 * near-price recommendation cards can replace only an unprotected original
 * tail, in candidate order. No title strength or guessed seller data is used.
 * Invalid/ambiguous input, disabled mode and unavailable quota are fail-closed.
 * This bounds fingerprint invocations, not cache misses or network requests.
 */
export function planYahooThumbnailWork(options = {}) {
  let baseline = [], originalIds = [], baselineTypes = [];
  const unchanged = () => ({ selected: baseline, reallocated: 0, originalIds, selectedTypes: baselineTypes });
  try {
    if (!record(options)) return unchanged();
    const suppliedBaseline = data(options, 'baseline');
    if (!Array.isArray(suppliedBaseline)) return unchanged();
    baseline = suppliedBaseline;
    const original = arrayValues(baseline).map(cardData);
    if (new Set(original.map(row => row.id)).size !== original.length) return unchanged();
    originalIds = original.map(row => row.id);
    baselineTypes = original.map(() => 'baseline');
    const quota = Math.min(MAX_REALLOCATED, Math.floor(original.length / 4));
    const ownPrice = data(options, 'ownPrice');
    if (data(options, 'enabled') !== true || !quota ||
        typeof ownPrice !== 'number' || !Number.isFinite(ownPrice) || ownPrice <= 0) return unchanged();

    const pool = arrayValues(data(options, 'candidates')).map(cardData);
    if (new Set(pool.map(row => row.id)).size !== pool.length) return unchanged();
    const byId = new Map(original.map(row => [row.id, row]));
    for (const row of pool) {
      const prior = byId.get(row.id);
      if (prior && (row.image !== prior.image || !Object.is(row.price, prior.price))) return unchanged();
    }
    const additions = pool.filter(row => !byId.has(row.id) && row.recommendation && row.knownPrice &&
      row.price >= ownPrice * 0.75 && row.price < ownPrice).slice(0, quota);
    if (!additions.length) return unchanged();

    const protectedIds = new Set(original.filter(row => !row.knownPrice).map(row => row.id));
    const lowest = original.reduce((best, row) => row.knownPrice && (!best || row.price < best.price) ? row : best, null);
    if (lowest) protectedIds.add(lowest.id);
    // Preserve the earliest representative of every observed source category,
    // including absent/unrecognized sources rather than classifying them away.
    const represented = new Set();
    for (const row of original) {
      if (row.categories.some(source => !represented.has(source))) protectedIds.add(row.id);
      for (const source of row.categories) represented.add(source);
    }
    const removedIds = new Set();
    for (let index = original.length - 1; index >= 0 && removedIds.size < additions.length; index--) {
      if (!protectedIds.has(original[index].id)) removedIds.add(original[index].id);
    }
    if (!removedIds.size) return unchanged();
    const retained = original.filter(row => !removedIds.has(row.id));
    const reallocated = removedIds.size;
    return {
      selected: [...retained.map(row => row.card), ...additions.slice(0, reallocated).map(row => row.card)],
      reallocated,
      originalIds,
      selectedTypes: [...retained.map(() => 'baseline'), ...Array(reallocated).fill('near_price_recommendation')],
    };
  } catch {
    return unchanged();
  }
}
