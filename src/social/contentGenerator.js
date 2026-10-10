// ─── Social Media Studio: Content Generation ─────────────────
// Phase 8. Real, free, works today regardless of whether any platform
// account is actually connected — this is AI text generation, not
// posting. Platform-aware in one concrete way that matters: real
// character limits, so a generated caption doesn't get silently
// truncated when the user tries to actually post it themselves.

const PLATFORM_LIMITS = {
  instagram: { captionChars: 2200, hashtagsRecommended: 5, tone: 'visual-first, can be more casual/emotive' },
  youtube:   { captionChars: 5000, hashtagsRecommended: 3, tone: 'descriptive, can include more context/detail' },
  tiktok:    { captionChars: 2200, hashtagsRecommended: 4, tone: 'punchy, trend-aware, casual' },
  facebook:  { captionChars: 63206, hashtagsRecommended: 2, tone: 'conversational, can be longer-form' },
  x:         { captionChars: 280, hashtagsRecommended: 2, tone: 'concise, punchy — hard character limit matters a lot here' },
  linkedin:  { captionChars: 3000, hashtagsRecommended: 3, tone: 'professional, insight-driven' },
};

const VALID_PLATFORMS = Object.keys(PLATFORM_LIMITS);

function buildCaptionPrompt(platform, description, options = {}) {
  const limits = PLATFORM_LIMITS[platform];
  const toneNote = options.tone ? `Requested tone: ${options.tone}.` : `Platform-typical tone: ${limits.tone}.`;
  return [
    {
      role: 'system',
      content: `You write real, usable social media captions for ${platform}. Hard limit: ${limits.captionChars} characters — the caption MUST fit, not just approximately. ${toneNote} Write only the caption itself, no explanation, no quotes around it.`
    },
    { role: 'user', content: `Write a ${platform} caption for: ${description}` }
  ];
}

function buildTitlePrompt(platform, description) {
  return [
    {
      role: 'system',
      content: `You write short, real titles for ${platform} content. Give exactly 3 distinct title options, numbered 1-3, each on its own line, no other text.`
    },
    { role: 'user', content: `Write ${platform} titles for: ${description}` }
  ];
}

function buildHashtagPrompt(platform, description) {
  const limits = PLATFORM_LIMITS[platform];
  return [
    {
      role: 'system',
      content: `Suggest exactly ${limits.hashtagsRecommended} relevant hashtags for ${platform} content. Real, plausible hashtags people actually use for this topic — not generic filler like #love #instagood unless genuinely relevant. Respond as a single space-separated line of hashtags, nothing else.`
    },
    { role: 'user', content: `Suggest hashtags for: ${description}` }
  ];
}

function validatePlatform(platform) {
  if (!VALID_PLATFORMS.includes(platform)) {
    throw new Error(`platform must be one of: ${VALID_PLATFORMS.join(', ')}`);
  }
}

async function generateCaption(platform, description, getAIReply, signal, options) {
  validatePlatform(platform);
  if (!description || !description.trim()) throw new Error('description is required');
  const { reply, provider } = await getAIReply(buildCaptionPrompt(platform, description, options), 'auto', signal);
  const caption = reply.trim();
  return { platform, caption, characterCount: caption.length, characterLimit: PLATFORM_LIMITS[platform].captionChars, fitsLimit: caption.length <= PLATFORM_LIMITS[platform].captionChars, provider };
}

async function generateTitles(platform, description, getAIReply, signal) {
  validatePlatform(platform);
  if (!description || !description.trim()) throw new Error('description is required');
  const { reply, provider } = await getAIReply(buildTitlePrompt(platform, description), 'auto', signal);
  const titles = reply.split('\n').map(l => l.replace(/^\d+[.):\s]*/, '').trim()).filter(Boolean);
  return { platform, titles, provider };
}

async function generateHashtags(platform, description, getAIReply, signal) {
  validatePlatform(platform);
  if (!description || !description.trim()) throw new Error('description is required');
  const { reply, provider } = await getAIReply(buildHashtagPrompt(platform, description), 'auto', signal);
  const hashtags = reply.trim().split(/\s+/).filter(t => t.startsWith('#'));
  return { platform, hashtags, provider };
}

module.exports = { generateCaption, generateTitles, generateHashtags, PLATFORM_LIMITS, VALID_PLATFORMS };
