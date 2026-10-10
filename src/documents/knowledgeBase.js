// ─── Documents: Knowledge Base (RAG) ──────────────────────────
// Phase 11. Ties chunking + embeddings + storage together into real
// retrieval-augmented generation: ingest a document (split → embed each
// chunk → store), then answer questions by retrieving the most relevant
// chunks (via cosine similarity, not just the whole document dumped in)
// and asking the AI to answer using only that retrieved context.

const db = require('../db');
const { chunkText } = require('./chunking');
const { embedText, rankBySimilarity } = require('./embeddings');

async function ingestDocument(documentId, userId, fullText, openAiKey, fetchWithTimeout, safeJson) {
  const chunks = chunkText(fullText);
  if (chunks.length === 0) return { chunksIndexed: 0 };

  const embedded = [];
  for (let i = 0; i < chunks.length; i++) {
    // Sequential, not Promise.all — deliberate: avoids hammering the
    // embeddings API with a burst of concurrent requests for a large
    // document, which risks hitting rate limits mid-ingestion.
    const embedding = await embedText(chunks[i], openAiKey, fetchWithTimeout, safeJson);
    embedded.push({ chunkIndex: i, text: chunks[i], embedding });
  }

  await db.saveDocumentChunks(documentId, userId, embedded);
  await db.markDocumentIndexed(documentId);
  return { chunksIndexed: embedded.length };
}

// Semantic search across ALL of a user's documents (the "knowledge
// base" search), or optionally scoped to one document (document chat).
async function semanticSearch(userId, query, openAiKey, fetchWithTimeout, safeJson, { documentId, topK = 5 } = {}) {
  const queryEmbedding = await embedText(query, openAiKey, fetchWithTimeout, safeJson);
  const candidates = documentId
    ? await db.getDocumentChunks(documentId, userId)
    : await db.getAllUserChunks(userId);

  if (candidates.length === 0) {
    return { results: [], note: 'No indexed document chunks found — upload and index a document first.' };
  }
  const results = rankBySimilarity(queryEmbedding, candidates, topK);
  return { results };
}

// Real document-grounded chat: retrieves relevant chunks, then asks the
// AI to answer using ONLY that retrieved context — the actual mechanism
// that makes this "chat with your document" rather than a generic
// chatbot that happens to have seen a document once.
async function chatWithDocuments(userId, question, getAIReply, openAiKey, fetchWithTimeout, safeJson, signal, { documentId } = {}) {
  const { results, note } = await semanticSearch(userId, question, openAiKey, fetchWithTimeout, safeJson, { documentId, topK: 5 });
  if (results.length === 0) {
    return { answer: note || 'No relevant content found in your documents.', sources: [] };
  }

  const context = results.map((r, i) => `[${i + 1}] (from "${r.filename || 'document'}"):\n${r.text}`).join('\n\n');
  const messages = [
    {
      role: 'system',
      content: `Answer the user's question using ONLY the provided document excerpts below. If the excerpts don't contain enough information to answer, say so plainly rather than filling in from general knowledge. Cite which excerpt(s) you used by number, e.g. "[1]".\n\nDocument excerpts:\n${context}`
    },
    { role: 'user', content: question }
  ];

  const { reply, provider } = await getAIReply(messages, 'auto', signal);
  return {
    answer: reply.trim(),
    provider,
    sources: results.map(r => ({ documentId: r.documentId, filename: r.filename, chunkText: r.text.slice(0, 200), similarity: Math.round(r.similarity * 1000) / 1000 })),
  };
}

module.exports = { ingestDocument, semanticSearch, chatWithDocuments };
