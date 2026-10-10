'use strict';

// Universal AI Compute Layer: an in-memory scheduler/broker. Jobs are structured
// data, never commands. All state is lost on restart (documented in docs/UACL.md);
// workers re-register themselves and clients resubmit.
//
// Lifecycle:  queued → assigned → running → succeeded | failed | cancelled | expired
//             assigned/running → queued   (worker lost, bounded by maxAttempts)

const crypto = require('crypto');

const WORKLOAD_TYPES = new Set(['inference', 'training', 'evaluation', 'embedding']);
const JOB_STATES = new Set(['queued', 'assigned', 'running', 'succeeded', 'failed', 'cancelled', 'expired']);
const WORKER_STATES = new Set(['online', 'draining', 'offline']);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired']);
const ALLOWED_TRANSITIONS = {
  queued: ['assigned', 'cancelled', 'expired'],
  assigned: ['running', 'queued', 'failed', 'cancelled', 'expired'],
  running: ['succeeded', 'failed', 'cancelled', 'expired', 'queued'],
};
const WORKER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Upper bounds stop a hostile worker/client from skewing the scheduler with absurd numbers.
const CAPS = Object.freeze({ cpuCores: 4096, ramGb: 16384, storageGb: 1_000_000, acceleratorMemoryGb: 4096, maxConcurrentJobs: 64, pricePerHour: 10_000 });
const MAX_SPEC_BYTES = 256 * 1024;
const MAX_METADATA_BYTES = 8 * 1024;

class UaclError extends Error {
  constructor(message, code = 'INVALID_INPUT', status = 422) {
    super(message);
    this.name = 'UaclError';
    this.code = code;
    this.status = status;
  }
}
const E = {
  invalid: m => new UaclError(m, 'INVALID_INPUT', 422),
  unauthorized: (m = 'Invalid worker credentials') => new UaclError(m, 'UNAUTHORIZED', 401),
  forbidden: m => new UaclError(m, 'FORBIDDEN', 403),
  notFound: m => new UaclError(m, 'NOT_FOUND', 404),
  conflict: m => new UaclError(m, 'CONFLICT', 409),
  halted: () => new UaclError('Compute is stopped by the kill switch', 'KILL_SWITCH_ENGAGED', 423),
  full: m => new UaclError(m, 'QUEUE_FULL', 503),
  limit: m => new UaclError(m, 'TENANT_LIMIT', 429),
};

function id(prefix) { return `${prefix}_${crypto.randomBytes(8).toString('hex')}`; }
function num(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function positive(value, fallback, max) {
  const n = num(value, fallback);
  return n > 0 ? Math.min(n, max ?? Infinity) : fallback;
}
function digest(value) { return crypto.createHash('sha256').update(String(value)).digest(); }
function safeEqual(a, b) { return crypto.timingSafeEqual(digest(a), digest(b)); }
function strList(input, max) {
  return Array.isArray(input) ? [...new Set(input.map(v => String(v).trim().toLowerCase().slice(0, 64)).filter(Boolean))].slice(0, max) : [];
}

// Validates untrusted JSON-like data: bounded depth/size, no prototype-pollution keys.
// Returns a deep clone so callers can't mutate stored state afterwards.
function cleanJson(value, { maxBytes, label }) {
  let nodes = 0;
  const walk = (v, depth) => {
    if (depth > 12) throw E.invalid(`${label} is nested too deeply`);
    if (++nodes > 20_000) throw E.invalid(`${label} has too many fields`);
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) return;
    if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return; }
    if (typeof v === 'object') {
      for (const k of Object.keys(v)) {
        if (BAD_KEYS.has(k)) throw E.invalid(`${label} contains a forbidden key`);
        walk(v[k], depth + 1);
      }
      return;
    }
    throw E.invalid(`${label} must be plain JSON`);
  };
  walk(value, 0);
  const text = JSON.stringify(value ?? null);
  if (text.length > maxBytes) throw new UaclError(`${label} is too large (max ${maxBytes} bytes)`, 'PAYLOAD_TOO_LARGE', 413);
  return JSON.parse(text);
}

function sanitizeCapabilities(input = {}) {
  const i = input && typeof input === 'object' ? input : {};
  return {
    accelerators: strList(i.accelerators, 16),
    acceleratorMemoryGb: positive(i.acceleratorMemoryGb, 0, CAPS.acceleratorMemoryGb),
    cpuCores: positive(i.cpuCores, 1, CAPS.cpuCores),
    ramGb: positive(i.ramGb, 1, CAPS.ramGb),
    storageGb: positive(i.storageGb, 1, CAPS.storageGb),
    internet: i.internet !== false,
    maxConcurrentJobs: Math.floor(positive(i.maxConcurrentJobs, 1, CAPS.maxConcurrentJobs)),
  };
}

function sanitizeRequirements(input = {}) {
  const i = input && typeof input === 'object' ? input : {};
  return {
    accelerators: strList(i.accelerators, 16),
    acceleratorMemoryGb: positive(i.acceleratorMemoryGb, 0, CAPS.acceleratorMemoryGb),
    cpuCores: positive(i.cpuCores, 1, CAPS.cpuCores),
    ramGb: positive(i.ramGb, 1, CAPS.ramGb),
    storageGb: positive(i.storageGb, 1, CAPS.storageGb),
    internet: i.internet !== false,
    maxCostPerHour: i.maxCostPerHour == null ? null : Math.min(CAPS.pricePerHour, Math.max(0, num(i.maxCostPerHour, 0))),
    regions: strList(i.regions, 32),
    allowPreemptible: i.allowPreemptible !== false,
  };
}

function createUacl({
  now = () => Date.now(),
  maxQueueSize = 1000,
  maxActiveJobsPerTenant = 8,
  jobTtlMs = 30 * 60 * 1000,
  heartbeatTtlMs = 45 * 1000,
  workerSecret = '',
  isHalted = () => false,
  maxAttempts = 3,
  maxRuntimeMs = 30 * 60 * 1000,
  maxRuntimeCapMs = 6 * 3600 * 1000,
  terminalRetentionMs = 60 * 60 * 1000,
  maxRetainedTerminal = 1000,
  maxWorkers = 500,
  workerRetentionMs = 60 * 60 * 1000,
  maxResultBytes = 1024 * 1024,
} = {}) {
  const queueCap = Number.isFinite(Number(maxQueueSize)) && Number(maxQueueSize) > 0 ? Math.floor(Number(maxQueueSize)) : 1000;
  const authEnabled = !!workerSecret;
  const jobs = new Map();
  const workers = new Map();
  const idempotency = new Map(); // `${tenant}:${key}` -> jobId
  const events = [];
  const tenantActive = new Map(); // tenant -> non-terminal jobs (queued + assigned + running)
  let activeTotal = 0;
  let seq = 0;
  let sweepTimer = null;

  function emit(type, data) {
    events.push({ id: id('evt'), type, at: new Date(now()).toISOString(), ...data });
    if (events.length > 2000) events.splice(0, events.length - 2000);
  }
  const nowIso = () => new Date(now()).toISOString();
  const tenantCount = t => tenantActive.get(t) || 0;
  function incTenant(t, d) {
    const next = Math.max(0, tenantCount(t) + d);
    if (next === 0) tenantActive.delete(t); else tenantActive.set(t, next);
  }

  // ── authentication ────────────────────────────────────────
  function authWorker(worker, token) {
    if (!authEnabled) return;
    if (!token || !worker.tokenHash || !crypto.timingSafeEqual(digest(token), worker.tokenHash)) throw E.unauthorized();
  }
  const getWorkerOrThrow = workerId => {
    const w = workers.get(String(workerId));
    if (!w) throw E.notFound('Worker not found');
    return w;
  };

  // ── job state machine ─────────────────────────────────────
  function moveJob(job, next, patch = {}) {
    if (!JOB_STATES.has(next)) throw E.invalid(`Invalid job state: ${next}`);
    if (!(ALLOWED_TRANSITIONS[job.state] || []).includes(next)) throw E.conflict(`Job is ${job.state}; cannot become ${next}`);
    const prev = job.state;
    const holdsSlot = prev === 'assigned' || prev === 'running';
    const keepsSlot = next === 'running';
    if (holdsSlot && !keepsSlot && job.assignedWorkerId) {
      const w = workers.get(job.assignedWorkerId);
      if (w) {
        w.activeJobs = Math.max(0, w.activeJobs - 1);
        if (next === 'cancelled' || next === 'expired') {
          w.cancelJobIds.add(job.id);
          if (w.cancelJobIds.size > 100) w.cancelJobIds.delete(w.cancelJobIds.values().next().value);
        }
      }
    }
    job.state = next;
    job.updatedAt = nowIso();
    for (const k of ['result', 'error', 'assignedWorkerId', 'startedAt', 'runDeadline']) if (k in patch) job[k] = patch[k];
    if (next === 'queued') { job.assignedWorkerId = null; job.startedAt = null; job.runDeadline = null; }
    if (next === 'running') { job.startedAt = job.startedAt || nowIso(); job.runDeadline = now() + job.maxRuntimeMs; }
    if (TERMINAL.has(next)) {
      job.finishedAt = nowIso();
      job.finishedAtMs = now();
      incTenant(job.tenantId, -1);
      activeTotal = Math.max(0, activeTotal - 1);
    }
    emit('job.transition', { jobId: job.id, from: prev, to: next, workerId: job.assignedWorkerId });
    return job;
  }

  // ── scheduling ────────────────────────────────────────────
  function workerAlive(w) { return now() - w.heartbeatAt <= heartbeatTtlMs; }
  function workerCanRun(worker, job) {
    if (!worker || worker.state !== 'online' || !workerAlive(worker)) return false;
    if (worker.activeJobs >= worker.capabilities.maxConcurrentJobs) return false;
    const c = worker.capabilities;
    const r = job.requirements;
    if (r.internet && !c.internet) return false;
    if (c.cpuCores < r.cpuCores || c.ramGb < r.ramGb || c.storageGb < r.storageGb) return false;
    if (c.acceleratorMemoryGb < r.acceleratorMemoryGb) return false;
    if (r.accelerators.length && !r.accelerators.every(a => c.accelerators.includes(a))) return false;
    if (r.maxCostPerHour != null && worker.pricePerHour > r.maxCostPerHour) return false;
    if (r.regions.length && !r.regions.includes(worker.region)) return false;
    if (!r.allowPreemptible && worker.preemptible) return false;
    return true;
  }
  function score(worker, job) {
    const c = worker.capabilities;
    const r = job.requirements;
    const headroom = Math.max(0, c.cpuCores - r.cpuCores) * 0.4 + Math.max(0, c.ramGb - r.ramGb) * 0.15 + Math.max(0, c.acceleratorMemoryGb - r.acceleratorMemoryGb) * 0.2;
    const localityBonus = r.regions.includes(worker.region) ? 8 : 0;
    return job.priority * 2 + headroom + localityBonus - worker.pricePerHour * 1.5 - worker.activeJobs * 8;
  }
  function selectWorker(job) {
    return [...workers.values()]
      .filter(w => workerCanRun(w, job))
      .sort((a, b) => (score(b, job) - score(a, job)) || a.workerId.localeCompare(b.workerId))[0] || null;
  }
  function schedule() {
    if (isHalted()) return; // kill switch: nothing new may start
    let idle = false;
    for (const w of workers.values()) if (w.state === 'online' && workerAlive(w) && w.activeJobs < w.capabilities.maxConcurrentJobs) { idle = true; break; }
    if (!idle) return;
    const queued = [...jobs.values()].filter(j => j.state === 'queued').sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq));
    for (const job of queued) {
      if (job.expiresAt <= now()) { moveJob(job, 'expired', { error: 'expired while queued' }); emit('job.expired', { jobId: job.id }); continue; }
      const worker = selectWorker(job);
      if (!worker) continue;
      job.attempts += 1;
      worker.activeJobs += 1;
      moveJob(job, 'assigned', { assignedWorkerId: worker.workerId });
      emit('job.assigned', { jobId: job.id, workerId: worker.workerId, attempt: job.attempts });
    }
  }

  // Jobs held by a lost worker are re-queued (bounded) instead of being stuck until expiry.
  function handleWorkerLoss(worker, reason) {
    for (const job of jobs.values()) {
      if (job.assignedWorkerId !== worker.workerId || (job.state !== 'assigned' && job.state !== 'running')) continue;
      if (job.attempts < job.maxAttempts) {
        moveJob(job, 'queued');
        emit('job.requeued', { jobId: job.id, workerId: worker.workerId, reason });
      } else {
        moveJob(job, 'failed', { error: `worker lost (${reason}); retry limit reached` });
      }
    }
    worker.activeJobs = 0;
    worker.cancelJobIds.clear();
  }

  function gc() {
    const t = now();
    const finished = [];
    for (const job of jobs.values()) if (TERMINAL.has(job.state)) finished.push(job);
    finished.sort((a, b) => a.finishedAtMs - b.finishedAtMs);
    let excess = Math.max(0, finished.length - maxRetainedTerminal);
    for (const job of finished) {
      if (excess > 0 || job.finishedAtMs + terminalRetentionMs <= t) {
        jobs.delete(job.id);
        if (job.idemKey) idempotency.delete(job.idemKey);
        excess -= 1;
      }
    }
    for (const [wid, w] of workers) {
      if (w.state === 'offline' && w.activeJobs === 0 && t - w.heartbeatAt > workerRetentionMs) workers.delete(wid);
    }
  }

  function sweep() {
    const t = now();
    for (const w of workers.values()) {
      if (w.state !== 'offline' && t - w.heartbeatAt > heartbeatTtlMs) {
        w.state = 'offline';
        emit('worker.offline', { workerId: w.workerId });
        handleWorkerLoss(w, 'heartbeat timeout');
      }
    }
    for (const job of jobs.values()) {
      if (TERMINAL.has(job.state)) continue;
      if (job.state === 'running' && job.runDeadline && job.runDeadline <= t) {
        moveJob(job, 'expired', { error: 'max runtime exceeded' });
        emit('job.expired', { jobId: job.id, reason: 'runtime' });
      } else if ((job.state === 'queued' || job.state === 'assigned') && job.expiresAt <= t) {
        moveJob(job, 'expired', { error: 'expired before completion' });
        emit('job.expired', { jobId: job.id, reason: 'ttl' });
      }
    }
    gc();
    schedule();
  }

  // ── jobs ──────────────────────────────────────────────────
  function submitJob(input = {}) {
    if (isHalted()) throw E.halted();
    if (!input || typeof input !== 'object') throw E.invalid('job must be an object');
    const workloadType = String(input.workloadType || '').toLowerCase();
    if (!WORKLOAD_TYPES.has(workloadType)) throw E.invalid(`Unsupported workloadType: ${workloadType.slice(0, 40)}`);
    const tenantId = String(input.tenantId ?? 'public').trim().slice(0, 128) || 'public';

    let idemKey = null;
    if (input.idempotencyKey != null) {
      const k = String(input.idempotencyKey).trim().slice(0, 128);
      if (k) {
        idemKey = `${tenantId}:${k}`;
        const existing = jobs.get(idempotency.get(idemKey));
        if (existing) return getJob(existing.id);
      }
    }
    if (activeTotal >= queueCap) { gc(); if (activeTotal >= queueCap) throw E.full('UACL queue is full'); }
    if (tenantCount(tenantId) >= maxActiveJobsPerTenant) throw E.limit('Tenant active-job limit reached');

    const spec = input.spec == null ? {} : input.spec;
    if (typeof spec !== 'object' || Array.isArray(spec)) throw E.invalid('spec must be an object');
    const job = {
      id: id('job'),
      seq: ++seq,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      state: 'queued',
      workloadType,
      tenantId,
      requirements: sanitizeRequirements(input.requirements),
      priority: Math.max(0, Math.min(100, Math.floor(num(input.priority, 50)))),
      spec: cleanJson(spec, { maxBytes: MAX_SPEC_BYTES, label: 'spec' }),
      expiresAt: now() + Math.min(jobTtlMs, Math.max(10_000, num(input.ttlMs, jobTtlMs))),
      maxRuntimeMs: Math.min(maxRuntimeCapMs, Math.max(1000, num(input.maxRuntimeMs, maxRuntimeMs))),
      maxAttempts: Math.max(1, Math.min(maxAttempts, Math.floor(num(input.maxAttempts, maxAttempts)))),
      attempts: 0,
      assignedWorkerId: null,
      startedAt: null,
      finishedAt: null,
      finishedAtMs: null,
      runDeadline: null,
      result: null,
      error: null,
      idemKey,
    };
    jobs.set(job.id, job);
    if (idemKey) idempotency.set(idemKey, job.id);
    incTenant(tenantId, 1);
    activeTotal += 1;
    emit('job.queued', { jobId: job.id, tenantId, workloadType });
    schedule();
    return getJob(job.id);
  }

  function cancelJob(jobId, tenantId = null) {
    const job = jobs.get(String(jobId));
    // Same answer for "missing" and "not yours" so ids can't be probed.
    if (!job || (tenantId != null && job.tenantId !== tenantId)) throw E.notFound('Job not found');
    if (TERMINAL.has(job.state)) return getJob(job.id);
    moveJob(job, 'cancelled', { error: 'cancelled' });
    schedule();
    return getJob(job.id);
  }

  // ── workers ───────────────────────────────────────────────
  function registerWorker(input = {}, enrollmentKey = '', workerToken = '') {
    if (isHalted()) throw E.halted();
    if (!input || typeof input !== 'object') throw E.invalid('worker must be an object');
    if (authEnabled && !safeEqual(enrollmentKey || '', workerSecret)) throw E.unauthorized();
    const workerId = input.workerId == null || input.workerId === '' ? id('worker') : String(input.workerId).trim();
    if (!WORKER_ID_RE.test(workerId)) throw E.invalid('workerId must be 1-64 characters: letters, digits, . _ : -');

    const existing = workers.get(workerId);
    if (!existing && workers.size >= maxWorkers) { gc(); if (workers.size >= maxWorkers) throw E.full('Worker limit reached'); }
    // The owner (or, with auth disabled for dev/tests, anyone) may re-register and keep its jobs.
    // Otherwise a LIVE worker id can't be taken over; a dead one is replaced and its jobs re-queued.
    const proves = !authEnabled || !!(existing && workerToken && existing.tokenHash && crypto.timingSafeEqual(digest(workerToken), existing.tokenHash));
    if (existing && !proves) {
      if (existing.state !== 'offline' && workerAlive(existing)) throw E.conflict('A live worker with this id already exists');
      handleWorkerLoss(existing, 'replaced');
    }
    const keepsJobs = !!existing && proves;

    const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
      ? cleanJson(input.metadata, { maxBytes: MAX_METADATA_BYTES, label: 'metadata' }) : {};
    const token = authEnabled ? crypto.randomBytes(32).toString('base64url') : null;
    const worker = {
      workerId,
      provider: String(input.provider || 'self-hosted').trim().slice(0, 64) || 'self-hosted',
      region: String(input.region || 'unknown').trim().toLowerCase().slice(0, 64) || 'unknown',
      pricePerHour: Math.min(CAPS.pricePerHour, Math.max(0, num(input.pricePerHour, 0))),
      preemptible: input.preemptible === true,
      capabilities: sanitizeCapabilities(input.capabilities),
      state: input.state === 'draining' ? 'draining' : 'online',
      activeJobs: keepsJobs ? existing.activeJobs : 0,
      heartbeatAt: now(),
      metadata,
      tokenHash: token ? digest(token) : null,
      cancelJobIds: keepsJobs ? existing.cancelJobIds : new Set(),
    };
    workers.set(workerId, worker);
    emit('worker.registered', { workerId, provider: worker.provider });
    schedule();
    const view = getWorker(workerId);
    return token ? { ...view, credential: token } : view;
  }

  function heartbeat(workerId, token = '') {
    const worker = getWorkerOrThrow(workerId);
    authWorker(worker, token);
    worker.heartbeatAt = now();
    if (worker.state === 'offline') { worker.state = 'online'; emit('worker.online', { workerId: worker.workerId }); }
    schedule();
    return { ...getWorker(workerId), cancelJobIds: [...worker.cancelJobIds] };
  }

  function claimJob(workerId, token = '') {
    if (isHalted()) throw E.halted();
    const worker = getWorkerOrThrow(workerId);
    authWorker(worker, token);
    if (worker.state === 'offline' || !workerAlive(worker)) throw E.conflict('Worker heartbeat expired');
    if (worker.state !== 'online') return null; // draining workers finish what they have
    worker.heartbeatAt = now();
    const job = [...jobs.values()]
      .filter(j => j.state === 'assigned' && j.assignedWorkerId === worker.workerId)
      .sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq))[0];
    if (!job) return null;
    moveJob(job, 'running');
    return getJob(job.id);
  }

  function ownedJob(workerId, jobId, token, states, attempt) {
    const worker = getWorkerOrThrow(workerId);
    authWorker(worker, token);
    const job = jobs.get(String(jobId));
    if (!job || job.assignedWorkerId !== worker.workerId) throw E.forbidden('Job is not assigned to this worker');
    if (!states.includes(job.state)) throw E.conflict(`Job is ${job.state}`); // e.g. cancelled: worker should stop
    if (attempt != null && Number(attempt) !== job.attempts) throw E.conflict('Stale job attempt');
    worker.heartbeatAt = now();
    worker.cancelJobIds.delete(job.id);
    return job;
  }

  function completeJob(workerId, jobId, result, token = '', attempt = null) {
    let job;
    try { job = ownedJob(workerId, jobId, token, ['running'], attempt); }
    catch (err) { if (err.status === 409) cleanupCancel(workerId, jobId); throw err; }
    let clean;
    try { clean = cleanJson(result ?? null, { maxBytes: maxResultBytes, label: 'result' }); }
    catch (err) {
      moveJob(job, 'failed', { error: `worker returned an invalid or oversized result: ${err.message}`.slice(0, 500) });
      schedule();
      return getJob(job.id);
    }
    moveJob(job, 'succeeded', { result: clean });
    schedule();
    return getJob(job.id);
  }

  function failJob(workerId, jobId, error, token = '', attempt = null) {
    let job;
    try { job = ownedJob(workerId, jobId, token, ['assigned', 'running'], attempt); }
    catch (err) { if (err.status === 409) cleanupCancel(workerId, jobId); throw err; }
    moveJob(job, 'failed', { error: String(error || 'Worker failure').slice(0, 2000) });
    schedule();
    return getJob(job.id);
  }
  function cleanupCancel(workerId, jobId) { workers.get(String(workerId))?.cancelJobIds.delete(String(jobId)); }

  // ── views ─────────────────────────────────────────────────
  function getJob(jobId) {
    const job = jobs.get(String(jobId));
    if (!job) return null;
    const { seq: _seq, finishedAtMs: _f, idemKey: _i, ...rest } = job;
    return JSON.parse(JSON.stringify(rest));
  }
  function getWorker(workerId) {
    const w = workers.get(String(workerId));
    if (!w) return null;
    const { tokenHash: _t, cancelJobIds: _c, ...rest } = w;
    return JSON.parse(JSON.stringify(rest));
  }
  function status() {
    sweep();
    const c = { queued: 0, assigned: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, expired: 0 };
    for (const j of jobs.values()) c[j.state] += 1;
    const w = { total: workers.size, online: 0, draining: 0, offline: 0 };
    for (const x of workers.values()) w[x.state] += 1;
    return { ...c, workers: w, halted: !!isHalted() };
  }
  function listEvents(limit = 100) {
    const n = Math.max(1, Math.min(500, Math.floor(num(limit, 100))));
    return events.slice(-n).map(e => ({ ...e }));
  }

  // Periodic sweep so stale workers and expired jobs are handled even when nobody polls /status.
  function start(intervalMs = 5000) {
    if (sweepTimer) return;
    sweepTimer = setInterval(() => { try { sweep(); } catch { /* keep the timer alive */ } }, Math.max(250, intervalMs));
    sweepTimer.unref?.();
  }
  function stop() { if (sweepTimer) clearInterval(sweepTimer); sweepTimer = null; }

  return {
    submitJob, registerWorker, heartbeat, claimJob, completeJob, failJob, cancelJob,
    getJob, getWorker, status, listEvents, schedule, sweep, start, stop,
    workerCanRun, selectWorker,
    constants: { WORKLOAD_TYPES: [...WORKLOAD_TYPES], JOB_STATES: [...JOB_STATES], WORKER_STATES: [...WORKER_STATES] },
  };
}

module.exports = { createUacl, UaclError, WORKLOAD_TYPES, JOB_STATES, WORKER_STATES, sanitizeCapabilities, sanitizeRequirements };
