// Synthetic data only. No real account IDs, URLs, titles, credentials or prices.
export class FakeClock {
  constructor(now = 0) { this.time = now; this.pending = new Set(); this.scheduled = false; }
  now = () => this.time;
  sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const item = {at:this.time + ms, finish:() => { signal?.removeEventListener('abort', abort); resolve(); }};
    const abort = () => { this.pending.delete(item); signal.removeEventListener('abort', abort); reject(new Error('aborted')); };
    signal?.addEventListener('abort', abort, {once:true});
    this.pending.add(item); this.pump();
  });
  pump() {
    if (this.scheduled || !this.pending.size) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (!this.pending.size) return;
      this.time = Math.min(...[...this.pending].map(item => item.at));
      for (const item of [...this.pending]) if (item.at <= this.time) { this.pending.delete(item); item.finish(); }
      this.pump();
    });
  }
}

export const baseTarget = (id, {platform = 'yahoo', accountId = 'account', query = 'same query',
  candidate = 'https://fixture.invalid/offer/shared', supplier = 'https://fixture.invalid/supplier/shared', ...extra} = {}) => ({
  id, accountId, platform, comparisonMode:'same_platform', title:'Synthetic product',
  identity:{skuId:'fixture-sku',quantity:1},
  own:{accessScope:'public', url:`https://fixture.invalid/own/${accountId}/${id}`},
  pricing:{[platform]:{accessScope:'public', query:{q:query}, knownOffers:candidate ? [{url:candidate}] : []}},
  procurement:supplier ? {supplier:{accessScope:'public', query:{q:'supplier search'}, knownOffers:[{url:supplier}]}} : {},
  ...extra
});

export const planInput = (targets, extra = {}) => ({
  cycleId:'cycle-1', startedAt:0, phase:'refresh',
  accounts:[...new Set(targets.map(target => target.accountId))].map(id => ({id, expectedCount:targets.filter(t => t.accountId === id).length,
    status:'live', cycleId:'cycle-1', observedAt:0, paginationComplete:true})), targets, ...extra
});

export const passGates = () => Object.fromEntries(['identity','quantity','condition','correction','ownership','price','availability','shipping'].map(gate => [gate, 'pass']));
export const acceptedOffer = (target = baseTarget('one')) => ({gates:passGates(), quote:{price:100, shipping:0,
  currency:'JPY', shippingCurrency:'JPY', shippingDestination:'fixture-destination', shippingMethod:'fixture-delivery',
  targetKey:`${target.accountId}:${target.id}`, skuId:target.identity?.skuId || 'fixture-sku', quantity:target.identity?.quantity || 1,
  available:true, sellerId:'external-seller'}});

export const fakeAdapters = (clock, {delay = 1, dataFor, readLog = []} = {}) => ({
  clock, maxConcurrency:8,
  sourceLimits:Object.fromEntries(['yahoo','rakuma','mercari','supplier','supplier2'].map(source => [source, {maxConcurrent:3, minIntervalMs:0}])),
  fetchRaw:async (request, context) => {
    readLog.push({request:structuredClone(request), at:clock.now(), nodeId:context.nodeId});
    await clock.sleep(delay, context.signal);
    let data = dataFor ? await dataFor(request, context) : request.kind === 'search' ? {offers:[], complete:true} : {title:'Synthetic product', description:'Exact sale contents'};
    if (request.kind === 'search') data = {coverageScope:'exact_query_results', paginationComplete:data?.complete, truncated:false, ...data};
    return {cycleId:context.cycleId, observedAt:clock.now(), fromCache:false, data};
  },
  // Trusted fixture assertions only; no real Yahoo/Rakuma coverage is certified.
  assessInventoryCoverage:(manifest, context) => ({complete:manifest.accounts.every(account => account.paginationComplete === true),
    scope:'all_configured_accounts', cycleId:context.cycleId, proofRef:'fixture-complete-inventory',
    accounts:manifest.accounts.map(({id, expectedCount}) => ({id, expectedCount}))}),
  assessDiscoveryCoverage:(request, raw) => ({accepted:true, scope:'exact_query_page', exhaustive:raw.data.complete, proofRef:'fixture-exhaustive-query'}),
  validateOwn:async target => ({complete:true,identity:target.identity || {skuId:'fixture-sku',quantity:1}}),
  validateOffer:async target => acceptedOffer(target)
});

// Observed account/query/own-page/candidate-page counts; offer associations and
// request durations are intentionally synthetic and are NOT a production model.
export function observedScaleFixture() {
  const targets = [], accounts = [];
  let yahooIndex = 0;
  for (const [accountId, count] of [['yahoo-a',98],['yahoo-b',48],['yahoo-c',489]]) {
    accounts.push({id:accountId, expectedCount:count, status:'live', cycleId:'scale', observedAt:0, paginationComplete:true});
    for (let i = 0; i < count; i++, yahooIndex++) {
      targets.push(baseTarget(`item-${i}`, {accountId, platform:'yahoo', query:`yahoo-query-${yahooIndex % 627}`,
        candidate:`https://fixture.invalid/yahoo-candidate/${yahooIndex % 131}`, supplier:null}));
    }
  }
  accounts.push({id:'rakuma-a', expectedCount:826, status:'live', cycleId:'scale', observedAt:0, paginationComplete:true});
  for (let i = 0; i < 826; i++) targets.push(baseTarget(`item-${i}`, {accountId:'rakuma-a', platform:'rakuma', query:`rakuma-query-${i % 813}`,
    candidate:`https://fixture.invalid/rakuma-candidate/${i % 47}`, supplier:null}));
  return {cycleId:'scale', startedAt:0, phase:'bootstrap', accounts, targets};
}
