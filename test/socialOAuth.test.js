const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { getPlatformConfig, isPlatformConfigured, buildAuthorizeUrl, generateState, exchangeCodeForToken, encryptToken, decryptToken } = require('../src/social/oauth');

function setPlatformEnv(platform, overrides = {}) {
  const key = platform.toUpperCase();
  process.env[`SOCIAL_${key}_CLIENT_ID`] = overrides.clientId ?? 'test-client-id';
  process.env[`SOCIAL_${key}_CLIENT_SECRET`] = overrides.clientSecret ?? 'test-secret';
  process.env[`SOCIAL_${key}_AUTH_URL`] = overrides.authUrl ?? 'https://example.com/oauth/authorize';
  process.env[`SOCIAL_${key}_TOKEN_URL`] = overrides.tokenUrl ?? 'https://example.com/oauth/token';
  process.env[`SOCIAL_${key}_SCOPES`] = overrides.scopes ?? 'read write';
}
function clearPlatformEnv(platform) {
  const key = platform.toUpperCase();
  for (const suffix of ['CLIENT_ID', 'CLIENT_SECRET', 'AUTH_URL', 'TOKEN_URL', 'SCOPES']) {
    delete process.env[`SOCIAL_${key}_${suffix}`];
  }
}

test('isPlatformConfigured is false when no env vars are set', () => {
  clearPlatformEnv('testplatform');
  assert.equal(isPlatformConfigured('testplatform'), false);
});

test('isPlatformConfigured is true once all required env vars are set', () => {
  setPlatformEnv('testplatform');
  assert.equal(isPlatformConfigured('testplatform'), true);
  clearPlatformEnv('testplatform');
});

test('isPlatformConfigured is false if only some required vars are set (partial config)', () => {
  clearPlatformEnv('testplatform');
  process.env.SOCIAL_TESTPLATFORM_CLIENT_ID = 'x';
  // missing CLIENT_SECRET, AUTH_URL, TOKEN_URL
  assert.equal(isPlatformConfigured('testplatform'), false);
  clearPlatformEnv('testplatform');
});

test('buildAuthorizeUrl throws a clear error for an unconfigured platform', () => {
  clearPlatformEnv('testplatform');
  assert.throws(() => buildAuthorizeUrl('testplatform', 'https://app.com/callback', 'state123'), /not configured/);
});

test('buildAuthorizeUrl produces a real, correctly-formed URL with all required params', () => {
  setPlatformEnv('testplatform');
  const url = buildAuthorizeUrl('testplatform', 'https://app.com/callback', 'state123');
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://example.com/oauth/authorize');
  assert.equal(parsed.searchParams.get('client_id'), 'test-client-id');
  assert.equal(parsed.searchParams.get('redirect_uri'), 'https://app.com/callback');
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('state'), 'state123');
  assert.equal(parsed.searchParams.get('scope'), 'read write');
  clearPlatformEnv('testplatform');
});

test('generateState produces a real random, sufficiently long, unique value each call', () => {
  const s1 = generateState();
  const s2 = generateState();
  assert.notEqual(s1, s2);
  assert.ok(s1.length >= 32, 'state should be long enough to resist guessing (CSRF protection)');
});

test('exchangeCodeForToken throws for an unconfigured platform', async () => {
  clearPlatformEnv('testplatform');
  await assert.rejects(
    () => exchangeCodeForToken('testplatform', 'code123', 'https://app.com/cb', async () => ({}), async () => ({})),
    /not configured/
  );
});

test('exchangeCodeForToken returns real access/refresh tokens on success', async () => {
  setPlatformEnv('testplatform');
  const fakeFetch = async (url, opts) => {
    assert.equal(opts.method, 'POST');
    assert.match(opts.body, /grant_type=authorization_code/);
    return { ok: true };
  };
  const fakeSafeJson = async () => ({ access_token: 'real-access-token', refresh_token: 'real-refresh-token', expires_in: 3600 });
  const result = await exchangeCodeForToken('testplatform', 'code123', 'https://app.com/cb', fakeFetch, fakeSafeJson);
  assert.equal(result.accessToken, 'real-access-token');
  assert.equal(result.refreshToken, 'real-refresh-token');
  assert.equal(result.expiresInSeconds, 3600);
  clearPlatformEnv('testplatform');
});

test('exchangeCodeForToken throws if the platform response has no access_token', async () => {
  setPlatformEnv('testplatform');
  const fakeFetch = async () => ({ ok: true });
  const fakeSafeJson = async () => ({ error: 'invalid_grant' });
  await assert.rejects(
    () => exchangeCodeForToken('testplatform', 'code123', 'https://app.com/cb', fakeFetch, fakeSafeJson),
    /no access_token/
  );
  clearPlatformEnv('testplatform');
});

test('exchangeCodeForToken surfaces a clear error on a failed HTTP response', async () => {
  setPlatformEnv('testplatform');
  const fakeFetch = async () => ({ ok: false, status: 400, text: async () => 'invalid_request' });
  await assert.rejects(
    () => exchangeCodeForToken('testplatform', 'bad-code', 'https://app.com/cb', fakeFetch, async () => ({})),
    /Token exchange failed/
  );
  clearPlatformEnv('testplatform');
});

// ── Token encryption: the critical security property ──────────

test('encryptToken throws when SOCIAL_TOKEN_ENC_KEY is not set (never silently stores plaintext)', () => {
  const original = process.env.SOCIAL_TOKEN_ENC_KEY;
  delete process.env.SOCIAL_TOKEN_ENC_KEY;
  assert.throws(() => encryptToken('secret-access-token'), /SOCIAL_TOKEN_ENC_KEY/);
  if (original !== undefined) process.env.SOCIAL_TOKEN_ENC_KEY = original;
});

test('encryptToken throws when the key is the wrong length instead of silently using a weak key', () => {
  const original = process.env.SOCIAL_TOKEN_ENC_KEY;
  process.env.SOCIAL_TOKEN_ENC_KEY = Buffer.from('too-short').toString('base64');
  assert.throws(() => encryptToken('secret'), /32 bytes/);
  if (original !== undefined) process.env.SOCIAL_TOKEN_ENC_KEY = original; else delete process.env.SOCIAL_TOKEN_ENC_KEY;
});

test('encrypt/decrypt round-trip recovers the exact original token', () => {
  process.env.SOCIAL_TOKEN_ENC_KEY = crypto.randomBytes(32).toString('base64');
  const original = 'ya29.a0AfH6SMC-real-looking-oauth-token-1234567890';
  const encrypted = encryptToken(original);
  assert.notEqual(encrypted, original, 'ciphertext must not equal plaintext');
  const decrypted = decryptToken(encrypted);
  assert.equal(decrypted, original);
});

test('encrypting the same token twice produces different ciphertext (random IV each time)', () => {
  process.env.SOCIAL_TOKEN_ENC_KEY = crypto.randomBytes(32).toString('base64');
  const a = encryptToken('same-token');
  const b = encryptToken('same-token');
  assert.notEqual(a, b, 'must use a fresh random IV per encryption, not a fixed one');
});

test('decryptToken fails on tampered ciphertext rather than silently returning corrupted data (GCM auth tag integrity check)', () => {
  process.env.SOCIAL_TOKEN_ENC_KEY = crypto.randomBytes(32).toString('base64');
  const encrypted = encryptToken('a real token');
  const tampered = Buffer.from(encrypted, 'base64');
  tampered[tampered.length - 1] ^= 0xff; // flip a bit in the ciphertext
  assert.throws(() => decryptToken(tampered.toString('base64')));
});
