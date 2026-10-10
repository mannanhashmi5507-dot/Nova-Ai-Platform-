const test = require('node:test');
const assert = require('node:assert/strict');
const { extractTextFromImage } = require('../src/documents/ocr');

test('throws a clear error when no OpenAI key is configured', async () => {
  await assert.rejects(
    () => extractTextFromImage('base64data', null, async () => ({}), async () => ({})),
    /OpenAI API key/
  );
});

test('rejects missing imageBase64', async () => {
  await assert.rejects(
    () => extractTextFromImage('', 'sk-test', async () => ({}), async () => ({})),
    /imageBase64 is required/
  );
});

test('returns extracted text and foundText=true for a real result', async () => {
  const fakeFetch = async (url, opts) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'gpt-4o-mini');
    assert.match(body.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/);
    return { ok: true };
  };
  const fakeSafeJson = async () => ({ choices: [{ message: { content: 'Invoice #123\nTotal: $50.00' } }] });
  const result = await extractTextFromImage('ZmFrZWJhc2U2NA==', 'sk-test', fakeFetch, fakeSafeJson);
  assert.equal(result.text, 'Invoice #123\nTotal: $50.00');
  assert.equal(result.foundText, true);
});

test('returns empty text and foundText=false when the model reports no readable text', async () => {
  const fakeFetch = async () => ({ ok: true });
  const fakeSafeJson = async () => ({ choices: [{ message: { content: '[no text found]' } }] });
  const result = await extractTextFromImage('data', 'sk-test', fakeFetch, fakeSafeJson);
  assert.equal(result.text, '');
  assert.equal(result.foundText, false);
});

test('respects a custom mimeType in the constructed data URL', async () => {
  let capturedUrl = null;
  const fakeFetch = async (url, opts) => {
    capturedUrl = JSON.parse(opts.body).messages[0].content[1].image_url.url;
    return { ok: true };
  };
  const fakeSafeJson = async () => ({ choices: [{ message: { content: 'text' } }] });
  await extractTextFromImage('data', 'sk-test', fakeFetch, fakeSafeJson, 'image/png');
  assert.match(capturedUrl, /^data:image\/png;base64,/);
});

test('surfaces a clear error on API failure', async () => {
  const fakeFetch = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
  await assert.rejects(() => extractTextFromImage('data', 'sk-test', fakeFetch, async () => ({})), /OCR request failed/);
});
