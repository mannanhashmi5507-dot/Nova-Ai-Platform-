// ─── Victus: adaptive personalization layer ─────────────────
//
// HONEST SCOPE NOTE (read this before marketing it):
// "Victus" is NOT a new trained model and is not a step toward
// general/super intelligence — nobody has built that, at any
// budget. What this actually is: a real feedback + preference
// loop on top of your existing providers (Groq/Gemini/ChatGPT).
// It genuinely adapts to each user over time — remembers what
// they like, adjusts tone/detail based on their thumbs up/down
// history — which is a real, sellable personalization feature.
// Market it as "adapts to you" or "learns your preferences,"
// not as "superintelligent," so the claim matches what it does.

const db = require('../db');
const { rankPreferencesByRelevance } = require('./memoryRetrieval');

// Distill a short list of durable facts/preferences about a user from
// their recent conversation, using the same AI providers already wired
// up (no separate model needed). This is what makes Victus "adaptive" —
// it periodically writes back what it learned, and every future prompt
// reads it.
async function learnFromConversation(userId, recentMessages, getAIReply) {
  if (!db.isEnabled() || !userId || recentMessages.length < 4) return; // need enough signal

  const transcript = recentMessages
    .slice(-12)
    .map(m => `${m.role}: ${m.content}`.slice(0, 400))
    .join('\n');

  const extractionPrompt = [
    {
      role: 'system',
      content: `Extract 1-3 short, durable facts or preferences about the USER from this conversation
(e.g. "prefers short answers", "is building a WhatsApp support bot", "asks in Roman Urdu").
Ignore one-off details. Respond as plain lines "key: value", nothing else. If nothing durable, respond "none".`
    },
    { role: 'user', content: transcript }
  ];

  try {
    const { reply } = await getAIReply(extractionPrompt, 'auto');
    if (!reply || /^none/i.test(reply.trim())) return;

    const lines = reply.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines.slice(0, 3)) {
      const [key, ...rest] = line.split(':');
      if (!key || rest.length === 0) continue;
      await db.upsertPreference(userId, key.trim().toLowerCase().slice(0, 60), rest.join(':').trim().slice(0, 200));
    }
  } catch (err) {
    // Adaptive learning is a bonus layer — never let it break a chat request.
    console.warn('[Victus] learning step skipped:', err.message);
  }
}

// Build the personalization block injected into the system prompt.
// This is the actual "adaptive" behavior a user experiences: answers
// shift based on what's been learned and how their feedback has trended.
// Build the personalization block injected into the system prompt.
// This is the actual "adaptive" behavior a user experiences: answers
// shift based on what's been learned and how their feedback has trended.
//
// UPGRADED (Phase 4): previously injected ALL stored preferences
// regardless of relevance to the current message. Now retrieves only
// the preferences relevant to what the user is actually asking right
// now — see memoryRetrieval.js for the ranking logic.
async function buildAdaptiveContext(userId, currentMessage = '') {
  if (!db.isEnabled() || !userId) return '';

  // Phase 14 addition: org-level shared preferences run alongside the
  // existing personal preferences/feedback lookup. getUserOrgPreferences
  // returns [] for any user not in an organization — so this Promise.all
  // entry is a genuine no-op for every user this app had before Phase 14.
  const [prefs, feedback, orgPrefs] = await Promise.all([
    db.getPreferences(userId),
    db.getFeedbackScore(userId),
    db.getUserOrgPreferences(userId),
  ]);

  if (prefs.length === 0 && feedback.total === 0 && orgPrefs.length === 0) return '';

  const relevant = rankPreferencesByRelevance(prefs, currentMessage);

  const parts = [];
  if (orgPrefs.length > 0) {
    parts.push('Shared team preferences (apply to all responses for this organization): '
      + orgPrefs.map(p => `${p.pref_key}: ${p.pref_value}`).join('; '));
  }
  if (relevant.length > 0) {
    parts.push('Known user preferences (adapt your answers accordingly): '
      + relevant.map(p => `${p.pref_key}: ${p.pref_value}`).join('; '));
  }
  if (feedback.total >= 5) {
    const ratio = feedback.positive / feedback.total;
    if (ratio < 0.5) {
      parts.push('This user has rated recent responses poorly more often than not — '
        + 'be more concise, double-check accuracy, and avoid padding answers.');
    }
  }
  return parts.join('\n');
}

// Record a thumbs up/down on a specific assistant message.
async function recordFeedback(userId, messageId, rating) {
  if (!db.isEnabled()) return { stored: false, reason: 'Database not configured' };
  if (![1, -1].includes(rating)) return { stored: false, reason: 'rating must be 1 or -1' };
  const row = await db.saveFeedback(userId, messageId, rating);
  return { stored: !!row };
}

module.exports = { learnFromConversation, buildAdaptiveContext, recordFeedback };
