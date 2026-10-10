'use strict';

// HTTP layer for UACL. This file is the ONLY place routes are defined
// (mountUaclRoutes), so there is no second path that could skip authentication
// or the kill switch.
//
// Auth model
//   admin    : header x-victus-admin-key == UACL_ADMIN_KEY
//   enroll   : header x-victus-worker-key == UACL_WORKER_KEY (register only)
//   worker   : header x-victus-worker-token — a per-worker credential issued at
//              registration; the core verifies it (heartbeat/claim/complete/fail)
//   client   : the logged-in user (req.dbUser) — jobs are scoped to that tenant
// Missing configuration FAILS CLOSED unless allowInsecureDev is set explicitly.

const crypto = require('crypto');
const { UaclError } = require('./uacl');

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function digest(v) { return crypto.createHash('sha256').update(String(v)).digest(); }
function safeEqual(a, b) { return crypto.timingSafeEqual(digest(a), digest(b)); }

function createUaclRoutes(uacl, {
  adminSecret = '',
  workerSecret = '',
  killSwitch = null,
  allowInsecureDev = false,
  logger = null,
} = {}) {
  const adminValid = req => !!adminSecret && safeEqual(req.get('x-victus-admin-key') || '', adminSecret);

  function requireAdmin(req, res, next) {
    if (!adminSecret) {
      if (allowInsecureDev) return next();
      return res.status(503).json({ error: 'UACL admin access is not configured.', code: 'NOT_CONFIGURED' });
    }
    if (!adminValid(req)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  }
  function requireEnrollment(req, res, next) {
    if (!workerSecret) {
      if (allowInsecureDev) return next();
      return res.status(503).json({ error: 'UACL worker authentication is not configured.', code: 'NOT_CONFIGURED' });
    }
    if (!safeEqual(req.get('x-victus-worker-key') || '', workerSecret)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  }
  function requireWorker(req, res, next) {
    if (!workerSecret && !allowInsecureDev) return res.status(503).json({ error: 'UACL worker authentication is not configured.', code: 'NOT_CONFIGURED' });
    next(); // the per-worker token is verified inside the core
  }
  function requireComputeRunning(req, res, next) {
    try { killSwitch?.assertRunning('compute'); next(); }
    catch (err) { return res.status(423).json({ error: err.message, code: err.code || 'KILL_SWITCH_ENGAGED' }); }
  }
  function limitBody(req, res, next) {
    const len = Number(req.get('content-length') || 0);
    if (len > MAX_BODY_BYTES) return res.status(413).json({ error: 'Request body too large', code: 'PAYLOAD_TOO_LARGE' });
    next();
  }

  // Clients are identified by the authenticated user, never by a body field.
  // (Admins may act for a tenant explicitly.)
  function tenantOf(req) {
    if (adminValid(req)) return typeof req.body?.tenantId === 'string' && req.body.tenantId ? req.body.tenantId : 'admin';
    if (req.dbUser?.id != null) return `user:${req.dbUser.id}`;
    return null;
  }
  const body = req => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

  function handle(fn) {
    return async (req, res) => {
      try {
        const out = await fn(req, res);
        if (!res.headersSent) res.json(out);
      } catch (err) {
        if (err instanceof UaclError) return res.status(err.status).json({ error: err.message, code: err.code });
        logger?.error?.('uacl.route_error', { path: req.path, error: err?.message });
        res.status(500).json({ error: 'Internal error' });
      }
    };
  }
  const unauth = () => new UaclError('Login required to use compute', 'UNAUTHORIZED', 401);
  const workerToken = req => req.get('x-victus-worker-token') || '';

  const handlers = {
    status: handle(() => uacl.status()),
    events: handle(req => ({ events: uacl.listEvents(req.query?.limit) })),
    submit: handle(req => {
      const tenantId = tenantOf(req);
      if (!tenantId) throw unauth();
      const b = body(req);
      const admin = adminValid(req);
      // Only admins may use priorities above the default band (stops a user starving everyone else).
      const priority = admin ? b.priority : Math.min(50, Number.isFinite(Number(b.priority)) ? Number(b.priority) : 50);
      return { job: uacl.submitJob({ ...b, tenantId, priority }) };
    }),
    getJob: handle(req => {
      const tenantId = tenantOf(req);
      if (!tenantId) throw unauth();
      const job = uacl.getJob(req.params.jobId);
      if (!job || (!adminValid(req) && job.tenantId !== tenantId)) throw new UaclError('Job not found', 'NOT_FOUND', 404);
      return { job };
    }),
    cancelJob: handle(req => {
      const tenantId = tenantOf(req);
      if (!tenantId) throw unauth();
      return { job: uacl.cancelJob(req.params.jobId, adminValid(req) ? null : tenantId) };
    }),
    registerWorker: handle(req => {
      const { credential, ...worker } = uacl.registerWorker(body(req), req.get('x-victus-worker-key') || '', workerToken(req));
      return { worker, ...(credential ? { credential } : {}) };
    }),
    heartbeat: handle(req => ({ worker: uacl.heartbeat(req.params.workerId, workerToken(req)) })),
    claim: handle(req => ({ job: uacl.claimJob(req.params.workerId, workerToken(req)) })),
    complete: handle(req => ({ job: uacl.completeJob(req.params.workerId, req.params.jobId, body(req).result, workerToken(req), body(req).attempt) })),
    fail: handle(req => ({ job: uacl.failJob(req.params.workerId, req.params.jobId, body(req).error, workerToken(req), body(req).attempt) })),
  };

  return {
    ...handlers,
    admin: { requireAdmin },
    worker: { requireWorker, requireEnrollment },
    compute: { requireComputeRunning },
    limitBody,
  };
}

// `middleware.limiter` / `middleware.clientGate` are the app's rate limiter and
// usage gate; they are injected so tests don't need Express or Postgres.
function mountUaclRoutes(app, uacl, opts = {}, middleware = {}) {
  const r = createUaclRoutes(uacl, opts);
  const limiter = middleware.limiter || ((req, res, next) => next());
  const clientGate = middleware.clientGate || ((req, res, next) => next());
  const P = '/api/victus/cloud';
  app.get(`${P}/status`, limiter, r.status);
  app.get(`${P}/events`, limiter, r.admin.requireAdmin, r.events);
  app.post(`${P}/jobs`, limiter, r.limitBody, clientGate, r.compute.requireComputeRunning, r.submit);
  app.get(`${P}/jobs/:jobId`, limiter, r.getJob);
  app.post(`${P}/jobs/:jobId/cancel`, limiter, r.cancelJob);                 // cancellation stays available during a stop
  app.post(`${P}/workers/register`, limiter, r.limitBody, r.compute.requireComputeRunning, r.worker.requireEnrollment, r.registerWorker);
  app.post(`${P}/workers/:workerId/heartbeat`, limiter, r.worker.requireWorker, r.heartbeat);   // stays available during a stop
  app.post(`${P}/workers/:workerId/claim`, limiter, r.compute.requireComputeRunning, r.worker.requireWorker, r.claim);
  app.post(`${P}/workers/:workerId/jobs/:jobId/complete`, limiter, r.limitBody, r.worker.requireWorker, r.complete);
  app.post(`${P}/workers/:workerId/jobs/:jobId/fail`, limiter, r.limitBody, r.worker.requireWorker, r.fail);
  return r;
}

module.exports = { createUaclRoutes, mountUaclRoutes };
