import { setTimeout as delay } from 'node:timers/promises';

// Only explicit HTTP responses can authorize replay of the non-idempotent POST.
// No SHA fallback: several different artifacts can be published by one commit.
const CREATE_RETRY = new Set([500, 502, 503, 504]);
const FINAL_STATUS = new Set(['deployment_failed', 'deployment_perms_error', 'deployment_content_failed', 'deployment_cancelled', 'deployment_lost']);
export const PAGES_LIMITS = Object.freeze({ createBudgetMs: 180_000, requestMs: 30_000, pollBudgetMs: 600_000, pollIntervalMs: 5_000, pollErrors: 10 });
const problem = (stage, reason, status) => Object.assign(new Error(`Pages ${stage}: ${reason}${status ? ` (HTTP ${status})` : ''}.`), { stage, reason, status });
const httpStatus = error => Number(error?.response?.status) || 0;
const validId = value => /^(?:[a-zA-Z0-9_-]+)$/.test(String(value ?? '')) ? String(value) : '';

function deploymentId(data, { owner, repo, apiUrl }) {
  const id = validId(data?.id);
  let fromUrl = '';
  if (data?.status_url) {
    try {
      const url = new URL(data.status_url), base = new URL(apiUrl);
      const prefix = `${base.pathname.replace(/\/$/, '')}/repos/${owner}/${repo}/pages/deployments/`;
      if (url.origin !== base.origin || !url.pathname.startsWith(prefix) || url.search || url.hash || url.username || url.password) throw Error();
      fromUrl = validId(url.pathname.slice(prefix.length).replace(/\/status$/, ''));
      if (!fromUrl || (id && id !== fromUrl)) throw Error();
    } catch { throw problem('create', 'invalid deployment identity'); }
  }
  return id || fromUrl;
}

function retryAfterMs(headers, now) {
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (raw === undefined) return 0;
  const value = String(raw).trim();
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  // An unparseable server delay is not permission to retry earlier.
  return Number.isFinite(date) ? Math.max(0, date - now) : Infinity;
}

async function bounded(operation, timeoutMs, signal) {
  const controller = new AbortController();
  let timer, onAbort;
  const stopped = new Promise((_, reject) => {
    onAbort = () => { controller.abort(); reject(problem('request', 'cancelled')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    timer = setTimeout(() => { controller.abort(); reject(problem('request', 'response unknown after timeout')); }, timeoutMs);
  });
  try { return await Promise.race([stopped, Promise.resolve().then(() => { if (controller.signal.aborted) throw problem('request', 'cancelled'); return operation(controller.signal); })]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}

// request/getIDToken are supplied by official actions/github-script. No tokens,
// raw exceptions, response bodies, request objects or arbitrary status text log.
export async function deployPages({
  request, getIDToken, owner, repo, artifactId, buildVersion, apiUrl = 'https://api.github.com',
  signal, now = Date.now, sleep = (ms, abortSignal) => delay(ms, undefined, { signal: abortSignal }),
  info = () => {}, warning = () => {}, limits = PAGES_LIMITS,
}) {
  const artifact = Number(artifactId);
  if (!Number.isSafeInteger(artifact) || artifact <= 0) throw problem('input', 'missing uploaded artifact ID');
  if (!/^[\w.-]+$/.test(owner || '') || !/^[\w.-]+$/.test(repo || '') || !/^[a-f0-9]{40}$/i.test(buildVersion || '')) throw problem('input', 'invalid repository or build identity');
  const createDeadline = now() + limits.createBudgetMs;
  let created = null, id = '', pending = false;
  const invoke = (method, params, deadline, abortSignal = signal) => {
    const remaining = deadline - now();
    if (remaining <= 0) throw problem('request', 'time budget exhausted');
    return bounded(innerSignal => request(method, { owner, repo, ...params, request: { signal: innerSignal, retries: 0 } }), Math.min(limits.requestMs, remaining), abortSignal);
  };
  const wait = async ms => {
    if (signal?.aborted) throw problem('request', 'cancelled');
    try { await sleep(ms, signal); }
    catch { throw problem('request', 'cancelled'); }
    if (signal?.aborted) throw problem('request', 'cancelled');
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (signal?.aborted) throw problem('create', 'cancelled');
    let token;
    try {
      const remaining = createDeadline - now();
      if (remaining <= 0) throw Error();
      token = await bounded(() => getIDToken(), Math.min(limits.requestMs, remaining), signal);
      if (!token) throw Error();
    } catch { throw problem('authentication', 'OIDC token unavailable'); }
    let failure;
    try {
      const response = await invoke('POST /repos/{owner}/{repo}/pages/deployments', { artifact_id: artifact, pages_build_version: buildVersion, oidc_token: token }, createDeadline);
      created = response?.data;
      id = deploymentId(created, { owner, repo, apiUrl });
      if (!id) throw problem('create', 'response did not identify deployment');
      break;
    } catch (error) {
      // Even an error response may identify an accepted deployment. Never POST
      // again once GitHub has returned its identity.
      const known = error?.response?.data;
      const knownId = deploymentId(known, { owner, repo, apiUrl });
      if (knownId) { id = knownId; created = known; break; }
      const status = httpStatus(error);
      if (!CREATE_RETRY.has(status)) throw problem('create', status ? 'request rejected' : 'response unknown; not retried', status);
      if (attempt === 3) throw problem('create', 'three attempts exhausted', status);
      failure = { status, headers: error.response.headers };
    }
    const pause = Math.max(attempt === 1 ? 15_000 : 45_000, retryAfterMs(failure.headers, now()));
    if (!Number.isFinite(pause) || pause >= createDeadline - now()) throw problem('create', 'retry delay exceeds time budget', failure.status);
    warning(`Pages create: HTTP ${failure.status}; retry ${attempt + 1}/3 in ${Math.ceil(pause / 1000)}s.`);
    await wait(pause);
  }
  pending = true;
  const pollDeadline = now() + limits.pollBudgetMs;
  let errors = 0;
  try {
    while (now() < pollDeadline) {
      await wait(Math.min(limits.pollIntervalMs, pollDeadline - now()));
      if (now() >= pollDeadline) break;
      let response;
      try {
        response = await invoke('GET /repos/{owner}/{repo}/pages/deployments/{deploymentId}', { deploymentId: id }, pollDeadline);
      } catch (error) {
        const status = httpStatus(error);
        if (signal?.aborted || [400, 401, 403, 422].includes(status)) throw problem('status', 'request rejected or cancelled', status);
        if (++errors >= limits.pollErrors) throw problem('status', 'error limit reached', status);
        warning(`Pages status: temporary request failure${status ? ` (HTTP ${status})` : ''}.`);
        continue;
      }
      const status = response?.data?.status;
      if (status === 'succeed') {
        pending = false;
        info('Pages deployment confirmed.');
        return { deploymentId: id, pageUrl: String(created?.page_url || ''), status: 'succeed' };
      }
      if (FINAL_STATUS.has(status)) { pending = false; throw problem('deployment', status); }
      // GitHub retries deployment_attempt_error internally. Poll this ID only.
    }
    throw problem('status', 'time budget exhausted');
  } finally {
    if (pending) {
      // Match deploy-pages' bounded failure cleanup, but only for this response's
      // exact ID. Never cancel by SHA or cancel an unknown/other deployment.
      try {
        await invoke('POST /repos/{owner}/{repo}/pages/deployments/{deploymentId}/cancel', { deploymentId: id }, now() + Math.min(limits.requestMs, 10_000), null);
      } catch { warning('Pages cancellation: could not confirm cancellation of this deployment.'); }
    }
  }
}
