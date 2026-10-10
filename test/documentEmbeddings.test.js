const test = require('node:test');
const assert = require('node:assert/strict');
const { cosineSimilarity, rankBySimilarity, embedText } = require('../src/documents/embeddings');

test('identical vectors have cosine similarity of exactly 1', () => {
  const v = [1, 2, 3, 4];
  assert.equal(cosineSimilarity(v, v), 1);
});

test('orthogonal vectors have cosine similarity of 0', () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('opposite-direction vectors have cosine similarity of -1', () => {
  assert.equal(cosineSimilarity([1, 2, 3], [-1, -2, -3]), -1);
});

test('cosine similarity is scale-invariant (same direction, different magnitude = still 1)', () => {
  assert.equal(cosineSimilarity([1, 1, 1], [5, 5, 5]), 1);
});

test('a known non-trivial case matches the hand-computed value', () => {
  // cos_sim([1,0],[1,1]) = 1 / (1 * sqrt(2)) = 1/sqrt(2) ≈ 0.7071
  const result = cosineSimilarity([1, 0], [1, 1]);
  assert.ok(Math.abs(result - 0.7071067811865475) < 1e-9);
});

test('rejects mismatched vector lengths', () => {
  assert.throws(() => cosineSimilarity([1, 2], [1, 2, 3]), /equal length/);
});

test('rejects empty vectors', () => {
  assert.throws(() => cosineSimilarity([], []), /non-empty/);
});

test('handles a zero vector without dividing by zero / returning NaN', () => {
  const result = cosineSimilarity([0, 0, 0], [1, 2, 3]);
  assert.equal(result, 0);
  assert.ok(!Number.isNaN(result));
});

test('rankBySimilarity returns results sorted with the most similar first', () => {
  const query = [1, 0, 0];
  const candidates = [
    { id: 'far', embedding: [0, 1, 0] },     // orthogonal, similarity 0
    { id: 'close', embedding: [0.9, 0.1, 0] }, // close to query
    { id: 'exact', embedding: [1, 0, 0] },   // identical, similarity 1
  ];
  const results = rankBySimilarity(query, candidates, 3);
  assert.equal(results[0].id, 'exact');
  assert.equal(results[results.length - 1].id, 'far');
});

test('rankBySimilarity respects topK and truncates the result list', () => {
  const query = [1, 0];
  const candidates = Array.from({ length: 10 }, (_, i) => ({ id: i, embedding: [1, i] }));
  const results = rankBySimilarity(query, candidates, 3);
  assert.equal(results.length, 3);
});

test('rankBySimilarity attaches a numeric similarity field to each result', () => {
  const results = rankBySimilarity([1, 0], [{ id: 'a', embedding: [1, 0] }], 1);
  assert.equal(typeof results[0].similarity, 'number');
});

// ── embedText: gating and validation (network mocked) ──────────

test('embedText throws a clear error when no OpenAI key is configured', async () => {
  await assert.rejects(
    () => embedText('some text', null, async () => ({}), async () => ({})),
    /OpenAI API key/
  );
});

test('embedText rejects empty text', async () => {
  await assert.rejects(() => embedText('', 'sk-test', async () => ({}), async () => ({})), /text is required/);
});

test('embedText returns the real embedding vector from a successful response', async () => {
  const fakeFetch = async (url, opts) => {
    assert.equal(url, 'https://api.openai.com/v1/embeddings');
    assert.match(opts.body, /text-embedding-3-small/);
    return { ok: true };
  };
  const fakeSafeJson = async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
  const result = await embedText('hello world', 'sk-test', fakeFetch, fakeSafeJson);
  assert.deepEqual(result, [0.1, 0.2, 0.3]);
});

test('embedText surfaces a clear error on API failure', async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => 'invalid key' });
  await assert.rejects(() => embedText('x', 'sk-bad', fakeFetch, async () => ({})), /Embeddings API error/);
});
