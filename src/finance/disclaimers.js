// ─── Finance Hub: Compliance Layer ────────────────────────────
// Phase 10. HONEST SCOPE, enforced in code, not just prompt wording:
//
// 1. Every Finance Hub API response includes this disclaimer as a real
//    field in the JSON, not something that only exists if the AI
//    remembers to say it. A frontend can rely on `response.disclaimer`
//    being present, always.
// 2. The "Learning" endpoint (see learningContent.js) only accepts a
//    FIXED set of asset-class topics — not free text — so it is not
//    possible to use it to ask "should I buy X right now," by
//    construction, not by asking the model to decline nicely.
// 3. Planners (planners.js) are pure calculators applying a NAMED,
//    well-known framework (e.g. the 50/30/20 rule) to numbers the user
//    provides — they compute, they do not recommend what to actually
//    buy/sell/invest in.

const DISCLAIMER = 'This is general financial education and planning math, not personalized investment, legal, or tax advice. It does not account for your full financial situation. Consult a licensed financial advisor before making investment decisions.';

function withDisclaimer(payload) {
  return { ...payload, disclaimer: DISCLAIMER };
}

module.exports = { DISCLAIMER, withDisclaimer };
