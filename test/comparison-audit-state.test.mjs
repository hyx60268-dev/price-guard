import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encrypt, decrypt } from '../scripts/lib/crypto.mjs';
import { comparisonAuditMarker, claimComparisonAudit, decideComparisonAuditActivation, COMPARISON_AUDIT_LIMITS } from '../scripts/lib/comparison-audit-control.mjs';
import { COMPARISON_AUDIT_RECEIPT_FIELD as FIELD, prepareComparisonAuditState, openComparisonAuditState, validateComparisonAuditReceipt, mergeComparisonAuditReceipts } from '../scripts/lib/comparison-audit-state.mjs';

const START = Date.parse('2026-10-16T12:00:00Z'), SHA = 'a'.repeat(40), KEY = 'fixture-only-existing-dashboard-key';
const iso = value => new Date(value).toISOString();
const empty = () => ({ version: 1, revision: 0, consumed: [] });
const entry = (requestId = 'state-fixture-20261016', extra = {}) => ({ requestId, expectedSha: SHA, runId: '123', startedAt: iso(START), consumedAt: iso(START), deadlineAt: iso(START + COMPARISON_AUDIT_LIMITS.durationMs), ...extra });
const consumed = (id, extra) => ({ version: 1, revision: 1, consumed: [entry(id, extra)] });
const source = (ledger = empty()) => ({
  checkedAt: '2026-10-15T09:00:00Z', dataRevision: '2026-10-15T09:00:00Z',
  items: [{ id: 'own-a', accountId: 'account-a', yahoo: { checkedAt: '2026-10-15T08:00:00Z', candidates: [{ id: 'external', price: 5, checkedAt: '2026-10-15T07:00:00Z' }] }, sourceDetail: { checkedAt: '2026-10-15T06:00:00Z' } }],
  scanAdmission: { version: 1, runKey: '123:1', codeSha: SHA, claimedAt: iso(START - 1000), slotKey: '' },
  scanMeta: { codeSha: 'b'.repeat(40), startedAt: '2026-10-15T08:00:00Z' },
  manualCosts: { own: { purchaseCNY: 87, updatedAt: '2026-10-14T08:00:00Z' } },
  matchCorrections: { old: { deleted: true, updatedAt: '2026-10-13T08:00:00Z' } },
  yahooRequestAccess: { reason: 'http_429', retryAt: START + 3_600_000 },
  rakumaRequestAccess: { reason: 'blocked', retryAt: START + 3_600_000 },
  arbitraryFutureField: { preserve: ['exact', 4, null] },
  ...(ledger === undefined ? {} : { [FIELD]: ledger }),
});
async function setup(t, state = source()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-state-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'state'));
  const filename = path.join(root, 'state/latest.json.enc');
  const write = value => fs.writeFile(filename, encrypt(Buffer.from(JSON.stringify(value)), KEY));
  const read = async () => JSON.parse(decrypt(await fs.readFile(filename), KEY).toString('utf8'));
  if (state !== null) await write(state);
  return { root, filename, write, read, options: { root, password: KEY, writerLockHeld: true, runKey: '123:1', codeSha: SHA, startedAt: iso(START), now: () => START } };
}
function claimOptions(receipt) {
  return { activation: { enabled: true, requestId: 'state-fixture-20261016', issuedAt: iso(START - 60_000), expiresAt: iso(START + 3_600_000) }, context: { eventName: 'push', ref: 'refs/heads/main', runId: '123', runAttempt: 1, expectedSha: SHA, codeSha: SHA, eventSha: SHA, currentMainSha: SHA, startedAt: iso(START), commitMessage: comparisonAuditMarker('state-fixture-20261016') }, receipt, now: () => START };
}
const withoutLedger = state => { const copy = structuredClone(state); delete copy[FIELD]; return copy; };

test('disabled explicit migration adds only the ledger and is byte-for-byte idempotent thereafter', async t => {
  const original = withoutLedger(source()), env = await setup(t, original);
  const result = await prepareComparisonAuditState({ ...env.options, activation: { enabled: false }, legacyStateCodeShas: ['b'.repeat(40)] });
  assert.equal(result.prepared, true); assert.equal(result.migrated, true); assert.deepEqual(result.receipt, empty());
  assert.deepEqual(withoutLedger(await env.read()), original);
  const bytes = await fs.readFile(env.filename);
  const second = await prepareComparisonAuditState({ ...env.options, activation: { enabled: false } });
  assert.equal(second.migrated, false); assert.deepEqual(await fs.readFile(env.filename), bytes);
  assert.equal(second.sourceStateId, result.sourceStateId);
});

test('active missing ledger never initializes; migration requires explicitly disabled preparation', async t => {
  const env = await setup(t, withoutLedger(source())); const before = await fs.readFile(env.filename);
  await assert.rejects(openComparisonAuditState(env.options), /Missing or corrupt/);
  for (const activation of [undefined, {}, { enabled: true }, { enabled: 'false' }]) await assert.rejects(prepareComparisonAuditState({ ...env.options, activation }), /explicitly disabled/);
  assert.deepEqual(await fs.readFile(env.filename), before);
});

test('missing/corrupt/encrypted-under-another-key/full-state failures block even disabled preparation', async t => {
  const env = await setup(t, null);
  await assert.rejects(openComparisonAuditState(env.options), /Cannot read/);
  await assert.rejects(prepareComparisonAuditState({ ...env.options, activation: { enabled: false } }), /Cannot read/);
  for (const bytes of [Buffer.from('corrupt'), encrypt(Buffer.from('{invalid'), KEY), encrypt(Buffer.from('{}'), KEY), encrypt(Buffer.from(JSON.stringify(source())), 'different-fixture-key')]) {
    await fs.writeFile(env.filename, bytes);
    await assert.rejects(openComparisonAuditState(env.options));
    await assert.rejects(prepareComparisonAuditState({ ...env.options, activation: { enabled: false } }));
    assert.deepEqual(await fs.readFile(env.filename), bytes);
  }
});

test('present null or corrupt ledger is never treated as legacy absence', async t => {
  const env = await setup(t);
  for (const ledger of [null, {}, [], { version: 1, revision: 1, consumed: [] }, consumed('state-fixture-20261016', { requestId: 12345678 })]) {
    await env.write(source(ledger));
    await assert.rejects(openComparisonAuditState(env.options), /Missing or corrupt/);
    await assert.rejects(prepareComparisonAuditState({ ...env.options, activation: { enabled: false } }), /Missing or corrupt/);
  }
});

test('existing writer lock and current scan admission run/SHA are mandatory', async t => {
  const env = await setup(t);
  for (const changes of [{ writerLockHeld: false }, { writerLockHeld: undefined }, { runKey: '124:1' }, { codeSha: 'c'.repeat(40) }, { startedAt: iso(START - 2000) }, { startedAt: undefined }]) await assert.rejects(openComparisonAuditState({ ...env.options, ...changes }));
  for (const state of [{ ...source(), scanAdmission: undefined }, { ...source(), scanAdmission: {} }, { ...source(), items: null }]) {
    await env.write(state); await assert.rejects(openComparisonAuditState(env.options));
  }
});

test('real encrypted CAS consumes once without changing quotes, holds, manual costs or old clocks', async t => {
  const env = await setup(t), before = await env.read();
  const adapter = await openComparisonAuditState(env.options);
  const claim = await claimComparisonAudit({ ...claimOptions(adapter.receipt), consumeReceipt: adapter.consumeReceipt });
  assert.equal(claim.active, true);
  const after = await env.read(); assert.deepEqual(withoutLedger(after), withoutLedger(before));
  assert.deepEqual(after[FIELD], claim.receipt); assert.deepEqual(await adapter.readReceipt(), claim.receipt);
  assert.equal(after.scanMeta.startedAt, '2026-10-15T08:00:00Z');
  assert.equal(claim.audit.startedAt, iso(START)); assert.equal(claim.audit.deadlineAt, iso(START + 720_000));
  const reopen = await openComparisonAuditState(env.options);
  assert.equal(decideComparisonAuditActivation({ ...claimOptions(reopen.receipt), now: START }).reason, 'request_already_consumed');
  await assert.rejects(adapter.consumeReceipt({ previousReceipt: empty(), receipt: consumed() }), /already attempted/);
});

test('CAS rejects full-state mutation even when the ledger is unchanged', async t => {
  const env = await setup(t), adapter = await openComparisonAuditState(env.options);
  const changed = source(); changed.manualCosts.own.purchaseCNY = 88; await env.write(changed);
  assert.equal(await adapter.consumeReceipt({ previousReceipt: empty(), receipt: consumed() }), null);
  assert.deepEqual(await env.read(), changed);
});

test('CAS rejects ledger mutation and re-encryption of the original plaintext', async t => {
  const env = await setup(t);
  let adapter = await openComparisonAuditState(env.options);
  await env.write(source(consumed('other-fixture-id')));
  assert.equal(await adapter.consumeReceipt({ previousReceipt: empty(), receipt: consumed() }), null);
  await env.write(source()); adapter = await openComparisonAuditState(env.options);
  await env.write(source()); // Same full plaintext, different encrypted file identity.
  assert.equal(await adapter.consumeReceipt({ previousReceipt: empty(), receipt: consumed() }), null);
});

test('mutation during temporary-file staging is detected before rename', async t => {
  const env = await setup(t); let changed = false;
  const io = { ...fs, async open(filename, ...args) {
    const handle = await fs.open(filename, ...args);
    if (!filename.includes('.audit-tmp-')) return handle;
    return { writeFile: (...a) => handle.writeFile(...a), close: () => handle.close(), async sync() { await handle.sync(); const value = source(); value.arbitraryFutureField.changed = true; await env.write(value); changed = true; } };
  } };
  const adapter = await openComparisonAuditState({ ...env.options, io });
  await assert.rejects(adapter.consumeReceipt({ previousReceipt: empty(), receipt: consumed() }), /changed during staging/);
  assert.equal(changed, true); assert.equal((await env.read()).arbitraryFutureField.changed, true);
  assert.deepEqual((await env.read())[FIELD], empty());
  assert.deepEqual((await fs.readdir(path.dirname(env.filename))).sort(), ['latest.json.enc']);
});

test('save failure leaves original state and no temp file or active claim', async t => {
  const env = await setup(t); const before = await fs.readFile(env.filename);
  const io = { ...fs, async rename() { throw Error('fixture rename failure'); } };
  const adapter = await openComparisonAuditState({ ...env.options, io });
  const claim = await claimComparisonAudit({ ...claimOptions(adapter.receipt), consumeReceipt: adapter.consumeReceipt });
  assert.equal(claim.active, false); assert.equal(claim.reason, 'receipt_persistence_failed');
  assert.deepEqual(await fs.readFile(env.filename), before);
  assert.deepEqual((await fs.readdir(path.dirname(env.filename))).sort(), ['latest.json.enc']);
});

test('readback failure after rename cannot create active claim; consumed ID remains persisted', async t => {
  const env = await setup(t); let renamed = false;
  const io = { ...fs, async rename(...args) { await fs.rename(...args); renamed = true; }, async readFile(...args) { if (renamed) throw Error('fixture readback failure'); return fs.readFile(...args); } };
  const adapter = await openComparisonAuditState({ ...env.options, io });
  const claim = await claimComparisonAudit({ ...claimOptions(adapter.receipt), consumeReceipt: adapter.consumeReceipt });
  assert.equal(claim.active, false); assert.equal(claim.reason, 'receipt_persistence_failed');
  assert.deepEqual((await env.read())[FIELD], consumed());
  const reopened = await openComparisonAuditState(env.options);
  assert.equal(decideComparisonAuditActivation({ ...claimOptions(reopened.receipt), now: START }).reason, 'request_already_consumed');
});

test('wrong readback plaintext fails confirmation and publication cannot drop a consumed receipt', async t => {
  const env = await setup(t); let renamed = false;
  const io = { ...fs, async rename(...args) { await fs.rename(...args); renamed = true; }, async readFile(...args) { if (renamed) return encrypt(Buffer.from(JSON.stringify(source())), KEY); return fs.readFile(...args); } };
  const adapter = await openComparisonAuditState({ ...env.options, io });
  await assert.rejects(adapter.consumeReceipt({ previousReceipt: empty(), receipt: consumed() }), /readback/);
  await assert.rejects(adapter.readReceipt(), /history was lost/);
  assert.deepEqual((await env.read())[FIELD], consumed());
});

test('current readReceipt preserves the newly consumed ledger, not the pre-claim empty copy', async t => {
  const env = await setup(t), adapter = await openComparisonAuditState(env.options);
  await adapter.consumeReceipt({ previousReceipt: empty(), receipt: consumed() });
  assert.deepEqual(await adapter.readReceipt(), consumed());
  await env.write(source());
  await assert.rejects(adapter.readReceipt(), /history was lost/);
});

test('append-only run/SHA/original-start binding rejects forged ledger changes', async t => {
  const env = await setup(t);
  for (const ledger of [consumed(undefined, { runId: '999' }), consumed(undefined, { expectedSha: 'b'.repeat(40) }), consumed(undefined, { startedAt: iso(START - 100) }), { version: 1, revision: 2, consumed: [entry(), entry('other-fixture-id')] }]) {
    const adapter = await openComparisonAuditState(env.options);
    await assert.rejects(adapter.consumeReceipt({ previousReceipt: empty(), receipt: ledger }));
    assert.deepEqual((await env.read())[FIELD], empty());
  }
  const adapter = await openComparisonAuditState(env.options);
  assert.equal(await adapter.consumeReceipt({ previousReceipt: consumed('other-fixture-id'), receipt: { version: 1, revision: 2, consumed: [entry('other-fixture-id'), entry()] } }), null);
});

test('original scan deadline and regressed clocks cannot be reset by adapter reopens', async t => {
  const env = await setup(t);
  await assert.rejects(openComparisonAuditState({ ...env.options, now: () => START + 720_000 }), /twelve-minute/);
  let at = START; const adapter = await openComparisonAuditState({ ...env.options, now: () => at });
  at += 720_000;
  await assert.rejects(adapter.consumeReceipt({ previousReceipt: empty(), receipt: consumed() }), /twelve-minute/);
  let backwards = START + 1; const other = await openComparisonAuditState({ ...env.options, now: () => backwards }); backwards--;
  await assert.rejects(other.readReceipt(), /regressed/);
  assert.deepEqual((await env.read())[FIELD], empty());
});

test('restore/publication merge keeps all consumed IDs without inventing a ledger or changing clocks', () => {
  assert.equal(mergeComparisonAuditReceipts(undefined, undefined), undefined);
  const first = consumed(), second = consumed('another-fixture-id');
  const merged = mergeComparisonAuditReceipts(undefined, first, second, first);
  assert.equal(merged.revision, 2); assert.equal(merged.consumed.length, 2);
  assert.deepEqual(merged.consumed.find(row => row.requestId === first.consumed[0].requestId), first.consumed[0]);
  assert.throws(() => mergeComparisonAuditReceipts(null, first), /Missing or corrupt/);
  assert.throws(() => mergeComparisonAuditReceipts(first, consumed(undefined, { runId: '124' })), /Conflicting/);
  assert.deepEqual(validateComparisonAuditReceipt(merged), merged);
});


test('two concurrent adapters cannot both consume the same original encrypted state', async t => {
  const env = await setup(t);
  const first = await openComparisonAuditState(env.options), second = await openComparisonAuditState(env.options);
  const claims = await Promise.all([first, second].map(adapter => claimComparisonAudit({ ...claimOptions(adapter.receipt), consumeReceipt: adapter.consumeReceipt })));
  assert.equal(claims.filter(claim => claim.active).length, 1);
  assert.deepEqual((await env.read())[FIELD], consumed());
  assert.deepEqual((await fs.readdir(path.dirname(env.filename))).sort(), ['latest.json.enc']);
});


test('missing ledger migration requires separately trusted pre-feature publication SHA allowlist', async t => {
  const env = await setup(t, withoutLedger(source())); const original = await fs.readFile(env.filename);
  for (const legacyStateCodeShas of [undefined, [], ['bad'], [SHA], ['b'.repeat(40), 'b'.repeat(40)]]) {
    await assert.rejects(prepareComparisonAuditState({ ...env.options, activation: { enabled: false }, legacyStateCodeShas }), /trusted pre-feature/);
    assert.deepEqual(await fs.readFile(env.filename), original);
  }
  const changed = withoutLedger(source()); changed.scanMeta.codeSha = 'c'.repeat(40); await env.write(changed);
  await assert.rejects(prepareComparisonAuditState({ ...env.options, activation: { enabled: false }, legacyStateCodeShas: ['b'.repeat(40)] }), /trusted pre-feature/);
  await env.write(source(consumed()));
  const existing = await prepareComparisonAuditState({ ...env.options, activation: { enabled: false } });
  assert.equal(existing.migrated, false); assert.deepEqual(existing.receipt, consumed());
});
