'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  InternetGateway,
  InternetLayerError,
  assertSafeUrl,
  parseNodes,
} = require('../src/victus/internet/gateway');

function doc(nodeId, text = 'ok') {
  return { uri: 'https://example.com/a', title: nodeId, contentType: 'text/plain', text, fetchedAt: new Date().toISOString() };
}

test('provider-independent nodes can be configured without provider SDKs', () => {
  const nodes = parseNodes(JSON.stringify([
    { id: 'relay-a', type: 'relay', url: 'https://relay-a.example', provider: 'provider-a', region: 'global' },
    { id: 'relay-b', type: 'relay', url: 'https://relay-b.example', provider: 'provider-b', region: 'global' },
  ]));
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].provider, 'provider-a');
  assert.equal(nodes[1].provider, 'provider-b');
});

test('allowlist blocks domains outside the configured internet surface', () => {
  const out = assertSafeUrl('https://sub.example.com/path', {
    allowPublicInternet: false,
    allowedDomains: ['example.com'],
  });
  assert.equal(out.host, 'sub.example.com');
  assert.throws(
    () => assertSafeUrl('https://evil.example/path', { allowPublicInternet: false, allowedDomains: ['good.example'] }),
    err => err instanceof InternetLayerError && err.code === 'DOMAIN_NOT_ALLOWLISTED',
  );
});

test('private and credentialed URLs are blocked', () => {
  assert.throws(() => assertSafeUrl('http://127.0.0.1:80/', { allowPublicInternet: true }), /private or reserved/);
  assert.throws(() => assertSafeUrl('https://user:pass@example.com/', { allowPublicInternet: true }), /credentials/);
  assert.throws(() => assertSafeUrl('https://example.com:8443/', { allowPublicInternet: true }), /ports 80 or 443/);
});

test('successful fetches are cached and avoid a second node request', async () => {
  let calls = 0;
  const gateway = new InternetGateway({
    allowPublicInternet: true,
    cacheTtlMs: 60_000,
    nodes: [{ id: 'a', provider: 'a', transport: async () => { calls += 1; return doc('a'); } }],
  });
  const first = await gateway.fetch({ url: 'https://example.com/a' });
  const second = await gateway.fetch({ url: 'https://example.com/a' });
  assert.equal(first.cache, 'miss');
  assert.equal(second.cache, 'fresh');
  assert.equal(calls, 1);
});

test('failed node automatically fails over to another node', async () => {
  let aCalls = 0;
  let bCalls = 0;
  const gateway = new InternetGateway({
    allowPublicInternet: true,
    maxAttempts: 2,
    nodes: [
      { id: 'a', provider: 'a', weight: 100, transport: async () => { aCalls += 1; throw new Error('down'); } },
      { id: 'b', provider: 'b', weight: 1, transport: async () => { bCalls += 1; return doc('b', 'recovered'); } },
    ],
  });
  const result = await gateway.fetch({ url: 'https://example.com/failover' });
  assert.equal(result.text, 'recovered');
  assert.equal(aCalls, 1);
  assert.equal(bCalls, 1);
  assert.deepEqual(result.attempts.map(a => a.nodeId), ['a', 'b']);
});

test('circuit breaker temporarily removes a repeatedly failing node', async () => {
  let aCalls = 0;
  const gateway = new InternetGateway({
    allowPublicInternet: true,
    circuitFailureThreshold: 1,
    circuitCooldownMs: 60_000,
    maxAttempts: 2,
    nodes: [
      { id: 'a', provider: 'a', weight: 100, transport: async () => { aCalls += 1; throw new Error('down'); } },
      { id: 'b', provider: 'b', weight: 1, transport: async () => doc('b') },
    ],
  });
  const first = await gateway.fetch({ url: 'https://example.com/circuit', forceRefresh: true });
  const second = await gateway.fetch({ url: 'https://example.com/circuit', forceRefresh: true });
  assert.equal(first.nodeId, 'b');
  assert.equal(second.nodeId, 'b');
  assert.equal(aCalls, 1);
});

test('stale cache can preserve availability when every node fails', async () => {
  let fail = false;
  const gateway = new InternetGateway({
    allowPublicInternet: true,
    cacheTtlMs: 1,
    staleTtlMs: 60_000,
    maxAttempts: 1,
    nodes: [{ id: 'a', provider: 'a', transport: async () => {
      if (fail) throw new Error('offline');
      return doc('a', 'cached value');
    } }],
  });
  const first = await gateway.fetch({ url: 'https://example.com/stale', forceRefresh: true });
  assert.equal(first.text, 'cached value');
  await new Promise(r => setTimeout(r, 5));
  fail = true;
  const second = await gateway.fetch({ url: 'https://example.com/stale', forceRefresh: true });
  assert.equal(second.cache, 'stale');
  assert.equal(second.text, 'cached value');
});

test('request domain narrowing remains enforced in public mode', async () => {
  const gateway = new InternetGateway({
    allowPublicInternet: true,
    nodes: [{ id: 'a', provider: 'a', transport: async (_url, options) => {
      assert.deepEqual(options.allowedDomains, ['example.com']);
      return doc('a');
    } }],
  });
  await gateway.fetch({ url: 'https://example.com/path', domains: ['example.com'] });
  await assert.rejects(() => gateway.fetch({ url: 'https://other.example/path', domains: ['example.com'] }), err => err.code === 'DOMAIN_NOT_ALLOWLISTED');
});
