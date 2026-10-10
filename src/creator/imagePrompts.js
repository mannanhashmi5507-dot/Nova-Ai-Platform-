// ─── Creator Studio: Image Prompt Templates ──────────────────
// Phase 7. Real, free, works today — no paid API needed. Wraps the
// user's raw idea into a well-engineered prompt for each specialized
// mode, then hands off to the existing Pollinations image generation
// (same free provider /api/image already uses). This is genuinely
// useful prompt engineering, not a fake "logo generator" — the honest
// framing is "a specialized image generation mode," since there's no
// vector/SVG output, no transparent-background guarantee, and no
// brand-guideline awareness the way a dedicated logo tool would have.

const TEMPLATES = {
  general: (idea) => idea,

  logo: (idea) => `minimalist professional logo design, ${idea}, vector style, clean lines, flat design, simple, centered composition, solid plain background, no text unless specified, high contrast, iconic`,

  poster: (idea) => `professional poster design, ${idea}, bold typography space, striking composition, high visual impact, well-balanced layout, print-ready quality, vibrant but cohesive color palette`,

  product: (idea) => `professional product photography, ${idea}, studio lighting, clean plain background, sharp focus, commercial quality, centered composition, realistic textures, no distracting elements`,

  thumbnail: (idea) => `eye-catching video thumbnail, ${idea}, bold contrast, clear focal point, vibrant colors, dramatic lighting, designed to stand out at small size, no clutter`,
};

const VALID_STYLES = Object.keys(TEMPLATES);

function buildImagePrompt(style, idea) {
  if (!VALID_STYLES.includes(style)) {
    throw new Error(`style must be one of: ${VALID_STYLES.join(', ')}`);
  }
  if (!idea || typeof idea !== 'string' || !idea.trim()) {
    throw new Error('idea/description is required');
  }
  return TEMPLATES[style](idea.trim().slice(0, 300)); // cap the raw idea so the final prompt stays reasonable
}

module.exports = { buildImagePrompt, VALID_STYLES };
