// ─── Phase 2: Dashboard ──────────────────────────────────────
// Aggregates real data already tracked elsewhere in the app — no new
// "fake metrics" invented for this screen. If a number can't be computed
// from real stored data yet, it's left out rather than faked.

const db = require('../db');
const { getTier } = require('../config/tiers');
const { TOOLS, isValidToolKey } = require('./tools');

async function getDashboard(userId) {
  if (!userId) throw new Error('userId is required');

  const [
    conversations,
    usage,
    subscription,
    favoriteToolKeys,
    notifications,
    analytics,
  ] = await Promise.all([
    db.listConversations(userId, { limit: 5 }),
    db.getUsage(userId),
    db.getSubscription(userId),
    db.listFavoriteTools(userId),
    db.listNotifications(userId, { limit: 10 }),
    db.getUsageAnalytics(userId, 7),
  ]);

  const tier = getTier(subscription?.tier || 'free');
  const favoriteTools = TOOLS.filter(t => favoriteToolKeys.includes(t.key));
  const unreadCount = notifications.filter(n => !n.read).length;

  return {
    recentConversations: conversations.items,
    usage: {
      messagesUsed: usage.messagesUsed,
      imagesUsed: usage.imagesUsed,
      messageLimit: tier?.limits?.messagesPerMonth ?? null,
      imageLimit: tier?.limits?.imagesPerMonth ?? null,
    },
    billing: {
      tier: subscription?.tier || 'free',
      status: subscription?.status || 'active',
      currentPeriodEnd: subscription?.current_period_end || null,
    },
    favoriteTools,
    quickActions: TOOLS, // full list — the frontend decides how many to surface as "quick actions" vs the "all tools" view
    notifications,
    unreadNotificationCount: unreadCount,
    usageAnalytics: analytics, // [{ date, messages }] for the last 7 days — real data, chart-ready
  };
}

async function toggleFavoriteTool(userId, toolKey, action) {
  if (!isValidToolKey(toolKey)) {
    throw new Error(`Unknown tool key: ${toolKey}`);
  }
  if (action === 'add') return db.addFavoriteTool(userId, toolKey);
  if (action === 'remove') return db.removeFavoriteTool(userId, toolKey);
  throw new Error('action must be "add" or "remove"');
}

module.exports = { getDashboard, toggleFavoriteTool };
