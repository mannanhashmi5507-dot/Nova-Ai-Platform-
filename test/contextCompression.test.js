const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldCompress, buildPromptContext, COMPRESS_THRESHOLD, KEEP_RAW_MESSAGES } = require('../src/victus/contextCompression');

test('shouldCompress returns false below threshold, true at/above it', () => {
  assert.equal(shouldCompress(COMPRESS_THRESHOLD - 1), false);
  assert.equal(shouldCompress(COMPRESS_THRESHOLD), true);
  assert.equal(shouldCompress(COMPRESS_THRESHOLD + 5), true);
});

test('shouldCompress respects a custom threshold', () => {
  assert.equal(shouldCompress(5, 10), false);
  assert.equal(shouldCompress(10, 10), true);
});

test('buildPromptContext returns full raw history unchanged when there is no summary yet', () => {
  const history = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ];
  const result = buildPromptContext(null, history);
  assert.equal(result.contextNote, null);
  assert.deepEqual(result.recentMessages, history);
});

test('buildPromptContext trims to the last KEEP_RAW_MESSAGES and adds a context note when a summary exists', () => {
  const history = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg ${i}` }));
  const result = buildPromptContext('User previously asked about pricing.', history);

  assert.ok(result.contextNote.includes('User previously asked about pricing.'));
  assert.equal(result.recentMessages.length, KEEP_RAW_MESSAGES);
  // Must be the LAST N messages, not the first N — recency matters here.
  assert.equal(result.recentMessages[result.recentMessages.length - 1].content, 'msg 19');
});

test('buildPromptContext handles a short history gracefully (fewer messages than KEEP_RAW_MESSAGES)', () => {
  const history = [{ role: 'user', content: 'only one message' }];
  const result = buildPromptContext('some summary', history);
  assert.equal(result.recentMessages.length, 1);
  assert.deepEqual(result.recentMessages, history);
});
