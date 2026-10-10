// ─── Shared Agent Tools ──────────────────────────────────────
// Moved here from index.js so both the original Nova Agent (/api/agent)
// and the new Phase 5 persona agents (/api/agents/:key) use the exact
// same tool implementations — no duplicated, potentially-diverging logic.

function makeTools(fetchWithTimeout, safeJson) {
  return {
    calculator: {
      description: 'Evaluate a math expression, e.g. "12 * (5 + 3) / 2"',
      run: async (input) => {
        // Only allow digits, operators, parens, decimal points, spaces —
        // never eval() raw model output.
        const clean = String(input).replace(/[^0-9+\-*/().\s]/g, '');
        if (!clean.trim()) return 'Error: not a valid expression';
        try {
          // eslint-disable-next-line no-new-func
          const result = Function(`"use strict"; return (${clean})`)();
          if (typeof result !== 'number' || !isFinite(result)) return 'Error: invalid result';
          return String(result);
        } catch {
          return 'Error: could not evaluate expression';
        }
      }
    },
    webSearch: {
      description: 'Search the web for current information, e.g. "current price of gold in Pakistan"',
      run: async (input, signal) => {
        try {
          const res = await fetchWithTimeout(
            `https://api.duckduckgo.com/?q=${encodeURIComponent(input)}&format=json&no_html=1&skip_disambig=1`,
            { signal },
            10000
          );
          if (!res.ok) return `Search failed (${res.status})`;
          const data = await safeJson(res);
          const summary = data?.AbstractText
            || data?.RelatedTopics?.find(t => t.Text)?.Text
            || 'No direct summary found for that query.';
          return summary;
        } catch (err) {
          return `Search error: ${err.message}`;
        }
      }
    }
  };
}

module.exports = { makeTools };
