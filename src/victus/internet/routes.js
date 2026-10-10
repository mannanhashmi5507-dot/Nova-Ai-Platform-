'use strict';

const crypto = require('crypto');
const { InternetLayerError } = require('./gateway');

const MAX_BODY_BYTES = 64 * 1024;

function safeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function mountInternetRoutes(app, gateway, {
  limiter = (req, res, next) => next(),
  adminKey = '',
  killSwitch = null,
} = {}) {
  const P = '/api/victus/internet';
  const auth = (req, res, next) => req.dbUser?.id != null ? next() : res.status(401).json({ error: 'Sign in required' });
  const bodyLimit = (req, res, next) => {
    if (Number(req.get('content-length') || 0) > MAX_BODY_BYTES) return res.status(413).json({ error: 'Internet request too large', code: 'PAYLOAD_TOO_LARGE' });
    next();
  };
  const admin = (req, res, next) => {
    if (!adminKey || !safeEqual(req.get('x-victus-internet-admin-key') || '', adminKey)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  };
  const send = fn => async (req, res) => {
    try { return res.json(await fn(req, res)); }
    catch (err) {
      const status = err instanceof InternetLayerError ? err.status : /required|invalid|allowlisted|blocked/i.test(String(err.message)) ? 400 : 500;
      return res.status(status).json({ error: err.message, code: err.code || 'INTERNET_LAYER_ERROR' });
    }
  };

  app.get(`${P}/status`, limiter, auth, send(async () => ({ internet: gateway.status() })));
  app.get(`${P}/nodes`, limiter, auth, send(async () => ({ nodes: gateway.listNodes() })));
  app.post(`${P}/nodes`, limiter, bodyLimit, admin, send(async req => {
    const node = gateway.registerNode(req.body || {});
    return { node };
  }));
  app.delete(`${P}/nodes/:id`, limiter, admin, send(async req => ({ removed: gateway.unregisterNode(req.params.id) })));

  const requireInternetRunning = (req, res, next) => {
    try { killSwitch?.assertRunning('internet'); next(); }
    catch (err) { return res.status(423).json({ error: err.message, code: err.code || 'KILL_SWITCH_ENGAGED' }); }
  };

  app.post(`${P}/fetch`, limiter, bodyLimit, auth, requireInternetRunning, send(async req => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (!body.url || typeof body.url !== 'string') throw new InternetLayerError('url is required', 'URL_REQUIRED', 400);
    if (body.url.length > 4096) throw new InternetLayerError('url too long (max 4096 characters)', 'URL_TOO_LONG', 400);
    if (body.domains != null && (!Array.isArray(body.domains) || body.domains.some(d => typeof d !== 'string'))) {
      throw new InternetLayerError('domains must be an array of strings', 'BAD_DOMAINS', 400);
    }
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    const result = await gateway.fetch({ url: body.url, domains: body.domains, region: typeof body.region === 'string' ? body.region.slice(0, 80) : '', forceRefresh: body.forceRefresh === true, signal: controller.signal });
    return { document: result };
  }));

  app.post(`${P}/cache/clear`, limiter, admin, send(async () => ({ cleared: gateway.clearCache() })));
  return { auth, admin };
}

module.exports = { mountInternetRoutes };
