// ─── Documents: Embeddings & Semantic Search Math ─────────────
// Phase 11. HONEST SCOPE: real embeddings need a real embedding model —
// there's no free equivalent to Pollinations for this. Uses OpenAI's
// embeddings API, gated behind the SAME OPENAI_API_KEY already used for
// ChatGPT/Whisper — no separate key needed. Same "slot" pattern as
// every other optional integration in this app: genuinely functional
// once the key exists, honestly unavailable otherwise.
//
// Embeddings are stored as plain JSON arrays in Postgres (JSONB), and
// similarity is computed in application code (cosine similarity, pure
// math below) rather than requiring the pgvector extension — that
// keeps this working on any standard Postgres instance (including
// Railway's default), at the cost of being slower at large scale than
// a real vector index. Honest tradeoff, not hidden.

async function embedText(text, openAiKey, fetchWithTimeout, safeJson) {
  if (!openAiKey) {
    throw new Error('Semantic search / RAG needs an OpenAI API key. Set OPENAI_API_KEY to enable this feature.');
  }
  if (!text || !text.trim()) throw new Error('text is required');

  const res = await fetchWithTimeout(
    'https://api.openai.com/v1/embeddings',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAiKey}` },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 8000) }),
    },
    20000
  );
  if (!res.ok) throw new Error(`Embeddings API error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const data = await safeJson(res);
  const embedding = data?.data?.[0]?.embedding;
  if (!embedding) throw new Error('Embeddings API returned no embedding vector');
  return embedding;
}

// Cosine similarity: the standard metric for comparing embedding
// vectors — 1 means identical direction (highly similar meaning), 0
// means unrelated, -1 means opposite. Pure math, no I/O, exhaustively
// testable.
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
    throw new Error('cosineSimilarity requires two non-empty arrays of equal length');
  }
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Given a query embedding and a list of {embedding, ...rest} candidates,
// return the top-K most similar, each annotated with its similarity score.
function rankBySimilarity(queryEmbedding, candidates, topK = 5) {
  return candidates
    .map(c => ({ ...c, similarity: cosineSimilarity(queryEmbedding, c.embedding) }))
    .sort((x, y) => y.similarity - x.similarity)
    .slice(0, topK);
}

module.exports = { embedText, cosineSimilarity, rankBySimilarity };
