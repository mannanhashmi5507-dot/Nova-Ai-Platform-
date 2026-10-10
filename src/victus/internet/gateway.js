'use strict';

const crypto = require('crypto');
const net = require('net');
const { URL } = require('url');
const dns = require('dns').promises;
const { SafeResearchFetcher, narrowAllowlist } = require('../research/safeResearchFetcher');

const DEFAULTS = Object.freeze({
  timeoutMs: 12000,
  maxBytes: 2 * 1024 * 1024,
  maxAttempts: 4,
  cacheTtlMs: 30_000,
  staleTtlMs: 5 * 60_000,
  maxCacheEntries: 500,
  circuitFailureThreshold: 3,
  circuitCooldownMs: 30_000,
  maxConcurrentPerNode: 4,
});

class InternetLayerError extends Error {
  constructor(message, code = 'INTERNET_LAYER_ERROR', status = 500) {
    super(message);
    this.name = 'InternetLayerError';
    this.code = code;
    this.status = status;
  }
}

function clamp(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

function normalizeDomains(values) {
  if (!Array.isArray(values)) values = typeof values === 'string' ? values.split(',') : [];
  return [...new Set(values.map(v => String(v).trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '')).filter(Boolean))];
}

function normalizeNodeSpec(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('internet node must be an object');
  const id = String(input.id || '').trim();
  if (!id || id.length > 160) throw new TypeError('internet node id is required and must be <= 160 characters');
  const type = input.type === 'relay' ? 'relay' : 'direct';
  let url = null;
  if (input.url) {
    try {
      url = new URL(String(input.url));
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
      if (url.username || url.password) throw new Error('credentials not allowed');
      if (url.port && !['80', '443'].includes(url.port)) throw new Error('non-standard port not allowed');
      if (type === 'relay' && process.env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('relay nodes must use HTTPS in production');
    } catch (err) {
      throw new TypeError(`invalid internet node URL: ${err.message}`);
    }
  }
  if (type === 'relay' && !url) throw new TypeError('relay internet node requires url');
  return {
    id,
    provider: String(input.provider || 'generic').slice(0, 120),
    region: String(input.region || 'unknown').slice(0, 80),
    type,
    url: url ? url.href.replace(/\/$/, '') : null,
    key: String(input.key || ''),
    weight: Math.max(1, Math.min(100, Math.floor(Number(input.weight) || 10))),
    maxConcurrent: clamp(input.maxConcurrent, DEFAULTS.maxConcurrentPerNode, 1, 32),
  };
}

function cacheKey(url) {
  const normalized = new URL(url);
  normalized.hash = '';
  normalized.hostname = normalized.hostname.toLowerCase();
  if ((normalized.protocol === 'https:' && normalized.port === '443') || (normalized.protocol === 'http:' && normalized.port === '80')) normalized.port = '';
  return crypto.createHash('sha256').update(normalized.href).digest('hex');
}

function assertSafeUrl(raw, { allowPublicInternet, allowedDomains, lookup = dns.lookup } = {}) {
  let url;
  try { url = new URL(raw); } catch { throw new InternetLayerError('invalid internet URL', 'BAD_URL', 400); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new InternetLayerError('only HTTP(S) internet URLs are allowed', 'BAD_PROTOCOL', 400);
  if (url.username || url.password) throw new InternetLayerError('internet URLs cannot contain credentials', 'URL_CREDENTIALS_BLOCKED', 400);
  if (url.port && !['80', '443'].includes(url.port)) throw new InternetLayerError('internet URLs must use ports 80 or 443', 'PORT_BLOCKED', 400);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (isPrivateHost(host)) throw new InternetLayerError('private or reserved internet hosts are blocked', 'SSRF_BLOCKED', 403);
  const domains = normalizeDomains(allowedDomains);
  if (!domains.includes('*') && !domains.some(d => host === d || host.endsWith(`.${d}`))) {
    throw new InternetLayerError(`domain not allowlisted: ${host}`, 'DOMAIN_NOT_ALLOWLISTED', 403);
  }
  url.hash = '';
  return { url, host, domains };
}

function isPrivateHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal' || host.endsWith('.local')) return true;
  if (net.isIP(host)) return isPrivateIp(host);
  return false;
}

function isPrivateIp(ip) {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const normalized = ip.toLowerCase();
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('ff');
}

function parseNodes(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(normalizeNodeSpec);
  try {
    const parsed = JSON.parse(String(value));
    if (!Array.isArray(parsed)) throw new Error('must be a JSON array');
    return parsed.map(normalizeNodeSpec);
  } catch (err) {
    throw new TypeError(`VICTUS_INTERNET_NODES is invalid: ${err.message}`);
  }
}

class InternetGateway {
  constructor({
    fetchImpl = globalThis.fetch,
    lookup = dns.lookup,
    allowedDomains = [],
    allowPublicInternet = false,
    timeoutMs = DEFAULTS.timeoutMs,
    maxBytes = DEFAULTS.maxBytes,
    maxAttempts = DEFAULTS.maxAttempts,
    cacheTtlMs = DEFAULTS.cacheTtlMs,
    staleTtlMs = DEFAULTS.staleTtlMs,
    maxCacheEntries = DEFAULTS.maxCacheEntries,
    circuitFailureThreshold = DEFAULTS.circuitFailureThreshold,
    circuitCooldownMs = DEFAULTS.circuitCooldownMs,
    maxConcurrentPerNode = DEFAULTS.maxConcurrentPerNode,
    nodes = [],
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('internet fetch implementation is required');
    this.fetchImpl = fetchImpl;
    this.lookup = lookup;
    this.allowedDomains = normalizeDomains(allowedDomains);
    this.allowPublicInternet = allowPublicInternet === true;
    this.timeoutMs = clamp(timeoutMs, DEFAULTS.timeoutMs, 1000, 30000);
    this.maxBytes = clamp(maxBytes, DEFAULTS.maxBytes, 32 * 1024, 10 * 1024 * 1024);
    this.maxAttempts = clamp(maxAttempts, DEFAULTS.maxAttempts, 1, 8);
    this.cacheTtlMs = clamp(cacheTtlMs, DEFAULTS.cacheTtlMs, 0, 24 * 60 * 60 * 1000);
    this.staleTtlMs = clamp(staleTtlMs, DEFAULTS.staleTtlMs, 0, 7 * 24 * 60 * 60 * 1000);
    this.maxCacheEntries = clamp(maxCacheEntries, DEFAULTS.maxCacheEntries, 0, 5000);
    this.circuitFailureThreshold = clamp(circuitFailureThreshold, DEFAULTS.circuitFailureThreshold, 1, 20);
    this.circuitCooldownMs = clamp(circuitCooldownMs, DEFAULTS.circuitCooldownMs, 1000, 10 * 60 * 1000);
    this.maxConcurrentPerNode = clamp(maxConcurrentPerNode, DEFAULTS.maxConcurrentPerNode, 1, 64);
    this.cache = new Map();
    this.nodes = new Map();
    for (const node of nodes) this.registerNode(node);
  }

  registerNode(input) {
    const spec = normalizeNodeSpec(input);
    const existing = this.nodes.get(spec.id);
    const node = existing || {
      failures: 0,
      successCount: 0,
      requestCount: 0,
      latencyMs: 500,
      consecutiveFailures: 0,
      circuitOpenUntil: 0,
      inFlight: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      transport: null,
    };
    Object.assign(node, spec);
    if (typeof input.transport === 'function') node.transport = input.transport;
    this.nodes.set(spec.id, node);
    return this.publicNode(node);
  }

  unregisterNode(id) { return this.nodes.delete(String(id)); }

  publicNode(node) {
    return {
      id: node.id,
      provider: node.provider,
      region: node.region,
      type: node.type,
      url: node.url,
      weight: node.weight,
      healthy: this.isNodeEligible(node),
      inFlight: node.inFlight,
      maxConcurrent: node.maxConcurrent,
      latencyMs: Math.round(node.latencyMs),
      successRate: node.requestCount ? Number((node.successCount / node.requestCount).toFixed(3)) : null,
      consecutiveFailures: node.consecutiveFailures,
      circuitOpenUntil: node.circuitOpenUntil ? new Date(node.circuitOpenUntil).toISOString() : null,
      lastSuccessAt: node.lastSuccessAt,
      lastFailureAt: node.lastFailureAt,
      lastError: node.lastError,
    };
  }

  listNodes() { return [...this.nodes.values()].map(node => this.publicNode(node)); }

  status() {
    const nodes = this.listNodes();
    const cacheEntries = [...this.cache.values()];
    return {
      enabled: this.allowPublicInternet || this.allowedDomains.length > 0,
      mode: this.allowPublicInternet ? 'public-internet' : 'allowlisted',
      allowedDomains: this.allowedDomains.slice(),
      cache: { entries: cacheEntries.length, maxEntries: this.maxCacheEntries, ttlMs: this.cacheTtlMs, staleTtlMs: this.staleTtlMs },
      routing: { maxAttempts: this.maxAttempts, circuitFailureThreshold: this.circuitFailureThreshold, circuitCooldownMs: this.circuitCooldownMs },
      nodes,
    };
  }

  async fetch({ url, signal, domains = [], forceRefresh = false, region = '' } = {}) {
    this.assertEnabled();
    const effectiveDomains = this.effectiveAllowedDomains(domains);
    const { url: parsed, host } = assertSafeUrl(url, {
      allowPublicInternet: this.allowPublicInternet,
      allowedDomains: effectiveDomains,
      lookup: this.lookup,
    });
    const canonical = parsed.href;
    const key = cacheKey(canonical);
    if (!forceRefresh) {
      const cached = this._readCache(key);
      if (cached && cached.fresh) return { ...cached.value, cache: 'fresh' };
    }

    const nodes = this._rankNodes(region);
    if (!nodes.length) {
      const stale = this._readCache(key, true);
      if (stale) return { ...stale.value, cache: 'stale', failover: true };
      throw new InternetLayerError('no healthy internet nodes are available', 'NO_NODES', 503);
    }

    const attempts = [];
    for (const node of nodes.slice(0, this.maxAttempts)) {
      if (signal?.aborted) throw new InternetLayerError('internet request aborted', 'ABORTED', 499);
      const started = Date.now();
      try {
        node.inFlight += 1;
        const document = await this._transport(node, canonical, { signal, host, allowedDomains: effectiveDomains });
        const latency = Date.now() - started;
        this._recordSuccess(node, latency);
        attempts.push({ nodeId: node.id, ok: true, latencyMs: latency });
        const value = {
          ...document,
          url: canonical,
          nodeId: node.id,
          provider: node.provider,
          region: node.region,
          fetchedAt: document.fetchedAt || new Date().toISOString(),
          attempts,
        };
        this._writeCache(key, value);
        return { ...value, cache: 'miss' };
      } catch (err) {
        const latency = Date.now() - started;
        this._recordFailure(node, latency, err);
        attempts.push({ nodeId: node.id, ok: false, latencyMs: latency, code: err.code || 'NODE_ERROR', error: err.message });
      } finally {
        node.inFlight = Math.max(0, node.inFlight - 1);
      }
    }

    const stale = this._readCache(key, true);
    if (stale) return { ...stale.value, cache: 'stale', failover: true, attempts };
    throw new InternetLayerError('all internet nodes failed', 'ALL_NODES_FAILED', 503);
  }

  effectiveAllowedDomains(requested) {
    const normalized = normalizeDomains(requested);
    if (this.allowPublicInternet && !normalized.length) return ['*'];
    if (this.allowPublicInternet && normalized.length) return normalized;
    if (!normalized.length) return this.allowedDomains;
    return narrowAllowlist(this.allowedDomains, normalized);
  }

  assertEnabled() {
    if (!this.allowPublicInternet && this.allowedDomains.length === 0) throw new InternetLayerError('Victus Internet Layer is disabled; configure VICTUS_INTERNET_ALLOWLIST or explicitly enable public internet mode', 'NOT_CONFIGURED', 503);
  }

  _rankNodes(preferredRegion = '') {
    const eligible = [...this.nodes.values()].filter(node => this.isNodeEligible(node));
    return eligible.sort((a, b) => this._score(b, preferredRegion) - this._score(a, preferredRegion));
  }

  _score(node, preferredRegion = '') {
    const successRate = node.requestCount ? node.successCount / node.requestCount : 0.65;
    const latencyFactor = 1 / Math.max(0.25, node.latencyMs / 500);
    const loadFactor = 1 / (1 + node.inFlight);
    const failurePenalty = node.consecutiveFailures ? 1 / (1 + node.consecutiveFailures) : 1;
    const regionBonus = preferredRegion && node.region === preferredRegion ? 1.15 : 1;
    return node.weight * (0.25 + 0.75 * successRate) * latencyFactor * loadFactor * failurePenalty * regionBonus;
  }

  isNodeEligible(node) {
    if (node.inFlight >= Math.min(node.maxConcurrent, this.maxConcurrentPerNode)) return false;
    if (node.circuitOpenUntil && Date.now() < node.circuitOpenUntil) return false;
    return true;
  }

  async _transport(node, url, options) {
    if (typeof node.transport === 'function') return node.transport(url, options);
    if (node.type === 'relay') return this._relayTransport(node, url, options);
    const fetcher = new SafeResearchFetcher({
      allowedDomains: this.allowPublicInternet ? ['*'] : this.allowedDomains,
      fetchImpl: this.fetchImpl,
      lookup: this.lookup,
      maxBytes: this.maxBytes,
      timeoutMs: this.timeoutMs,
      maxRedirects: 3,
    });
    const out = await fetcher.fetchDocument(url, { signal: options.signal, allowedDomains: options.allowedDomains });
    return out;
  }

  async _relayTransport(node, url, options) {
    const { signal } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const response = await this.fetchImpl(`${node.url}/relay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(node.key ? { 'x-victus-internet-node-key': node.key } : {}) },
        body: JSON.stringify({ url, maxBytes: this.maxBytes, timeoutMs: this.timeoutMs, allowedDomains: options.allowedDomains }),
        signal: controller.signal,
      });
      if (!response.ok) throw new InternetLayerError(`relay node returned HTTP ${response.status}`, 'RELAY_HTTP_ERROR', 502);
      const payload = await response.json();
      if (!payload?.document || typeof payload.document !== 'object') throw new InternetLayerError('relay node returned an invalid document', 'RELAY_BAD_RESPONSE', 502);
      return payload.document;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  _recordSuccess(node, latency) {
    node.requestCount += 1;
    node.successCount += 1;
    node.consecutiveFailures = 0;
    node.lastSuccessAt = new Date().toISOString();
    node.lastError = null;
    node.latencyMs = node.latencyMs * 0.7 + latency * 0.3;
    node.circuitOpenUntil = 0;
  }

  _recordFailure(node, latency, err) {
    node.requestCount += 1;
    node.consecutiveFailures += 1;
    node.failures += 1;
    node.lastFailureAt = new Date().toISOString();
    node.lastError = String(err?.message || err).slice(0, 300);
    node.latencyMs = node.latencyMs * 0.8 + latency * 0.2;
    if (node.consecutiveFailures >= this.circuitFailureThreshold) node.circuitOpenUntil = Date.now() + this.circuitCooldownMs;
  }

  _readCache(key, staleAllowed = false) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    const now = Date.now();
    if (now <= entry.expiresAt) return { fresh: true, value: entry.value };
    if (staleAllowed && now <= entry.staleUntil) return { fresh: false, value: entry.value };
    this.cache.delete(key);
    return null;
  }

  _writeCache(key, value) {
    if (this.maxCacheEntries <= 0 || this.cacheTtlMs <= 0) return;
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.cacheTtlMs,
      staleUntil: Date.now() + this.cacheTtlMs + this.staleTtlMs,
    });
    while (this.cache.size > this.maxCacheEntries) {
      const first = this.cache.keys().next().value;
      this.cache.delete(first);
    }
  }

  clearCache() {
    const size = this.cache.size;
    this.cache.clear();
    return size;
  }
}

function createInternetGateway(options = {}) {
  return new InternetGateway(options);
}

module.exports = {
  DEFAULTS,
  InternetGateway,
  InternetLayerError,
  createInternetGateway,
  parseNodes,
  normalizeDomains,
  normalizeNodeSpec,
  assertSafeUrl,
};
