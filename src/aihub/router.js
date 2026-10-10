// ─── AI Hub: Model Routing Layer ─────────────────────────────
// Phase 3. This is deliberately extracted as a PURE function — no network
// calls, no side effects, just: given the current provider list, cooldown
// state, and the user's preference, decide the order to try providers in.
//
// Why pull this out of index.js: the actual network-calling logic
// (fetch, timeouts, parsing each provider's response shape) is inherently
// untestable without mocking a lot of HTTP — but the ROUTING DECISION
// itself (which provider goes first, which are skipped) is simple logic
// that deserves real unit tests, and previously had none. Extracting it
// here means it now does.
//
// Current strategy: "preferred-first with automatic fallback."
//   1. Drop any provider that's unavailable (no key configured) or in a
//      cooldown window (from a recent rate-limit hit).
//   2. If the user asked for a specific provider, move it to the front of
//      the remaining list — but if it's unavailable, fall back through
//      the rest rather than failing outright.
//   3. Everything else keeps its original priority order (defined by the
//      order providers are registered in AI_PROVIDERS).
//
// NOT implemented yet, despite being on the roadmap: cost-aware routing
// (preferring a cheaper model when quality requirements allow it). That's
// scoped for Phase 4 (Victus), since it needs Victus's per-user context to
// decide when "cheaper" is an acceptable tradeoff. Building it here first
// would mean guessing at that logic twice.

function selectProviderOrder(providers, preferred, cooldowns, now = Date.now()) {
  let available = providers.filter(p => {
    if (!p.available()) return false;
    const cooldownUntil = cooldowns.get(p.name);
    if (cooldownUntil && now < cooldownUntil) return false;
    return true;
  });

  const hasRealPreference = preferred && preferred !== 'auto' && preferred !== 'victor';
  if (hasRealPreference) {
    const idx = available.findIndex(p => p.name.toLowerCase() === preferred.toLowerCase());
    if (idx > 0) {
      available = [available[idx], ...available.slice(0, idx), ...available.slice(idx + 1)];
    }
    // idx === 0: already first, nothing to do.
    // idx === -1: preferred provider isn't available right now (no key, or
    // in cooldown) — fall through to the rest in their normal order rather
    // than throwing, since "the user's favorite model is temporarily rate
    // limited" shouldn't mean "the whole chat fails."
  }

  return available;
}

// ── Phase 4: cost-aware routing ───────────────────────────────
// Opt-in only — existing callers of selectProviderOrder() are completely
// unaffected (see the 5th `options` parameter, defaulted to {}).
//
// Idea: not every message needs the most capable/expensive model. A
// simple factual question or a short follow-up can go to a cheap/free
// provider; something long, technical, or clearly hard should still get
// a strong one. This is a coarse heuristic, not a real cost-optimization
// engine — it costs nothing to run (no AI call to decide), which matters
// since adding an AI call just to pick a cheaper AI call would defeat
// the purpose.
//
// Cost tiers are a rough ordering, not real-time pricing data — update
// this table if a provider's actual pricing changes meaningfully.
const PROVIDER_COST_TIER = {
  Pollinations: 'free',
  LocalModel:   'free',
  Victus:       'free',
  Groq:         'cheap',
  DeepSeek:     'cheap',
  Gemini:       'cheap',
  Grok:         'mid',
  ChatGPT:      'mid',
  MyModel:      'mid',
  Claude:       'premium',
};
const TIER_RANK = { free: 0, cheap: 1, mid: 2, premium: 3 };

// Very coarse complexity estimate from the message text alone — no AI
// call. Long messages, code, or multi-part questions skew toward
// "complex" (keep quality-first ordering); short simple messages skew
// toward "simple" (cost savings are safe).
function estimateComplexity(message) {
  if (!message || typeof message !== 'string') return 'simple';
  const length = message.length;
  const hasCode = message.includes('```') || /\bfunction\b|\bclass\b|\bdef\b/.test(message);
  const multiPart = (message.match(/\?/g) || []).length > 1;

  if (hasCode || length > 500 || multiPart) return 'complex';
  if (length < 80) return 'simple';
  return 'moderate';
}

// Given an already-availability-filtered provider list (output of the
// function above), re-sort with a cost bias for simple messages. If the
// user had an explicit preference, that provider stays pinned in front —
// an explicit choice should still win over a cost heuristic. In "auto"
// mode there's no explicit choice to protect, so the whole list is
// eligible for cost-based reordering.
function applyCostBias(orderedProviders, complexity, hasExplicitPreference = false) {
  if (complexity !== 'simple' || orderedProviders.length <= 1) return orderedProviders;

  const byCost = (a, b) => {
    const rankA = TIER_RANK[PROVIDER_COST_TIER[a.name]] ?? TIER_RANK.mid;
    const rankB = TIER_RANK[PROVIDER_COST_TIER[b.name]] ?? TIER_RANK.mid;
    return rankA - rankB;
  };

  if (hasExplicitPreference) {
    const [first, ...rest] = orderedProviders;
    return [first, ...[...rest].sort(byCost)];
  }
  return [...orderedProviders].sort(byCost);
}

// Convenience wrapper combining availability/preference routing with the
// optional cost-aware bias in one call, for callers (like getAIReply)
// that want both without duplicating the "was there a real preference"
// check themselves.
function selectProviderOrderCostAware(providers, preferred, cooldowns, message, now = Date.now()) {
  const ordered = selectProviderOrder(providers, preferred, cooldowns, now);
  const hasExplicitPreference = !!(preferred && preferred !== 'auto' && preferred !== 'victor');
  const complexity = estimateComplexity(message);
  return applyCostBias(ordered, complexity, hasExplicitPreference);
}

module.exports = { selectProviderOrder, estimateComplexity, applyCostBias, selectProviderOrderCostAware, PROVIDER_COST_TIER };
