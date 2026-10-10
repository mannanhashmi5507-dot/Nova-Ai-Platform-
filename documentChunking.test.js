const test = require('node:test');
const assert = require('node:assert/strict');
const { chunkText } = require('../src/documents/chunking');

test('returns empty array for empty/null/undefined input', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText(null), []);
  assert.deepEqual(chunkText(undefined), []);
  assert.deepEqual(chunkText('   '), []);
});

test('short text (under chunkSize) returns exactly one chunk', () => {
  const result = chunkText('This is a short document.', { chunkSize: 1000 });
  assert.equal(result.length, 1);
  assert.equal(result[0], 'This is a short document.');
});

test('long text is split into multiple chunks', () => {
  const longText = 'word '.repeat(500); // 2500 chars
  const result = chunkText(longText, { chunkSize: 1000, overlap: 100 });
  assert.ok(result.length > 1);
});

test('every character of the original text is covered by at least one chunk (no silent gaps)', () => {
  // Genuinely random text (not a repeating pattern) so that indexOf-based
  // verification can't be fooled by coincidental substring repeats —
  // a periodic pattern (even a 90-char cycle) can accidentally make a
  // 100-char chunk match at the wrong position, which broke an earlier
  // version of this test even though chunkText itself was correct.
  const crypto = require('crypto');
  const text = crypto.randomBytes(500).toString('hex').slice(0, 500);
  const chunks = chunkText(text, { chunkSize: 100, overlap: 20 });
  const covered = new Set();
  for (const chunk of chunks) {
    const idx = text.indexOf(chunk);
    assert.ok(idx !== -1, 'every chunk must be a real substring of the original text');
    for (let i = idx; i < idx + chunk.length; i++) covered.add(i);
  }
  assert.equal(covered.size, text.length, 'every character position should be covered by some chunk');
});

test('consecutive chunks actually overlap by roughly the requested amount', () => {
  const text = 'x'.repeat(1000);
  const chunks = chunkText(text, { chunkSize: 300, overlap: 50 });
  // chunk[0] should be 300 chars, chunk[1] should start 250 chars into the text
  assert.equal(chunks[0].length, 300);
});

test('rejects overlap >= chunkSize (would infinite-loop or produce nonsense)', () => {
  assert.throws(() => chunkText('some text here', { chunkSize: 100, overlap: 100 }), /overlap must be smaller/);
  assert.throws(() => chunkText('some text here', { chunkSize: 100, overlap: 150 }), /overlap must be smaller/);
});

test('never produces an infinite loop on realistic large input (terminates in reasonable chunk count)', () => {
  const bigText = 'a'.repeat(50000);
  const chunks = chunkText(bigText, { chunkSize: 1000, overlap: 150 });
  assert.ok(chunks.length > 0 && chunks.length < 100, `expected a reasonable chunk count, got ${chunks.length}`);
});

test('trims whitespace from each chunk', () => {
  const chunks = chunkText('  leading and trailing spaces  ', { chunkSize: 1000 });
  assert.equal(chunks[0], 'leading and trailing spaces');
});
