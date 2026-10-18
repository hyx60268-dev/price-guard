import { createHash } from 'node:crypto';

// A finite, opt-in diagnostic. Nothing here reads files, changes configuration,
// fetches a source, initializes durable state, or changes collector pacing.
export const COMPARISON_AUDIT_LIMITS = Object.freeze({
  pageFetches: 80,
  competitorDetailFetches: 64,
  initialDetailsPerTarget: 32,
  durationMs: 12 * 60_000,
  activationTtlMs: 2 * 60 * 60_000,
});
const PREFIX = '[price-guard-yahoo-comparison-audit:';
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;
const SHA = /^[a-f0-9]{40}$/;
const validRequestId = value => typeof value === 'string' && ID.test(value);
const validSha = value => typeof value === 'string' && SHA.test(value);
const PAGE_KINDS = new Set(['profile', 'own', 'search', 'known', 'detail']);
const claims = new WeakSet();
const usedClaims = new WeakSet();
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const stamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z') ? Date.parse(value) : NaN;
const iso = value => new Date(value).toISOString();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function time(value) { try { return stamp(value); } catch { return NaN; } }
const observationTime = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : time(value);
function requireThat(condition, message) { if (!condition) throw new Error(message); }
function stringSet(values, label, { empty = true } = {}) {
  requireThat(Array.isArray(values) && (empty || values.length > 0) && values.every(nonempty) && new Set(values).size === values.length, `Invalid ${label}`);
  return [...values].sort();
}
const blocked = reason => ({ requested: true, admitted: false, active: false, reason });
const inactive = reason => ({ requested: false, admitted: false, active: false, reason });

export function comparisonAuditMarker(requestId) {
  requireThat(validRequestId(requestId), 'Invalid comparison audit requestId');
  return `${PREFIX}${requestId}]`;
}

function validateReceipt(receipt, now) {
  requireThat(plain(receipt) && receipt.version === 1 && Number.isSafeInteger(receipt.revision) && receipt.revision >= 0 && Array.isArray(receipt.consumed) && receipt.revision === receipt.consumed.length, 'Missing or corrupt comparison audit receipt');
  const ids = new Set();
  for (const row of receipt.consumed) {
    requireThat(plain(row) && validRequestId(row.requestId) && !ids.has(row.requestId) && validSha(row.expectedSha) && /^[1-9]\d*$/.test(row.runId || '') && Number.isFinite(time(row.consumedAt)) && time(row.consumedAt) <= now && Number.isFinite(time(row.startedAt)) && time(row.startedAt) <= time(row.consumedAt) && Number.isFinite(time(row.deadlineAt)) && time(row.deadlineAt) > time(row.startedAt) && time(row.deadlineAt) <= time(row.startedAt) + COMPARISON_AUDIT_LIMITS.durationMs, 'Missing or corrupt comparison audit receipt');
    ids.add(row.requestId);
  }
  return clone(receipt);
}

// expectedSha is trusted runtime context, never a self-referential config SHA.
// An ordinary push/cron without the single matching marker is always inactive.
export function decideComparisonAuditActivation({ activation, context = {}, receipt, now = Date.now() } = {}) {
  if (activation?.enabled !== true) return inactive('disabled');
  const message = typeof context.commitMessage === 'string' ? context.commitMessage : '';
  if (!validRequestId(activation.requestId)) return message.includes(PREFIX) ? blocked('invalid_activation') : inactive('no_matching_marker');
  const marker = comparisonAuditMarker(activation.requestId);
  if (!message.includes(marker)) return inactive('no_matching_marker');
  if (message.split(PREFIX).length - 1 !== 1 || message.split(marker).length - 1 !== 1) return blocked('ambiguous_marker');
  const issued = time(activation.issuedAt), expires = time(activation.expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued || expires - issued > COMPARISON_AUDIT_LIMITS.activationTtlMs) return blocked('invalid_activation_window');
  if (now < issued || now >= expires) return blocked('activation_expired_or_not_due');
  if (context.eventName !== 'push' || context.ref !== 'refs/heads/main') return blocked('not_main_push');
  if (String(context.runAttempt) !== '1') return blocked('rerun_forbidden');
  if (!/^[1-9]\d*$/.test(String(context.runId || ''))) return blocked('invalid_run_identity');
  if (!validSha(context.expectedSha) || context.expectedSha !== context.codeSha || context.expectedSha !== context.currentMainSha || context.expectedSha !== context.eventSha) return blocked('unexpected_main_sha');
  const started = time(context.startedAt);
  if (!Number.isFinite(started) || started < issued || started > now) return blocked('invalid_original_start');
  const deadline = Math.min(started + COMPARISON_AUDIT_LIMITS.durationMs, expires);
  if (now >= deadline) return blocked('deadline_exceeded');
  let prior;
  try { prior = validateReceipt(receipt, now); } catch { return blocked('missing_or_corrupt_receipt'); }
  if (prior.consumed.some(row => row.requestId === activation.requestId)) return blocked('request_already_consumed');
  const consumed = { requestId: activation.requestId, expectedSha: context.expectedSha, runId: String(context.runId), startedAt: context.startedAt, consumedAt: iso(now), deadlineAt: iso(deadline) };
  return freeze({ requested: true, admitted: true, active: false, reason: 'receipt_must_be_persisted', previousReceipt: prior, receipt: { version: 1, revision: prior.revision + 1, consumed: [...prior.consumed, consumed] }, audit: consumed });
}

// consumeReceipt must atomically compare previousReceipt and durably persist
// receipt under the existing global writer lock. Return the stored full receipt;
// return null on conflict. A failed/uncertain persistence never creates a claim.
export async function claimComparisonAudit({ consumeReceipt, now = Date.now, ...options } = {}) {
  const clock = typeof now === 'function' ? now : () => now;
  const decision = decideComparisonAuditActivation({ ...options, now: clock() });
  if (!decision.admitted) return decision;
  if (typeof consumeReceipt !== 'function') return blocked('receipt_persistence_required');
  let stored;
  try { stored = await consumeReceipt({ previousReceipt: clone(decision.previousReceipt), receipt: clone(decision.receipt) }); }
  catch { return blocked('receipt_persistence_failed'); }
  const after = clock();
  try {
    validateReceipt(stored, after);
    if (hash(stored) !== hash(decision.receipt)) return blocked('receipt_persistence_unconfirmed');
  } catch { return blocked('receipt_persistence_unconfirmed'); }
  if (!Number.isFinite(after) || after < time(decision.audit.consumedAt) || after >= time(decision.audit.deadlineAt)) return { ...blocked('deadline_or_clock_changed_during_claim'), consumed: true };
  const claim = freeze({ requested: true, admitted: true, active: true, reason: 'consumed', audit: clone(decision.audit), receipt: clone(stored) });
  claims.add(claim);
  return claim;
}

// The caller derives expectedAccountIds from ALL configured Yahoo accounts,
// including aliases, never just the two audit targets. Non-Yahoo refreshes are
// outside this prerequisite. Provenance references restored private state.
export function validateConfiguredComparisonAuditOwnership({ configuredOwnership, expectedAccountIds, sourceStateId, now = Date.now() } = {}) {
  const expected = stringSet(expectedAccountIds, 'expected Yahoo ownership accounts', { empty: false });
  const index = configuredOwnership;
  requireThat(plain(index) && index.version === 1 && nonempty(sourceStateId) && index.sourceStateId === sourceStateId && Array.isArray(index.accounts), 'Configured Yahoo ownership mapping is required');
  const actual = stringSet(index.accounts.map(row => row?.accountId), 'Yahoo ownership accounts', { empty: false });
  requireThat(JSON.stringify(actual) === JSON.stringify(expected), 'Ownership mapping does not cover every configured Yahoo account');
  for (const row of index.accounts) {
    requireThat(row.platform === 'yahoo' && row.sellerBindingVerified === true, 'Verified Yahoo seller/alias mapping is required');
    stringSet(row.sellerIds, 'ownership seller IDs', { empty: false });
    stringSet(row.listingIds, 'retained ownership listing IDs');
    requireThat(Array.isArray(row.provenance) && row.provenance.length > 0 && row.provenance.every(source => plain(source) && nonempty(source.source) && source.sourceStateId === sourceStateId && Number.isFinite(observationTime(source.observedAt)) && observationTime(source.observedAt) <= now), 'Ownership source provenance is required');
  }
  return freeze(clone(index));
}

// verifiedAt is index assembly/validation time, not a marketplace observation.
// profile.observedAt must come from the current successful full enumeration;
// profile.reservationIds proves the actual reads were inside the shared budget.
export function validateComparisonAuditOwnership({ index, configuredOwnership, expectedAccountIds, sourceStateId, startedAt, now = Date.now() } = {}) {
  const configured = validateConfiguredComparisonAuditOwnership({ configuredOwnership, expectedAccountIds, sourceStateId, now });
  const validated = validateConfiguredComparisonAuditOwnership({ configuredOwnership: index, expectedAccountIds, sourceStateId, now });
  requireThat(index.complete === true, 'Complete current ownership index is required');
  const verified = time(index.verifiedAt), started = time(startedAt);
  requireThat(Number.isFinite(now) && Number.isFinite(started) && Number.isFinite(verified) && verified >= started && verified <= now, 'Ownership index verification is not current');
  for (const row of validated.accounts) {
    const prior = configured.accounts.find(account => account.accountId === row.accountId);
    requireThat(row.complete === true && JSON.stringify([...prior.sellerIds].sort()) === JSON.stringify([...row.sellerIds].sort()) && prior.listingIds.every(id => row.listingIds.includes(id)), 'Current ownership must retain every seller alias and owned listing ID');
    requireThat(plain(row.profile) && row.profile.complete === true && Number.isFinite(observationTime(row.profile.observedAt)) && observationTime(row.profile.observedAt) >= started && observationTime(row.profile.observedAt) <= verified, 'Current complete Yahoo profile enumeration is required');
    stringSet(row.profile.reservationIds, 'counted profile reservation IDs', { empty: false });
  }
  return validated;
}

// Freeze once after recall/eligibility filtering. This is candidate-set t0, not
// a successful detail/quote timestamp. ID and t0 never change after details run.
export function freezeComparisonAuditCandidates({ frozenAt, targets } = {}) {
  requireThat(Number.isFinite(time(frozenAt)) && Array.isArray(targets) && targets.length === 2, 'Exactly two frozen targets and a candidate-set time are required');
  const ids = stringSet(targets.map(target => target?.targetId), 'target IDs', { empty: false });
  const normalized = ids.map(targetId => {
    const target = targets.find(row => row.targetId === targetId);
    requireThat(Array.isArray(target.candidates), 'Frozen candidate list is required');
    stringSet(target.candidates.map(candidate => candidate?.id), 'candidate IDs');
    const candidates = target.candidates.map(candidate => {
      requireThat(plain(candidate) && (candidate.sellerId === undefined || nonempty(candidate.sellerId)) && (candidate.url === undefined || nonempty(candidate.url)), 'Invalid frozen candidate');
      return { id: candidate.id, ...(candidate.sellerId === undefined ? {} : { sellerId: candidate.sellerId }), ...(candidate.url === undefined ? {} : { url: candidate.url }) };
    }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return { targetId, candidates };
  });
  const body = { version: 1, frozenAt, targets: normalized };
  return freeze({ ...body, identity: hash(body) });
}

export function createComparisonAuditController({ claim, configuredOwnership, expectedAccountIds, sourceStateId, targetIds, now = Date.now, signal } = {}) {
  requireThat(claims.has(claim) && !usedClaims.has(claim), 'A fresh durably consumed audit claim is required');
  requireThat(typeof now === 'function', 'An audit clock is required');
  const ids = stringSet(targetIds, 'audit targets', { empty: false });
  requireThat(ids.length === 2, 'Exactly two audit targets are required');
  let lastNow = now();
  const configured = validateConfiguredComparisonAuditOwnership({ configuredOwnership, expectedAccountIds, sourceStateId, now: lastNow });
  let ownership = null;
  requireThat(Number.isFinite(lastNow) && lastNow >= time(claim.audit.consumedAt) && lastNow < time(claim.audit.deadlineAt), 'Audit deadline or clock is invalid');
  usedClaims.add(claim);
  const abort = new AbortController();
  const targets = new Map(ids.map(id => [id, { detailReservations: 0, detailFetches: 0, candidates: new Map() }]));
  const requests = new Map(), transportIds = new Set();
  const ownedSellers = new Set(), ownedListings = new Set();
  for (const account of configured.accounts) {
    for (const id of account.sellerIds) ownedSellers.add(`${account.platform}:${id}`);
    for (const id of account.listingIds) ownedListings.add(`${account.platform}:${id}`);
  }
  let frozenCandidates = null, stopped = null;
  const counts = { pageReservations: 0, competitorDetailReservations: 0, pageFetches: 0, competitorDetailFetches: 0, cacheReuses: 0, pageBytes: 0, pageWallMs: 0, imageFetches: 0, imageBytes: 0, imageWallMs: 0, outcomes: { ok: 0, failed: 0, denied: 0, cancelled: 0 }, actualOutcomes: { ok: 0, failed: 0, denied: 0, cancelled: 0 }, byKindReservations: Object.fromEntries([...PAGE_KINDS].map(kind => [kind, 0])), byKind: Object.fromEntries([...PAGE_KINDS].map(kind => [kind, 0])) };
  function stop(reason) {
    if (!stopped) { stopped = reason; abort.abort(reason); }
    return { admitted: false, reason: stopped };
  }
  function tick() {
    const current = now();
    if (!Number.isFinite(current) || current < lastNow) { stop('invalid_or_regressed_clock'); return null; }
    lastNow = current;
    if (signal?.aborted) stop('cancelled');
    if (current >= time(claim.audit.deadlineAt)) stop('deadline_exceeded');
    return current;
  }
  function classifyOwnership({ id, sellerId, platform = 'yahoo' } = {}) {
    if (platform !== 'yahoo' || !nonempty(id)) return 'unknown';
    if (ownedListings.has(`${platform}:${id}`) || nonempty(sellerId) && ownedSellers.has(`${platform}:${sellerId}`)) return 'owned';
    return ownership && nonempty(sellerId) ? 'not_owned' : 'unknown';
  }
  function setOwnershipIndex(index) {
    tick();
    requireThat(!stopped && !ownership, 'Ownership is already finalized or audit stopped');
    const validated = validateComparisonAuditOwnership({ index, configuredOwnership: configured, expectedAccountIds, sourceStateId, startedAt: claim.audit.startedAt, now: lastNow });
    requireThat([...requests.values()].every(request => request.kind !== 'profile' || request.outcome !== null), 'Profile requests are still in flight');
    requireThat([...requests.values()].every(request => request.kind !== 'profile' || request.outcome === 'ok'), 'Failed profile enumeration cannot establish complete ownership');
    const referenced = new Set();
    for (const account of validated.accounts) {
      let earliestObservation = Infinity;
      for (const id of account.profile.reservationIds) {
        const request = requests.get(id), sourceAccount = configured.accounts.find(row => row.accountId === request?.accountId);
        requireThat(request?.kind === 'profile' && request.outcome === 'ok' && Number.isFinite(observationTime(request.observedAt)) && sourceAccount && account.sellerIds.some(sellerId => sourceAccount.sellerIds.includes(sellerId)), 'Ownership profile evidence was not a successful counted account read');
        requireThat(time(validated.verifiedAt) >= time(request.finishedAt), 'Ownership verification predates a completed profile request');
        earliestObservation = Math.min(earliestObservation, observationTime(request.observedAt));
        referenced.add(id);
      }
      requireThat(observationTime(account.profile.observedAt) === earliestObservation, 'Ownership profile time must retain the earliest original page observation');
    }
    requireThat([...requests.values()].every(request => request.kind !== 'profile' || request.outcome !== 'ok' || referenced.has(request.reservationId)), 'Successful profile pages were omitted from ownership evidence');
    requireThat(ids.every(id => validated.accounts.some(account => account.listingIds.includes(id))), 'Both audit targets must belong to the complete owned-listing index');
    ownership = validated;
    for (const account of ownership.accounts) {
      for (const id of account.sellerIds) ownedSellers.add(`yahoo:${id}`);
      for (const id of account.listingIds) ownedListings.add(`yahoo:${id}`);
    }
    return ownership;
  }
  const remaining = target => [...target.candidates.values()].filter(candidate => candidate.state === 'pending' || candidate.state === 'in_flight').length;
  function allowance(targetId) {
    const otherId = ids.find(id => id !== targetId), other = targets.get(otherId);
    return COMPARISON_AUDIT_LIMITS.initialDetailsPerTarget + (frozenCandidates && remaining(other) === 0 ? Math.max(0, COMPARISON_AUDIT_LIMITS.initialDetailsPerTarget - other.detailReservations) : 0);
  }
  function freezeCandidates(value) {
    tick();
    requireThat(!stopped && ownership && !frozenCandidates, 'Complete ownership is required before freezing, or candidate set is already frozen/audit stopped');
    requireThat([...requests.values()].every(request => request.outcome !== null), 'Recall requests are still in flight');
    requireThat(value?.frozenAt === undefined || time(value.frozenAt) === lastNow, 'Candidate-set time cannot be backdated or moved forward');
    const frozen = freezeComparisonAuditCandidates({ ...value, frozenAt: iso(lastNow) });
    requireThat(JSON.stringify(frozen.targets.map(target => target.targetId)) === JSON.stringify(ids), 'Candidate set target identity is invalid');
    frozenCandidates = frozen;
    for (const target of frozen.targets) for (const candidate of target.candidates) {
      const owned = classifyOwnership(candidate) === 'owned';
      targets.get(target.targetId).candidates.set(candidate.id, { ...candidate, state: owned ? 'ineligible' : 'pending', ...(owned ? { reason: 'owned' } : {}) });
    }
    return frozen;
  }
  function markCandidateIneligible({ targetId, candidateId, reason } = {}) {
    tick();
    requireThat(!stopped && nonempty(reason), 'Audit stopped or exclusion reason missing');
    const candidate = targets.get(targetId)?.candidates.get(candidateId);
    requireThat(candidate?.state === 'pending', 'Only a pending frozen candidate can be excluded');
    candidate.state = 'ineligible'; candidate.reason = reason;
  }
  function recordCacheReuse({ targetId, candidateId, observedAt } = {}) {
    tick();
    requireThat(!stopped && Number.isFinite(observationTime(observedAt)) && observationTime(observedAt) <= lastNow, 'Original cache observation time is required');
    if (targetId !== undefined || candidateId !== undefined) {
      const candidate = targets.get(targetId)?.candidates.get(candidateId);
      requireThat(candidate?.state === 'pending', 'Only a pending frozen candidate can reuse a detail');
      candidate.state = 'cached'; candidate.detailObservedAt = observedAt;
    }
    counts.cacheReuses++;
  }
  // Call ONCE at the actual transport boundary, after pacing/cache resolution,
  // with no await between this reservation and starting the transport. Every
  // attempted transport (including errors/denials) consumes its reservation.
  function reservePageFetch({ kind, transportId, accountId, targetId, candidateId } = {}) {
    const at = tick();
    if (stopped) return { admitted: false, reason: stopped };
    if (!PAGE_KINDS.has(kind) || !nonempty(transportId)) return { admitted: false, reason: 'invalid_page_request' };
    if (kind === 'profile') {
      if (ownership) return { admitted: false, reason: 'ownership_already_finalized' };
      if (!configured.accounts.some(account => account.accountId === accountId)) return { admitted: false, reason: 'unknown_profile_account' };
    } else if (!ownership) return { admitted: false, reason: 'ownership_incomplete' };
    if (transportIds.has(transportId)) return { admitted: false, reason: 'duplicate_transport_id' };
    if (counts.pageReservations >= COMPARISON_AUDIT_LIMITS.pageFetches) return stop('page_budget_exhausted');
    const detail = kind === 'known' || kind === 'detail';
    let candidate, target;
    if (detail) {
      target = targets.get(targetId); candidate = target?.candidates.get(candidateId);
      if (!frozenCandidates || !candidate) return { admitted: false, reason: 'candidate_not_frozen' };
      if (candidate.state !== 'pending') return { admitted: false, reason: 'candidate_not_eligible' };
      if (counts.competitorDetailReservations >= COMPARISON_AUDIT_LIMITS.competitorDetailFetches) return { admitted: false, reason: 'detail_budget_exhausted' };
      if (target.detailReservations >= allowance(targetId)) return { admitted: false, reason: 'target_allowance_exhausted' };
    } else if (targetId !== undefined || candidateId !== undefined) return { admitted: false, reason: 'misclassified_competitor_detail' };
    transportIds.add(transportId);
    counts.pageReservations++; counts.byKindReservations[kind]++;
    if (detail) { counts.competitorDetailReservations++; target.detailReservations++; candidate.state = 'in_flight'; }
    const reservationId = `${claim.audit.requestId}:${counts.pageReservations}`;
    requests.set(reservationId, { reservationId, transportId, kind, ...(kind === 'profile' ? { accountId } : {}), ...(detail ? { targetId, candidateId } : {}), startedAt: iso(at), transportStarted: null, outcome: null });
    return freeze({ admitted: true, reservationId, deadlineAt: claim.audit.deadlineAt, candidateSetIdentity: frozenCandidates?.identity ?? null });
  }
  function finishPageFetch({ reservationId, outcome, transportStarted = true, observedAt, bytes = 0 } = {}) {
    const at = tick(), request = requests.get(reservationId);
    requireThat(request && request.outcome === null && ['ok', 'failed', 'denied', 'cancelled'].includes(outcome), 'Invalid or already completed page reservation');
    const terminal = outcome === 'denied' || outcome === 'cancelled';
    // A known source denial/cancellation takes effect before ancillary metadata
    // validation. Malformed byte/time observations must never reopen admission.
    if (terminal) stop(outcome === 'denied' ? 'source_denied' : 'cancelled');
    requireThat(typeof transportStarted === 'boolean' && (transportStarted || outcome === 'cancelled'), 'A reservation without transport must finish as cancelled');
    const validBytes = Number.isSafeInteger(bytes) && bytes >= 0;
    if (!terminal) {
      requireThat(validBytes, 'Invalid page byte observation');
      if (observedAt !== undefined) requireThat(outcome === 'ok' && at !== null && Number.isFinite(observationTime(observedAt)) && observationTime(observedAt) >= time(request.startedAt) && observationTime(observedAt) <= at, 'Invalid original page observation time');
    } else if (!validBytes || observedAt !== undefined) request.invalidAncillaryMetadata = true;
    request.transportStarted = transportStarted;
    request.outcome = outcome; request.finishedAt = at === null ? null : iso(at);
    request.observedAt = transportStarted && outcome === 'ok' && at !== null ? observedAt ?? null : null;
    request.bytes = transportStarted && validBytes ? bytes : 0; counts.outcomes[outcome]++; counts.pageBytes += request.bytes;
    if (transportStarted) {
      counts.pageFetches++; counts.byKind[request.kind]++; counts.actualOutcomes[outcome]++;
      if (request.targetId) { counts.competitorDetailFetches++; targets.get(request.targetId).detailFetches++; }
    }
    if (transportStarted && at !== null) counts.pageWallMs += at - time(request.startedAt);
    if (request.targetId) {
      const candidate = targets.get(request.targetId).candidates.get(request.candidateId);
      candidate.state = outcome; candidate.detailObservedAt = request.observedAt;
    }
    return freeze(clone(request));
  }
  function observeImageTransfer({ fetches = 1, bytes = 0, durationMs = 0 } = {}) {
    requireThat(Number.isSafeInteger(fetches) && fetches >= 0 && Number.isSafeInteger(bytes) && bytes >= 0 && Number.isFinite(durationMs) && durationMs >= 0, 'Invalid image observations');
    counts.imageFetches += fetches; counts.imageBytes += bytes; counts.imageWallMs += durationMs;
  }
  function snapshot() {
    tick();
    return freeze({ version: 1, requestId: claim.audit.requestId, startedAt: claim.audit.startedAt, deadlineAt: claim.audit.deadlineAt, stopped, ownershipSourceStateId: configured.sourceStateId, ownershipReady: ownership !== null, candidateSet: frozenCandidates, counts: { ...clone(counts), pendingReservations: [...requests.values()].filter(request => request.outcome === null).length }, targets: Object.fromEntries(ids.map(id => [id, { detailReservations: targets.get(id).detailReservations, detailFetches: targets.get(id).detailFetches, allowance: allowance(id), remainingEligible: remaining(targets.get(id)), candidates: [...targets.get(id).candidates.values()].map(clone) }])), requests: [...requests.values()].map(clone) });
  }
  return Object.freeze({ reservePageFetch, finishPageFetch, setOwnershipIndex, freezeCandidates, markCandidateIneligible, recordCacheReuse, classifyOwnership, observeImageTransfer, snapshot, cancel: () => stop('cancelled'), signal: abort.signal });
}
