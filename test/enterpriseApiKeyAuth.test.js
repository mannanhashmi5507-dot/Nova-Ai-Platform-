const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { apiKeyAuth } = require('../src/enterprise/apiKeyAuth');
const { generateApiKey } = require('../src/enterprise/apiKeys');

function withMockedDb(mocks, fn) {
  const originals = {};
  for (const key of Object.keys(mocks)) { originals[key] = db[key]; db[key] = mocks[key]; }
  return Promise.resolve(fn()).finally(() => { for (const key of Object.keys(originals)) db[key] = originals[key]; });
}

function runMiddleware(mw, req) {
  return new Promise((resolve) => {
    const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; resolve({ req, res: this }); } };
    mw(req, res, () => resolve({ req, res: null }));
  });
}

test('passes through when there is no Authorization header', async () => {
  const { res } = await runMiddleware(apiKeyAuth, { headers: {} });
  assert.equal(res, null);
});

test('passes through when Authorization is not Bearer', async () => {
  const { req, res } = await runMiddleware(apiKeyAuth, { headers: { authorization: 'Basic dXNlcjpwYXNz' } });
  assert.equal(res, null);
  assert.equal(req.dbUser, undefined);
});

test('passes through when Bearer token is not Nova-key-shaped', async () => {
  const { res } = await runMiddleware(apiKeyAuth, { headers: { authorization: 'Bearer some-other-token' } });
  assert.equal(res, null);
});

test('rejects with 401 for a well-formed but unrecognized key', async () => {
  const { rawKey } = generateApiKey();
  await withMockedDb({ isEnabled: () => true, getUserByApiKeyHash: async () => null }, async () => {
    const { res } = await runMiddleware(apiKeyAuth, { headers: { authorization: `Bearer ${rawKey}` } });
    assert.equal(res.statusCode, 401);
  });
});

test('returns 503 when database is not configured', async () => {
  const { rawKey } = generateApiKey();
  await withMockedDb({ isEnabled: () => false }, async () => {
    const { res } = await runMiddleware(apiKeyAuth, { headers: { authorization: `Bearer ${rawKey}` } });
    assert.equal(res.statusCode, 503);
  });
});

test('a valid key sets req.dbUser and req.isAuthenticated() returns true', async () => {
  const { rawKey } = generateApiKey();
  await withMockedDb({
    isEnabled: () => true,
    getUserByApiKeyHash: async () => ({ id: 7, email: 'dev@example.com' }),
    getActiveOrgSubscriptionForUser: async () => null,
    getSubscription: async () => ({ tier: 'free', status: 'active' }),
  }, async () => {
    const { req, res } = await runMiddleware(apiKeyAuth, { headers: { authorization: `Bearer ${rawKey}` } });
    assert.equal(res, null);
    assert.equal(req.dbUser.id, 7);
    assert.equal(req.apiKeyAuth, true);
    assert.equal(req.isAuthenticated(), true);
  });
});

test('THE GAP FIX: a valid API key resolves req.tier so usageGate cannot be bypassed', async () => {
  const { rawKey } = generateApiKey();
  await withMockedDb({
    isEnabled: () => true,
    getUserByApiKeyHash: async () => ({ id: 7, email: 'dev@example.com' }),
    getActiveOrgSubscriptionForUser: async () => null,
    getSubscription: async () => ({ tier: 'starter', status: 'active' }),
  }, async () => {
    const { req } = await runMiddleware(apiKeyAuth, { headers: { authorization: `Bearer ${rawKey}` } });
    assert.ok(req.tier);
    assert.equal(req.tier.id, 'starter');
  });
});

test('an API key user in an org with active team billing gets the org tier', async () => {
  const { rawKey } = generateApiKey();
  await withMockedDb({
    isEnabled: () => true,
    getUserByApiKeyHash: async () => ({ id: 7, email: 'dev@example.com' }),
    getActiveOrgSubscriptionForUser: async () => ({ tier: 'business', status: 'active' }),
  }, async () => {
    const { req } = await runMiddleware(apiKeyAuth, { headers: { authorization: `Bearer ${rawKey}` } });
    assert.equal(req.tier.id, 'business');
  });
});

test('does not throw even if tier resolution fails', async () => {
  const { rawKey } = generateApiKey();
  await withMockedDb({
    isEnabled: () => true,
    getUserByApiKeyHash: async () => ({ id: 7, email: 'dev@example.com' }),
    getActiveOrgSubscriptionForUser: async () => { throw new Error('db hiccup'); },
  }, async () => {
    const { req, res } = await runMiddleware(apiKeyAuth, { headers: { authorization: `Bearer ${rawKey}` } });
    assert.equal(res, null);
    assert.equal(req.dbUser.id, 7);
  });
});
