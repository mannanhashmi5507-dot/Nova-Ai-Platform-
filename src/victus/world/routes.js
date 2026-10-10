'use strict';

function mountWorldModelRoutes(app, worldModel, { limiter = (req,res,next)=>next(), maxBodyBytes = 256 * 1024 } = {}) {
  const P = '/api/victus/world';
  const bodyLimit = (req, res, next) => {
    const len = Number(req.get('content-length') || 0);
    if (len > maxBodyBytes) return res.status(413).json({ error: 'World model request too large', code: 'PAYLOAD_TOO_LARGE' });
    next();
  };
  const auth = (req, res, next) => req.dbUser?.id != null ? next() : res.status(401).json({ error: 'Sign in required' });
  const tenant = req => `user:${req.dbUser.id}`;
  const safe = fn => async (req, res) => {
    try { return res.json(await fn(req, res)); }
    catch (err) {
      const status = /not found|must exist/i.test(err.message) ? 404 : /limit|exceeds|invalid|unsupported|must be/i.test(err.message) ? 400 : 500;
      return res.status(status).json({ error: err.message });
    }
  };

  app.post(`${P}/entities`, limiter, bodyLimit, auth, safe(async req => ({ entity: await worldModel.upsertEntity(req.body || {}, tenant(req)) })));
  app.get(`${P}/entities`, limiter, auth, safe(async req => ({ entities: await worldModel.listEntities(tenant(req), req.query || {}) })));
  app.get(`${P}/entities/:id`, limiter, auth, safe(async req => {
    const entity = await worldModel.getEntity(tenant(req), req.params.id);
    if (!entity) throw new Error('entity not found');
    return { entity };
  }));
  app.post(`${P}/relations`, limiter, bodyLimit, auth, safe(async req => ({ relation: await worldModel.link(req.body || {}, tenant(req)) })));
  app.get(`${P}/entities/:id/neighbors`, limiter, auth, safe(async req => ({ neighbors: await worldModel.neighbors(tenant(req), req.params.id, req.query || {}) })));
  app.post(`${P}/context`, limiter, bodyLimit, auth, safe(async req => ({ context: await worldModel.context(tenant(req), Array.isArray(req.body?.entityIds) ? req.body.entityIds : [], req.body || {}) })));
  app.get(`${P}/snapshot`, limiter, auth, safe(async req => ({ snapshot: await worldModel.snapshot(tenant(req), req.query || {}) })));
}

module.exports = { mountWorldModelRoutes };
