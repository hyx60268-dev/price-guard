import test from 'node:test';
import assert from 'node:assert/strict';
import { planYahooThumbnailWork } from '../scripts/lib/yahoo-thumbnail-work-plan.mjs';

const card = (id, price, extra = {}) => ({ id, price, image: `fixture-${id}`, title: '', sources: ['recommendation'], ...extra });
const baseline = () => Array.from({ length: 20 }, (_, index) => card(`low-${index}`, 100 + index));
const near = () => Array.from({ length: 7 }, (_, index) => card(`near-${index}`, 750 + index * 20));
const plan = (options = {}) => planYahooThumbnailWork({ enabled: true, ownPrice: 1000, baseline: baseline(), candidates: near(), ...options });
const ids = rows => rows.map(row => row.id);

test('same bounded 20-card work list retains 16 low weak-title cards and adds four near-price recommendations', () => {
  const original = baseline(), candidates = near();
  const result = plan({ baseline: original, candidates });
  assert.deepEqual(result.selected, [...original.slice(0, 16), ...candidates.slice(0, 4)]);
  assert.equal(result.reallocated, 4);
  assert.deepEqual(result.originalIds, ids(original));
  assert.deepEqual(result.selectedTypes, [...Array(16).fill('baseline'), ...Array(4).fill('near_price_recommendation')]);
  assert.equal(new Set(ids(result.selected)).size, 20);
  assert.ok(result.selected.every(row => original.includes(row) || candidates.includes(row)));
});

test('disabled default and missing or invalid inputs preserve the original order', () => {
  const original = baseline();
  for (const options of [
    { baseline: original, candidates: near(), ownPrice: 1000 },
    { enabled: false }, { enabled: 'true' }, { ownPrice: undefined }, { ownPrice: null },
    { ownPrice: 0 }, { ownPrice: -100 }, { ownPrice: NaN }, { ownPrice: Infinity }, { ownPrice: '1000' },
    { candidates: undefined }, { candidates: null }, { candidates: {} }, { candidates: [] },
  ]) {
    const result = options.enabled === undefined && Object.hasOwn(options, 'baseline')
      ? planYahooThumbnailWork(options) : plan({ baseline: original, ...options });
    assert.deepEqual(result.selected, original);
    assert.equal(result.reallocated, 0);
  }
  assert.deepEqual(planYahooThumbnailWork().selected, []);
  assert.deepEqual(planYahooThumbnailWork(null).selected, []);
});

test('every budget is bounded by its actual baseline length and floor(n / 4), never configured capacity', () => {
  for (let length = 0; length <= 30; length++) {
    const original = Array.from({ length }, (_, index) => card(`low-${index}`, index + 1));
    const result = plan({ baseline: original });
    assert.equal(result.selected.length, length);
    assert.equal(result.reallocated, Math.min(4, Math.floor(length / 4)));
    if (length < 4) assert.deepEqual(result.selected, original);
    else assert.ok(result.selected.includes(original[0]));
  }
});

test('unknown prices and all source categories survive, as does the lowest card even at the tail', () => {
  const original = baseline();
  original[15] = card('unknown-null', null);
  original[16] = card('unknown-undefined', undefined, { sources: [] });
  original[17] = card('only-search', 200, { sources: ['search'] });
  original[18] = card('only-known', 200, { sources: ['prior_verified'] });
  original[19] = card('lowest-last', 1, { sources: ['unrecognized-source'] });
  const result = plan({ baseline: original });
  for (const row of original.slice(15)) assert.ok(result.selected.includes(row));
  assert.deepEqual(result.selected.filter(row => original.includes(row)), original.filter((_, index) => index < 11 || index >= 15));
  assert.equal(result.selected.length, 20);
  assert.equal(result.reallocated, 4);
});

test('protected unknown-price baselines can reduce the allocation rather than lose unknown recall', () => {
  const original = Array.from({ length: 20 }, (_, index) => card(`unknown-${index}`, null));
  const result = plan({ baseline: original });
  assert.deepEqual(result.selected, original);
  assert.equal(result.reallocated, 0);
});

test('near-price is only a scheduling preference: recommendation source and strict bounds required', () => {
  const original = baseline();
  const candidates = [
    card('unknown-price', null), card('undefined-price', undefined), card('string-price', '800'),
    card('nan-price', NaN), card('below', 749.99), card('equal', 1000), card('higher', 1001),
    card('search-only', 800, { sources: ['search'] }), card('source-missing', 800, { sources: [] }),
    card('boundary', 750, { title: '' }), card('preliminary', 999.99, { title: 'weak', preliminary: true }),
  ];
  const result = plan({ baseline: original, candidates });
  assert.equal(result.reallocated, 2);
  assert.deepEqual(ids(result.selected), [...ids(original.slice(0, 18)), 'boundary', 'preliminary']);
  assert.equal(result.selected.some(row => row.id === 'low-0'), true, 'very cheap cards are not excluded');
});

test('a candidate already in the baseline cannot consume a replacement or create a gap', () => {
  const original = baseline();
  original[0] = card('already-selected', 800);
  const result = plan({ baseline: original, candidates: [original[0], ...near()] });
  assert.equal(result.reallocated, 4);
  assert.equal(result.selected.length, original.length);
  assert.equal(new Set(ids(result.selected)).size, original.length);
  assert.deepEqual(ids(result.selected.slice(-4)), ids(near().slice(0, 4)));
  assert.deepEqual(plan({ baseline: original, candidates: [original[0]] }).selected, original);
});

test('duplicate or conflicting ID bindings, absent images, malformed and hostile cards fail closed', () => {
  const original = baseline();
  const hostile = { image: 'fixture-hostile', price: 800, sources: ['recommendation'] };
  Object.defineProperty(hostile, 'id', { get() { throw new Error('must never call getter'); } });
  for (const candidates of [
    [near()[0], near()[0]], [card(original[0].id, 800)], [card('missing-image', 800, { image: '' })],
    [card('bad-id', 800, { id: {} })], [card('bad-source', 800, { sources: [null] })],
    [hostile], [null], new Array(1),
  ]) {
    const result = plan({ baseline: original, candidates });
    assert.deepEqual(result.selected, original);
    assert.equal(result.reallocated, 0);
  }
  for (const invalid of [[...original, original[0]], [hostile, ...original.slice(1)], [card('no-image', 1, { image: null }), ...original.slice(1)]]) {
    const result = plan({ baseline: invalid });
    assert.strictEqual(result.selected, invalid);
    assert.equal(result.reallocated, 0);
  }
});

test('planning neither mutates inputs nor reads title or seller guesses', () => {
  const original = baseline(), candidates = near();
  for (const row of [...original, ...candidates]) {
    Object.defineProperty(row, 'sellerId', { get() { throw new Error('seller must be screened by caller'); } });
    Object.freeze(row.sources);
    Object.freeze(row);
  }
  Object.freeze(original); Object.freeze(candidates);
  const result = plan({ baseline: original, candidates });
  assert.equal(result.reallocated, 4);
  assert.deepEqual(ids(original), Array.from({ length: 20 }, (_, index) => `low-${index}`));
  assert.strictEqual(result.selected[16], candidates[0]);
});

test('cache model: total calls stay 20, but a warmed old baseline can incur four new fetches', () => {
  const original = baseline(), selected = plan({ baseline: original }).selected;
  const run = rows => {
    const cache = new Set(original.map(row => row.image));
    let calls = 0, fetches = 0;
    for (const row of rows) {
      calls++;
      if (!cache.has(row.image)) { fetches++; cache.add(row.image); }
    }
    return { calls, fetches };
  };
  assert.deepEqual(run(original), { calls: 20, fetches: 0 });
  assert.deepEqual(run(selected), { calls: 20, fetches: 4 });
});
