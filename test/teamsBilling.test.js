const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { attachUser } = require('../src/middleware/usageGate');

function withMockedDb(mocks, fn) {
  const originals = {};
  for (const key of Object.keys(mocks)) { originals[key] = db[key]; db[key] = mocks[key]; }
  return Promise.resolve(fn()).finally(() => { for (const key of Object.keys(originals)) db[key] = originals[key]; });
}

function fakeReq() {
  return {
    isAuthenticated: () => true,
    user: { id: 'google-123', email: 'test@example.com', name: 'Test User' },
  };
}

test('REGRESSION: a user with NO organization gets their personal subscription exactly as before Phase 14', async () => {
  const req = fakeReq();
  await withMockedDb({
    isEnabled: () => true,
    upsertUserByGoogle: async () => ({ id: 1, email: 'test@example.com' }),
    getSubscription: async () => ({ tier: 'starter', status: 'active' }),
    getActiveOrgSubscriptionForUser: async () => null, // the Phase 14 addition — returns null for a non-org user
  }, async () => {
    await new Promise(resolve => attachUser(req, {}, resolve));
    assert.equal(req.subscription.tier, 'starter', 'must fall through to the exact same personal subscription lookup as before this phase');
    assert.equal(req.tier.id, 'starter');
  });
});

test('REGRESSION: a user with no organization AND no personal subscription still defaults to free, exactly as before', async () => {
  const req = fakeReq();
  await withMockedDb({
    isEnabled: () => true,
    upsertUserByGoogle: async () => ({ id: 1, email: 'test@example.com' }),
    getSubscription: async () => null,
    getActiveOrgSubscriptionForUser: async () => null,
  }, async () => {
    await new Promise(resolve => attachUser(req, {}, resolve));
    assert.equal(req.tier.id, 'free');
  });
});

test('a user in an organization WITH an active org subscription gets the ORG tier, not their personal one', async () => {
  const req = fakeReq();
  await withMockedDb({
    isEnabled: () => true,
    upsertUserByGoogle: async () => ({ id: 1, email: 'test@example.com' }),
    getSubscription: async () => ({ tier: 'free', status: 'active' }), // personal plan is free
    getActiveOrgSubscriptionForUser: async () => ({ tier: 'business', status: 'active' }), // org plan is business
  }, async () => {
    await new Promise(resolve => attachUser(req, {}, resolve));
    assert.equal(req.tier.id, 'business', 'active org subscription must take precedence over the personal one');
  });
});

test('getSubscription (personal) is not even called when an active org subscription exists (no unnecessary lookup)', async () => {
  const req = fakeReq();
  let personalLookupCalled = false;
  await withMockedDb({
    isEnabled: () => true,
    upsertUserByGoogle: async () => ({ id: 1, email: 'test@example.com' }),
    getSubscription: async () => { personalLookupCalled = true; return null; },
    getActiveOrgSubscriptionForUser: async () => ({ tier: 'business', status: 'active' }),
  }, async () => {
    await new Promise(resolve => attachUser(req, {}, resolve));
    assert.equal(personalLookupCalled, false);
  });
});

test('attachUser never throws even if getActiveOrgSubscriptionForUser fails — degrades gracefully like the rest of this function', async () => {
  const req = fakeReq();
  await withMockedDb({
    isEnabled: () => true,
    upsertUserByGoogle: async () => ({ id: 1, email: 'test@example.com' }),
    getActiveOrgSubscriptionForUser: async () => { throw new Error('db hiccup'); },
  }, async () => {
    await assert.doesNotReject(() => new Promise(resolve => attachUser(req, {}, resolve)));
  });
});
