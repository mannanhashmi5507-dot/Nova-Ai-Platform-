// ─── Victus: Agent Orchestration ─────────────────────────────
// Phase 4. Right now nova-ai has three separate capabilities a message
// could need: plain chat, Nova Agent (tool use — calculator/web search),
// and the Developer Hub coding agent (explain/fix/review/refactor/docs).
// Previously a user had to know which endpoint to call. This module
// decides which one a message actually needs, from the message text
// alone — a real (if simple) orchestration layer, not just a UI dropdown.
//
// HONEST SCOPE: this is rule-based classification (keyword/pattern
// matching), not a learned classifier. That's a deliberate choice — it's
// deterministic, testable, explainable, and costs nothing to run. An
// LLM-based classifier would be more flexible but slower, costs a call
// per message, and is harder to test exhaustively. Rule-based is the
// right tool for a scoped decision like this one.

const MATH_PATTERN = /(\d+\s*[\+\-\*/]\s*\d+|calculate|what is \d|percent of|square root|\d+\s*%)/i;
const SEARCH_PATTERN = /\b(current|latest|today|right now|this week|price of|weather in|who is the current|search for|look up)\b/i;
const CODE_PATTERN = /```|\bfunction\b|\bconst\b|\bclass\b|\bdef\b|\bimport\b.*\bfrom\b|;\s*$/m;
const CODE_INTENT = {
  fix:      /\b(fix|bug|error|not working|broken|debug|why (is|does)\b.*(fail|crash|error))\b/i,
  security: /\b(security|vulnerability|vulnerabilit(?:y|ies)|secure this|auth bug|injection|xss|csrf)\b/i,
  optimize: /\b(optimi[sz]e|performance|speed up|faster|latency|memory usage|slow)\b/i,
  refactor: /\b(refactor|clean up|improve this code|make this cleaner|simplify this)\b/i,
  migrate:  /\b(migrate|migration|upgrade from|port to|replace .*api|move to)\b/i,
  review:   /\b(review|code review|is this good|any issues|feedback on this code)\b/i,
  docs:     /\b(document|add comments|generate docs|jsdoc|docstring)\b/i,
  architect:/\b(architect|architecture|design this system|system design|project structure)\b/i,
  test:     /\b(write tests|add tests|unit tests|test this|testing strategy)\b/i,
  explain:  /\b(explain|what does this (do|code)|walk me through|how does this work)\b/i,
};
const DESCRIPTION_INTENT = {
  architect: /\b(architect|architecture|design this system|system design|project structure)\b/i,
  generate:  /\b(generate|write|build|create)\b.*\b(code|program|function|api|app|script)\b/i,
  scaffold:  /\b(scaffold|starter project|project skeleton|file tree)\b/i,
};

// Decide which capability should handle this message.
// Returns { target: 'chat' | 'agent' | 'coding_agent', reason, codingMode? }
function routeMessage(message) {
  if (!message || typeof message !== 'string') return { target: 'chat', reason: 'empty or invalid input' };

  const hasCodeBlock = message.includes('```') || CODE_PATTERN.test(message);

  for (const [mode, pattern] of Object.entries(DESCRIPTION_INTENT)) {
    if (pattern.test(message) && !hasCodeBlock) {
      return { target: 'coding_agent', codingMode: mode, reason: `matches coding workflow \"${mode}\" without requiring existing code` };
    }
  }

  if (hasCodeBlock) {
    for (const [mode, pattern] of Object.entries(CODE_INTENT)) {
      if (pattern.test(message)) {
        return { target: 'coding_agent', codingMode: mode, reason: `contains code and matches "${mode}" intent` };
      }
    }
    // Code present but no clear intent keyword — default to explain,
    // the safest/most generally useful mode for "here's code, help."
    return { target: 'coding_agent', codingMode: 'explain', reason: 'contains code, no specific intent keyword, defaulting to explain' };
  }

  const needsMath = MATH_PATTERN.test(message);
  const needsCurrentInfo = SEARCH_PATTERN.test(message);
  if (needsMath || needsCurrentInfo) {
    return { target: 'agent', reason: needsMath && needsCurrentInfo ? 'needs both calculation and current info' : needsMath ? 'needs calculation' : 'needs current/live information' };
  }

  return { target: 'chat', reason: 'no tool-use or code signal detected' };
}

module.exports = { routeMessage };
