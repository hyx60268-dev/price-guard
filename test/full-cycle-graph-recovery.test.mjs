// Complete test blocks recovered from the prior graph suite's visible output.
// This is not a claim that the entire prior test suite was recovered.
import test from 'node:test';
import assert from 'node:assert/strict';
import {planFullCycle, runFullCycle, graphCounts, fullCycleReport, SourceDeniedError} from '../scripts/lib/full-cycle-graph.mjs';
import {FakeClock, baseTarget, planInput, acceptedOffer, fakeAdapters, observedScaleFixture} from './fixtures/full-cycle-graph-fixtures.mjs';

test('all 1,461 obligations exist before dispatch; observed distinct-query counts do not imply complete cost coverage', async () => {
  const graph = planFullCycle(observedScaleFixture()), before = graphCounts(graph);
  assert.equal(before.targets, 1461);
  assert.equal(before.rawBySource.yahoo.search, 627);
  assert.equal(before.rawBySource.rakuma.search, 813);
  assert.equal(before.rawBySource.yahoo.detail, 635 + 131);
  assert.equal(before.rawBySource.rakuma.detail, 826 + 47);
  assert.equal(before.byKind.raw, 3079);
  assert.equal([...graph.nodes.values()].filter(node => node.kind === 'own').length, 1461);
  assert.equal([...graph.nodes.values()].filter(node => node.kind === 'cost').length, 1461);
  assert.deepEqual(graph.accounts.map(account => account.expectedCount), [98,48,489,826]);
  const clock = new FakeClock(), reads = [];
  const result = await runFullCycle(graph, fakeAdapters(clock, {readLog:reads}));
  assert.equal(reads.length, 3079);
  assert.equal(new Set(reads.map(read => read.nodeId)).size, reads.length);
  assert.equal(result.ownIdentityVerified, 1461);
  assert.equal(result.priceComplete, 1461);
  assert.equal(result.costVerified, 0);
  assert.equal(result.completed, 0);
  assert.equal(result.complete, false);
  assert.equal(result.missingTargets.length, 1461);
  assert.ok(result.missingTargets.every(row => row.missing.some(missing => missing.kind === 'cost' && missing.blockers[0].code === 'supplier_discovery_unconfigured')));
  assert.equal(result.productionAccepted, false);
});

test('diamond graph deduplicates exact searches, pagination and detail URLs while decisions remain target-specific', async () => {
  const a = baseTarget('a'), b = baseTarget('b');
  const graph = planFullCycle(planInput([a,b]));
  const clock = new FakeClock(), reads = [], decisions = [];
  const adapters = fakeAdapters(clock, {readLog:reads, dataFor:request => {
    if (request.kind === 'search' && request.source !== 'yahoo') return {offers:[], complete:true};
    if (request.kind === 'search') return request.query.page === 2
      ? {offers:[{url:'https://fixture.invalid/offer/shared#fragment'}], complete:true}
      : {offers:[{url:'https://fixture.invalid/offer/shared'}], complete:false, nextQuery:{q:'same query', page:2}};
    return {description:'Current details'};
  }});
  adapters.validateOffer = async (target, own, offer, context) => {
    decisions.push(`${target.id}:${context.purpose}`);
    const result = acceptedOffer(target);
    if (target.id === 'b' && context.purpose === 'pricing') result.gates.quantity = 'reject';
    return result;
  };
  const result = await runFullCycle(graph, adapters);
  assert.equal(result.complete, true);
  assert.equal(result.completed, 2);
  assert.equal(result.cadenceProven, false);
  assert.equal(reads.filter(read => read.request.kind === 'search' && read.request.source === 'yahoo').length, 2);
  assert.equal(reads.filter(read => read.request.url === 'https://fixture.invalid/offer/shared').length, 1);
  assert.deepEqual(decisions.sort(), ['a:pricing','a:procurement','b:pricing','b:procurement']);
  const scopes = graph.scopes.filter(scope => scope.purpose === 'pricing');
  assert.equal(scopes[0].result.quotes.length, 1);
  assert.equal(scopes[1].result.quotes.length, 0);
});

test('account/access scope, exact query parameters and source boundaries prevent unsafe raw sharing', () => {
  const targets = [baseTarget('a'), baseTarget('b'), baseTarget('c', {platform:'rakuma'})];
  targets[1].pricing.yahoo.accessScope = 'authenticated-account-b';
  targets[1].pricing.yahoo.query = {q:'same query', sort:'newest'};
  const graph = planFullCycle(planInput(targets));
  const searches = [...graph.nodes.values()].filter(node => node.kind === 'raw' && node.request.kind === 'search');
  assert.equal(searches.filter(node => node.source !== 'supplier').length, 3);
  const offers = [...graph.nodes.values()].filter(node => node.kind === 'raw' && node.request.url === 'https://fixture.invalid/offer/shared');
  assert.equal(offers.length, 3);
});

test('correction, ownership, quantity and condition decisions cannot bleed between targets or force identity acceptance', async () => {
  const targets = ['normal','correction','owned','quantity','condition','unknown'].map(id => baseTarget(id));
  const graph = planFullCycle(planInput(targets)), clock = new FakeClock();
  const adapters = fakeAdapters(clock);
  adapters.validateOffer = async (target, own, raw, context) => {
    const result = acceptedOffer(target);
    if (context.purpose === 'pricing' && target.id !== 'normal') result.gates[target.id === 'owned' ? 'ownership' : target.id === 'unknown' ? 'identity' : target.id] = target.id === 'unknown' ? 'unknown' : 'reject';
    raw.data.description = 'mutated private validator copy';
    return result;
  };
  const result = await runFullCycle(graph, adapters);
  assert.equal(result.priceComplete, 5);
  assert.equal(result.completed, 5);
  assert.equal(result.missingTargets[0].targetId, 'account:unknown');
  assert.equal(graph.scopes.filter(s => s.purpose === 'pricing' && s.result.quotes.length).length, 1);
  for (const raw of graph.nodes.values()) if (raw.kind === 'raw' && raw.request.kind === 'detail') {
    assert.notEqual(raw.result.data.description, 'mutated private validator copy');
  }
});

test('global and per-source concurrency and minimum start interval stay bounded', async () => {
  const targets = Array.from({length:8}, (_, i) => baseTarget(String(i), {platform:i % 2 ? 'rakuma' : 'yahoo', query:`q-${i}`}));
  const graph = planFullCycle(planInput(targets)), clock = new FakeClock(), reads = [];
  const adapters = fakeAdapters(clock, {delay:11, readLog:reads});
  adapters.maxConcurrency = 3;
  adapters.sourceLimits = {yahoo:{maxConcurrent:2,minIntervalMs:7}, rakuma:{maxConcurrent:1,minIntervalMs:3}, supplier:{maxConcurrent:1,minIntervalMs:5}};
  const result = await runFullCycle(graph, adapters);
  assert.equal(result.complete, true);
  assert.ok(result.execution.peakConcurrency <= 3);
  for (const [source, policy] of Object.entries(adapters.sourceLimits)) {
    assert.ok(result.execution.sources[source].peakConcurrency <= policy.maxConcurrent);
    const times = reads.filter(read => read.request.source === source).map(read => read.at);
    assert.ok(times.slice(1).every((time, i) => time - times[i] >= policy.minIntervalMs));
  }
});

test('source denial stops new admissions without starving independent work and reports exact missing targets', async () => {
  const targets = [baseTarget('y1'), baseTarget('y2'), baseTarget('r1',{platform:'rakuma'})];
  const graph = planFullCycle(planInput(targets)), clock = new FakeClock(), reads = [];
  const adapters = fakeAdapters(clock, {readLog:reads, dataFor:request => {
    if (request.source === 'yahoo') throw Object.assign(new SourceDeniedError('Synthetic access denial'),{httpStatus:429,retryAfter:'3600',retryAt:3600000,reason:'http_429'});
    return request.kind === 'search' ? {offers:[],complete:true} : {description:'Current details'};
  }});
  adapters.sourceLimits.yahoo.maxConcurrent = 1;
  const result = await runFullCycle(graph, adapters);
  assert.equal(reads.filter(read => read.request.source === 'yahoo').length, 1);
  assert.equal(result.completed, 1);
  assert.deepEqual(result.missingTargets.map(target => target.targetId), ['account:y1','account:y2']);
  assert.ok(result.missingTargets.every(target => target.missing.some(missing => missing.blockers.some(blocker => blocker.code === 'source_denied'))));
  assert.equal(result.execution.sources.yahoo.closed, 'source_denied');
  assert.equal(result.execution.sources.yahoo.httpStatus,429);assert.equal(result.execution.sources.yahoo.retryAfter,'3600');
  const blocked=[...graph.nodes.values()].filter(node=>node.error?.code==='source_denied');
  assert.ok(blocked.length>1);assert.ok(blocked.every(node=>node.error.httpStatus===429&&node.error.retryAt===3600000));
  assert.ok(result.missingTargets.every(target=>target.missing.some(missing=>missing.blockers.some(blocker=>blocker.httpStatus===429&&blocker.retryAfter==='3600'))));
  assert.equal(result.complete, false);
});

test('one blocked supplier source does not discard another independently current validated cost', async () => {
  const target = baseTarget('one');
  target.procurement.supplier2 = {accessScope:'public', query:{q:'supplier2 search'}, knownOffers:[{url:'https://fixture.invalid/supplier2/one'}]};
  const graph = planFullCycle(planInput([target])), clock = new FakeClock();
  const adapters = fakeAdapters(clock, {dataFor:request => {
    if (request.source === 'supplier') throw new SourceDeniedError();
    return request.kind === 'search' ? {offers:[],complete:true} : {description:'Current details'};
  }});
  const result = await runFullCycle(graph, adapters);
  assert.equal(result.complete, true);
  const cost = [...graph.nodes.values()].find(node => node.kind === 'cost');
  assert.deepEqual(cost.result.incompleteSources, ['supplier']);
  assert.equal(cost.result.quotes.length, 1);
});

test('fixed deadline reports unfinished own/price/cost work and late reads cannot revive the cycle', async () => {
  const graph = planFullCycle(planInput([baseTarget('one'),baseTarget('two')], {deadlineAt:10})), clock = new FakeClock();
  const late = [], adapters = fakeAdapters(clock);
  adapters.fetchRaw = (request, context) => new Promise(resolve => late.push({resolve, context}));
  const result = await runFullCycle(graph, adapters);
  assert.equal(result.finishedAt, 10);
  assert.equal(result.completed, 0);
  assert.equal(result.missingTargets.length, 2);
  assert.ok(result.missingTargets.every(target => target.missing.some(missing => missing.blockers.some(blocker => blocker.code === 'deadline'))));
  for (const entry of late) entry.resolve({cycleId:entry.context.cycleId, observedAt:9, fromCache:false, data:{}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fullCycleReport(graph).completed, 0);
  assert.ok(late.every(entry => entry.context.signal.aborted));
});

test('stale, cache-only and previous-cycle observations never slide their timestamps', async () => {
  for (const kind of ['stale','cache','previous-cycle']) {
    const input = planInput([baseTarget('one')], {startedAt:100, accounts:[{id:'account',expectedCount:1,status:'live',cycleId:'cycle-1',observedAt:100}]});
    const graph = planFullCycle(input), clock = new FakeClock(100), adapters = fakeAdapters(clock);
    adapters.fetchRaw = async (request, context) => ({cycleId:kind === 'previous-cycle' ? 'old-cycle' : context.cycleId,
      observedAt:kind === 'stale' ? 99 : clock.now(), fromCache:kind === 'cache', data:{offers:[],complete:true}});
    const result = await runFullCycle(graph, adapters);
    assert.equal(result.complete, false, kind);
    assert.equal(result.costVerified, 0, kind);
    assert.ok(result.missingTargets[0].missing.some(missing => missing.blockers.some(blocker => blocker.code === 'raw_evidence_not_current_cycle')), kind);
  }
});

test('unknown candidate frontier, failed pagination, invalid manifest and capacity cannot produce false completeness', async () => {
  for (const scenario of ['unfinished','loop','malformed','capacity']) {
    const input = planInput([baseTarget('one', {candidate:null})]);
    const baseline = graphCounts(planFullCycle(input)).nodes;
    const graph = planFullCycle({...input, maxNodes:scenario === 'capacity' ? baseline + 1 : 100});
    const clock = new FakeClock(), adapters = fakeAdapters(clock, {dataFor:request => request.kind !== 'search' ? {} :
      scenario === 'unfinished' ? {offers:[],complete:false} :
      scenario === 'loop' ? {offers:[],complete:false,nextQuery:request.query} :
      scenario === 'malformed' ? {offers:null,complete:true} :
      {offers:[{url:'https://fixture.invalid/new/1'},{url:'https://fixture.invalid/new/2'}],complete:true}});
    const result = await runFullCycle(graph, adapters);
    assert.equal(result.complete, false, scenario);
    assert.equal(result.priceComplete, 0, scenario);
    assert.equal(result.plannedTargets, 1, scenario);
    assert.ok(result.missingTargets[0].missing.some(missing => missing.blockers.some(blocker =>
      blocker.code === (scenario === 'capacity' ? 'graph_capacity_exceeded' : scenario === 'unfinished' ? 'discovery_continuation_unavailable' : 'discovery_manifest_incomplete'))), scenario);
  }
});

test('actual observation timestamps survive validation and graphs are single-use', async () => {
  const graph = planFullCycle(planInput([baseTarget('one')], {previousCompleteAt:0})), clock = new FakeClock();
  const adapters = fakeAdapters(clock, {delay:2});
  adapters.validateOffer = async target => ({...acceptedOffer(target), observedAt:999999, identityObservedAt:999999});
  const result = await runFullCycle(graph, adapters);
  assert.equal(result.complete, true);
  assert.equal(result.cadenceProven, true);
  for (const decision of graph.nodes.values()) if (decision.kind === 'decision') {
    assert.equal(decision.result.observedAt, graph.nodes.get(decision.rawId).result.observedAt);
    assert.equal(decision.result.identityObservedAt, decision.result.observedAt);
  }
  await assert.rejects(runFullCycle(graph, adapters), /single-use/);
});

test('cross-platform obligations cannot disappear when only same-platform configuration is supplied', async () => {
  const target = baseTarget('one'); target.comparisonMode = 'cross_platform';
  const graph = planFullCycle(planInput([target])), clock = new FakeClock();
  const result = await runFullCycle(graph, fakeAdapters(clock));
  assert.equal(result.complete, false);
  assert.equal(result.costVerified, 1);
  assert.equal(result.priceComplete, 0);
  assert.deepEqual(result.missingTargets[0].missing.map(missing => missing.source), ['rakuma','mercari']);
});
