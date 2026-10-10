// ─── Victus: Writing Style Fingerprint ───────────────────────
// Phase 4. Deliberately deterministic (no AI call) — analyzes the user's
// OWN recent messages for observable style markers, and turns that into
// a short instruction so replies can mirror their tone rather than
// defaulting to one generic "assistant voice" for everyone.
//
// This is intentionally simple pattern-matching, not stylometry research.
// It catches a few clear, common signals; it won't catch subtle style.
// That honesty matters more than pretending this is more sophisticated
// than it is.

function analyzeMessages(messages) {
  const userMessages = messages.filter(m => m.role === 'user').map(m => m.content).filter(Boolean);
  if (userMessages.length === 0) return null;

  const allText = userMessages.join(' ');
  const avgLength = allText.length / userMessages.length;

  const emojiCount = (allText.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length;
  const exclamationCount = (allText.match(/!/g) || []).length;
  const usesFormalGreeting = /\b(dear|regards|sincerely|kindly)\b/i.test(allText);
  const usesCasualMarkers = /\b(lol|lmao|hey|yo|gonna|wanna|kinda|thx|u\b|ur\b)\b/i.test(allText);
  const usesContractions = /\b(don't|can't|won't|it's|i'm|didn't|isn't)\b/i.test(allText);
  const avgSentenceLength = allText.split(/[.!?]+/).filter(Boolean)
    .reduce((sum, s, _, arr) => sum + s.trim().split(/\s+/).length / arr.length, 0);

  let formality = 'neutral';
  if (usesFormalGreeting && !usesCasualMarkers) formality = 'formal';
  else if (usesCasualMarkers || emojiCount > 0) formality = 'casual';

  let verbosity = 'moderate';
  if (avgLength < 40) verbosity = 'brief';
  else if (avgLength > 200) verbosity = 'detailed';

  return {
    formality,
    verbosity,
    usesEmoji: emojiCount > 0,
    usesExclamations: exclamationCount / userMessages.length > 0.3,
    usesContractions,
    avgSentenceLength: Math.round(avgSentenceLength),
    sampleSize: userMessages.length,
  };
}

// Turn the fingerprint into an actual instruction the model can follow.
// Kept as gentle guidance, not a rigid mimicry command — a user's own
// message style is a signal for tone matching, not a script to copy verbatim.
function toInstruction(fingerprint) {
  if (!fingerprint || fingerprint.sampleSize < 3) return ''; // not enough signal yet to be confident

  const parts = [];
  if (fingerprint.formality === 'casual') parts.push('Match a casual, relaxed tone');
  else if (fingerprint.formality === 'formal') parts.push('Match a more formal, polished tone');

  if (fingerprint.verbosity === 'brief') parts.push('keep responses short, this user writes brief messages');
  else if (fingerprint.verbosity === 'detailed') parts.push('this user writes detailed messages and likely appreciates thorough answers');

  if (fingerprint.usesEmoji) parts.push('light emoji use is fine if natural');

  if (parts.length === 0) return '';
  return `Writing style note (based on how this user writes): ${parts.join('; ')}.`;
}

module.exports = { analyzeMessages, toInstruction };
