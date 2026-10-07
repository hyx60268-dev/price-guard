import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { deployPages, PAGES_LIMITS } from '../scripts/lib/pages-deployment.mjs';

const sha = 'a'.repeat(40);
const created = { data: { id: 456, status_url: 'https://api.github.com/repos/owner/repo/pages/deployments/456', page_url: 'https://owner.github.io/repo/' } };
const success = { data: { status: 'succeed' } };
const httpError = (status, headers = {}, data = {}) => Object.assign(new Error('SECRET_TOKEN_AND_PAYLOAD'), { status, request: { token: 'secret' }, response: { status, headers, data } });
function harness(sequence, overrides = {}) {
  let time = 0;
  const calls = [], waits = [], logs = [];
  const inputs = {
    owner: 'owner', repo: 'repo', artifactId: '123', buildVersion: sha,
    getIDToken: async () => 'TOP_SECRET',
    now: () => time,
    sleep: async ms => { waits.push(ms); time += ms; },
    warning: text => logs.push(text), info: text => logs.push(text),
    request: async (route, params) => {
      calls.push({ route, params });
      const next = sequence.shift();
      if (typeof next === 'function') return next(route, params);
      if (next instanceof Error) throw next;
      assert.ok(next, 'unexpected request');
      return next;
    },
    ...overrides,
  };
  return { inputs, calls, waits, logs, run: () => deployPages(inputs), advance: ms => { time += ms; } };
}
const creates = h => h.calls.filter(x => x.route === 'POST /repos/{owner}/{repo}/pages/deployments');
const polls = h => h.calls.filter(x => x.route.startsWith('GET '));
const cancels = h => h.calls.filter(x => x.route.endsWith('/cancel'));

test('explicit create 500 retries the same uploaded artifact and polls only the returned ID', async () => {
  const h = harness([httpError(500), created, success]);
  assert.deepEqual(await h.run(), { deploymentId: '456', pageUrl: created.data.page_url, status: 'succeed' });
  assert.deepEqual(h.waits, [15_000, 5_000]);
  assert.equal(creates(h).length, 2);
  assert.deepEqual(creates(h).map(x => x.params.artifact_id), [123, 123]);
  assert.equal(polls(h)[0].params.deploymentId, '456');
  assert.equal(h.calls.every(x => x.params.request.retries === 0), true);
  assert.equal(cancels(h).length, 0);
  assert.doesNotMatch(h.logs.join(' '), /SECRET|PAYLOAD|oidc_token/);
});

test('500/502/503/504 are finite: exactly three creates and 15/45 second backoff', async () => {
  for (const status of [500, 502, 503, 504]) {
    const h = harness([httpError(status), httpError(status), httpError(status)]);
    await assert.rejects(h.run(), error => error.reason === 'three attempts exhausted' && error.status === status);
    assert.equal(creates(h).length, 3);
    assert.deepEqual(h.waits, [15_000, 45_000]);
    assert.equal(cancels(h).length, 0);
  }
});

test('authentication, permission, missing artifact, validation and other HTTP failures never retry', async () => {
  for (const status of [400, 401, 403, 404, 409, 422, 429, 501]) {
    const h = harness([httpError(status)]);
    await assert.rejects(h.run(), error => error.status === status && !error.message.includes('SECRET'));
    assert.equal(creates(h).length, 1);
    assert.deepEqual(h.waits, []);
    assert.equal(cancels(h).length, 0);
  }
});

test('connection loss and synthetic status 500 without an HTTP response never replay create', async () => {
  for (const error of [new Error('socket reset SECRET'), Object.assign(new Error('fetch failed SECRET'), { status: 500 })]) {
    const h = harness([error]);
    await assert.rejects(h.run(), /response unknown; not retried/);
    assert.equal(creates(h).length, 1);
    assert.equal(h.calls.length, 1);
  }
});

test('create response timeout aborts the request and never retries or cancels unknown deployment', async () => {
  let requestSignal;
  const h = harness([(_route, params) => { requestSignal = params.request.signal; return new Promise(() => {}); }], { limits: { ...PAGES_LIMITS, requestMs: 15 } });
  await assert.rejects(h.run(), /response unknown; not retried/);
  assert.equal(requestSignal.aborted, true);
  assert.equal(h.calls.length, 1);
});

test('Retry-After seconds and dates delay longer, but never exceed the create budget', async () => {
  for (const header of ['70', new Date(70_000).toUTCString()]) {
    const h = harness([httpError(503, { 'retry-after': header }), created, success]);
    await h.run();
    assert.equal(h.waits[0], 70_000);
  }
  for (const header of ['181', 'invalid']) {
    const h = harness([httpError(503, { 'retry-after': header })]);
    await assert.rejects(h.run(), /retry delay exceeds time budget/);
    assert.equal(creates(h).length, 1);
    assert.deepEqual(h.waits, []);
  }
});

test('request time is included in the overall create retry budget', async () => {
  let h;
  h = harness([() => { h.advance(175_000); throw httpError(500); }]);
  await assert.rejects(h.run(), /retry delay exceeds time budget/);
  assert.equal(h.calls.length, 1);
});

test('unknown create response cannot fall back to a successful deployment for the same SHA', async () => {
  const h = harness([{ data: { page_url: created.data.page_url } }, success]);
  await assert.rejects(h.run(), /response unknown; not retried/);
  assert.equal(h.calls.length, 1);
  assert.equal(polls(h).length, 0);
});

test('a response with a status URL only is bound to that repository deployment', async () => {
  const h = harness([{ data: { ...created.data, id: undefined } }, success]);
  const result = await h.run();
  assert.equal(result.deploymentId, '456');
  assert.equal(polls(h)[0].params.deploymentId, '456');
  for (const status_url of ['https://evil.example/repos/owner/repo/pages/deployments/456', 'https://api.github.com/repos/other/repo/pages/deployments/456', 'https://api.github.com/repos/owner/repo/pages/deployments/999']) {
    const invalid = harness([{ data: { ...created.data, status_url } }]);
    await assert.rejects(invalid.run());
    assert.equal(invalid.calls.length, 1);
  }
});

test('an accepted deployment identity in an HTTP error response is polled without a second POST', async () => {
  const h = harness([httpError(500, {}, created.data), success]);
  await h.run();
  assert.equal(creates(h).length, 1);
  assert.equal(polls(h)[0].params.deploymentId, '456');
});

test('pending/temporary deployment statuses and read failures poll the same ID without re-creating', async () => {
  const h = harness([created, { data: { status: 'queued' } }, httpError(503), { data: { status: 'deployment_attempt_error' } }, success]);
  await h.run();
  assert.equal(creates(h).length, 1);
  assert.equal(polls(h).length, 4);
  assert.equal(polls(h).every(x => x.params.deploymentId === '456'), true);
});

test('terminal content/permission/cancel statuses fail immediately without retrying or cancelling', async () => {
  for (const status of ['deployment_failed', 'deployment_perms_error', 'deployment_content_failed', 'deployment_cancelled', 'deployment_lost']) {
    const h = harness([created, { data: { status } }]);
    await assert.rejects(h.run(), error => error.reason === status);
    assert.equal(h.calls.length, 2);
    assert.equal(cancels(h).length, 0);
  }
});

test('poll timeout cancels only this deployment and never posts another creation', async () => {
  const h = harness([created, { data: { status: 'queued' } }, { data: {} }], { limits: { ...PAGES_LIMITS, pollBudgetMs: 10_000 } });
  await assert.rejects(h.run(), /time budget exhausted/);
  assert.equal(cancels(h).length, 1);
  assert.equal(cancels(h)[0].params.deploymentId, '456');
  assert.equal(creates(h).length, 1);
});

test('poll authentication error fails and cancels only the already known deployment', async () => {
  const h = harness([created, httpError(403), { data: {} }]);
  await assert.rejects(h.run(), error => error.status === 403);
  assert.equal(cancels(h).length, 1);
  assert.equal(creates(h).length, 1);
});

test('OIDC failure cannot leak its exception or make a create request', async () => {
  const h = harness([], { getIDToken: async () => { throw Error('SECRET_TOKEN'); } });
  await assert.rejects(h.run(), error => error.stage === 'authentication' && !error.message.includes('SECRET'));
  assert.equal(h.calls.length, 0);
});

test('invalid or missing upload identity cannot choose a default or historical artifact', async () => {
  for (const artifactId of ['', undefined, 0, -1, 'invalid']) {
    const h = harness([], { artifactId });
    await assert.rejects(h.run(), /missing uploaded artifact ID/);
    assert.equal(h.calls.length, 0);
  }
});

test('cancellation before creation makes no network request', async () => {
  const controller = new AbortController();
  controller.abort();
  const h = harness([], { signal: controller.signal });
  await assert.rejects(h.run(), /cancelled/);
  assert.equal(h.calls.length, 0);
});

test('cancellation after create cancels this exact ID with an independent bounded request', async () => {
  const controller = new AbortController();
  const h = harness([created, { data: {} }], { signal: controller.signal, sleep: async () => { controller.abort(); } });
  await assert.rejects(h.run(), /cancelled/);
  assert.equal(creates(h).length, 1);
  assert.equal(cancels(h).length, 1);
  assert.equal(cancels(h)[0].params.deploymentId, '456');
  assert.equal(cancels(h)[0].params.request.signal.aborted, false);
});

test('cancellation with unknown POST outcome never retries or cancels by SHA', async () => {
  const controller = new AbortController();
  const h = harness([() => { controller.abort(); return new Promise(() => {}); }], { signal: controller.signal });
  await assert.rejects(h.run(), /response unknown; not retried/);
  assert.equal(h.calls.length, 1);
});

test('ten read errors fail without repeating create and without leaking response bodies', async () => {
  const h = harness([created, ...Array.from({ length: 10 }, () => httpError(503, {}, { message: 'SECRET_BODY' })), httpError(500)]);
  await assert.rejects(h.run(), /error limit reached/);
  assert.equal(creates(h).length, 1);
  assert.equal(polls(h).length, 10);
  assert.equal(cancels(h).length, 1);
  assert.doesNotMatch(h.logs.join(' '), /SECRET|BODY|PAYLOAD|oidc_token/);
});

test('separate artifacts for the same commit each require their own returned deployment success', async () => {
  const quick = harness([created, success], { artifactId: '123' });
  const prices = harness([{ data: { id: 789, page_url: created.data.page_url } }, success], { artifactId: '124' });
  await quick.run();
  await prices.run();
  assert.equal(creates(quick)[0].params.pages_build_version, creates(prices)[0].params.pages_build_version);
  assert.equal(creates(prices)[0].params.artifact_id, 124);
  assert.equal(polls(prices)[0].params.deploymentId, '789');
  assert.notEqual(polls(prices)[0].params.deploymentId, sha);
});

test('all six publication stages bind their own upload output and preserve environment output IDs', async () => {
  let total = 0;
  for (const name of ['price-guard', 'cloud-sync', 'dashboard-repair', 'merchant-monitor']) {
    const source = await fs.readFile(new URL('../.github/workflows/' + name + '.yml', import.meta.url), 'utf8');
    const steps = source.split(/\r?\n      - /);
    const uploads = new Set();
    for (const step of steps) {
      if (step.includes('uses: actions/upload-pages-artifact@v3')) {
        const id = step.match(/^        id: ([\w-]+)$/m)?.[1];
        assert.ok(id);
        assert.equal(uploads.has(id), false);
        uploads.add(id);
      }
      if (step.includes('uses: ./.github/actions/deploy-pages-retry')) {
        const bound = step.match(/artifact_id: \$\{\{ steps\.([\w-]+)\.outputs\.artifact_id \}\}/)?.[1];
        assert.ok(uploads.has(bound), 'publish must use a preceding upload from this stage');
        uploads.delete(bound);
        assert.doesNotMatch(step, /continue-on-error:/);
        total++;
      }
    }
    assert.equal(uploads.size, 0);
    assert.doesNotMatch(source, /uses: actions\/deploy-pages@/);
    assert.match(source, /pages: write/);
    assert.match(source, /id-token: write/);
    assert.match(source, /group: pages/);
    assert.match(source, /cancel-in-progress: false/);
    assert.match(source, /name: github-pages/);
    const outputId = name === 'merchant-monitor' ? 'deploy' : 'deployment';
    assert.ok(source.includes('url: ${{ steps.' + outputId + '.outputs.page_url }}'));
    assert.ok(source.includes('id: ' + outputId));
  }
  assert.equal(total, 6);
  const action = await fs.readFile(new URL('../.github/actions/deploy-pages-retry/action.yml', import.meta.url), 'utf8');
  assert.match(action, /retries: 0/);
  assert.match(action, /debug: false/);
  assert.match(action, /core.getIDToken\(\)/);
  assert.match(action, /actions\/github-script@[a-f0-9]{40}/);
  assert.match(action, /value: \$\{\{ steps.publish.outputs.page_url \}\}/);
  assert.ok(action.indexOf("core.setOutput('page_url'") > action.indexOf('await deployPages('));
});

test('official Pages create response with /status suffix supports explicit ID and status URL identity', async () => {
  // Shape from GitHub REST Pages create-deployment documentation. The returned
  // ID may itself be a SHA; it is accepted only when actually returned by POST.
  const id = '4fd754f7e594640989b406850d0bc8f06a121251';
  const official = { id, status_url: 'https://api.github.com/repos/owner/repo/pages/deployments/' + id + '/status', page_url: 'owner.github.io' };
  for (const data of [official, { ...official, id: undefined }]) {
    const h = harness([{ data }, success]);
    const result = await h.run();
    assert.equal(result.deploymentId, id);
    assert.equal(result.pageUrl, 'owner.github.io');
    assert.equal(polls(h)[0].route, 'GET /repos/{owner}/{repo}/pages/deployments/{deploymentId}');
    assert.equal(polls(h)[0].params.deploymentId, id);
    assert.equal(creates(h).length, 1);
  }
  for (const status_url of [
    'https://api.github.com/repos/other/repo/pages/deployments/' + id + '/status',
    'https://api.github.com/repos/owner/other/pages/deployments/' + id + '/status',
    'https://api.github.com/repos/owner/repo/pages/deployments/999/status',
    'https://api.github.com/repos/owner/repo/pages/deployments/' + id + '/status/status',
  ]) {
    const h = harness([{ data: { ...official, status_url } }]);
    await assert.rejects(h.run());
    assert.equal(h.calls.length, 1);
    assert.equal(polls(h).length, 0);
    assert.equal(cancels(h).length, 0);
  }
});

test('a /status-only response without an ID must still be from this repository', async () => {
  const h = harness([{ data: { status_url: 'https://api.github.com/repos/other/repo/pages/deployments/456/status' } }]);
  await assert.rejects(h.run());
  assert.equal(h.calls.length, 1);
});
