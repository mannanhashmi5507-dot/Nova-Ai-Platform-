// ─── Victus: Context Compression ─────────────────────────────
// Phase 4. Real problem this solves: a long conversation means every
// future message re-sends the ENTIRE history to the AI provider — that's
// real, growing cost and slower responses the longer a conversation runs.
//
// Strategy: once a conversation crosses COMPRESS_THRESHOLD messages since
// the last summary, distill the older turns into a compact summary
// (using the same AI providers already wired up), store it on the
// conversation, and reset the counter. Future prompts use [summary] +
// [last few raw messages] instead of the full raw history — smaller,
// cheaper, and the model still has the context that matters.
//
// This intentionally trades a small amount of fidelity (exact wording of
// old turns) for a real, ongoing cost reduction on long conversations.
// That trade is made explicit here, not hidden.

const COMPRESS_THRESHOLD = 12; // messages since last summary
const KEEP_RAW_MESSAGES = 6;   // most recent raw messages always kept verbatim

function shouldCompress(messagesSinceSummary, threshold = COMPRESS_THRESHOLD) {
  return messagesSinceSummary >= threshold;
}

// Pure: assembles what actually gets sent to the AI provider, given an
// existing summary (if any) and the full raw history. No network call —
// fully testable without mocking AI.
function buildPromptContext(existingSummary, fullHistory) {
  if (!existingSummary) {
    return { contextNote: null, recentMessages: fullHistory };
  }
  const recentMessages = fullHistory.slice(-KEEP_RAW_MESSAGES);
  const contextNote = `Summary of earlier conversation (for context, not verbatim): ${existingSummary}`;
  return { contextNote, recentMessages };
}

// The actual compression step: summarize the OLDER portion of history
// (everything except the last KEEP_RAW_MESSAGES) into a short paragraph,
// merging with any previous summary so nothing gets silently dropped
// across repeated compressions.
async function generateSummary(fullHistory, previousSummary, getAIReply) {
  const olderMessages = fullHistory.slice(0, -KEEP_RAW_MESSAGES);
  if (olderMessages.length === 0) return previousSummary || null;

  const transcript = olderMessages.map(m => `${m.role}: ${m.content}`.slice(0, 500)).join('\n');
  const priorNote = previousSummary ? `Previous summary to build on: ${previousSummary}\n\n` : '';

  const messages = [
    {
      role: 'system',
      content: 'Summarize this part of a conversation in 3-5 sentences. Keep concrete facts, decisions, names, and numbers — drop small talk and filler. This summary will replace the raw messages as context for future replies, so it must preserve anything that matters for continuity.'
    },
    { role: 'user', content: `${priorNote}Conversation to summarize:\n${transcript}` }
  ];

  try {
    const { reply } = await getAIReply(messages, 'auto');
    return reply?.trim() || previousSummary || null;
  } catch (err) {
    // Compression is a cost-optimization, not a correctness requirement —
    // if it fails, just keep using the previous summary (or none) rather
    // than breaking the conversation.
    console.warn('[Victus contextCompression] summary generation skipped:', err.message);
    return previousSummary || null;
  }
}

module.exports = { shouldCompress, buildPromptContext, generateSummary, COMPRESS_THRESHOLD, KEEP_RAW_MESSAGES };
