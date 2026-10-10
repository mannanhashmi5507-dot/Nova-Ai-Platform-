'use strict';

const { SafeResearchFetcher } = require('../research/safeResearchFetcher');

const MAX_REQUEST_BYTES = 32 * 1024;

function createInternetRelayHandler({
  secret = '',
  allowedDomains = [],
  allowPublicInternet = false,
  fetchImpl = globalThis.fetch,
  lookup,
  maxBytes = 2 * 1024 * 1024,
  timeoutMs = 12000,
} = {}) {
  const fetcher = new SafeResearchFetcher({
    allowedDomains: allowPublicInternet ? ['*'] : allowedDomains,
    fetchImpl,
    ...(lookup ? { lookup } : {}),
    maxBytes,
    timeoutMs,
  });
  return async function relay(req, res) {
    if (secret && req.get('x-victus-internet-node-key') !== secret) return res.status(401).json({ error: 'Unauthorized' });
    const len = Number(req.get('content-length') || 0);
    if (len > MAX_REQUEST_BYTES) return res.status(413).json({ error: 'Relay request too large' });
    const url = req.body?.url;
    if (!url || typeof url !== 'string' || url.length > 4096) return res.status(400).json({ error: 'valid url is required' });
    try {
      const document = await fetcher.fetchDocument(url, {
        allowedDomains: Array.isArray(req.body?.allowedDomains) ? req.body.allowedDomains : undefined,
        maxBytes: Math.min(maxBytes, Number(req.body?.maxBytes) || maxBytes),
        timeoutMs: Math.min(timeoutMs, Number(req.body?.timeoutMs) || timeoutMs),
      });
      return res.json({ ok: true, document });
    } catch (err) {
      return res.status(502).json({ error: err.message, code: err.code || 'RELAY_FETCH_FAILED' });
    }
  };
}

function mountInternetRelayRoute(app, options = {}, { bodyLimitBytes = MAX_REQUEST_BYTES } = {}) {
  const bodyLimit = (req, res, next) => Number(req.get('content-length') || 0) > bodyLimitBytes
    ? res.status(413).json({ error: 'Relay request too large' })
    : next();
  app.get('/health', (req, res) => res.json({ ok: true, service: 'victus-internet-node' }));
  app.post('/relay', bodyLimit, expressJsonRequired, createInternetRelayHandler(options));
}

function expressJsonRequired(req, res, next) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'JSON body is required' });
  next();
}

module.exports = { createInternetRelayHandler, mountInternetRelayRoute };
