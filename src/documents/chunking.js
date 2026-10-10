// ─── Documents: Chunking ──────────────────────────────────────
// Phase 11. Splits extracted document text into overlapping chunks for
// embedding + retrieval. Pure function, no I/O — real RAG systems all
// do some version of this; the overlap exists so a fact split across a
// chunk boundary isn't lost entirely from either chunk.

function chunkText(text, { chunkSize = 1000, overlap = 150 } = {}) {
  if (!text || typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (overlap >= chunkSize) throw new Error('overlap must be smaller than chunkSize');

  const chunks = [];
  let start = 0;
  while (start < trimmed.length) {
    const end = Math.min(start + chunkSize, trimmed.length);
    chunks.push(trimmed.slice(start, end).trim());
    if (end === trimmed.length) break;
    start = end - overlap;
  }
  return chunks.filter(c => c.length > 0);
}

module.exports = { chunkText };
