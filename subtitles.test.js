const test = require('node:test');
const assert = require('node:assert/strict');
const { isConfigured, transcribeAudio, toSRT, MAX_AUDIO_BYTES } = require('../src/creator/subtitles');

test('isConfigured reflects whether an OpenAI key was passed in', () => {
  assert.equal(isConfigured(null), false);
  assert.equal(isConfigured(''), false);
  assert.equal(isConfigured('sk-real-key'), true);
});

test('transcribeAudio throws a clear error when no OpenAI key is configured', async () => {
  await assert.rejects(
    () => transcribeAudio({ audioBase64: 'validbase64==' }, null, async () => ({}), async () => ({})),
    /OpenAI API key/
  );
});

test('transcribeAudio rejects missing audioBase64', async () => {
  await assert.rejects(
    () => transcribeAudio({}, 'sk-test', async () => ({}), async () => ({})),
    /audioBase64 is required/
  );
});

test('transcribeAudio rejects audio larger than the 25MB Whisper limit', async () => {
  // Construct a base64 string that decodes to > 25MB without actually
  // allocating real audio data — repeat a small valid base64 block.
  const bigBase64 = Buffer.alloc(MAX_AUDIO_BYTES + 1000).toString('base64');
  await assert.rejects(
    () => transcribeAudio({ audioBase64: bigBase64 }, 'sk-test', async () => ({}), async () => ({})),
    /too large/
  );
});

test('transcribeAudio returns text, segments, and language on success', async () => {
  const audioBase64 = Buffer.from('fake audio bytes').toString('base64');
  const fakeFetch = async (url, opts) => {
    assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(opts.method, 'POST');
    return { ok: true };
  };
  const fakeSafeJson = async () => ({
    text: 'Hello world.',
    language: 'english',
    segments: [
      { start: 0, end: 1.5, text: ' Hello' },
      { start: 1.5, end: 3.0, text: ' world.' },
    ],
  });
  const result = await transcribeAudio({ audioBase64 }, 'sk-test', fakeFetch, fakeSafeJson);
  assert.equal(result.text, 'Hello world.');
  assert.equal(result.language, 'english');
  assert.equal(result.segments.length, 2);
  assert.equal(result.segments[0].text, 'Hello'); // trimmed
});

test('transcribeAudio surfaces a clear error when the Whisper API call fails', async () => {
  const audioBase64 = Buffer.from('fake').toString('base64');
  const fakeFetch = async () => ({ ok: false, status: 400, text: async () => 'Invalid file format' });
  await assert.rejects(
    () => transcribeAudio({ audioBase64 }, 'sk-test', fakeFetch, async () => ({})),
    /Whisper API error/
  );
});

test('toSRT produces valid, correctly-numbered and correctly-timed SRT format', () => {
  const segments = [
    { start: 0, end: 1.5, text: 'Hello' },
    { start: 1.5, end: 3.25, text: 'world' },
  ];
  const srt = toSRT(segments);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,500\nHello/);
  assert.match(srt, /2\n00:00:01,500 --> 00:00:03,250\nworld/);
});

test('toSRT correctly formats timestamps beyond one hour', () => {
  const segments = [{ start: 3661.5, end: 3663, text: 'late in the video' }];
  const srt = toSRT(segments);
  assert.match(srt, /01:01:01,500/);
});

test('toSRT handles an empty segments array without throwing', () => {
  assert.equal(toSRT([]), '');
});
