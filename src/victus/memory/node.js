'use strict';

const crypto = require('crypto');

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function safeEqual(a, b) {
  const aa = crypto.createHash('sha256').update(String(a || '')).digest();
  const bb = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(aa, bb);
}

function createCloudMemoryNodeStore({ maxEntries = 10_000, maxBytes = 512 * 1024 * 1024, now = () => Date.now() } = {}) {
  const store = new Map();
  let usedBytes = 0;
  function sweep() {
    const t = now();
    for (const [key, item] of store) {
      if (item.expiresAt <= t) {
        usedBytes = Math.max(0, usedBytes - item.bytes);
        store.delete(key);
      }
    }
    while (store.size > maxEntries || usedBytes > maxBytes) {
      const oldest = store.keys().next().value;
      const item = store.get(oldest);
      store.delete(oldest);
      if (item) usedBytes = Math.max(0, usedBytes - item.bytes);
    }
  }
  return {
    set(key, item) { sweep(); if (store.has(key)) usedBytes -= store.get(key).bytes; store.set(key, item); usedBytes += item.bytes; sweep(); return true; },
    get(key) { sweep(); return store.get(key) || null; },
    delete(key) { const item = store.get(key); if (!item) return false; usedBytes -= item.bytes; return store.delete(key); },
    status() { sweep(); return { entries: store.size, bytes: usedBytes, maxEntries, maxBytes }; },
  };
}

function createCloudMemoryNodeHandler({ secret = '', store = createCloudMemoryNodeStore(), maxValueBytes = 2 * 1024 * 1024 } = {}) {
  const auth = req => {
    if (!secret) return false;
    return safeEqual(req.get('x-victus-cloud-memory-key') || '', secret);
  };
  const validKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
  return {
    health: (_req, res) => res.json({ ok: true, service: 'victus-cloud-memory-node' }),
    status: (req, res) => { if (!auth(req)) return res.status(401).json({ error: 'Unauthorized' }); return res.json(store.status()); },
    set: (req, res) => {
      if (!auth(req)) return res.status(401).json({ error: 'Unauthorized' });
      const b = req.body || {};
      if (!validKey(b.storageKey) || !b.envelope || typeof b.envelope !== 'object') return res.status(400).json({ error: 'invalid memory record' });
      const raw = JSON.stringify(b.envelope);
      const bytes = Buffer.byteLength(raw, 'utf8');
      if (bytes > maxValueBytes) return res.status(413).json({ error: 'memory payload too large' });
      const expiresAt = Number(b.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 7 * 24 * 60 * 60 * 1000 + 5000) return res.status(400).json({ error: 'invalid expiration' });
      store.set(b.storageKey, { envelope: b.envelope, expiresAt, bytes, updatedAt: new Date().toISOString() });
      return res.json({ ok: true });
    },
    get: (req, res) => {
      if (!auth(req)) return res.status(401).json({ error: 'Unauthorized' });
      if (!validKey(req.body?.storageKey)) return res.status(400).json({ error: 'invalid memory key' });
      const item = store.get(req.body.storageKey);
      if (!item) return res.json({ found: false });
      return res.json({ found: true, envelope: item.envelope, expiresAt: item.expiresAt, updatedAt: item.updatedAt });
    },
    delete: (req, res) => {
      if (!auth(req)) return res.status(401).json({ error: 'Unauthorized' });
      if (!validKey(req.body?.storageKey)) return res.status(400).json({ error: 'invalid memory key' });
      store.delete(req.body.storageKey);
      return res.json({ ok: true });
    },
  };
}

module.exports = { MAX_BODY_BYTES, createCloudMemoryNodeStore, createCloudMemoryNodeHandler, safeEqual };
