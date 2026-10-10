const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeErrorForStorage, reportError, MAX_MESSAGE_LENGTH, MAX_STACK_LENGTH } = require('../src/enterprise/errorReporting');

test('extracts message and stack from a real Error object', () => {
  const err = new Error('something broke');
  const result = sanitizeErrorForStorage(err);
  assert.equal(result.message, 'something broke');
  assert.ok(result.stack);
});

test('handles a plain string thrown as an error', () => {
  const result = sanitizeErrorForStorage('a string error');
  assert.equal(result.message, 'a string error');
  assert.equal(result.stack, null);
});

test('handles null/undefined gracefully', () => {
  const result = sanitizeErrorForStorage(null);
  assert.equal(result.message, 'Unknown error');
});

test('caps an extremely long message', () => {
  const result = sanitizeErrorForStorage(new Error('x'.repeat(10000)));
  assert.ok(result.message.length <= MAX_MESSAGE_LENGTH);
});

test('caps an extremely long stack trace', () => {
  const err = new Error('x');
  err.stack = 'y'.repeat(10000);
  const result = sanitizeErrorForStorage(err);
  assert.ok(result.stack.length <= MAX_STACK_LENGTH);
});

test('SECURITY: redacts a Nova API key in an error message', () => {
  const rawKey = 'nova_' + 'a'.repeat(64);
  const result = sanitizeErrorForStorage(new Error(`Failed for key ${rawKey}`));
  assert.doesNotMatch(result.message, /nova_a{64}/);
  assert.match(result.message, /\[REDACTED\]/);
});

test('SECURITY: redacts a Bearer token in an error message', () => {
  const result = sanitizeErrorForStorage(new Error('Request failed: Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456'));
  assert.doesNotMatch(result.message, /Bearer abcdefghijklmnopqrstuvwxyz123456/);
  assert.match(result.message, /\[REDACTED\]/);
});

test('SECURITY: redacts an OpenAI-style sk- key', () => {
  const result = sanitizeErrorForStorage(new Error('Invalid key sk-abcdefghijklmnopqrstuvwxyz123456'));
  assert.doesNotMatch(result.message, /sk-abcdefghijklmnopqrstuvwxyz123456/);
});

test('SECURITY: redaction also applies to the stack trace', () => {
  const err = new Error('x');
  err.stack = `Error: x\n    at fetch (nova_${'b'.repeat(64)})`;
  const result = sanitizeErrorForStorage(err);
  assert.doesNotMatch(result.stack, /nova_b{64}/);
});

test('does NOT over-redact ordinary long error text', () => {
  const result = sanitizeErrorForStorage(new Error('The user requested an invalid date format for their calendar event'));
  assert.equal(result.message, 'The user requested an invalid date format for their calendar event');
});

test('captures context (requestId, userId, path)', () => {
  const result = sanitizeErrorForStorage(new Error('x'), { requestId: 'req-123', userId: 42, path: '/api/chat' });
  assert.equal(result.requestId, 'req-123');
  assert.equal(result.userId, 42);
  assert.equal(result.path, '/api/chat');
});

test('reportError stores to the DB when enabled', async () => {
  let stored = null;
  const fakeDb = { isEnabled: () => true, recordErrorLog: async (entry) => { stored = entry; } };
  await reportError(new Error('test error'), {}, fakeDb, null);
  assert.equal(stored.message, 'test error');
});

test('reportError never throws even if DB storage fails', async () => {
  const fakeDb = { isEnabled: () => true, recordErrorLog: async () => { throw new Error('db down'); } };
  await assert.doesNotReject(() => reportError(new Error('test error'), {}, fakeDb, null));
});

test('reportError skips DB storage cleanly when db is not enabled', async () => {
  const fakeDb = { isEnabled: () => false };
  const result = await reportError(new Error('test error'), {}, fakeDb, null);
  assert.equal(result.message, 'test error');
});

test('reportError does not attempt a Sentry forward when SENTRY_DSN is not set', async () => {
  const original = process.env.SENTRY_DSN;
  delete process.env.SENTRY_DSN;
  let fetchCalled = false;
  const fakeDb = { isEnabled: () => false };
  const fakeFetch = async () => { fetchCalled = true; return { ok: true }; };
  await reportError(new Error('x'), {}, fakeDb, fakeFetch);
  assert.equal(fetchCalled, false);
  if (original !== undefined) process.env.SENTRY_DSN = original;
});
