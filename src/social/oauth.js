// ─── Social Media Studio: OAuth Connection Framework ─────────
// Phase 8. HONEST SCOPE: this is real, working OAuth 2.0 authorization-
// code-flow infrastructure — genuinely functional the moment a
// platform's CLIENT_ID/CLIENT_SECRET/etc. are configured. It is NOT
// pre-wired to Instagram/YouTube/TikTok/Facebook/X/LinkedIn specifically,
// because each of those requires the app owner (you) to register a
// developer app with that platform and, for most posting-related scopes,
// go through that platform's own app review process — that's a real
// external approval step, not something achievable by writing more code.
//
// What this buys you: the moment you register an app with any platform
// and add its config, connecting an account and storing tokens works
// immediately — no additional backend code needed per platform, just
// config. Actual posting/analytics calls are platform-specific (each
// has a different API shape) and are NOT included here; this module is
// the connection layer underneath them.

const crypto = require('crypto');

// ── Token encryption ──────────────────────────────────────────
// OAuth access/refresh tokens are real credentials to a user's actual
// social accounts — storing them in plaintext in the database is a real
// security risk (a DB leak becomes an account-takeover incident, not
// just a data leak). AES-256-GCM with a key from SOCIAL_TOKEN_ENC_KEY.
function getEncryptionKey() {
  const raw = (process.env.SOCIAL_TOKEN_ENC_KEY || '').trim();
  if (!raw) throw new Error('SOCIAL_TOKEN_ENC_KEY must be set to store social account tokens securely (32 random bytes, base64-encoded — e.g. `openssl rand -base64 32`)');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('SOCIAL_TOKEN_ENC_KEY must decode to exactly 32 bytes (use `openssl rand -base64 32` to generate one)');
  return key;
}

function encryptToken(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Store iv + authTag + ciphertext together, base64, so it's one string to persist.
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decryptToken(encoded) {
  const key = getEncryptionKey();
  const raw = Buffer.from(encoded, 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// Platform OAuth endpoints are read from env vars so adding a platform
// is a config change, not a code change:
//   SOCIAL_<PLATFORM>_CLIENT_ID, SOCIAL_<PLATFORM>_CLIENT_SECRET,
//   SOCIAL_<PLATFORM>_AUTH_URL, SOCIAL_<PLATFORM>_TOKEN_URL,
//   SOCIAL_<PLATFORM>_SCOPES
function getPlatformConfig(platform) {
  const key = platform.toUpperCase();
  const clientId = process.env[`SOCIAL_${key}_CLIENT_ID`];
  const clientSecret = process.env[`SOCIAL_${key}_CLIENT_SECRET`];
  const authUrl = process.env[`SOCIAL_${key}_AUTH_URL`];
  const tokenUrl = process.env[`SOCIAL_${key}_TOKEN_URL`];
  const scopes = process.env[`SOCIAL_${key}_SCOPES`] || '';
  if (!clientId || !clientSecret || !authUrl || !tokenUrl) return null;
  return { clientId, clientSecret, authUrl, tokenUrl, scopes };
}

function isPlatformConfigured(platform) {
  return getPlatformConfig(platform) !== null;
}

// Builds the URL to redirect the user to for authorization. `state` is
// a random token the caller must store (e.g. in the session) and verify
// on callback, to prevent CSRF — standard OAuth 2.0 practice.
function buildAuthorizeUrl(platform, redirectUri, state) {
  const config = getPlatformConfig(platform);
  if (!config) throw new Error(`${platform} is not configured. Register an app with ${platform} and set SOCIAL_${platform.toUpperCase()}_CLIENT_ID etc.`);

  const url = new URL(config.authUrl);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  if (config.scopes) url.searchParams.set('scope', config.scopes);
  return url.toString();
}

function generateState() {
  return crypto.randomBytes(24).toString('hex');
}

// Exchanges an authorization code for real access/refresh tokens.
async function exchangeCodeForToken(platform, code, redirectUri, fetchWithTimeout, safeJson) {
  const config = getPlatformConfig(platform);
  if (!config) throw new Error(`${platform} is not configured.`);

  const res = await fetchWithTimeout(
    config.tokenUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    },
    15000
  );
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const data = await safeJson(res);
  if (!data.access_token) throw new Error('Token exchange succeeded but no access_token was returned — check platform response format');

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresInSeconds: data.expires_in || null,
  };
}

module.exports = { getPlatformConfig, isPlatformConfigured, buildAuthorizeUrl, generateState, exchangeCodeForToken, encryptToken, decryptToken };
