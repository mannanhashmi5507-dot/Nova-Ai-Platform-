'use strict';

const { CloudMemoryError } = require('./cloudMemory');

function createCloudMemoryRoutes(memory, { requireUser = true, limiter = null, killSwitch = null } = {}) {
  const gate = fn => async (req, res) => {
    try {
      if (requireUser && req.dbUser?.id == null) return res.status(401).json({ error: 'Login required to use Victus Cloud Memory', code: 'UNAUTHORIZED' });
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out);
    } catch (err) {
      if (err instanceof CloudMemoryError) return res.status(err.status).json({ error: err.message, code: err.code });
      res.status(500).json({ error: 'Internal error' });
    }
  };
  const tenantOf = req => `user:${req.dbUser.id}`;
  const keyFrom = req => String(req.params.key || '').trim();
  const body = req => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
  const assertRunning = () => {
    try { killSwitch?.assertRunning('memory'); }
    catch (err) { throw new CloudMemoryError(err.message, err.code || 'KILL_SWITCH_ENGAGED', 423); }
  };

  const routes = {
    status: gate(async () => memory.status()),
    get: gate(async req => memory.get({ tenantId: tenantOf(req), key: keyFrom(req), allowStale: req.query?.allowStale !== 'false' })),
    set: gate(async req => {
      assertRunning();
      const b = body(req);
      return memory.set({ tenantId: tenantOf(req), key: keyFrom(req), value: b.value, ttlMs: b.ttlMs, staleTtlMs: b.staleTtlMs, replicas: b.replicas });
    }),
    delete: gate(async req => { assertRunning(); return memory.delete({ tenantId: tenantOf(req), key: keyFrom(req) }); }),
  };
  return routes;
}

function mountCloudMemoryRoutes(app, memory, { prefix = '/api/victus/memory', limiter = null, killSwitch = null, isAdmin = null } = {}) {
  const r = createCloudMemoryRoutes(memory, { limiter, killSwitch });
  const L = limiter || ((req, res, next) => next());
  const admin = async (req, res, next) => {
    try {
      if (typeof isAdmin !== 'function' || !isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
      next();
    } catch { return res.status(403).json({ error: 'Admin access required' }); }
  };
  app.get(`${prefix}/status`, L, r.status);
  app.get(`${prefix}/admin/status`, L, admin, async (req, res) => {
    try { return res.json(await memory.status({ includeNodes: true })); } catch { return res.status(500).json({ error: 'Internal error' }); }
  });
  app.get(`${prefix}/:key`, L, r.get);
  app.put(`${prefix}/:key`, L, r.set);
  app.delete(`${prefix}/:key`, L, r.delete);
  return r;
}

module.exports = { createCloudMemoryRoutes, mountCloudMemoryRoutes };
