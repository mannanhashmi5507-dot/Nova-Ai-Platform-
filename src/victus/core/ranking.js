'use strict';

// BM25 ranking: replaces naive "token appears" counting with term-frequency,
// inverse-document-frequency and length normalisation. Pure, deterministic.

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'were', 'it', 'this', 'that', 'with', 'as', 'at', 'by']);

function tokenize(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t && !STOP.has(t));
}

class BM25Index {
  constructor({ k1 = 1.5, b = 0.75 } = {}) {
    this.k1 = k1; this.b = b;
    this.docs = new Map(); // id -> { tf: Map, len }
    this.df = new Map();
    this.totalLen = 0;
  }

  add(id, text) {
    if (this.docs.has(id)) this.remove(id);
    const tokens = tokenize(text);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    this.docs.set(id, { tf, len: tokens.length });
    this.totalLen += tokens.length;
  }

  remove(id) {
    const d = this.docs.get(id);
    if (!d) return false;
    for (const t of d.tf.keys()) {
      const n = (this.df.get(t) || 1) - 1;
      if (n <= 0) this.df.delete(t); else this.df.set(t, n);
    }
    this.totalLen -= d.len;
    return this.docs.delete(id);
  }

  search(query, { limit = 20, allow } = {}) {
    const q = [...new Set(tokenize(query))];
    const N = this.docs.size;
    if (!q.length || !N) return [];
    const avg = this.totalLen / N || 1;
    const out = [];
    for (const [id, d] of this.docs) {
      if (allow && !allow(id)) continue;
      let score = 0;
      for (const t of q) {
        const f = d.tf.get(t);
        if (!f) continue;
        const n = this.df.get(t) || 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * (d.len / avg))));
      }
      if (score > 0) out.push({ id, score });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

module.exports = { BM25Index, tokenize };
