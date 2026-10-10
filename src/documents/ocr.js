// ─── Documents: OCR ────────────────────────────────────────────
// Phase 11. HONEST SCOPE CHOICE: rather than adding a heavy traditional
// OCR dependency (e.g. tesseract.js, which ships a large WASM binary
// and is slow on typical server hardware), this uses a vision-capable
// AI model to read text from an image — reusing the SAME OPENAI_API_KEY
// already configured for ChatGPT/Whisper, no separate key, no heavy new
// dependency. Modern vision models are generally at least as accurate
// as traditional OCR on real-world photos/screenshots, and often better
// on messy/angled/handwritten text. Same "slot" pattern as everything
// else gated on an existing key.

async function extractTextFromImage(imageBase64, openAiKey, fetchWithTimeout, safeJson, mimeType = 'image/jpeg') {
  if (!openAiKey) {
    throw new Error('OCR needs an OpenAI API key. Set OPENAI_API_KEY to enable this feature.');
  }
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    throw new Error('imageBase64 is required');
  }

  const res = await fetchWithTimeout(
    'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Extract ALL visible text from this image, exactly as it appears, preserving line breaks where meaningful. Output ONLY the extracted text — no commentary, no description of the image, no "Here is the text:" preamble. If there is no readable text, output exactly: [no text found]' },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
          ]
        }],
        max_tokens: 2000,
      }),
    },
    30000
  );
  if (!res.ok) throw new Error(`OCR request failed (${res.status}): ${(await res.text()).slice(0, 200)}`);

  const data = await safeJson(res);
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('OCR returned no content');

  return { text: text === '[no text found]' ? '' : text, foundText: text !== '[no text found]' };
}

module.exports = { extractTextFromImage };
