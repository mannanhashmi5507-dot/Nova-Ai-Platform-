'use strict';

/**
 * UACL Worker Agent
 *
 * Runs on a compute machine (GPU/TPU/NPU/CPU) and turns it into a UACL worker.
 * It only accepts structured workloads and hands them to handlers supplied by the
 * host application; it never executes shell commands from a job.
 *
 * Behaviour guarantees:
 *  - runs at most `maxConcurrentJobs` (default 1) jobs at a time, even if polls overlap
 *  - re-registers itself if the broker lost its state (broker restart)
 *  - reports results with retries; a failed *report* is never turned into a job failure
 *  - aborts a running handler when the job is cancelled or times out (handler gets `{ signal }`)
 *  - refuses to send credentials over plain http except to localhost
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

class UaclRequestError extends Error {
  constructor(status, message) { super(`UACL ${status}: ${message}`); this.status = status; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function createUaclWorkerAgent({
  baseUrl,
  workerId,
  workerKey = '',
  capabilities = {},
  provider = 'self-hosted',
  region = 'unknown',
  pricePerHour = 0,
  preemptible = false,
  metadata = {},
  handlers = {},
  fetchImpl = global.fetch,
  heartbeatMs = 15000,
  pollMs = 2000,
  jobTimeoutMs = 30 * 60 * 1000,
  maxConcurrentJobs = 1,
  reportRetries = 3,
  reportBackoffMs = 500,
  allowInsecureHttp = false,
  drainMs = 30000,
} = {}) {
  if (!baseUrl) throw new Error('UACL worker baseUrl is required');
  if (!workerId) throw new Error('UACL workerId is required');
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');

  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'https:' && !LOCAL_HOSTS.has(parsed.hostname) && !allowInsecureHttp) {
    throw new Error('UACL baseUrl must use https (credentials are sent with every request)');
  }
  const base = String(baseUrl).replace(/\/$/, '');
  const limit = Math.max(1, Math.floor(maxConcurrentJobs));

  let credential = '';            // per-worker token issued by the broker at registration
  let stopped = false;
  let heartbeatTimer = null;
  let pollTimer = null;
  const inflight = new Map();     // jobId -> AbortController

  async function request(path, { method = 'POST', body, auth = 'token' } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth === 'enroll' && workerKey) headers['x-victus-worker-key'] = workerKey;
    if (auth === 'token' && credential) headers['x-victus-worker-token'] = credential;
    if (auth === 'enroll' && credential) headers['x-victus-worker-token'] = credential; // lets an owner re-register
    const res = await fetchImpl(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new UaclRequestError(res.status ?? 500, data.error || 'request failed');
    return data;
  }
  const wpath = suffix => `/api/victus/cloud/workers/${encodeURIComponent(workerId)}${suffix}`;

  async function register() {
    const data = await request('/api/victus/cloud/workers/register', {
      auth: 'enroll',
      body: { workerId, provider, region, pricePerHour, preemptible, capabilities: { maxConcurrentJobs: limit, ...capabilities }, metadata },
    });
    if (data.credential) credential = data.credential;
    return data;
  }

  async function heartbeat() {
    let data;
    try {
      data = await request(wpath('/heartbeat'));
    } catch (err) {
      if (err.status === 404) { await register(); data = await request(wpath('/heartbeat')); } // broker lost its state
      else throw err;
    }
    for (const jobId of data.worker?.cancelJobIds || []) inflight.get(jobId)?.abort(new Error('job cancelled'));
    return data;
  }

  async function claim() {
    const data = await request(wpath('/claim'));
    return data.job || null;
  }

  // Reports are retried on network/5xx errors only. 4xx (e.g. 409 "job was cancelled") is final.
  async function report(kind, jobId, payload) {
    let lastErr;
    for (let i = 0; i < Math.max(1, reportRetries); i += 1) {
      try { return await request(wpath(`/jobs/${encodeURIComponent(jobId)}/${kind}`), { body: payload }); }
      catch (err) {
        lastErr = err;
        if (err.status && err.status < 500) throw err;
        if (i < reportRetries - 1) await sleep(reportBackoffMs * 2 ** i);
      }
    }
    throw lastErr;
  }
  const complete = (jobId, result, attempt) => report('complete', jobId, { result, ...(attempt != null ? { attempt } : {}) });
  const fail = (jobId, error, attempt) => report('fail', jobId, { error: String(error || 'Worker failure'), ...(attempt != null ? { attempt } : {}) });

  async function runJob(job) {
    const handler = handlers[job.workloadType];
    if (typeof handler !== 'function') {
      await fail(job.id, `No handler configured for workload type: ${job.workloadType}`, job.attempts).catch(() => {});
      return;
    }
    const controller = new AbortController();
    inflight.set(job.id, controller);
    const timer = setTimeout(() => controller.abort(new Error('job timed out')), Math.max(1000, jobTimeoutMs));
    timer.unref?.();
    let outcome;
    try {
      const result = await Promise.race([
        handler(job, { signal: controller.signal }),
        new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason || new Error('aborted')), { once: true })),
      ]);
      outcome = { ok: true, result };
    } catch (err) {
      outcome = { ok: false, error: err?.message || String(err) };
    } finally {
      clearTimeout(timer);
      inflight.delete(job.id);
    }
    // Reporting is separate from execution: a lost *report* must not be rewritten as a job failure.
    try {
      if (outcome.ok) await complete(job.id, outcome.result, job.attempts);
      else await fail(job.id, outcome.error, job.attempts);
    } catch { /* job was cancelled/reassigned (4xx) or the broker is unreachable; the broker will recover the job */ }
  }

  // `busy` reserves a slot synchronously, BEFORE the claim request is sent, so
  // overlapping polls can't all pass the capacity check and over-claim.
  let busy = 0;
  async function pollOnce() {
    if (stopped || busy >= limit) return null;
    busy += 1;
    try {
      const job = await claim();
      if (!job) return null;
      await runJob(job);
      return job;
    } finally {
      busy -= 1;
    }
  }

  async function start() {
    await register();
    await heartbeat();
    heartbeatTimer = setInterval(() => heartbeat().catch(() => {}), Math.max(5000, heartbeatMs));
    pollTimer = setInterval(() => pollOnce().catch(() => {}), Math.max(500, pollMs));
    return api;
  }

  // Stops taking new work, then waits (bounded) for running jobs to report.
  async function stop() {
    stopped = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (pollTimer) clearInterval(pollTimer);
    heartbeatTimer = null;
    pollTimer = null;
    const deadline = Date.now() + drainMs;
    while (inflight.size && Date.now() < deadline) await sleep(100);
    for (const c of inflight.values()) c.abort(new Error('worker stopping'));
  }

  const api = { register, heartbeat, claim, complete, fail, pollOnce, start, stop, get stopped() { return stopped; }, get running() { return inflight.size; } };
  return api;
}

module.exports = { createUaclWorkerAgent, UaclRequestError };
