const test = require('node:test');
const assert = require('node:assert/strict');
const { isConfigured, runPrediction, upscaleImage } = require('../src/creator/replicate');

test('isConfigured reflects whether REPLICATE_API_TOKEN is set', () => {
  const original = process.env.REPLICATE_API_TOKEN;
  delete process.env.REPLICATE_API_TOKEN;
  assert.equal(isConfigured(), false);
  process.env.REPLICATE_API_TOKEN = 'r8_test123';
  assert.equal(isConfigured(), true);
  if (original === undefined) delete process.env.REPLICATE_API_TOKEN; else process.env.REPLICATE_API_TOKEN = original;
});

test('runPrediction throws a clear, honest error when no token is configured', async () => {
  const original = process.env.REPLICATE_API_TOKEN;
  delete process.env.REPLICATE_API_TOKEN;
  await assert.rejects(
    () => runPrediction('upscale', {}, async () => ({}), async () => ({})),
    /Replicate API token/
  );
  if (original !== undefined) process.env.REPLICATE_API_TOKEN = original;
});

test('runPrediction rejects an unknown model key', async () => {
  process.env.REPLICATE_API_TOKEN = 'r8_test123';
  await assert.rejects(
    () => runPrediction('not-a-real-model', {}, async () => ({ ok: true }), async () => ({})),
    /Unknown Replicate model key/
  );
});

test('runPrediction polls until status becomes "succeeded" and returns the output', async () => {
  process.env.REPLICATE_API_TOKEN = 'r8_test123';
  const responses = [
    { status: 'starting' },
    { status: 'processing' },
    { status: 'succeeded', output: ['https://example.com/result.png'] },
  ];
  let createCalled = false;
  const fetchImpl = async (url, opts) => {
    if (!createCalled && opts?.method === 'POST') { createCalled = true; return { ok: true }; }
    return { ok: true }; // subsequent poll calls
  };
  const safeJsonImpl = (() => {
    let call = 0;
    return async () => {
      if (call === 0) { call++; return { urls: { get: 'https://api.replicate.com/v1/predictions/abc' } }; }
      const result = responses[Math.min(call - 1, responses.length - 1)];
      call++;
      return result;
    };
  })();

  const output = await runPrediction('upscale', { image: 'x' }, fetchImpl, safeJsonImpl);
  assert.deepEqual(output, ['https://example.com/result.png']);
});

test('runPrediction throws with the real error message when the prediction fails', async () => {
  process.env.REPLICATE_API_TOKEN = 'r8_test123';
  const fetchImpl = async () => ({ ok: true });
  const safeJsonImpl = (() => {
    let call = 0;
    return async () => {
      if (call === 0) { call++; return { urls: { get: 'https://x' } }; }
      call++;
      return { status: 'failed', error: 'model input was invalid' };
    };
  })();
  await assert.rejects(
    () => runPrediction('upscale', {}, fetchImpl, safeJsonImpl),
    /model input was invalid/
  );
});

test('runPrediction surfaces a clear error when the creation request itself fails', async () => {
  process.env.REPLICATE_API_TOKEN = 'r8_test123';
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'Invalid token' });
  await assert.rejects(
    () => runPrediction('upscale', {}, fetchImpl, async () => ({})),
    /Replicate request failed/
  );
});

test('upscaleImage unwraps a single-element array output to a plain URL string', async () => {
  process.env.REPLICATE_API_TOKEN = 'r8_test123';
  const fetchImpl = async () => ({ ok: true });
  const safeJsonImpl = (() => {
    let call = 0;
    return async () => {
      if (call === 0) { call++; return { urls: { get: 'https://x' } }; }
      call++;
      return { status: 'succeeded', output: ['https://example.com/upscaled.png'] };
    };
  })();
  const result = await upscaleImage('https://example.com/small.png', fetchImpl, safeJsonImpl);
  assert.equal(result, 'https://example.com/upscaled.png');
});
