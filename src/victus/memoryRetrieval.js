// ─── Victus: Memory Retrieval ────────────────────────────────
// Phase 4. Previously, buildAdaptiveContext() injected up to 20 stored
// preferences into every prompt regardless of whether they were relevant
// to the current message — a user's "prefers Roman Urdu replies" fact
// would get dumped in even when they're asking about calculus. That's
// wasted tokens and can actively confuse the model with irrelevant context.
//
// This module ranks stored preferences by relevance to the CURRENT
// message using keyword overlap — no embeddings API needed, so it works
// offline and costs nothing extra to run. It's not as good as real
// semantic search, but it's real, deterministic, and testable, which a
// hidden "just trust the LLM to ignore irrelevant context" approach isn't.

const STOPWORDS = new Set(['the','a','an','is','are','was','were','to','of','in','on','for','and','or','but','i','you','it','this','that','my','your','me','with','be','do','does','can','how','what','why','when']);

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

function scoreRelevance(preference, queryTokens) {
  const prefTokens = new Set(tokenize(`${preference.pref_key} ${preference.pref_value}`));
  let overlap = 0;
  for (const t of queryTokens) if (prefTokens.has(t)) overlap++;
  return overlap;
}

// Rank stored preferences by relevance to the current message, falling
// back to recency when nothing scores above zero — some preferences
// (like general tone/length preferences) are always relevant even
// without keyword overlap, so a total-zero result still returns the
// most recent few rather than nothing.
function rankPreferencesByRelevance(preferences, currentMessage, maxResults = 6) {
  if (preferences.length === 0) return [];

  const queryTokens = tokenize(currentMessage);
  const scored = preferences.map(p => ({ pref: p, score: scoreRelevance(p, queryTokens) }));

  const anyRelevant = scored.some(s => s.score > 0);
  if (!anyRelevant) {
    // preferences are already ordered most-recent-first from the DB query
    return preferences.slice(0, Math.min(3, maxResults));
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .filter(s => s.score > 0)
    .map(s => s.pref);
}

module.exports = { rankPreferencesByRelevance, tokenize };
