// ─── Enterprise: API Key Auth Middleware ──────────────────────
// Phase 15. Lets a request authenticate via `Authorization: Bearer
// nova_...` instead of a browser session cookie. Purely additive:
// existing session-based auth is completely untouched; this middleware
// only acts when a Bearer token is actually present and looks like a
// Nova API key.

const db = require('../db');
const { hashApiKey, isValidKeyFormat } = require('./apiKeys');
const { resolveTierForUser } = require('../middleware/usageGate');

async function apiKeyAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/);
  if (!match) return next();

  const rawKey = match[1];
  if (!isValidKeyFormat(rawKey)) return next();

  if (!db.isEnabled()) return res.status(503).json({ error: 'API key auth is not available — database not configured.' });

  const user = await db.getUserByApiKeyHash(hashApiKey(rawKey));
  if (!user) return res.status(401).json({ error: 'Invalid or revoked API key' });

  req.dbUser = user;
  req.apiKeyAuth = true;
  req.isAuthenticated = () => true;

  // Resolve billing tier the SAME way session auth does — without this,
  // usageGate() sees no req.tier and silently treats the request as an
  // unlimited guest, letting an API key bypass usage limits entirely.
  try {
    const { subscription, tier } = await resolveTierForUser(user.id);
    req.subscription = subscription;
    req.tier = tier;
  } catch (err) {
    console.warn('[WARN] apiKeyAuth tier resolution failed, continuing without tier limits applied:', err.message);
  }

  next();
}

module.exports = { apiKeyAuth };
