// ─── Creator Studio: Auto Subtitles ───────────────────────────
// Phase 7. Real transcription via OpenAI's Whisper API — reuses the
// SAME OPENAI_API_KEY already configured for ChatGPT (if set), no new
// key needed. Genuinely works today for anyone who already has that key;
// honestly unavailable otherwise, same as any other OpenAI-gated feature.
//
// Accepts base64-encoded audio in the JSON body rather than a multipart
// file upload — this app has no file-upload middleware or storage layer
// yet, and base64-in-JSON keeps this feature self-contained without
// adding that infrastructure just for one endpoint.

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // Whisper's own API limit is 25MB

function isConfigured(openAiKey) {
  return !!openAiKey;
}

async function transcribeAudio({ audioBase64, filename = 'audio.mp3', language }, openAiKey, fetchWithTimeout, safeJson) {
  if (!openAiKey) {
    throw new Error('Auto-subtitles need an OpenAI API key. Set OPENAI_API_KEY to enable this feature.');
  }
  if (!audioBase64 || typeof audioBase64 !== 'string') {
    throw new Error('audioBase64 is required');
  }

  const buffer = Buffer.from(audioBase64, 'base64');
  if (buffer.length === 0) throw new Error('audioBase64 could not be decoded — check it is valid base64');
  if (buffer.length > MAX_AUDIO_BYTES) throw new Error(`Audio too large (max 25MB, got ${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);

  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json'); // includes per-segment timestamps, needed for real subtitles
  if (language) form.append('language', language);

  const res = await fetchWithTimeout(
    'https://api.openai.com/v1/audio/transcriptions',
    { method: 'POST', headers: { Authorization: `Bearer ${openAiKey}` }, body: form },
    60000 // transcription of a real audio file can take a while
  );
  if (!res.ok) throw new Error(`Whisper API error (${res.status}): ${(await res.text()).slice(0, 200)}`);

  const data = await safeJson(res);
  const segments = (data.segments || []).map(s => ({ start: s.start, end: s.end, text: s.text.trim() }));
  return { text: data.text, segments, language: data.language };
}

// Turns Whisper segments into a standard .srt subtitle file — real,
// working format any video editor/player understands, not a custom
// invented format.
function toSRT(segments) {
  function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
  }

  return segments.map((seg, i) =>
    `${i + 1}\n${formatTime(seg.start)} --> ${formatTime(seg.end)}\n${seg.text}\n`
  ).join('\n');
}

module.exports = { isConfigured, transcribeAudio, toSRT, MAX_AUDIO_BYTES };
