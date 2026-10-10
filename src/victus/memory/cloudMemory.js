'use strict';

const crypto = require('crypto');
const { URL } = require('url');

const DEFAULTS = Object.freeze({
  localTtlMs: 60_000,
  staleTtlMs: 5 * 60_000,
  maxLocalEntries: 2_000,
  maxLocalBytes: 64 * 1024 * 1024,
  maxValueBytes: 2 * 1024 * 1024,
  nodeTimeoutMs: 5_000,
  maxAttempts: 3,
  circuitFailureThreshold: 3,
  circuitCooldownMs: 30_000,
  replicas: 1,
});

class CloudMemoryError extends Error {
  constructor(message, code = 'CLOUD_MEMORY_ERROR', status = 500) {
    super(message);
    this.name = 'CloudMemoryError';
    this.code = code;
    this.status = status;
  }
}

function clamp(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

function parsePositive(value, fallback, min, max) {
  return clamp(value, fallback, min, max);
}

function normalizeId(value, label, max = 160) {
  const id = String(value || '').trim();
  if (!id || id.length > max) throw new TypeError(`${label} is required and must be <= ${max} characters`);
  return id;
}

function safeJsonBytes(value) {
  let json;
  try { json = JSON.stringify(value); } catch { throw new CloudMemoryError('memory value must be JSON-serializable', 'BAD_VALUE', 400); }
  if (json == null) throw new CloudMemoryError('memory value must be JSON-serializable', 'BAD_VALUE', 400);
  return { json, bytes: Buffer.byteLength(json, 'utf8') };
}

function parseEncryptionKey(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const b = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (b.length === 32) return b;
  } catch { /* fall through */ }
  throw new TypeError('VICTUS_CLOUD_MEMORY_KEY must be exactly 32 bytes as 64 hex characters or base64');
}

function deriveStorageKey(tenantId, key) {
  return crypto.createHash('sha256').update(`${tenantId}\0${key}`).digest('hex');
}

function encryptJson(value, key) {
  if (!key) throw new CloudMemoryError('cloud memory encryption key is not configured', 'KEY_NOT_CONFIGURED', 503);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    tag: tag.toString('base64url'),
    data: ciphertext.toString('base64url'),
  };
}

function decryptJson(envelope, key) {
  if (!key) throw new CloudMemoryError('cloud memory encryption key is not configured', 'KEY_NOT_CONFIGURED', 503);
  if (!envelope || envelope.version !== 1 || envelope.alg !== 'aes-256-gcm') throw new CloudMemoryError('unsupported cloud memory envelope', 'BAD_ENVELOPE', 502);
  try {
    const iv = Buffer.from(String(envelope.iv), 'base64url');
    const tag = Buffer.from(String(envelope.tag), 'base64url');
    const data = Buffer.from(String(envelope.data), 'base64url');
    if (iv.length !== 12 || tag.length !== 16) throw new Error('invalid envelope dimensions');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new CloudMemoryError('cloud memory payload authentication failed', 'BAD_ENVELOPE', 502);
  }
}

function normalizeNodeSpec(input = {}, { production = false, allowPrivate = false } = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('cloud memory node must be an object');
  const id = normalizeId(input.id, 'cloud memory node id');
  let url;
  try {
    url = new URL(String(input.url || ''));
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
    if (url.username || url.password) throw new Error('credentials not allowed');
    if (url.port && !['80', '443'].includes(url.port)) throw new Error('non-standard port not allowed');
    if (production && url.protocol !== 'https:') throw new Error('cloud memory nodes must use HTTPS in production');
    const host = url.hostname.toLowerCase();
    const private4 = /^10\.|^192\.168\.|^172\.(1[6-9]|2[0-9]|3[0-1])\.|^169\.254\.|^127\./.test(host);
    const private6 = host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb');
    if (!allowPrivate && (/^(localhost|.*\.localhost)$/.test(host) || private4 || private6)) {
      throw new Error('private/local node addresses require explicit opt-in');
    }
  } catch (err) {
    throw new TypeError(`invalid cloud memory node URL: ${err.message}`);
  }
  return {
    id,
    url: url.href.replace(/\/$/, ''),
    region: String(input.region || 'unknown').slice(0, 80),
    provider: String(input.provider || 'generic').slice(0, 120),
    key: String(input.key || ''),
    weight: Math.max(1, Math.min(100, Math.floor(Number(input.weight) || 10))),
  };
}

class VictusCloudMemory {
  constructor({
    fetchImpl = globalThis.fetch,
    encryptionKey = null,
    nodes = [],
    production = false,
    allowPrivateNodes = false,
    localTtlMs = DEFAULTS.localTtlMs,
    staleTtlMs = DEFAULTS.staleTtlMs,
    maxLocalEntries = DEFAULTS.maxLocalEntries,
    maxLocalBytes = DEFAULTS.maxLocalBytes,
    maxValueBytes = DEFAULTS.maxValueBytes,
    nodeTimeoutMs = DEFAULTS.nodeTimeoutMs,
    maxAttempts = DEFAULTS.maxAttempts,
    circuitFailureThreshold = DEFAULTS.circuitFailureThreshold,
    circuitCooldownMs = DEFAULTS.circuitCooldownMs,
    replicas = DEFAULTS.replicas,
    remoteRequired = false,
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('cloud memory fetch implementation is required');
    this.fetchImpl = fetchImpl;
    this.encryptionKey = Buffer.isBuffer(encryptionKey) ? encryptionKey : parseEncryptionKey(encryptionKey);
    this.production = production === true;
    this.allowPrivateNodes = allowPrivateNodes === true;
    this.localTtlMs = parsePositive(localTtlMs, DEFAULTS.localTtlMs, 0, 24 * 60 * 60 * 1000);
    this.staleTtlMs = parsePositive(staleTtlMs, DEFAULTS.staleTtlMs, 0, 7 * 24 * 60 * 60 * 1000);
    this.maxLocalEntries = parsePositive(maxLocalEntries, DEFAULTS.maxLocalEntries, 0, 100_000);
    this.maxLocalBytes = parsePositive(maxLocalBytes, DEFAULTS.maxLocalBytes, 64 * 1024, 2 * 1024 * 1024 * 1024);
    this.maxValueBytes = parsePositive(maxValueBytes, DEFAULTS.maxValueBytes, 1024, 10 * 1024 * 1024);
    this.nodeTimeoutMs = parsePositive(nodeTimeoutMs, DEFAULTS.nodeTimeoutMs, 500, 30_000);
    this.maxAttempts = parsePositive(maxAttempts, DEFAULTS.maxAttempts, 1, 8);
    this.circuitFailureThreshold = parsePositive(circuitFailureThreshold, DEFAULTS.circuitFailureThreshold, 1, 20);
    this.circuitCooldownMs = parsePositive(circuitCooldownMs, DEFAULTS.circuitCooldownMs, 1_000, 10 * 60_000);
    this.replicas = parsePositive(replicas, DEFAULTS.replicas, 0, 8);
    this.remoteRequired = remoteRequired === true;
    this.local = new Map();
    this.localBytes = 0;
    this.nodes = new Map();
    for (const node of nodes) this.registerNode(node);
  }

  registerNode(input) {
    const spec = normalizeNodeSpec(input, { production: this.production, allowPrivate: this.allowPrivateNodes });
    const existing = this.nodes.get(spec.id);
    const node = existing || {
      failures: 0,
      successCount: 0,
      requestCount: 0,
      consecutiveFailures: 0,
      latencyMs: 100,
      circuitOpenUntil: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      inFlight: 0,
    };
    Object.assign(node, spec);
    this.nodes.set(spec.id, node);
    return this.publicNode(node);
  }

  unregisterNode(id) { return this.nodes.delete(String(id)); }

  publicNode(node) {
    return {
      id: node.id,
      provider: node.provider,
      region: node.region,
      url: node.url,
      healthy: this.isEligible(node),
      weight: node.weight,
      inFlight: node.inFlight,
      latencyMs: Math.round(node.latencyMs),
      successRate: node.requestCount ? Number((node.successCount / node.requestCount).toFixed(3)) : null,
      consecutiveFailures: node.consecutiveFailures,
      circuitOpenUntil: node.circuitOpenUntil ? new Date(node.circuitOpenUntil).toISOString() : null,
      lastSuccessAt: node.lastSuccessAt,
      lastFailureAt: node.lastFailureAt,
      lastError: node.lastError,
    };
  }

  status({ includeNodes = false } = {}) {
    const out = {
      enabled: true,
      tiering: 'local-hot + distributed-remote-cold',
      local: { entries: this.local.size, bytes: this.localBytes, maxEntries: this.maxLocalEntries, maxBytes: this.maxLocalBytes },
      remote: { configuredNodes: this.nodes.size, encryption: !!this.encryptionKey, replicas: this.replicas, remoteRequired: this.remoteRequired },
      ttl: { localMs: this.localTtlMs, staleMs: this.staleTtlMs },
    };
    if (includeNodes) out.nodes = [...this.nodes.values()].map(n => this.publicNode(n));
    return out;
  }

  async set({ tenantId, key, value, ttlMs, staleTtlMs, replicas } = {}) {
    const scope = normalizeId(tenantId, 'tenantId', 128);
    const memKey = normalizeId(key, 'memory key', 512);
    const { json, bytes } = safeJsonBytes(value);
    if (bytes > this.maxValueBytes) throw new CloudMemoryError('memory value is too large', 'VALUE_TOO_LARGE', 413);
    const now = Date.now();
    const effectiveTtl = clamp(ttlMs, this.localTtlMs, 0, 24 * 60 * 60 * 1000);
    const effectiveStale = clamp(staleTtlMs, this.staleTtlMs, 0, 7 * 24 * 60 * 60 * 1000);
    const storageKey = deriveStorageKey(scope, memKey);
    const envelope = this.encryptionKey ? encryptJson(value, this.encryptionKey) : null;
    if (this.nodes.size && !envelope) throw new CloudMemoryError('remote cloud memory requires VICTUS_CLOUD_MEMORY_KEY', 'KEY_NOT_CONFIGURED', 503);

    this._setLocal(storageKey, { tenantId: scope, key: memKey, value, bytes, createdAt: now, expiresAt: now + effectiveTtl, staleUntil: now + effectiveTtl + effectiveStale });

    const targetReplicas = clamp(replicas, this.replicas, 0, Math.max(0, this.nodes.size));
    const attempted = [];
    let written = 0;
    if (targetReplicas > 0) {
      for (const node of this._rankNodes().slice(0, Math.min(this.maxAttempts, this.nodes.size))) {
        try {
          node.inFlight += 1;
          await this._remoteSet(node, { storageKey, envelope, expiresAt: now + effectiveTtl + effectiveStale, bytes, version: 1 });
          this._recordSuccess(node);
          written += 1;
          attempted.push({ nodeId: node.id, ok: true });
          if (written >= targetReplicas) break;
        } catch (err) {
          this._recordFailure(node, err);
          attempted.push({ nodeId: node.id, ok: false, code: err.code || 'NODE_ERROR' });
        } finally {
          node.inFlight = Math.max(0, node.inFlight - 1);
        }
      }
    }
    if (this.remoteRequired && written < targetReplicas) {
      // Keep the local copy warm but make the write outcome explicit.
      throw new CloudMemoryError('cloud memory replication requirement was not met', 'REPLICATION_FAILED', 503);
    }
    return { ok: true, key: memKey, tenantId: scope, bytes, replicasWritten: written, replicasRequired: targetReplicas, attempts: attempted };
  }

  async get({ tenantId, key, allowStale = true } = {}) {
    const scope = normalizeId(tenantId, 'tenantId', 128);
    const memKey = normalizeId(key, 'memory key', 512);
    const storageKey = deriveStorageKey(scope, memKey);
    const local = this._getLocal(storageKey);
    if (local && local.fresh) return { hit: true, tier: 'local', stale: false, value: local.value, bytes: local.bytes, updatedAt: new Date(local.createdAt).toISOString() };

    const remoteErrors = [];
    if (this.nodes.size && this.encryptionKey) {
      for (const node of this._rankNodes().slice(0, this.maxAttempts)) {
        try {
          node.inFlight += 1;
          const remote = await this._remoteGet(node, storageKey);
          this._recordSuccess(node);
          if (remote?.found) {
            const value = decryptJson(remote.envelope, this.encryptionKey);
            const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
            const now = Date.now();
            const staleUntil = Number(remote.expiresAt) || now;
            this._setLocal(storageKey, { tenantId: scope, key: memKey, value, bytes, createdAt: now, expiresAt: Math.min(staleUntil, now + this.localTtlMs), staleUntil });
            return { hit: true, tier: 'remote', stale: false, value, bytes, updatedAt: new Date(now).toISOString(), nodeId: node.id };
          }
        } catch (err) {
          this._recordFailure(node, err);
          remoteErrors.push({ nodeId: node.id, code: err.code || 'NODE_ERROR' });
        } finally {
          node.inFlight = Math.max(0, node.inFlight - 1);
        }
      }
    }

    if (allowStale && local?.stale) return { hit: true, tier: 'local', stale: true, value: local.value, bytes: local.bytes, updatedAt: new Date(local.createdAt).toISOString(), failover: true };
    if (remoteErrors.length && this.remoteRequired) throw new CloudMemoryError('all cloud memory nodes failed', 'ALL_NODES_FAILED', 503);
    return { hit: false, value: null, remoteErrors };
  }

  async delete({ tenantId, key } = {}) {
    const scope = normalizeId(tenantId, 'tenantId', 128);
    const memKey = normalizeId(key, 'memory key', 512);
    const storageKey = deriveStorageKey(scope, memKey);
    this._deleteLocal(storageKey);
    const attempts = [];
    let deleted = 0;
    if (this.nodes.size) {
      for (const node of this._rankNodes().slice(0, this.maxAttempts)) {
        try {
          node.inFlight += 1;
          await this._remoteDelete(node, storageKey);
          this._recordSuccess(node);
          deleted += 1;
          attempts.push({ nodeId: node.id, ok: true });
        } catch (err) {
          this._recordFailure(node, err);
          attempts.push({ nodeId: node.id, ok: false, code: err.code || 'NODE_ERROR' });
        } finally {
          node.inFlight = Math.max(0, node.inFlight - 1);
        }
      }
    }
    return { ok: true, key: memKey, deletedLocal: true, nodesReached: deleted, attempts };
  }

  _setLocal(storageKey, record) {
    const existing = this.local.get(storageKey);
    if (existing) this.localBytes -= existing.bytes;
    this.local.set(storageKey, record);
    this.localBytes += record.bytes;
    while (this.local.size > this.maxLocalEntries || this.localBytes > this.maxLocalBytes) {
      const oldest = this.local.keys().next().value;
      const old = this.local.get(oldest);
      this.local.delete(oldest);
      if (old) this.localBytes = Math.max(0, this.localBytes - old.bytes);
    }
  }

  _getLocal(storageKey) {
    const entry = this.local.get(storageKey);
    if (!entry) return null;
    const now = Date.now();
    if (now <= entry.expiresAt) return { ...entry, fresh: true, stale: true };
    if (now <= entry.staleUntil) return { ...entry, fresh: false, stale: true };
    this._deleteLocal(storageKey);
    return null;
  }

  _deleteLocal(storageKey) {
    const old = this.local.get(storageKey);
    if (old) this.localBytes = Math.max(0, this.localBytes - old.bytes);
    this.local.delete(storageKey);
  }

  _rankNodes() {
    return [...this.nodes.values()].filter(n => this.isEligible(n)).sort((a, b) => this._score(b) - this._score(a));
  }

  _score(node) {
    const successRate = node.requestCount ? node.successCount / node.requestCount : 0.7;
    const latency = 1 / Math.max(0.25, node.latencyMs / 100);
    const load = 1 / (1 + node.inFlight);
    const failures = 1 / (1 + node.consecutiveFailures);
    return node.weight * (0.25 + 0.75 * successRate) * latency * load * failures;
  }

  isEligible(node) {
    return !(node.circuitOpenUntil && Date.now() < node.circuitOpenUntil);
  }

  async _remoteRequest(node, path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.nodeTimeoutMs);
    try {
      const headers = { 'content-type': 'application/json' };
      if (node.key) headers['x-victus-cloud-memory-key'] = node.key;
      const response = await this.fetchImpl(`${node.url}${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) }, signal: controller.signal });
      if (!response.ok) throw new CloudMemoryError(`cloud memory node returned HTTP ${response.status}`, 'NODE_HTTP_ERROR', 502);
      return response.json();
    } catch (err) {
      if (err.name === 'AbortError') throw new CloudMemoryError('cloud memory node timed out', 'NODE_TIMEOUT', 504);
      throw err;
    } finally { clearTimeout(timer); }
  }

  _remoteBody(storageKey, extra = {}) { return { storageKey, ...extra }; }

  async _remoteSet(node, payload) { return this._remoteRequest(node, '/memory/set', { method: 'POST', body: JSON.stringify(this._remoteBody(payload.storageKey, payload)) }); }
  async _remoteGet(node, storageKey) { return this._remoteRequest(node, '/memory/get', { method: 'POST', body: JSON.stringify(this._remoteBody(storageKey)) }); }
  async _remoteDelete(node, storageKey) { return this._remoteRequest(node, '/memory/delete', { method: 'POST', body: JSON.stringify(this._remoteBody(storageKey)) }); }

  _recordSuccess(node) {
    node.requestCount += 1;
    node.successCount += 1;
    node.consecutiveFailures = 0;
    node.lastSuccessAt = new Date().toISOString();
    node.lastError = null;
    node.circuitOpenUntil = 0;
  }

  _recordFailure(node, err) {
    node.requestCount += 1;
    node.consecutiveFailures += 1;
    node.failures += 1;
    node.lastFailureAt = new Date().toISOString();
    node.lastError = String(err?.message || err).slice(0, 300);
    if (node.consecutiveFailures >= this.circuitFailureThreshold) node.circuitOpenUntil = Date.now() + this.circuitCooldownMs;
  }
}

function parseCloudMemoryNodes(value, options = {}) {
  if (!value) return [];
  const parsed = Array.isArray(value) ? value : JSON.parse(String(value));
  if (!Array.isArray(parsed)) throw new TypeError('VICTUS_CLOUD_MEMORY_NODES must be a JSON array');
  return parsed.map(node => normalizeNodeSpec(node, options));
}

function createCloudMemory(options = {}) {
  return new VictusCloudMemory(options);
}

module.exports = {
  DEFAULTS,
  CloudMemoryError,
  VictusCloudMemory,
  createCloudMemory,
  parseCloudMemoryNodes,
  parseEncryptionKey,
  encryptJson,
  decryptJson,
  deriveStorageKey,
  normalizeNodeSpec,
};
