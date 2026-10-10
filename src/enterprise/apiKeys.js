// ─── Enterprise: API Keys ─────────────────────────────────────
// Phase 15. Real developer API keys, letting external scripts/apps call
// this API on a user's behalf without a browser session. SECURITY
// PROPERTY: the raw key is shown to the user exactly ONCE at creation
// and is never stored — only a SHA-256 hash is persisted, the same
// principle as password storage (though a fast hash, not bcrypt, is
// appropriate here since API keys are already high-entropy random
// values, not low-entropy human-chosen passwords needing slow-hash
// brute-force resistance).

const crypto = require('crypto');

const KEY_PREFIX = 'nova_';

function generateApiKey() {
  const randomPart = crypto.randomBytes(32).toString('hex');
  const rawKey = `${KEY_PREFIX}${randomPart}`;
  const keyHash = hashApiKey(rawKey);
  return { rawKey, keyHash };
}

function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function keyPreview(rawKey) {
  return rawKey.slice(0, KEY_PREFIX.length + 8) + '...';
}

function isValidKeyFormat(rawKey) {
  return typeof rawKey === 'string' && rawKey.startsWith(KEY_PREFIX) && rawKey.length === KEY_PREFIX.length + 64;
}

module.exports = { generateApiKey, hashApiKey, keyPreview, isValidKeyFormat, KEY_PREFIX };
