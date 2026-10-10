const express = require('express');
const db = require('../db');
const { getDashboard, toggleFavoriteTool } = require('./index');
const { logger } = require('../logging/logger');

const router = express.Router();

function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated() && req.dbUser) return next();
  return res.status(401).json({ error: 'Sign in to view your dashboard.' });
}

function notReadyIfNoDb(req, res, next) {
  if (!db.isEnabled()) return res.status(503).json({ error: 'Dashboard isn\u2019t configured on this server yet.' });
  next();
}

router.use(requireAuth, notReadyIfNoDb);

// GET /api/dashboard — everything the dashboard screen needs in one call:
// recent conversations, usage vs. plan limits, billing status, favorite
// tools, notifications, and a real 7-day usage chart.
router.get('/', async (req, res) => {
  try {
    const data = await getDashboard(req.dbUser.id);
    res.json(data);
  } catch (err) {
    logger.error('dashboard.load_failed', { requestId: req.id, userId: req.dbUser.id, error: err.message });
    res.status(500).json({ error: 'Could not load dashboard right now.' });
  }
});

// POST /api/dashboard/favorites { toolKey, action: 'add' | 'remove' }
router.post('/favorites', async (req, res) => {
  try {
    const { toolKey, action } = req.body;
    if (!toolKey || !['add', 'remove'].includes(action)) {
      return res.status(400).json({ error: 'toolKey and action ("add" or "remove") are required' });
    }
    await toggleFavoriteTool(req.dbUser.id, toolKey, action);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/dashboard/notifications/:id/read
router.post('/notifications/:id/read', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid notification id' });
    const result = await db.markNotificationRead(req.dbUser.id, id);
    if (!result) return res.status(404).json({ error: 'Notification not found' });
    res.json({ success: true });
  } catch (err) {
    logger.error('dashboard.notification_read_failed', { requestId: req.id, userId: req.dbUser.id, error: err.message });
    res.status(500).json({ error: 'Could not update notification.' });
  }
});

module.exports = { router };
