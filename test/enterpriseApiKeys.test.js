const test = require('node:test');
const assert = require('node:assert/strict');
const { generateApiKey, hashApiKey, keyPreview, isValidKeyFormat, KEY_PREFIX } = require('../src/enterprise/apiKeys');

test('generateApiKey produces a key with the correct prefix', () => {
  const { rawKey } = generateApiKey();
  assert.ok(rawKey.startsWith(KEY_PREFIX));
});

test('generateApiKey produces a real high-entropy key, not a short/predictable one', () => {
  const { rawKey } = generateApiKey();
  assert.equal(rawKey.length, KEY_PREFIX.length + 64);
});

test('generateApiKey produces a genuinely different key every call', () => {
  const a = generateApiKey();
  const b = generateApiKey();
  assert.notEqual(a.rawKey, b.rawKey);
  assert.notEqual(a.keyHash, b.keyHash);
});

test('SECURITY: the returned keyHash is NOT the raw key', () => {
  const { rawKey, keyHash } = generateApiKey();
  assert.notEqual(keyHash, rawKey);
  assert.equal(keyHash.length, 64);
});

test('hashApiKey is deterministic', () => {
  const { rawKey, keyHash } = generateApiKey();
  assert.equal(hashApiKey(rawKey), keyHash);
});

test('hashApiKey produces different hashes for different keys', () => {
  const a = generateApiKey();
  const b = generateApiKey();
  assert.notEqual(hashApiKey(a.rawKey), hashApiKey(b.rawKey));
});

test('keyPreview reveals only a short, safe prefix', () => {
  const { rawKey } = generateApiKey();
  const preview = keyPreview(rawKey);
  assert.ok(preview.length < rawKey.length);
  assert.ok(preview.endsWith('...'));
});

test('isValidKeyFormat accepts a genuinely generated key', () => {
  const { rawKey } = generateApiKey();
  assert.equal(isValidKeyFormat(rawKey), true);
});

test('isValidKeyFormat rejects malformed keys', () => {
  assert.equal(isValidKeyFormat('sk-not-a-nova-key'), false);
  assert.equal(isValidKeyFormat('nova_tooshort'), false);
  assert.equal(isValidKeyFormat(''), false);
  assert.equal(isValidKeyFormat(null), false);
  assert.equal(isValidKeyFormat(12345), false);
});

test('isValidKeyFormat rejects tampered/truncated keys', () => {
  const { rawKey } = generateApiKey();
  assert.equal(isValidKeyFormat(rawKey.slice(0, -1)), false);
  assert.equal(isValidKeyFormat(rawKey + 'x'), false);
});
