import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureImageFingerprintCache, imageFingerprints } from '../scripts/lib/image.mjs';

const url = 'https://fixture.test/image?private=never-record';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';
const bytes = Buffer.byteLength(svg);
const response = (headers = {}) => new Response(svg, { headers });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const bounded = observeImageTransfer => ({ signal: new AbortController().signal, observeImageTransfer });
async function fixture(fetcher, run, settings = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher; configureImageFingerprintCache(settings);
  try { await run(); } finally { globalThis.fetch = original; configureImageFingerprintCache(); }
}
async function directoryFixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'image-transfer-test-'));
  try { await run(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
function checkObservation(value, expected) {
  assert.deepEqual(Object.keys(value).sort(), ['bytes', 'durationMs', 'fetches', 'httpStatus']);
  assert.equal(value.fetches, 1);
  assert.equal(value.bytes, expected.bytes);
  assert.equal(value.httpStatus, expected.httpStatus);
  assert.ok(Number.isSafeInteger(value.durationMs) && value.durationMs >= 0);
  assert.ok(Object.isFrozen(value));
  assert.doesNotMatch(JSON.stringify(value), /private|fixture|secret|retry-after/);
}

test('image transfer observes completed decoded body bytes rather than content length', async () => {
  const events = []; let reads = 0;
  await fixture(async () => { reads++; return response({ 'content-length': '7', 'content-encoding': 'gzip', 'secret-header': 'private' }); }, async () => {
    assert.ok((await imageFingerprints(url, bounded(event => events.push(event))))?.contentSha256);
    assert.equal(reads, 1); assert.equal(events.length, 1);
    checkObservation(events[0], { bytes, httpStatus: 200 });
  });
});

test('HTTP 500 retry observes both actual attempts without reading discarded error bodies', async () => {
  const events = []; let reads = 0, errorBodyReads = 0;
  await fixture(async () => {
    reads++;
    if (reads === 1) return { status: 500, ok: false, headers: new Headers(), arrayBuffer: async () => { errorBodyReads++; return Buffer.from('private'); } };
    return response();
  }, async () => {
    assert.ok(await imageFingerprints(url, bounded(event => events.push(event))));
    assert.equal(reads, 2); assert.equal(errorBodyReads, 0); assert.equal(events.length, 2);
    checkObservation(events[0], { bytes: 0, httpStatus: 500 });
    checkObservation(events[1], { bytes, httpStatus: 200 });
  });
});

test('exhausted HTTP retries each count once even when no image is returned', async () => {
  const events = []; let reads = 0;
  await fixture(async () => { reads++; return new Response('private error', { status: 500 }); }, async () => {
    assert.equal(await imageFingerprints(url, bounded(event => events.push(event))), null);
    assert.equal(reads, 2); assert.equal(events.length, 2);
    events.forEach(event => checkObservation(event, { bytes: 0, httpStatus: 500 }));
  });
});

test('audit access denials reject once with bounded status and Retry-After', async () => {
  for (const [status, header, retryAfter] of [
    [401, '120', '120'], [403, 'Wed, 21 Oct 2015 07:28:00 GMT (private comment)', 'Wed, 21 Oct 2015 07:28:00 GMT'],
    [429, 'private arbitrary data', null], [429, '12345678901', null],
  ]) {
    const events = []; let reads = 0;
    await fixture(async () => { reads++; return new Response('private body', { status, headers: { 'retry-after': header } }); }, async () => {
      await assert.rejects(imageFingerprints(url, { ...bounded(event => events.push(event)), stopOnAccessDenial: true }), error => {
        assert.equal(error.auditReason, 'source_denied'); assert.equal(error.httpStatus, status); assert.equal(error.retryAfter, retryAfter);
        assert.deepEqual(Object.keys(error).sort(), ['auditReason', 'httpStatus', 'retryAfter']);
        assert.doesNotMatch(JSON.stringify(error), /private|fixture/); return true;
      });
      assert.equal(reads, 1); assert.equal(events.length, 1);
      checkObservation(events[0], { bytes: 0, httpStatus: status });
    });
  }
});

test('default denial behavior remains null with one attempt', async () => {
  for (const status of [401, 403, 429]) {
    const events = []; let reads = 0;
    await fixture(async () => { reads++; return new Response('', { status }); }, async () => {
      assert.equal(await imageFingerprints(url, bounded(event => events.push(event))), null);
      assert.equal(reads, 1); assert.equal(events.length, 1);
      checkObservation(events[0], { bytes: 0, httpStatus: status });
    });
  }
});

test('expired and already-aborted calls produce zero transport and no observation', async () => {
  const events = []; let reads = 0;
  await fixture(async () => { reads++; return response(); }, async () => {
    const controller = new AbortController(); controller.abort();
    for (const options of [{ signal: controller.signal }, { deadlineAt: 10, now: () => 10 }]) {
      assert.equal(await imageFingerprints(url, { ...options, observeImageTransfer: event => events.push(event) }), null);
    }
    assert.equal(reads, 0); assert.deepEqual(events, []);
  });
});

test('network failures and unreadable bodies report actual attempts without invented bytes', async () => {
  for (const phase of ['fetch', 'body']) {
    const events = []; let reads = 0;
    await fixture(async () => {
      reads++;
      if (phase === 'fetch') throw new Error('private network failure');
      return { status: 200, ok: true, headers: new Headers({ 'content-length': '999' }), arrayBuffer: async () => { throw new Error('private partial body failure'); } };
    }, async () => {
      assert.equal(await imageFingerprints(url, bounded(event => events.push(event))), null);
      assert.equal(reads, 2); assert.equal(events.length, 2);
      events.forEach(event => checkObservation(event, { bytes: 0, httpStatus: phase === 'fetch' ? null : 200 }));
    });
  }
});

test('completed bodies still count if length validation or decoding fails', async () => {
  for (const headers of [{ 'content-length': '999' }, {}]) {
    const events = [];
    await fixture(async () => new Response('invalid image bytes', { headers }), async () => {
      assert.equal(await imageFingerprints(url, bounded(event => events.push(event))), null);
      assert.equal(events.length, 1);
      checkObservation(events[0], { bytes: Buffer.byteLength('invalid image bytes'), httpStatus: 200 });
    });
  }
});

test('observer exceptions fail closed without retrying transport or publishing a cache entry', () => directoryFixture(async directory => {
  for (const status of [200, 500]) {
    let reads = 0, observations = 0;
    await fixture(async () => { reads++; return status === 200 ? response({ 'cache-control': 'public, max-age=60' }) : new Response('', { status }); }, async () => {
      await assert.rejects(imageFingerprints(url, bounded(() => { observations++; throw new Error('private observer failure'); })), error => {
        assert.equal(error.auditReason, 'image_transfer_observation_failed'); assert.doesNotMatch(String(error), /private/); return true;
      });
      assert.equal(reads, 1); assert.equal(observations, 1); assert.deepEqual(await fs.readdir(directory), []);
    }, { directory });
  }
}));

test('async observers are consumed and rejected without retrying even when their promise rejects', async () => {
  for (const observer of [async () => {}, async () => { throw new Error('private async failure'); }, () => ({ then: (_resolve, reject) => reject(new Error('private thenable failure')) })]) {
    for (const status of [200, 500]) {
      let reads = 0;
      await fixture(async () => { reads++; return status === 200 ? response() : new Response('', { status }); }, async () => {
        await assert.rejects(imageFingerprints(url, bounded(observer)), { auditReason: 'image_transfer_observation_failed' });
        await flush(); assert.equal(reads, 1);
      });
    }
  }
});

test('source denial remains terminal if its observer also fails', async () => {
  let reads = 0;
  await fixture(async () => { reads++; return new Response('', { status: 403 }); }, async () => {
    await assert.rejects(imageFingerprints(url, { ...bounded(async () => { throw new Error('private'); }), stopOnAccessDenial: true }), { auditReason: 'source_denied', httpStatus: 403 });
    await flush(); assert.equal(reads, 1);
  });
});

test('fresh process and disk cache hits add no transport observation', () => directoryFixture(async directory => {
  for (const mode of ['process', 'disk']) {
    let reads = 0; const events = [];
    await fixture(async () => { reads++; return response({ 'cache-control': 'public, max-age=60' }); }, async () => {
      const first = await imageFingerprints(url, mode === 'disk' ? bounded(event => events.push(event)) : undefined);
      assert.ok(first); assert.equal(reads, 1);
      if (mode === 'disk') configureImageFingerprintCache({ directory, now: () => 1000 });
      const before = events.length;
      const second = await imageFingerprints(url, bounded(event => events.push(event)));
      assert.ok(second); assert.equal(second.imageObservedAt, first.imageObservedAt);
      assert.equal(reads, 1); assert.equal(events.length, before);
    }, { ...(mode === 'disk' ? { directory } : {}), now: () => 1000 });
  }
}));

test('options without a deadline or signal retain the existing unbounded wrapper behavior', async () => {
  let reads = 0, observations = 0;
  await fixture(async () => { reads++; return new Response('', { status: 403 }); }, async () => {
    assert.equal(await imageFingerprints(url, { stopOnAccessDenial: true, observeImageTransfer: () => { observations++; } }), null);
    assert.equal(reads, 1); assert.equal(observations, 0);
  });
});

for (const phase of ['fetch', 'body', 'failure']) {
  test(`late ${phase} settlement is observed after cancellation without claiming settled totals early`, () => directoryFixture(async directory => {
    const entered = deferred(), late = deferred(), observed = deferred(), events = [], controller = new AbortController();
    let reads = 0, bodyReads = 0;
    await fixture(async () => {
      reads++;
      if (phase !== 'body') { entered.resolve(); return late.promise; }
      return { status: 200, ok: true, headers: new Headers({ 'cache-control': 'public, max-age=60' }), arrayBuffer: () => { bodyReads++; entered.resolve(); return late.promise; } };
    }, async () => {
      const pending = imageFingerprints(url, { signal: controller.signal, observeImageTransfer: event => { events.push(event); observed.resolve(); } });
      await entered.promise; controller.abort();
      assert.equal(await pending, null); assert.equal(events.length, 0);
      if (phase === 'failure') late.reject(new Error('private late failure'));
      else if (phase === 'body') late.resolve(Buffer.from(svg));
      else late.resolve({ status: 200, ok: true, headers: new Headers(), arrayBuffer: async () => { bodyReads++; return Buffer.from(svg); } });
      await observed.promise; await flush();
      assert.equal(reads, 1); assert.equal(events.length, 1); assert.equal(bodyReads, phase === 'body' ? 1 : 0);
      checkObservation(events[0], { bytes: phase === 'body' ? bytes : 0, httpStatus: phase === 'failure' ? null : 200 });
      assert.deepEqual(await fs.readdir(directory), []);
    }, { directory });
  }));
}

test('late observer failure is consumed by the bounded loader and never retries', async () => {
  const entered = deferred(), late = deferred(), observed = deferred(), controller = new AbortController(); let reads = 0;
  await fixture(async () => { reads++; entered.resolve(); return late.promise; }, async () => {
    const pending = imageFingerprints(url, { signal: controller.signal, observeImageTransfer: async () => { observed.resolve(); throw new Error('private late observer failure'); } });
    await entered.promise; controller.abort(); assert.equal(await pending, null);
    late.resolve(response()); await observed.promise; await flush(); assert.equal(reads, 1);
  });
});

// Audit transport accounting cannot include hidden redirect hops or retries.
test('audit image transport uses one manual request for redirects and server failures', async () => {
  for (const status of [302, 500]) {
    let reads=0; const events=[];
    await fixture(async (_url,options) => {
      reads++; assert.equal(options.redirect,'manual');
      return new Response('',{status,headers:{location:'https://not-followed.invalid/image.jpg'}});
    }, async () => {
      assert.equal(await imageFingerprints(url,{...bounded(event=>events.push(event)),auditTransport:true,stopOnAccessDenial:true}),null);
      assert.equal(reads,1);assert.equal(events.length,1);checkObservation(events[0],{bytes:0,httpStatus:status});
    });
  }
});

test('start observation precedes fetch and remains visible while a canceled transfer is unsettled', async () => {
  const entered=deferred(),late=deferred(),controller=new AbortController();let starts=0;const completed=[];
  await fixture(async ()=>{assert.equal(starts,1);entered.resolve();return late.promise;},async()=>{
    const pending=imageFingerprints(url,{signal:controller.signal,observeImageTransferStart:()=>{starts++;},observeImageTransfer:event=>completed.push(event)});
    await entered.promise;controller.abort();assert.equal(await pending,null);assert.equal(starts,1);assert.equal(completed.length,0);
    late.resolve(response());await flush();assert.equal(completed.length,1);assert.equal(starts,1);
  });
});
test('a failing start observer stops before source transport without retry',async()=>{
  let reads=0;await fixture(async()=>{reads++;return response();},async()=>{
    await assert.rejects(imageFingerprints(url,{...bounded(()=>{}),observeImageTransferStart:()=>{throw Error('private');}}),{auditReason:'image_transfer_observation_failed'});
    assert.equal(reads,0);
  });
});
