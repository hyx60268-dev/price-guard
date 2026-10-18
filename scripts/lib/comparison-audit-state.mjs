import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { encrypt, decrypt } from './crypto.mjs';
import { mergeScanAdmission } from './scan-admission.mjs';
import { COMPARISON_AUDIT_LIMITS } from './comparison-audit-control.mjs';

// This is a non-secret replay ledger, encrypted with the existing dashboard key.
// It creates no credentials, permissions, lock service, activation, or network I/O.
// The caller MUST already hold the existing global writer lock for this lifetime.
export const COMPARISON_AUDIT_RECEIPT_FIELD = 'comparisonAuditReceipt';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonHash = value => digest(JSON.stringify(value));
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const requestId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(value);
// The existing workflow lock serializes processes. This ephemeral queue also
// serializes accidental concurrent adapters within one process; it is not a new
// persistent lock, token, permission, or substitute for that workflow lock.
const writeQueues = new Map();
function serializeWrite(filename, operation) {
  const previous = writeQueues.get(filename) || Promise.resolve();
  const result = previous.then(operation);
  const settled = result.then(() => {}, () => {});
  writeQueues.set(filename, settled);
  return result.finally(() => { if (writeQueues.get(filename) === settled) writeQueues.delete(filename); });
}

const stamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z') ? Date.parse(value) : NaN;
function assert(condition, message) { if (!condition) throw Error(message); }
function freeze(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }

// Mirrors the pure controller's ledger format; never interpret null/corruption
// as legacy absence. Exported for publication/restore preservation, not activation.
export function validateComparisonAuditReceipt(receipt, { now = Date.now() } = {}) {
  assert(Number.isFinite(now) && plain(receipt) && receipt.version === 1 && Number.isSafeInteger(receipt.revision) && receipt.revision >= 0 && Array.isArray(receipt.consumed) && receipt.revision === receipt.consumed.length, 'Missing or corrupt comparison audit receipt');
  const ids = new Set();
  for (const row of receipt.consumed) {
    assert(plain(row) && requestId(row.requestId) && !ids.has(row.requestId) && sha(row.expectedSha) && typeof row.runId === 'string' && /^[1-9]\d*$/.test(row.runId) && Number.isFinite(stamp(row.startedAt)) && Number.isFinite(stamp(row.consumedAt)) && stamp(row.startedAt) <= stamp(row.consumedAt) && stamp(row.consumedAt) <= now && Number.isFinite(stamp(row.deadlineAt)) && stamp(row.deadlineAt) > stamp(row.startedAt) && stamp(row.deadlineAt) <= stamp(row.startedAt) + COMPARISON_AUDIT_LIMITS.durationMs, 'Missing or corrupt comparison audit receipt');
    ids.add(row.requestId);
  }
  return freeze(clone(receipt));
}

// Optional restore/publication hookup. Missing legacy copies may be absent, but
// a present bad ledger fails closed. Conflicting consumption of an ID is not reset.
// This never creates an empty ledger when all inputs are absent.
export function mergeComparisonAuditReceipts(...receipts) {
  const present = receipts.filter(receipt => receipt !== undefined);
  if (!present.length) return undefined;
  const entries = new Map();
  for (const receipt of present) for (const row of validateComparisonAuditReceipt(receipt).consumed) {
    const existing = entries.get(row.requestId);
    assert(!existing || jsonHash(existing) === jsonHash(row), 'Conflicting comparison audit consumption receipts');
    entries.set(row.requestId, row);
  }
  const consumed = [...entries.values()].sort((a, b) => stamp(a.consumedAt) - stamp(b.consumedAt) || (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0));
  return freeze({ version: 1, revision: consumed.length, consumed });
}

function environment({ root, password, writerLockHeld, runKey, codeSha, startedAt, now = Date.now, io = fs }) {
  assert(typeof root === 'string' && path.isAbsolute(root), 'Absolute audit state root required');
  assert(typeof password === 'string' && password.length >= 8, 'Existing dashboard key required for audit state');
  assert(writerLockHeld === true, 'Existing global writer lock must already be held');
  assert(typeof runKey === 'string' && /^[1-9]\d*:[1-9]\d*$/.test(runKey) && sha(codeSha), 'Authenticated current scan admission identity required');
  assert(Number.isFinite(stamp(startedAt)), 'Original scan-entry startedAt is required');
  assert(typeof now === 'function', 'Audit state clock must be a function');
  const filename = path.join(root, 'state', 'latest.json.enc');
  let lastNow = -Infinity;
  function clock() {
    const current = now();
    assert(Number.isFinite(current) && current >= lastNow && current >= stamp(startedAt), 'Invalid or regressed audit state clock');
    lastNow = current;
    return current;
  }
  function validateState(state, current) {
    assert(plain(state) && Array.isArray(state.items) && state.items.every(plain), 'Restored full private state is missing or invalid');
    const admission = mergeScanAdmission(state.scanAdmission);
    assert(admission && admission.runKey === runKey && admission.codeSha === codeSha && Date.parse(admission.claimedAt) <= stamp(startedAt) && Date.parse(admission.claimedAt) <= current, 'Current scanAdmission runKey/codeSha or original start mismatch');
  }
  async function read() {
    const current = clock();
    let bytes, plaintext, state;
    try { bytes = await io.readFile(filename); plaintext = decrypt(bytes, password); state = JSON.parse(plaintext.toString('utf8')); }
    catch (cause) { throw Error('Cannot read and decrypt restored full audit state; no initialization allowed', { cause }); }
    validateState(state, current);
    return { state, fullStateHash: digest(plaintext), fileHash: digest(bytes), sourceStateId: `private-state-sha256:${digest(plaintext)}` };
  }
  const same = (left, right) => left.fullStateHash === right.fullStateHash && left.fileHash === right.fileHash;
  async function replaceUnlocked(expected, nextState) {
    const temporary = `${filename}.audit-tmp-${randomUUID()}`;
    const plaintext = Buffer.from(JSON.stringify(nextState));
    let handle;
    try {
      assert(same(await read(), expected), 'Full audit state changed before write');
      handle = await io.open(temporary, 'wx', 0o600);
      await handle.writeFile(encrypt(plaintext, password));
      await handle.sync(); await handle.close(); handle = null;
      // The existing global writer lock is the serialization primitive. Recheck
      // both full-state content and exact original file immediately before rename.
      assert(same(await read(), expected), 'Full audit state changed during staging');
      await io.rename(temporary, filename);
      const directory = await io.open(path.dirname(filename), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      const confirmed = await read();
      assert(confirmed.fullStateHash === digest(plaintext) && jsonHash(confirmed.state[COMPARISON_AUDIT_RECEIPT_FIELD]) === jsonHash(nextState[COMPARISON_AUDIT_RECEIPT_FIELD]), 'Audit state durable readback did not confirm the write');
      return confirmed;
    } finally {
      if (handle) await handle.close().catch(() => {});
      await io.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  return { read, replace: (expected, nextState) => serializeWrite(filename, () => replaceUnlocked(expected, nextState)), same, clock, runKey, codeSha, startedAt };
}

// Explicit preparation only, after normal restore/admission and with audit
// disabled. Never invoke this as a fallback from active loading or CAS failure.
export async function prepareComparisonAuditState({ activation, legacyStateCodeShas, ...options } = {}) {
  assert(activation?.enabled === false, 'Receipt migration requires explicitly disabled audit preparation');
  const env = environment(options), current = await env.read();
  const prior = current.state[COMPARISON_AUDIT_RECEIPT_FIELD];
  if (Object.hasOwn(current.state, COMPARISON_AUDIT_RECEIPT_FIELD)) {
    const receipt = validateComparisonAuditReceipt(prior, { now: env.clock() });
    return freeze({ prepared: true, migrated: false, sourceStateId: current.sourceStateId, receipt });
  }
  // The allowlist is separately reviewed pre-feature publication metadata. Never
  // derive it from this same restored state or widen it after an active failure.
  assert(Array.isArray(legacyStateCodeShas) && legacyStateCodeShas.length > 0 && legacyStateCodeShas.every(sha) && new Set(legacyStateCodeShas).size === legacyStateCodeShas.length && sha(current.state.scanMeta?.codeSha) && legacyStateCodeShas.includes(current.state.scanMeta.codeSha), 'Missing receipt is not a trusted pre-feature legacy publication');
  const receipt = { version: 1, revision: 0, consumed: [] };
  const saved = await env.replace(current, { ...current.state, [COMPARISON_AUDIT_RECEIPT_FIELD]: receipt });
  return freeze({ prepared: true, migrated: true, sourceStateId: saved.sourceStateId, receipt });
}

// Strict active adapter. Pass its receipt/context into claimComparisonAudit;
// its callback is the only mutating path. Do not hold an adapter across writers.
export async function openComparisonAuditState(options = {}) {
  const env = environment(options), original = await env.read();
  const receipt = validateComparisonAuditReceipt(original.state[COMPARISON_AUDIT_RECEIPT_FIELD], { now: env.clock() });
  const deadline = stamp(env.startedAt) + COMPARISON_AUDIT_LIMITS.durationMs;
  assert(env.clock() < deadline, 'Original twelve-minute audit deadline exceeded');
  let attempted = false, minimumReceipt = receipt;
  async function consumeReceipt({ previousReceipt, receipt: nextReceipt } = {}) {
    assert(!attempted, 'This audit state adapter has already attempted consumption');
    attempted = true;
    const currentTime = env.clock();
    assert(currentTime < deadline, 'Original twelve-minute audit deadline exceeded');
    const previous = validateComparisonAuditReceipt(previousReceipt, { now: currentTime });
    const next = validateComparisonAuditReceipt(nextReceipt, { now: currentTime });
    if (jsonHash(previous) !== jsonHash(receipt)) return null;
    assert(next.revision === previous.revision + 1 && jsonHash(next.consumed.slice(0, -1)) === jsonHash(previous.consumed), 'Consumption must append exactly one receipt without changing history');
    const added = next.consumed.at(-1);
    assert(added.runId === env.runKey.split(':')[0] && env.runKey.endsWith(':1') && added.expectedSha === env.codeSha && added.startedAt === env.startedAt && stamp(added.consumedAt) >= stamp(env.startedAt) && currentTime < stamp(added.deadlineAt) && stamp(added.deadlineAt) <= deadline, 'Consumption is not bound to this original scan run/deadline');
    const current = await env.read();
    if (!env.same(current, original) || jsonHash(current.state[COMPARISON_AUDIT_RECEIPT_FIELD]) !== jsonHash(previous)) return null;
    minimumReceipt = next; // Preserve even an uncertain post-rename consumption.
    const saved = await env.replace(original, { ...original.state, [COMPARISON_AUDIT_RECEIPT_FIELD]: next });
    return validateComparisonAuditReceipt(saved.state[COMPARISON_AUDIT_RECEIPT_FIELD], { now: env.clock() });
  }
  // Read the CURRENT disk ledger for the new scan result; the pre-claim in-memory
  // previous state still has the old ledger. No missing-field fallback is allowed.
  async function readReceipt() {
    const current = await env.read();
    const latest = validateComparisonAuditReceipt(current.state[COMPARISON_AUDIT_RECEIPT_FIELD], { now: env.clock() });
    for (const row of minimumReceipt.consumed) assert(latest.consumed.some(candidate => jsonHash(candidate) === jsonHash(row)), 'Consumed audit history was lost before publication');
    return latest;
  }
  return Object.freeze({ receipt, sourceStateId: original.sourceStateId, startedAt: env.startedAt, runKey: env.runKey, codeSha: env.codeSha, consumeReceipt, readReceipt });
}
