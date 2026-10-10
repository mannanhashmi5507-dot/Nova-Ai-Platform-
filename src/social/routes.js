const express = require('express');
const db = require('../db');
const oauth = require('./oauth');
const { logger } = require('../logging/logger');
const { VALID_PLATFORMS } = require('./contentGenerator');

const router = express.Router();

function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated() && req.dbUser) return next();
  return res.status(401).json({ error: 'Sign in to manage social connections and your content calendar.' });
}

function notReadyIfNoDb(req, res, next) {
  if (!db.isEnabled()) return res.status(503).json({ error: 'This feature isn\u2019t configured on this server yet.' });
  next();
}

router.use(requireAuth, notReadyIfNoDb);

// ── Connections ──────────────────────────────────────────────

// GET /api/social/connections — list connected platforms (never returns tokens)
router.get('/connections', async (req, res) => {
  const connections = await db.listSocialConnections(req.dbUser.id);
  const configuredPlatforms = VALID_PLATFORMS.filter(p => oauth.isPlatformConfigured(p));
  res.json({ connections, configurablePlatforms: configuredPlatforms, allPlatforms: VALID_PLATFORMS });
});

// GET /api/social/connections/:platform/authorize-url — start OAuth
router.get('/connections/:platform/authorize-url', async (req, res) => {
  try {
    const { platform } = req.params;
    const { redirectUri } = req.query;
    if (!redirectUri) return res.status(400).json({ error: 'redirectUri query param is required' });
    const state = oauth.generateState();
    req.session.socialOAuthState = { platform, state }; // verified on callback below
    const url = oauth.buildAuthorizeUrl(platform, redirectUri, state);
    res.json({ authorizeUrl: url, state });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/social/connections/:platform/callback — finish OAuth after redirect
router.post('/connections/:platform/callback', async (req, res) => {
  try {
    const { platform } = req.params;
    const { code, state, redirectUri } = req.body;
    if (!code || !state || !redirectUri) return res.status(400).json({ error: 'code, state, and redirectUri are required' });

    const stored = req.session.socialOAuthState;
    if (!stored || stored.state !== state || stored.platform !== platform) {
      return res.status(400).json({ error: 'Invalid or expired OAuth state — please restart the connection process.' });
    }
    delete req.session.socialOAuthState;

    const tokens = await oauth.exchangeCodeForToken(platform, code, redirectUri, req.app.locals.fetchWithTimeout, req.app.locals.safeJson);
    const accessTokenEnc = oauth.encryptToken(tokens.accessToken);
    const refreshTokenEnc = tokens.refreshToken ? oauth.encryptToken(tokens.refreshToken) : null;
    const expiresAt = tokens.expiresInSeconds ? new Date(Date.now() + tokens.expiresInSeconds * 1000) : null;

    const saved = await db.saveSocialConnection(req.dbUser.id, platform, { accessTokenEnc, refreshTokenEnc, expiresAt });
    logger.info('social.connected', { requestId: req.id, userId: req.dbUser.id, platform });
    res.json({ connected: true, connection: saved });
  } catch (err) {
    logger.error('social.connect_failed', { requestId: req.id, error: err.message });
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/social/connections/:platform
router.delete('/connections/:platform', async (req, res) => {
  await db.removeSocialConnection(req.dbUser.id, req.params.platform);
  res.json({ disconnected: true });
});

// ── Content calendar (planning only — does not auto-publish) ──

router.get('/calendar', async (req, res) => {
  const posts = await db.listScheduledPosts(req.dbUser.id, { status: req.query.status });
  res.json({ posts });
});

router.post('/calendar', async (req, res) => {
  try {
    const { platform, content, hashtags, scheduledFor } = req.body;
    if (!platform || !content || !scheduledFor) {
      return res.status(400).json({ error: 'platform, content, and scheduledFor are required' });
    }
    if (isNaN(Date.parse(scheduledFor))) return res.status(400).json({ error: 'scheduledFor must be a valid date' });
    const post = await db.createScheduledPost(req.dbUser.id, { platform, content, hashtags, scheduledFor });
    res.json({ post });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/calendar/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid post id' });
  const post = await db.updateScheduledPost(id, req.dbUser.id, req.body);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  res.json({ post });
});

router.delete('/calendar/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid post id' });
  const deleted = await db.deleteScheduledPost(id, req.dbUser.id);
  if (!deleted) return res.status(404).json({ error: 'Post not found' });
  res.json({ deleted: true });
});

module.exports = { router };
