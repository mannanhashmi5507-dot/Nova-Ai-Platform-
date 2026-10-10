'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  VictusCloudMemory,
  CloudMemoryError,
  parseEncryptionKey,
  encryptJson,
  decryptJson,
  deriveStorageKey,
  normalizeNodeSpec,
} = require('../src/victus/memory/cloudMemory');
const { createCloudMemoryNodeStore, createCloudMemoryNodeHandler } = require('../src/victus/memory/node');

const KEY = '11'.repeat(32);
const ENC = parseEncryptionKey(KEY);

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function remoteHarness({ secret = 'node-secret', fail = false } = {}) {
  const store = createCloudMemoryNodeStore({ maxEntries: 100, maxBytes: 1024 * 1024 });
  const handlers = createCloudMemoryNodeHandler({ secret, store, maxValueBytes: 1024 * 1024 });
  function fakeReq(path, options = {}) {
    const headers = new Map(Object.entries(options.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const req = {
      get(name) { return headers.get(String(name).toLowerCase()); },
      body: options.body ? JSON.parse(options.body) : {},
    };
    return { req };
  }
  return {
    async fetch(url, options = {}) {
      if (fail) throw new Error('node offline');
      const path = new URL(url).pathname;
      const { req } = fakeReq(path, options);
      const out = { statusCode: 200, body: null };
      const res = { status(n) { out.statusCode = n; return res; }, json(b) { out.body = b; return res; } };
      if (path === '/memory/set') handlers.set(req, res);
      else if (path === '/memory/get') handlers.get(req, res);
      else if (path === '/memory/delete') handlers.delete(req, res);
      else return jsonResponse({}, 404);
      return jsonResponse(out.body, out.statusCode);
    },
    store,
  };
}

test('cloud memory encryption round-trips without exposing plaintext', () => {
  const value = { secret: 'victus', nested: [1, true, 'x'] };
  const envelope = encryptJson(value, ENC);
  assert.equal(JSON.stringify(envelope).includes('victus'), false);
  assert.deepEqual(decryptJson(envelope, ENC), value);
});

test('tenant/key storage identifiers are deterministic and isolated', () => {
  assert.equal(deriveStorageKey('user:1', 'abc').length, 64);
  assert.notEqual(deriveStorageKey('user:1', 'abc'), deriveStorageKey('user:2', 'abc'));
  assert.notEqual(deriveStorageKey('user:1', 'abc'), deriveStorageKey('user:1', 'abd'));
});

test('local hot tier serves fresh values without a remote node', async () => {
  const memory = new VictusCloudMemory({ encryptionKey: ENC });
  await memory.set({ tenantId: 'user:1', key: 'hot', value: { n: 42 } });
  const out = await memory.get({ tenantId: 'user:1', key: 'hot' });
  assert.equal(out.hit, true);
  assert.equal(out.tier, 'local');
  assert.deepEqual(out.value, { n: 42 });
});

test('remote tier stores encrypted envelopes and hydrates local hot cache', async () => {
  const relay = remoteHarness();
  const memory = new VictusCloudMemory({
    encryptionKey: ENC,
    nodes: [{ id: 'a', url: 'https://memory-a.example', key: 'node-secret', weight: 10 }],
    fetchImpl: relay.fetch,
    localTtlMs: 0,
  });
  const set = await memory.set({ tenantId: 'user:1', key: 'cold', value: { hello: 'world' }, replicas: 1 });
  assert.equal(set.replicasWritten, 1);
  const stored = relay.store.get(deriveStorageKey('user:1', 'cold'));
  assert.equal(typeof stored.envelope.data, 'string');
  assert.equal(stored.envelope.data.includes('hello'), false);
  const out = await memory.get({ tenantId: 'user:1', key: 'cold' });
  assert.equal(out.hit, true);
  assert.equal(out.tier, 'remote');
  assert.deepEqual(out.value, { hello: 'world' });
});

test('remote read failure falls back to stale local data', async () => {
  let now = 0;
  const relay = remoteHarness({ fail: true });
  const memory = new VictusCloudMemory({ encryptionKey: ENC, fetchImpl: relay.fetch, staleTtlMs: 1000, localTtlMs: 1, nodes: [{ id: 'a', url: 'https://a.example', key: 'node-secret' }] });
  // Seed through a local-only instance using the same API, then force the clock forward with a short TTL.
  await memory.set({ tenantId: 'user:1', key: 'stale', value: 'cached', ttlMs: 1, replicas: 0 });
  await new Promise(r => setTimeout(r, 5));
  const out = await memory.get({ tenantId: 'user:1', key: 'stale', allowStale: true });
  assert.equal(out.stale, true);
  assert.equal(out.failover, true);
  assert.equal(out.value, 'cached');
  void now;
});

test('remote replication can fail closed when required', async () => {
  const relay = remoteHarness({ fail: true });
  const memory = new VictusCloudMemory({
    encryptionKey: ENC,
    fetchImpl: relay.fetch,
    nodes: [{ id: 'a', url: 'https://a.example', key: 'node-secret' }],
    remoteRequired: true,
    replicas: 1,
  });
  await assert.rejects(() => memory.set({ tenantId: 'user:1', key: 'required', value: true }), err => err.code === 'REPLICATION_FAILED');
});

test('circuit breaker removes repeatedly failing memory nodes', async () => {
  const relay = remoteHarness({ fail: true });
  const memory = new VictusCloudMemory({
    encryptionKey: ENC,
    fetchImpl: relay.fetch,
    nodes: [{ id: 'a', url: 'https://a.example', key: 'node-secret' }],
    circuitFailureThreshold: 1,
    circuitCooldownMs: 60000,
    maxAttempts: 1,
  });
  await memory.get({ tenantId: 'user:1', key: 'x' });
  const status = memory.status({ includeNodes: true });
  assert.equal(status.nodes[0].healthy, false);
});

test('node URL policy rejects private endpoints unless explicitly enabled', () => {
  assert.throws(() => normalizeNodeSpec({ id: 'local', url: 'http://127.0.0.1' }), /private\/local/);
  assert.doesNotThrow(() => normalizeNodeSpec({ id: 'local', url: 'http://127.0.0.1' }, { allowPrivate: true }));
});

test('value size is bounded', async () => {
  const memory = new VictusCloudMemory({ encryptionKey: ENC, maxValueBytes: 1024 });
  await assert.rejects(() => memory.set({ tenantId: 'user:1', key: 'big', value: 'x'.repeat(2000) }), err => err.code === 'VALUE_TOO_LARGE');
});

test('node store enforces capacity and expiration', () => {
  let now = 0;
  const store = createCloudMemoryNodeStore({ maxEntries: 1, maxBytes: 100, now: () => now });
  store.set('a', { envelope: {}, expiresAt: 100, bytes: 10 });
  assert.ok(store.get('a'));
  store.set('b', { envelope: {}, expiresAt: 100, bytes: 10 });
  assert.equal(store.get('a'), null);
  now = 101;
  assert.equal(store.get('b'), null);
});

test('cloud memory node refuses unauthenticated operations', () => {
  const handlers = createCloudMemoryNodeHandler({ secret: 'x' });
  const req = { get: () => '', body: {} };
  let code = 200;
  const res = { status(n) { code = n; return res; }, json() { return res; } };
  handlers.status(req, res);
  assert.equal(code, 401);
});

test('remote replicas can spread a value across multiple healthy nodes', async () => {
  const a = remoteHarness();
  const b = remoteHarness();
  const memory = new VictusCloudMemory({
    encryptionKey: ENC,
    fetchImpl: async (url, options) => url.includes('a.example') ? a.fetch(url, options) : b.fetch(url, options),
    nodes: [
      { id: 'a', url: 'https://a.example', key: 'node-secret', weight: 10 },
      { id: 'b', url: 'https://b.example', key: 'node-secret', weight: 9 },
    ],
    replicas: 2,
  });
  const out = await memory.set({ tenantId: 'user:1', key: 'replicated', value: { ok: true }, replicas: 2 });
  assert.equal(out.replicasWritten, 2);
  assert.ok(a.store.get(deriveStorageKey('user:1', 'replicated')));
  assert.ok(b.store.get(deriveStorageKey('user:1', 'replicated')));
});

test('memory kill switch scope exists independently from compute and internet', () => {
  const { KillSwitch } = require('../src/victus/safety/killSwitch');
  const ks = new KillSwitch();
  ks.engage({ by: 'test', scope: 'memory', reason: 'maintenance' });
  assert.equal(ks.isEngaged('memory'), true);
  assert.equal(ks.isEngaged('compute'), false);
  assert.throws(() => ks.assertRunning('memory'), /memory/);
});

test('cloud memory route handlers enforce the authenticated tenant and memory kill switch', async () => {
  const { createCloudMemoryRoutes } = require('../src/victus/memory/routes');
  const memory = new VictusCloudMemory({ encryptionKey: ENC });
  const killed = { assertRunning() { const e = new Error('memory stopped'); e.code = 'KILL_SWITCH_ENGAGED'; throw e; } };
  const routes = createCloudMemoryRoutes(memory, { killSwitch: killed });
  const req = { dbUser: { id: 7 }, params: { key: 'x' }, body: { value: 'secret' } };
  let sent = null;
  const res = { headersSent: false, status(n) { sent = n; return res; }, json(body) { sent = body; return res; } };
  await routes.set(req, res);
  assert.equal(sent.code, 'KILL_SWITCH_ENGAGED');

  const liveRoutes = createCloudMemoryRoutes(memory, {});
  let body = null;
  const res2 = { headersSent: false, status(n) { sent = n; return res2; }, json(v) { body = v; return res2; } };
  req.body = { value: { owner: 7 } };
  await liveRoutes.set(req, res2);
  assert.equal(body.tenantId, 'user:7');
  const out = await memory.get({ tenantId: 'user:7', key: 'x' });
  assert.deepEqual(out.value, { owner: 7 });
  void sent;
});
