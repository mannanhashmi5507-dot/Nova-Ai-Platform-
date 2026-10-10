// ─── Social Media Studio: Reply Assistant ────────────────────
// Phase 8. Real and free — generates reply suggestions for a comment or
// message the user pastes in. Does NOT read real comments from any
// platform (that needs the platform's API + a connected account, see
// src/social/oauth.js for the connection infrastructure that's ready
// but not live-wired to any specific platform yet).

const TONES = ['friendly', 'professional', 'witty', 'brief'];

function buildReplyPrompt(comment, tone, context) {
  const toneInstruction = {
    friendly: 'warm and approachable',
    professional: 'polished and professional',
    witty: 'clever and a little playful, without being unkind',
    brief: 'as short as possible while still being genuine',
  }[tone];

  const contextNote = context ? `\n\nContext about the post/account (for relevance): ${context}` : '';

  return [
    {
      role: 'system',
      content: `You write real reply suggestions to a social media comment. Tone: ${toneInstruction}. Give exactly 3 distinct reply options, numbered 1-3, each a complete standalone reply on its own line. Never suggest a reply that pretends to know something not stated in the comment or context — if you'd need more info to reply well, one of the 3 options can be a clarifying question.`
    },
    { role: 'user', content: `Comment to reply to: "${comment}"${contextNote}` }
  ];
}

async function generateReplySuggestions(comment, getAIReply, signal, { tone = 'friendly', context } = {}) {
  if (!comment || !comment.trim()) throw new Error('comment is required');
  if (!TONES.includes(tone)) throw new Error(`tone must be one of: ${TONES.join(', ')}`);

  const { reply, provider } = await getAIReply(buildReplyPrompt(comment, tone, context), 'auto', signal);
  const suggestions = reply.split('\n').map(l => l.replace(/^\d+[.):\s]*/, '').trim()).filter(Boolean);
  return { suggestions, tone, provider };
}

module.exports = { generateReplySuggestions, TONES };
