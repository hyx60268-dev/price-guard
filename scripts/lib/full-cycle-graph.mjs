// Pure full-inventory scheduler. Readers, source policy and publication are injected.
// Raw reads may be shared within one cycle. Target decisions may never be shared.
import {createHash} from 'node:crypto';
import {requiredPricingPlatforms} from '../../public/pricing-policy.js';

const MAX_CYCLE_MS = 20 * 60 * 1000;
const PLATFORM = value => value === 'yahoo_fleamarket' ? 'yahoo' : value;
const terminal = node => ['succeeded', 'failed', 'blocked', 'skipped'].includes(node.status);
const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const hash = value => createHash('sha256').update(stable(value)).digest('hex').slice(0, 24);
const copy = value => structuredClone(value);
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const nonEmptyString = value => typeof value === 'string' && value.trim().length > 0;
const jsonRequestData = (value, seen = new Set()) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  seen.add(value);
  const valid = Object.values(value).every(child => jsonRequestData(child, seen)); seen.delete(value); return valid;
};
const fail = (node, code, extra = {}) => {
  if (terminal(node)) return;
  node.status = 'failed'; node.error = {code, ...extra};
};
const scopeProblem = (scope, code, extra = {}) => {
  scope.problem = {code, ...extra}; scope.discoveryFinished = true;
};
const canonicalUrl = value => {
  const url = new URL(value);
  assert(url.protocol === 'https:' && !url.username && !url.password, 'Only credential-free HTTPS URLs are allowed');
  url.hash = '';
  return url.href;
};
const targetKey = target => `${target.accountId}:${target.id}`;

export const VALIDATION_GATES = Object.freeze(['identity', 'quantity', 'condition', 'correction', 'ownership', 'price', 'availability', 'shipping']);

export class SourceDeniedError extends Error {
  constructor(message = 'Source denied access') { super(message); this.code = 'ACCESS_DENIED'; }
}

/**
 * Construct obligations for the entire declared inventory BEFORE dispatch.
 * targets contain own, pricing[source], and procurement[source] request specs.
 * A query is an exact adapter request, not a canonical SKU or an identity proof.
 * Sources and authenticated/public access scopes are deliberately explicit.
 */
export function planFullCycle({cycleId, startedAt, deadlineAt = startedAt + MAX_CYCLE_MS,
  phase = 'bootstrap', accounts, targets, maxNodes = 100_000, previousCompleteAt = null}, {assessDiscoveryBinding} = {}) {
  assert(typeof cycleId === 'string' && cycleId, 'cycleId is required');
  assert(Number.isFinite(startedAt) && Number.isFinite(deadlineAt) && deadlineAt > startedAt && deadlineAt - startedAt <= MAX_CYCLE_MS,
    'A fixed positive cycle window of at most 20 minutes is required');
  assert(['bootstrap', 'refresh'].includes(phase), 'Invalid phase');
  assert(Array.isArray(accounts) && accounts.length && Array.isArray(targets), 'Explicit full inventory is required');
  assert(Number.isSafeInteger(maxNodes) && maxNodes > 0, 'Invalid graph capacity');
  const graph = {version:1, cycleId, startedAt, deadlineAt, phase, maxNodes, previousCompleteAt,
    accounts:freeze(copy(accounts)), targets:new Map(), nodes:new Map(), scopes:[], inventoryIssues:[], status:'planned', assessDiscoveryBinding};
  const accountIds = new Set();
  for (const account of accounts) {
    assert(typeof account.id === 'string' && account.id && !accountIds.has(account.id), 'Duplicate or missing account ID');
    assert(Number.isSafeInteger(account.expectedCount) && account.expectedCount >= 0, 'Each account needs its full expected inventory count');
    accountIds.add(account.id);
    const actual = targets.filter(t => t.accountId === account.id).length;
    if (actual !== account.expectedCount) graph.inventoryIssues.push({accountId:account.id, code:'inventory_count_mismatch', expected:account.expectedCount, actual});
    if (account.status !== 'live' || account.cycleId !== cycleId || !inWindow(graph, account.observedAt)) {
      graph.inventoryIssues.push({accountId:account.id, code:'inventory_not_current', observedAt:account.observedAt ?? null});
    }
    if (account.paginationComplete !== true || account.truncated === true) graph.inventoryIssues.push({
      accountId:account.id, code:'inventory_pagination_incomplete'});
  }
  for (const input of targets) {
    assert(typeof input.id === 'string' && input.id && typeof input.accountId === 'string', 'Target IDs are required');
    const key = targetKey(input);
    assert(!graph.targets.has(key), `Duplicate target: ${key}`);
    const target = freeze(copy(input));
    if (!accountIds.has(target.accountId)) graph.inventoryIssues.push({accountId:target.accountId, targetId:key, code:'unregistered_account'});
    const record = {key, target, roots:[]}; graph.targets.set(key, record);
    const own = addNode(graph, {id:`own:${hash(key)}`, kind:'own', targetKey:key, deps:new Set()});
    record.ownId = own.id; record.roots.push(own.id);
    try {
      const request = {...target.own, source:PLATFORM(target.platform), kind:'detail', readRole:'ownIdentity'};
      own.rawId = addRaw(graph, request).id; own.deps.add(own.rawId);
    } catch (error) { fail(own, 'own_request_missing_or_invalid', {message:error.message}); }
    const required = requiredPricingPlatforms(target);
    if (!required.length) {
      const missing = addNode(graph, {id:`price:${hash([key, 'unknown'])}`, kind:'price', targetKey:key, deps:new Set()});
      fail(missing, 'required_pricing_source_unknown'); record.roots.push(missing.id);
    }
    for (const source of required) record.roots.push(addScope(graph, record, 'pricing', source, target.pricing?.[source]).id);
    const cost = addNode(graph, {id:`cost:${hash(key)}`, kind:'cost', targetKey:key, deps:new Set([own.id])});
    record.roots.push(cost.id);
    for (const [source, spec] of Object.entries(target.procurement || {})) cost.deps.add(addScope(graph, record, 'procurement', source, spec).id);
    if (cost.deps.size === 1) fail(cost, 'supplier_discovery_unconfigured');
  }
  return graph;
}

function inWindow(graph, observedAt) {
  return Number.isFinite(observedAt) && observedAt >= graph.startedAt && observedAt <= graph.deadlineAt;
}

function addNode(graph, spec) {
  if (graph.nodes.has(spec.id)) return graph.nodes.get(spec.id);
  assert(graph.nodes.size < graph.maxNodes, `graph_capacity_exceeded:${graph.maxNodes}`);
  const node = {status:'pending', result:null, error:null, ...spec};
  graph.nodes.set(node.id, node); return node;
}

function addRaw(graph, input) {
  assert(input && typeof input.source === 'string' && input.source && typeof input.accessScope === 'string' && input.accessScope,
    'Read source and accessScope are required');
  assert(['detail', 'search', 'quote'].includes(input.kind), 'Invalid raw read kind');
  const request = {source:input.source, accessScope:input.accessScope, kind:input.kind};
  if (input.kind === 'search') {
    assert(input.query && typeof input.query === 'object' && !Array.isArray(input.query), 'Exact query request is required');
    assert(jsonRequestData(input.query), 'Query request must be lossless finite JSON data');
    request.query = copy(input.query);
  } else request.url = canonicalUrl(input.url);
  // API projection/locale/selected-SKU parameters belong in the key too.
  if (input.parameters !== undefined) {
    assert(jsonRequestData(input.parameters), 'Representation parameters must be lossless finite JSON data');
    request.parameters = copy(input.parameters);
  }
  const id = `raw:${hash(request)}`;
  const node = addNode(graph, {id, kind:'raw', source:request.source, request:freeze(request), deps:new Set(),
    readRoles:new Set(), screenIds:new Set(), unconditionalRead:false});
  if (!input.deferUntilScreen) node.unconditionalRead = true;
  if (input.readRole) node.readRoles.add(input.readRole);
  return node;
}

function addScope(graph, record, purpose, source, spec) {
  // A stored URL, incomplete catalog offer or response-supplied `accepted` flag
  // is not an eligible discovery binding. Only an injected trusted registry
  // assessment can suppress bootstrap discovery during a refresh cycle.
  const eligibleBindings = (spec?.knownOffers || []).filter(offer => {
    if (purpose !== 'procurement' || typeof graph.assessDiscoveryBinding !== 'function') return false;
    try { return graph.assessDiscoveryBinding(copy(offer.binding ?? null), copy(record.target),
      {source, accessScope:spec.accessScope, url:canonicalUrl(offer.url), parameters:copy(offer.parameters), purpose, now:graph.startedAt})?.eligible === true; }
    catch { return false; }
  }).length;
  const scope = addNode(graph, {id:`${purpose}:${hash([record.key, source])}`, kind:'scope', purpose, source,
    targetKey:record.key, deps:new Set([record.ownId]), searchIds:new Set(), expanded:new Set(), decisions:new Set(),
    eligibleDiscoveryBindings:eligibleBindings, storedLinks:(spec?.knownOffers || []).length,
    discoveryRequired:purpose === 'pricing' || graph.phase === 'bootstrap' || !eligibleBindings,
    discoveryFinished:false, spec:freeze(copy(spec || {}))});
  graph.scopes.push(scope);
  const recall = addNode(graph, {id:`own-recall:${hash(scope.id)}`, kind:'ownRecall', scopeId:scope.id,
    targetKey:record.key, purpose, source, deps:new Set([record.ownId])});
  scope.ownRecallId = recall.id; scope.deps.add(recall.id);
  try {
    assert(spec, 'Required source has no request configuration');
    for (const offer of spec.knownOffers || []) addCandidate(graph, scope, offer);
    if (scope.discoveryRequired) {
      assert(spec.query, 'Required source has no discovery query');
      const raw = addRaw(graph, {source, accessScope:spec.accessScope, kind:'search', query:spec.query, parameters:spec.parameters, readRole:`${purpose}Discovery`});
      scope.searchIds.add(raw.id); scope.deps.add(raw.id);
    } else scope.discoveryFinished = true;
  } catch (error) { scopeProblem(scope, error.message.startsWith('graph_capacity_exceeded') ? 'graph_capacity_exceeded' : 'discovery_request_missing_or_invalid', {message:error.message}); }
  return scope;
}

function addCandidate(graph, scope, offer, origin = 'known', discovery = null) {
  // Reserve potential reads for capacity/counting, but never admit them until a
  // target-specific current-own screen requires detail. A raw node can also be
  // an unconditional own-detail read, or serve another target that needs it.
  const raw = addRaw(graph, {source:scope.source, accessScope:scope.spec.accessScope, kind:'detail', url:offer.url,
    parameters:offer.parameters, readRole:`${scope.purpose}:${origin}Detail`, deferUntilScreen:true});
  const candidate = freeze(copy({...offer, url:raw.request.url}));
  const id = `decision:${hash([scope.id, raw.id])}`;
  const ownId = graph.targets.get(scope.targetKey).ownId;
  const node = addNode(graph, {id, kind:'decision', targetKey:scope.targetKey, purpose:scope.purpose, source:scope.source,
    scopeId:scope.id, rawId:raw.id, binding:freeze(copy(offer.binding ?? null)), screenIds:new Set(), deps:new Set([ownId])});
  // Different card observations cannot borrow another card's rejection. Exact
  // duplicate cards still deduplicate, including a fragment-only URL difference.
  const screen = addNode(graph, {id:`screen:${hash([scope.id, raw.id, candidate])}`, kind:'screen',
    targetKey:scope.targetKey, purpose:scope.purpose, source:scope.source, scopeId:scope.id, rawId:raw.id,
    candidate, origin, discoveryObservedAt:discovery?.result.observedAt ?? null,
    searchRequest:origin === 'discovered' && discovery ? freeze(copy(discovery.request)) : null, deps:new Set([ownId])});
  raw.screenIds.add(screen.id); node.screenIds.add(screen.id); node.deps.add(screen.id);
  if (raw.status === 'skipped') { raw.status = 'pending'; raw.error = null; }
  scope.decisions.add(node.id); scope.deps.add(node.id);
}

// The raw-read dependency is disjunctive across targets, not a reason to merge
// their decisions. A skipped reservation can be reactivated by a later page.
function reconcileCandidateReads(graph) {
  for (const node of graph.nodes.values()) {
    if (node.kind === 'decision') {
      if ([...node.screenIds].some(id => graph.nodes.get(id).result?.decision === 'detail')) node.deps.add(node.rawId);
    } else if (node.kind === 'raw' && !node.unconditionalRead && node.status === 'pending') {
      const screens = [...node.screenIds].map(id => graph.nodes.get(id));
      if (screens.length && screens.every(terminal) && !screens.some(screen => screen.result?.decision === 'detail')) {
        node.status = 'skipped'; node.error = {code:'candidate_detail_not_required'};
      }
    }
  }
}

function candidateContext(graph, node, own, signal) {
  const scope = graph.nodes.get(node.scopeId);
  return {purpose:node.purpose, source:node.source, accessScope:scope.spec.accessScope,
    origin:node.origin, discoveryObservedAt:node.discoveryObservedAt, searchRequest:copy(node.searchRequest),
    ownIdentity:copy(own.result.identity), signal, cycleId:graph.cycleId, deadlineAt:graph.deadlineAt};
}

function screenDecision(value) {
  // This callback is trusted executable adapter code. Seller/card flags do not
  // reach this branch by themselves, and no positive result can certify a quote.
  const gates = value?.gates;
  const validGates = gates && typeof gates === 'object' && !Array.isArray(gates) &&
    Object.entries(gates).every(([gate, state]) => VALIDATION_GATES.includes(gate) && ['pass','reject','unknown'].includes(state));
  if (value?.decision === 'reject' && nonEmptyString(value.reason) && validGates && Object.values(gates).includes('reject')) {
    return {complete:true, accepted:false, decision:'reject', reason:value.reason,
      gates:Object.fromEntries(VALIDATION_GATES.map(gate => [gate, gates[gate] ?? 'unknown']))};
  }
  return {complete:true, accepted:false, decision:'detail', reason:'candidate_detail_required'};
}

// Every target already owns a mandatory scope root. Search pagination and newly
// discovered URLs expand underneath that root, never create a selected subset.
function expandDiscovery(graph) {
  // Recommendation rails are additional recall only. They never erase a
  // configured original query or certify its pagination/marketplace coverage.
  for (const scope of graph.scopes) {
    const recall = graph.nodes.get(scope.ownRecallId);
    if (scope.ownRecallExpanded || recall.status !== 'succeeded') continue;
    scope.ownRecallExpanded = true;
    try {
      const own = graph.nodes.get(graph.targets.get(scope.targetKey).ownId);
      const raw = graph.nodes.get(own.rawId);
      for (const offer of recall.result.offers || []) addCandidate(graph, scope, offer, 'own', raw);
    } catch (error) {
      scopeProblem(scope, error.message.startsWith('graph_capacity_exceeded') ? 'graph_capacity_exceeded' : 'own_recall_manifest_incomplete', {message:error.message});
    }
  }
  for (const scope of graph.scopes) {
    if (terminal(scope) || scope.problem || !scope.discoveryRequired) continue;
    for (const id of scope.searchIds) {
      const raw = graph.nodes.get(id);
      if (raw.status !== 'succeeded' || scope.expanded.has(id)) continue;
      scope.expanded.add(id);
      try {
        const data = raw.result.data;
        assert(data && Array.isArray(data.offers) && typeof data.complete === 'boolean', 'Malformed discovery manifest');
        assert(!data.complete || !data.nextQuery, 'Exhausted discovery cannot have a next page');
        assert(data.truncated === false && data.coverageScope === 'exact_query_results' &&
          (data.coverage === undefined || data.coverage === 'exact_query_results') && data.paginationComplete === data.complete,
        'Search pagination/coverage evidence is incomplete or contradictory');
        const coverage = graph.assessDiscoveryCoverage?.(copy(raw.request), copy(raw.result), {
          cycleId:graph.cycleId, source:scope.source, originalQuery:copy(scope.spec.query)});
        assert(coverage?.accepted === true && coverage.scope === 'exact_query_page' && coverage.exhaustive === data.complete &&
          typeof coverage.proofRef === 'string' && coverage.proofRef, 'discovery_coverage_unproven');
        for (const offer of data.offers) addCandidate(graph, scope, offer, 'discovered', raw);
        if (!data.complete && !data.nextQuery) {
          scopeProblem(scope, 'discovery_continuation_unavailable');
          break;
        }
        if (data.nextQuery) {
          const next = addRaw(graph, {...raw.request, query:data.nextQuery, readRole:`${scope.purpose}Discovery`});
          assert(!scope.searchIds.has(next.id), 'Repeated pagination request');
          scope.searchIds.add(next.id); scope.deps.add(next.id);
        }
      } catch (error) {
        scopeProblem(scope, error.message.startsWith('graph_capacity_exceeded') ? 'graph_capacity_exceeded' :
          error.message === 'discovery_coverage_unproven' ? 'discovery_coverage_unproven' : 'discovery_manifest_incomplete', {message:error.message});
        break;
      }
    }
    scope.discoveryFinished = Boolean(scope.problem) || [...scope.searchIds].every(id => terminal(graph.nodes.get(id)) &&
      (graph.nodes.get(id).status !== 'succeeded' || scope.expanded.has(id)));
  }
}

function gateDecision(value, target, ownIdentity) {
  if (!value || !value.gates || VALIDATION_GATES.some(gate => !['pass', 'reject', 'unknown'].includes(value.gates[gate]))) {
    return {complete:false, accepted:false, reason:'validation_gates_missing'};
  }
  // A definitive rejection is useful, but unknown evidence never becomes a quote.
  if (Object.values(value.gates).includes('reject')) return {...copy(value), complete:true, accepted:false, reason:'candidate_rejected'};
  if (Object.values(value.gates).includes('unknown')) return {...copy(value), complete:false, accepted:false, reason:'validation_evidence_unknown'};
  const quote = value.quote;
  if (!quote || !Number.isFinite(quote.price) || quote.price <= 0 || quote.available !== true ||
      !Number.isFinite(quote.shipping) || quote.shipping < 0 || !nonEmptyString(quote.sellerId) ||
      !/^[A-Z]{3}$/.test(quote.currency || '') || quote.shippingCurrency !== quote.currency ||
      !nonEmptyString(quote.shippingDestination) || !nonEmptyString(quote.shippingMethod) || quote.targetKey !== targetKey(target) ||
      !nonEmptyString(quote.skuId) || !Number.isSafeInteger(quote.quantity) || quote.quantity <= 0 ||
      !ownIdentity || quote.skuId !== ownIdentity.skuId || quote.quantity !== ownIdentity.quantity) {
    return {...copy(value), complete:false, accepted:false, reason:'payable_quote_incomplete'};
  }
  return {...copy(value), complete:true, accepted:true};
}

async function executeNode(graph, node, {fetchRaw, validateOwn, validateOffer, screenCandidate, candidatesFromOwn, clock, signal}) {
  if (node.kind === 'raw') {
    const result = await fetchRaw(copy(node.request), {cycleId:graph.cycleId, signal, deadlineAt:graph.deadlineAt, nodeId:node.id});
    assert(result?.cycleId === graph.cycleId && result?.fromCache === false && inWindow(graph, result.observedAt) && result.observedAt <= clock.now(),
      'raw_evidence_not_current_cycle');
    return freeze(copy(result));
  }
  const record = graph.targets.get(node.targetKey), deps = [...node.deps].map(id => graph.nodes.get(id));
  if (node.kind === 'own') {
    if (deps.some(dep => dep.status !== 'succeeded')) return {complete:false, reason:'own_read_unavailable'};
    const raw = graph.nodes.get(node.rawId).result;
    const decision = await validateOwn(copy(record.target), copy(raw), {signal, cycleId:graph.cycleId});
    const identity = decision?.identity;
    const identityComplete = nonEmptyString(identity?.skuId) && Number.isSafeInteger(identity.quantity) && identity.quantity > 0;
    const priorAgrees = (!record.target.identity?.skuId || record.target.identity.skuId === identity?.skuId) &&
      (record.target.identity?.quantity === undefined || record.target.identity.quantity === identity?.quantity);
    const complete = decision?.complete === true && Boolean(identityComplete) && priorAgrees;
    return {...copy(decision), complete, reason:complete ? null : decision?.reason || 'own_identity_unverified', observedAt:raw.observedAt};
  }
  if (node.kind === 'ownRecall') {
    const own = graph.nodes.get(record.ownId);
    if (own.status !== 'succeeded' || !own.result?.complete) return {complete:false, reason:'own_identity_unavailable', offers:[]};
    const raw = graph.nodes.get(own.rawId).result;
    const scope = graph.nodes.get(node.scopeId);
    const offers = typeof candidatesFromOwn === 'function' ? await candidatesFromOwn(copy(record.target), copy(raw), {
      source:node.source, purpose:node.purpose, accessScope:scope.spec.accessScope, ownIdentity:copy(own.result.identity),
      signal, cycleId:graph.cycleId, deadlineAt:graph.deadlineAt}) : [];
    assert(Array.isArray(offers), 'own_recall_manifest_incomplete');
    return {complete:true, offers:freeze(copy(offers))};
  }
  if (node.kind === 'screen') {
    const own = graph.nodes.get(record.ownId);
    if (own.status !== 'succeeded' || !own.result?.complete) {
      return {complete:false, accepted:false, decision:'blocked', reason:'own_identity_unavailable'};
    }
    const ownRaw = graph.nodes.get(own.rawId).result;
    const value = typeof screenCandidate === 'function' ? await screenCandidate(copy(record.target), copy(ownRaw), copy(node.candidate),
      candidateContext(graph, node, own, signal)) : null;
    return screenDecision(value);
  }
  if (node.kind === 'decision') {
    const own = graph.nodes.get(record.ownId), screens = [...node.screenIds].map(id => graph.nodes.get(id));
    if (own.status !== 'succeeded' || !own.result?.complete || !screens.length ||
      screens.some(screen => screen.status !== 'succeeded' || !screen.result?.complete)) {
      return {complete:false, accepted:false, reason:'required_screen_unavailable'};
    }
    if (screens.every(screen => screen.result.decision === 'reject')) {
      return {complete:true, accepted:false, reason:'candidate_screen_rejected',
        rejections:screens.map(screen => ({reason:screen.result.reason, gates:copy(screen.result.gates)}))};
    }
    const raw = graph.nodes.get(node.rawId);
    if (raw.status !== 'succeeded') return {complete:false, accepted:false, reason:'required_detail_unavailable'};
    const ownRaw = graph.nodes.get(own.rawId).result;
    // The full adapter receives the card which needed detail, not a different
    // target's card or a definitively rejected presentation of this same URL.
    const screen = screens.find(screen => screen.result.decision === 'detail');
    const decision = await validateOffer(copy(record.target), copy(ownRaw), copy(raw.result),
      {...candidateContext(graph, screen, own, signal), candidate:copy(screen.candidate), binding:copy(node.binding)});
    // Never accept a validator's wall clock as an observation time.
    return {...gateDecision(decision, record.target, own.result.identity), observedAt:raw.result.observedAt, identityObservedAt:raw.result.observedAt};
  }
  if (node.kind === 'scope') {
    const successful = deps.every(dep => dep.status === 'succeeded' && (dep.kind === 'raw' || dep.result?.complete === true));
    const quotes = [...node.decisions].map(id => graph.nodes.get(id)).filter(d => d.status === 'succeeded' && d.result?.accepted)
      .map(d => ({...copy(d.result.quote), observedAt:d.result.observedAt, nodeId:d.id}));
    const complete = successful && node.discoveryFinished && !node.problem;
    return {complete, quotes, reason:complete ? null : node.problem?.code || 'scope_evidence_incomplete'};
  }
  if (node.kind === 'cost') {
    const scopes = deps.filter(dep => dep.kind === 'scope');
    const ownComplete = graph.nodes.get(record.ownId).result?.complete === true;
    // Independent supplier failures are visible but cannot erase a current,
    // independently validated quote from an allowed source.
    const quotes = scopes.flatMap(scope => scope.status === 'succeeded' ? scope.result?.quotes || [] : []);
    return {complete:ownComplete && quotes.length > 0, quotes, reason:quotes.length ? null : 'no_current_verified_supplier_quote',
      incompleteSources:scopes.filter(scope => scope.status !== 'succeeded' || !scope.result?.complete).map(scope => scope.source)};
  }
  throw new Error(`Unknown node kind: ${node.kind}`);
}

export const realClock = Object.freeze({now:() => Date.now(), sleep:(ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new Error('aborted'));
  const timer = setTimeout(done, ms);
  function done() { signal?.removeEventListener('abort', abort); resolve(); }
  function abort() { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('aborted')); }
  signal?.addEventListener('abort', abort, {once:true});
})});

function scopeExpansionFinished(graph, scope) {
  const recall = graph.nodes.get(scope.ownRecallId);
  return scope.discoveryFinished && terminal(recall) && (recall.status !== 'succeeded' || scope.ownRecallExpanded);
}

function ready(graph, node) {
  if (node.status !== 'pending' || node.kind === 'scope' && !scopeExpansionFinished(graph, node) ||
      node.kind === 'decision' && !scopeExpansionFinished(graph, graph.nodes.get(node.scopeId)) ||
      ![...node.deps].every(id => terminal(graph.nodes.get(id)))) return false;
  return node.kind !== 'raw' || node.unconditionalRead ||
    [...node.screenIds].some(id => graph.nodes.get(id).status === 'succeeded' && graph.nodes.get(id).result?.decision === 'detail');
}

// Alternate the two ready lanes within each source, keeping FIFO order inside
// each lane. Only actual admissions advance the lane cursor. Newly discovered
// details can therefore finish evidence before the initial roots are exhausted,
// while a large candidate frontier cannot starve remaining own/search roots.
function* interleaveReads(nodes, lastLane) {
  const roots = nodes.filter(node => node.unconditionalRead);
  const candidates = nodes.filter(node => !node.unconditionalRead);
  let root = 0, candidate = 0, lane = lastLane === 'root' ? 'candidate' : 'root';
  while (root < roots.length || candidate < candidates.length) {
    if ((lane === 'candidate' && candidate < candidates.length) || root >= roots.length) {
      yield candidates[candidate++]; lane = 'root';
    } else { yield roots[root++]; lane = 'candidate'; }
  }
}

function* readyInSourceOrder(graph, lastSource, sourceState) {
  const local = [], queues = new Map();
  for (const node of graph.nodes.values()) {
    if (!ready(graph, node)) continue;
    if (node.kind !== 'raw') local.push(node);
    else { if (!queues.has(node.source)) queues.set(node.source, []); queues.get(node.source).push(node); }
  }
  yield* local;
  for (const [source, nodes] of queues) queues.set(source, [...interleaveReads(nodes, sourceState.get(source)?.lastLane)]);
  const sources = [...queues.keys()], previous = sources.indexOf(lastSource);
  const rotated = previous < 0 ? sources : sources.slice(previous + 1).concat(sources.slice(0, previous + 1));
  for (let index = 0, more = true; more; index++) {
    more = false;
    for (const source of rotated) if (index < queues.get(source).length) { more = true; yield queues.get(source)[index]; }
  }
}

/** Execute only via injected readers/validators. Limits are caller-owned policy,
 * never inferred permission to increase traffic. An access denial closes that
 * source for this cycle without retries, proxy changes or fallback identities. */
export async function runFullCycle(graph, {fetchRaw, validateOwn, validateOffer, screenCandidate, candidatesFromOwn, assessInventoryCoverage, assessDiscoveryCoverage, clock = realClock,
  maxConcurrency = 4, sourceLimits = {}} = {}) {
  assert(graph.status === 'planned', 'Graphs are single-use; build a new graph for a new cycle');
  assert([fetchRaw, validateOwn, validateOffer].every(fn => typeof fn === 'function'), 'Injected raw reader and target validators are required');
  assert(Number.isSafeInteger(maxConcurrency) && maxConcurrency > 0, 'Invalid global concurrency');
  assert(clock.now() >= graph.startedAt, 'Clock precedes cycle start');
  for (const account of graph.accounts) if (account.observedAt > clock.now()) graph.inventoryIssues.push({
    accountId:account.id, code:'inventory_observation_in_future', observedAt:account.observedAt});
  let inventoryCoverage;
  try { inventoryCoverage = assessInventoryCoverage?.({accounts:copy(graph.accounts),
    targets:[...graph.targets.values()].map(record => ({targetKey:record.key, accountId:record.target.accountId, id:record.target.id}))},
    {cycleId:graph.cycleId, now:clock.now()}); } catch { /* Unknown coverage stays incomplete. */ }
  if (inventoryCoverage?.complete !== true || inventoryCoverage.scope !== 'all_configured_accounts' ||
      inventoryCoverage.cycleId !== graph.cycleId || typeof inventoryCoverage.proofRef !== 'string' || !inventoryCoverage.proofRef ||
      !Array.isArray(inventoryCoverage.accounts) || inventoryCoverage.accounts.some(account => typeof account.id !== 'string' ||
        !Number.isSafeInteger(account.expectedCount) || account.expectedCount < 0) ||
      new Set(inventoryCoverage.accounts.map(account => account.id)).size !== inventoryCoverage.accounts.length) {
    graph.inventoryIssues.push({accountId:null, code:'inventory_coverage_unproven'});
  } else {
    graph.inventoryUniverse = copy(inventoryCoverage.accounts);
    const registered = new Map(inventoryCoverage.accounts.map(account => [account.id, account.expectedCount]));
    const planned = new Map(graph.accounts.map(account => [account.id, account.expectedCount]));
    const missingAccounts = [...registered.keys()].filter(id => !planned.has(id));
    const unexpectedAccounts = [...planned.keys()].filter(id => !registered.has(id));
    if (missingAccounts.length || unexpectedAccounts.length) graph.inventoryIssues.push({accountId:null,
      code:'inventory_account_set_mismatch', missingAccounts, unexpectedAccounts});
    for (const [accountId, expected] of registered) if ((planned.get(accountId) ?? 0) !== expected) graph.inventoryIssues.push({
      accountId, code:'registered_inventory_count_mismatch', expected, planned:planned.get(accountId) ?? 0});
  }
  graph.assessDiscoveryCoverage = assessDiscoveryCoverage;
  const sourceState = new Map();
  for (const [source, limit] of Object.entries(sourceLimits)) {
    assert(Number.isSafeInteger(limit.maxConcurrent) && limit.maxConcurrent > 0 && Number.isFinite(limit.minIntervalMs) && limit.minIntervalMs >= 0,
      `Invalid admission policy: ${source}`);
    assert(limit.maxRequests === undefined || Number.isSafeInteger(limit.maxRequests) && limit.maxRequests >= 0, `Invalid request ceiling: ${source}`);
    sourceState.set(source, {limit, running:0, starts:0, nextAt:graph.startedAt, closed:null, closedError:null, lastLane:null, peak:0});
  }
  graph.status = 'running';
  const running = new Map(), events = []; let closed = false, peak = 0, lastRawSource = null;
  const finish = (node, result, error) => {
    const entry = running.get(node.id);
    if (!entry) return;
    running.delete(node.id);
    const state = sourceState.get(node.source);
    if (node.kind === 'raw' && state) state.running--;
    if (closed) return; // late source returns cannot revive a timed-out cycle
    if (clock.now() > graph.deadlineAt) { fail(node, 'deadline'); return; }
    if (error) {
      const denied = error.code === 'ACCESS_DENIED', deferred = error.code === 'request_deferred';
      const diagnostic = {message:String(error.message || error),
        ...Object.fromEntries(['reason','retryAt','httpStatus','retryAfter'].filter(key=>error[key]!==undefined).map(key=>[key,error[key]]))};
      fail(node, denied ? 'source_denied' : deferred ? 'request_deferred' :
        error.message === 'raw_evidence_not_current_cycle' ? error.message : 'execution_failed', diagnostic);
      if (denied && state) { state.closed = 'source_denied'; state.closedError = diagnostic; }
      // The collector owns persistent cooldowns. Preserve its exact hold; do not
      // retry an inadmissible source, turn a deferral into an access denial, or
      // spend the rest of this cycle dispatching calls known to be held.
      const retryAt = error.retryAt === 'indefinite' ? Infinity : error.retryAt;
      if (deferred && node.kind === 'raw' && state && typeof retryAt === 'number' && retryAt >= graph.deadlineAt) {
        const previous = state.closedError?.retryAt === 'indefinite' ? Infinity : state.closedError?.retryAt;
        if (previous === undefined || retryAt > previous) state.closedError = diagnostic;
        if (state.closed !== 'source_denied') state.closed = 'request_deferred';
      }
    } else { node.result = result; node.status = 'succeeded'; }
    events.push({event:'finish', nodeId:node.id, kind:node.kind, source:node.source ?? null, at:clock.now(), status:node.status});
  };
  while (true) {
    expandDiscovery(graph);
    reconcileCandidateReads(graph);
    if (clock.now() >= graph.deadlineAt) {
      for (const node of graph.nodes.values()) if (!terminal(node)) fail(node, 'deadline');
      closed = true;
      for (const entry of running.values()) entry.controller.abort();
      break;
    }
    let launched = false, nextAdmission = Infinity;
    for (const node of readyInSourceOrder(graph, lastRawSource, sourceState)) {
      const state = node.kind === 'raw' ? sourceState.get(node.source) : null;
      if (node.kind === 'raw') {
        if (!state || state.closed || state.starts >= (state.limit.maxRequests ?? Infinity)) {
          fail(node, !state ? 'source_admission_unconfigured' : state.closed || 'source_budget_exhausted', state?.closedError || {}); continue;
        }
        if (state.running >= state.limit.maxConcurrent) continue;
        if (state.nextAt > clock.now()) { nextAdmission = Math.min(nextAdmission, state.nextAt); continue; }
      }
      if (running.size >= maxConcurrency) continue;
      const controller = new AbortController();
      node.status = 'running';
      if (state) { state.running++; state.starts++; state.nextAt = clock.now() + state.limit.minIntervalMs; state.peak = Math.max(state.peak, state.running); lastRawSource = node.source; state.lastLane = node.unconditionalRead ? 'root' : 'candidate'; }
      events.push({event:'start', nodeId:node.id, kind:node.kind, source:node.source ?? null, at:clock.now()});
      const entry = {controller, promise:null}; running.set(node.id, entry);
      entry.promise = executeNode(graph, node, {fetchRaw, validateOwn, validateOffer, screenCandidate, candidatesFromOwn, clock, signal:controller.signal})
        .then(result => finish(node, result), error => finish(node, null, error));
      peak = Math.max(peak, running.size); launched = true;
    }
    if ([...graph.nodes.values()].every(terminal)) break;
    // Newly failed reads can unblock aggregators without any outstanding promise.
    if (!running.size && !Number.isFinite(nextAdmission)) {
      expandDiscovery(graph);
      reconcileCandidateReads(graph);
      if ([...graph.nodes.values()].some(node => ready(graph, node))) continue;
      for (const node of graph.nodes.values()) if (!terminal(node)) fail(node, 'dependency_unresolved');
      break;
    }
    // A fresh admission time may have been created during this loop.
    if (launched) { await Promise.resolve(); continue; }
    const wakeAt = Math.min(graph.deadlineAt, nextAdmission), sleeper = new AbortController();
    const timer = clock.sleep(Math.max(0, wakeAt - clock.now()), sleeper.signal).catch(() => {});
    await Promise.race([...running.values()].map(entry => entry.promise).concat(timer));
    sleeper.abort();
  }
  closed = true; graph.status = 'settled'; graph.finishedAt = clock.now();
  graph.execution = {peakConcurrency:peak, sources:Object.fromEntries([...sourceState].map(([source, state]) =>
    [source, {starts:state.starts, peakConcurrency:state.peak, closed:state.closed,
      ...Object.fromEntries(['reason','retryAt','httpStatus','retryAfter'].filter(key=>state.closedError?.[key]!==undefined).map(key=>[key,state.closedError[key]]))}])), events};
  return fullCycleReport(graph);
}

function blockersFor(graph, rootId, seen = new Set()) {
  if (seen.has(rootId)) return [];
  seen.add(rootId);
  const node = graph.nodes.get(rootId), blockers = [];
  if (node.status !== 'succeeded' || node.result?.complete === false) blockers.push({nodeId:node.id, kind:node.kind,
    source:node.source ?? null, code:node.error?.code || node.result?.reason || node.status,
    ...(node.error?.reason !== undefined ? {reason:node.error.reason} : {}),
    ...(node.error?.retryAt !== undefined ? {retryAt:node.error.retryAt} : {}),
    ...Object.fromEntries(['httpStatus','retryAfter'].filter(key=>node.error?.[key]!==undefined).map(key=>[key,node.error[key]])),
    ...(node.result?.observedAt !== undefined ? {observedAt:node.result.observedAt} : {})});
  for (const id of node.deps) blockers.push(...blockersFor(graph, id, seen));
  return blockers;
}

export function fullCycleReport(graph) {
  const targets = [...graph.targets.values()].map(record => {
    const missing = record.roots.filter(id => {
      const root = graph.nodes.get(id); return root.status !== 'succeeded' || root.result?.complete !== true;
    }).map(id => ({obligationId:id, kind:graph.nodes.get(id).purpose || graph.nodes.get(id).kind,
      source:graph.nodes.get(id).source ?? null, blockers:blockersFor(graph, id)}));
    const roots = record.roots.map(id => graph.nodes.get(id));
    const done = node => node.status === 'succeeded' && node.result?.complete === true;
    return {targetId:record.key, accountId:record.target.accountId, complete:missing.length === 0,
      ownIdentityVerified:done(graph.nodes.get(record.ownId)),
      priceComplete:roots.filter(node => node.purpose === 'pricing' || node.kind === 'price').every(done),
      costVerified:roots.filter(node => node.kind === 'cost').every(done), missing};
  });
  // Contradictory manifests cannot shrink the original denominator. Retain the
  // per-account union maximum and both asserted totals for reconciliation.
  const inventoryCounts = new Map();
  const countFor = id => { if (!inventoryCounts.has(id)) inventoryCounts.set(id, {accountId:id, declared:0, registered:0, planned:0}); return inventoryCounts.get(id); };
  for (const account of graph.accounts) countFor(account.id).declared = account.expectedCount;
  for (const account of graph.inventoryUniverse || []) countFor(account.id).registered = account.expectedCount;
  for (const record of graph.targets.values()) countFor(record.target.accountId).planned++;
  for (const counts of inventoryCounts.values()) counts.denominator = Math.max(counts.declared, counts.registered, counts.planned);
  const fullInventoryCount = [...inventoryCounts.values()].reduce((n, counts) => n + counts.denominator, 0);
  const completed = targets.filter(target => target.complete).length;
  const coverageComplete = graph.inventoryIssues.length === 0 && targets.length === fullInventoryCount && completed === targets.length;
  const finishedAt = graph.finishedAt ?? null;
  const withinTarget = finishedAt !== null && finishedAt >= graph.startedAt && finishedAt - graph.startedAt <= MAX_CYCLE_MS;
  const complete = graph.status === 'settled' && coverageComplete && withinTarget;
  const cadenceProven = complete && Number.isFinite(graph.previousCompleteAt) && graph.previousCompleteAt <= graph.startedAt && finishedAt - graph.previousCompleteAt <= MAX_CYCLE_MS;
  return {version:1, phase:graph.phase, cycleId:graph.cycleId, startedAt:graph.startedAt, finishedAt,
    total:fullInventoryCount, declaredInventoryTotal:graph.accounts.reduce((n, account) => n + account.expectedCount, 0),
    registeredInventoryTotal:graph.inventoryUniverse ? graph.inventoryUniverse.reduce((n, account) => n + account.expectedCount, 0) : null,
    inventoryCounts:[...inventoryCounts.values()], plannedTargets:targets.length, completed,
    ownIdentityVerified:targets.filter(target => target.ownIdentityVerified).length,
    priceComplete:targets.filter(target => target.priceComplete).length, costVerified:targets.filter(target => target.costVerified).length,
    coverageComplete, withinTarget, complete, cadenceProven,
    comparisonScope:'configured_query_results_for_all_inventory', marketWideCoverageProven:false,
    productionAccepted:false, // Synthetic graph results are never production acceptance.
    inventoryIssues:copy(graph.inventoryIssues), missingTargets:targets.filter(target => !target.complete), targets,
    counts:graphCounts(graph), execution:graph.execution || null};
}

export function graphCounts(graph) {
  const byKind = {}, rawBySource = {}, rawByRole = {};
  for (const node of graph.nodes.values()) {
    byKind[node.kind] = (byKind[node.kind] || 0) + 1;
    if (node.kind === 'raw') {
      const source = rawBySource[node.source] ||= {search:0, detail:0, quote:0}; source[node.request.kind]++;
      for (const role of node.readRoles) rawByRole[role] = (rawByRole[role] || 0) + 1;
    }
  }
  const withBindings = new Set(graph.scopes.filter(scope => scope.purpose === 'procurement' && scope.eligibleDiscoveryBindings > 0).map(scope => scope.targetKey));
  return {targets:graph.targets.size, nodes:graph.nodes.size, byKind, rawBySource, rawByRole,
    inventoryObservations:graph.accounts.length, canonicalSkuGroups:null,
    targetsWithEligibleSupplierDiscoveryBindings:withBindings.size, targetsWithoutEligibleSupplierDiscoveryBindings:graph.targets.size - withBindings.size,
    storedSupplierLinks:graph.scopes.filter(scope => scope.purpose === 'procurement').reduce((n, scope) => n + scope.storedLinks, 0),
    eligibleSupplierDiscoveryBindings:graph.scopes.filter(scope => scope.purpose === 'procurement').reduce((n, scope) => n + scope.eligibleDiscoveryBindings, 0)};
}
