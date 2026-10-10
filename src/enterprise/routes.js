const express = require('express');
const db = require('../db');
const { generateApiKey, keyPreview } = require('./apiKeys');
const { exportUserData } = require('./dataExport');
const sso = require('./sso');
const { logger } = require('../logging/logger');
const { hasPermission } = require('../teams/permissions');

const router = express.Router();

function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated() && req.dbUser) return next();
  return res.status(401).json({ error: 'Sign in to use Enterprise features.' });
}
function notReadyIfNoDb(req, res, next) {
  if (!db.isEnabled()) return res.status(503).json({ error: 'This feature isn\u2019t configured on this server yet.' });
  next();
}
router.use(requireAuth, notReadyIfNoDb);

function requireAppAdmin(req, res, next) {
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  if (!admins.includes((req.dbUser.email || '').toLowerCase())) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ── API keys ─────────────────────────────────────────────────
router.get('/api-keys', async (req, res) => {
  res.json({ keys: await db.listApiKeys(req.dbUser.id) });
});

router.post('/api-keys', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const { rawKey, keyHash } = generateApiKey();
  const saved = await db.createApiKey(req.dbUser.id, name.trim(), keyHash, keyPreview(rawKey));
  await db.recordAuditLog({ userId: req.dbUser.id, action: 'apikey.created', targetType: 'api_key', targetId: saved.id, metadata: { name: name.trim() } });
  res.json({ key: { ...saved, rawKey }, warning: 'Save this key now \u2014 it will not be shown again.' });
});

router.delete('/api-keys/:id', async (req, res) => {
  const revoked = await db.revokeApiKey(parseInt(req.params.id, 10), req.dbUser.id);
  if (!revoked) return res.status(404).json({ error: 'API key not found' });
  await db.recordAuditLog({ userId: req.dbUser.id, action: 'apikey.revoked', targetType: 'api_key', targetId: req.params.id });
  res.json({ revoked: true });
});

// ── Audit logs (org-scoped) ──────────────────────────────────
router.get('/organizations/:orgId/audit-logs', async (req, res) => {
  const orgId = parseInt(req.params.orgId, 10);
  const membership = await db.getOrgMembership(orgId, req.dbUser.id);
  if (!membership || !hasPermission(membership.role, 'view')) return res.status(403).json({ error: 'You are not a member of this organization' });
  res.json({ logs: await db.listAuditLogs(orgId) });
});

// ── Data export ("backups") ──────────────────────────────────
router.get('/export', async (req, res) => {
  try {
    const result = await exportUserData(req.dbUser.id);
    res.json(result);
  } catch (err) {
    logger.error('enterprise.export_failed', { requestId: req.id, error: err.message });
    res.status(500).json({ error: 'Export failed. Please try again.' });
  }
});

// ── SSO status ────────────────────────────────────────────────
router.get('/sso/status', (req, res) => {
  res.json({ configured: sso.isConfigured() });
});

// ── Error logs (app-admin only) ───────────────────────────────
router.get('/errors', requireAppAdmin, async (req, res) => {
  res.json({ errors: await db.listErrorLogs({ limit: parseInt(req.query.limit, 10) || 50 }) });
});

module.exports = { router, requireAppAdmin };
