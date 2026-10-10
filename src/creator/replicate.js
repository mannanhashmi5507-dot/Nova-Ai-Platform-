// ─── Creator Studio: Replicate Integration ───────────────────
// Phase 7. HONEST SCOPE: image upscaling, background removal, and video
// generation all need a real model to run somewhere — there's no free
// equivalent to Pollinations for these. Replicate is a real, working
// pay-per-use API host for open models (Real-ESRGAN for upscaling,
// rembg for background removal, various text-to-video models). This is
// the same "slot" pattern as the Claude/Grok/DeepSeek providers: fully
// wired and genuinely functional the moment REPLICATE_API_TOKEN is set,
// honestly reports "not configured" otherwise — never a fake response.
//
// Model version IDs are Replicate-specific and do change over time as
// models get updated; if a call starts failing with a "version not
// found" style error, check https://replicate.com for the current
// version ID of the model in question and update MODEL_VERSIONS below.

const MODEL_VERSIONS = {
  upscale:          '42fed1c4974146d4d2414e2be2c5277c7fcf05fcc3a73abf41610695738c1d7', // Real-ESRGAN
  removeBackground: 'fb8af171cfa1616ddcf1242c093f9c46bcada5ad4cf6f2fbe8b81b330ec5c003', // rembg
  textToVideo:      '3f0457e4619daac51203dedb472816fd4af51f3149fa7a9e0b5ffcf1b8172438', // zeroscope-v2-xl
};

function isConfigured() {
  return !!(process.env.REPLICATE_API_TOKEN || '').trim();
}

async function runPrediction(versionKey, input, fetchWithTimeout, safeJson) {
  const token = (process.env.REPLICATE_API_TOKEN || '').trim();
  if (!token) {
    throw new Error(`This feature needs a Replicate API token. Set REPLICATE_API_TOKEN to enable it (get one at replicate.com/account/api-tokens).`);
  }
  const version = MODEL_VERSIONS[versionKey];
  if (!version) throw new Error(`Unknown Replicate model key: ${versionKey}`);

  const createRes = await fetchWithTimeout(
    'https://api.replicate.com/v1/predictions',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ version, input }),
    },
    20000
  );
  if (!createRes.ok) throw new Error(`Replicate request failed (${createRes.status}): ${(await createRes.text()).slice(0, 200)}`);
  const prediction = await safeJson(createRes);

  // Poll for completion — Replicate is async by design (these models can
  // take seconds to minutes). Bounded to a real timeout so a request
  // can't hang forever.
  const pollUrl = prediction.urls?.get;
  const maxAttempts = 30;
  const pollIntervalMs = 2000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    const pollRes = await fetchWithTimeout(pollUrl, { headers: { Authorization: `Bearer ${token}` } }, 10000);
    if (!pollRes.ok) throw new Error(`Replicate status check failed (${pollRes.status})`);
    const status = await safeJson(pollRes);

    if (status.status === 'succeeded') return status.output;
    if (status.status === 'failed' || status.status === 'canceled') {
      throw new Error(`Replicate prediction ${status.status}: ${status.error || 'no error detail provided'}`);
    }
    // status is 'starting' or 'processing' — keep polling
  }
  throw new Error('Replicate prediction timed out (60s) — the model may be under heavy load, try again shortly.');
}

async function upscaleImage(imageUrl, fetchWithTimeout, safeJson) {
  const output = await runPrediction('upscale', { image: imageUrl }, fetchWithTimeout, safeJson);
  return Array.isArray(output) ? output[0] : output;
}

async function removeBackground(imageUrl, fetchWithTimeout, safeJson) {
  const output = await runPrediction('removeBackground', { image: imageUrl }, fetchWithTimeout, safeJson);
  return Array.isArray(output) ? output[0] : output;
}

async function generateVideo(prompt, fetchWithTimeout, safeJson) {
  const output = await runPrediction('textToVideo', { prompt }, fetchWithTimeout, safeJson);
  return Array.isArray(output) ? output[0] : output;
}

module.exports = { isConfigured, runPrediction, upscaleImage, removeBackground, generateVideo, MODEL_VERSIONS };
