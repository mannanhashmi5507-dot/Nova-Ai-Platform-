// ─── Finance Hub: Learning ────────────────────────────────────
// Phase 10. HOW THE "NO PERSONALIZED ADVICE" BOUNDARY IS ENFORCED HERE:
// this endpoint does NOT accept free-text questions. It only accepts one
// of a fixed set of asset-class topics (see TOPICS below). That means
// "should I buy Tesla stock right now" is not a request this module can
// even receive — not because the AI was told to refuse it, but because
// there is no input field for a free-form question. This is a stronger
// guarantee than a system-prompt instruction, which a clever enough
// prompt could in principle talk a model out of.

const TOPICS = {
  stocks:      'individual company stocks — what owning a share represents, how prices move, and the general risk/reward profile',
  etfs:        'ETFs (exchange-traded funds) — what they are, how they differ from individual stocks, common types',
  index_funds: 'index funds — what an index is, how index funds work, why they are often discussed as a passive investing strategy',
  property:    'real estate as an asset class — how property investment generally works, liquidity, leverage, common costs',
  businesses:  'owning/investing in a business — equity vs. debt, risk profile, how business value is generally assessed',
  gold:        'gold and precious metals as an asset class — historical role, common ways to hold it, how it is generally discussed as an inflation hedge',
  crypto:      'cryptocurrency as an asset class — how it works at a high level, volatility, custody/security basics',
  lending:     'peer-to-peer lending / private lending as an asset class — how it generally works, credit risk, illiquidity',
};

const VALID_TOPICS = Object.keys(TOPICS);

function buildLearningPrompt(topic) {
  return [
    {
      role: 'system',
      content: `You are a financial EDUCATION assistant, not an advisor. Explain ${TOPICS[topic]} in clear, general, educational terms.
STRICT RULES:
- Never recommend a specific stock, fund, coin, property, or business by name as something to buy.
- Never give a personalized recommendation ("you should invest in...").
- Never claim to predict future prices/returns.
- Cover general mechanics, typical risk/reward characteristics, and common considerations — the kind of thing in an intro finance textbook.
- If relevant, briefly note that historical performance does not predict future results.`
    },
    { role: 'user', content: `Explain ${topic.replace('_', ' ')} as a general educational topic.` }
  ];
}

async function getLearningContent(topic, getAIReply, signal) {
  if (!VALID_TOPICS.includes(topic)) {
    throw new Error(`topic must be one of: ${VALID_TOPICS.join(', ')} (free-text topics are not accepted — see learningContent.js for why)`);
  }
  const { reply, provider } = await getAIReply(buildLearningPrompt(topic), 'auto', signal);
  return { topic, content: reply.trim(), provider };
}

module.exports = { getLearningContent, VALID_TOPICS, TOPICS };
