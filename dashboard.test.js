// Tests for src/dashboard/index.js and src/dashboard/tools.js
// Run with: npm test (or node --test)
//
// Approach: db/index.js is a CommonJS singleton — every module that
// requires('../db') gets the exact same object. So monkey-patching methods
// on that shared object here affects what dashboard/index.js sees too,
// without needing a mocking library. Each test restores the originals
// afterward so tests don't leak into each other.

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { getDashboard, toggleFavoriteTool } = require('../src/dashboard/index');
const { TOOLS, TOOL_KEYS, isValidToolKey } = require('../src/dashboard/tools');
const { getTier } = require('../src/config/tiers');

function withMockedDb(mocks, fn) {
  const originals = {};
  for (const key of Object.keys(mocks)) {
    originals[key] = db[key];
    db[key] = mocks[key];
  }
  return Promise.resolve(fn()).finally(() => {
    for (const key of Object.keys(originals)) db[key] = originals[key];
  });
}

test('tools registry: every tool has a unique key, name, and route', () => {
  const seen = new Set();
  for (const tool of TOOLS) {
    assert.ok(tool.key, 'tool must have a key');
    assert.ok(tool.name, 'tool must have a name');
    assert.ok(tool.route, 'tool must have a route');
    assert.ok(!seen.has(tool.key), `duplicate tool key: ${tool.key}`);
    seen.add(tool.key);
  }
});

test('isValidToolKey correctly accepts real keys and rejects unknown ones', () => {
  assert.equal(isValidToolKey('agent'), true);
  assert.equal(isValidToolKey('totally-made-up-tool'), false);
  assert.equal(isValidToolKey(''), false);
});

test('getDashboard aggregates real data from every subsystem into one object', async () => {
  await withMockedDb({
    listConversations: async () => ({ items: [{ id: 'c1', title: 'Test convo' }], nextCursor: null }),
    getUsage: async () => ({ messagesUsed: 42, imagesUsed: 3 }),
    getSubscription: async () => ({ tier: 'starter', status: 'active', current_period_end: '2026-08-01T00:00:00Z' }),
    listFavoriteTools: async () => ['agent', 'dev.review'],
    listNotifications: async () => ([
      { id: 1, type: 'usage_warning_messages', message: 'You are near your limit', read: false, created_at: '2026-07-20' },
      { id: 2, type: 'system', message: 'Welcome!', read: true, created_at: '2026-07-19' },
    ]),
    getUsageAnalytics: async () => ([{ date: '2026-07-25', messages: 5 }]),
  }, async () => {
    const dashboard = await getDashboard(42);

    assert.equal(dashboard.recentConversations.length, 1);
    assert.equal(dashboard.recentConversations[0].title, 'Test convo');

    assert.equal(dashboard.usage.messagesUsed, 42);
    assert.equal(dashboard.usage.imagesUsed, 3);
    // Confirm the earlier field-name bug (messages vs messagesPerMonth) is
    // actually fixed: this must equal the real starter-tier limit, not undefined.
    const starterTier = getTier('starter');
    assert.equal(dashboard.usage.messageLimit, starterTier.limits.messagesPerMonth);
    assert.notEqual(dashboard.usage.messageLimit, undefined);

    assert.equal(dashboard.billing.tier, 'starter');
    assert.equal(dashboard.billing.status, 'active');

    assert.equal(dashboard.favoriteTools.length, 2);
    assert.ok(dashboard.favoriteTools.every(t => ['agent', 'dev.review'].includes(t.key)));

    assert.equal(dashboard.notifications.length, 2);
    assert.equal(dashboard.unreadNotificationCount, 1, 'only one of the two notifications is unread');

    assert.equal(dashboard.usageAnalytics.length, 1);
    assert.equal(dashboard.usageAnalytics[0].messages, 5);

    assert.ok(Array.isArray(dashboard.quickActions) && dashboard.quickActions.length > 0);
  });
});

test('getDashboard defaults gracefully when a user has no subscription row yet (free tier)', async () => {
  await withMockedDb({
    listConversations: async () => ({ items: [], nextCursor: null }),
    getUsage: async () => ({ messagesUsed: 0, imagesUsed: 0 }),
    getSubscription: async () => null, // brand-new user, no row yet
    listFavoriteTools: async () => [],
    listNotifications: async () => [],
    getUsageAnalytics: async () => [],
  }, async () => {
    const dashboard = await getDashboard(99);
    assert.equal(dashboard.billing.tier, 'free');
    assert.equal(dashboard.billing.status, 'active');
    const freeTier = getTier('free');
    assert.equal(dashboard.usage.messageLimit, freeTier.limits.messagesPerMonth);
  });
});

test('getDashboard requires a userId', async () => {
  await assert.rejects(() => getDashboard(null), /userId is required/);
});

test('toggleFavoriteTool rejects an invalid tool key before touching the database', async () => {
  let dbWasCalled = false;
  await withMockedDb({
    addFavoriteTool: async () => { dbWasCalled = true; },
  }, async () => {
    await assert.rejects(
      () => toggleFavoriteTool(1, 'not-a-real-tool', 'add'),
      /Unknown tool key/
    );
  });
  assert.equal(dbWasCalled, false, 'should validate before calling the database');
});

test('toggleFavoriteTool rejects an invalid action', async () => {
  await assert.rejects(
    () => toggleFavoriteTool(1, TOOL_KEYS[0], 'delete-everything'),
    /action must be/
  );
});

test('toggleFavoriteTool calls the correct db function for add vs remove', async () => {
  let addCalled = false;
  let removeCalled = false;
  await withMockedDb({
    addFavoriteTool: async () => { addCalled = true; },
    removeFavoriteTool: async () => { removeCalled = true; },
  }, async () => {
    await toggleFavoriteTool(1, TOOL_KEYS[0], 'add');
    assert.equal(addCalled, true);
    assert.equal(removeCalled, false);

    await toggleFavoriteTool(1, TOOL_KEYS[0], 'remove');
    assert.equal(removeCalled, true);
  });
});
