'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createVictusModelProvider, trimEndpoint } = require('../src/victus/model/openaiCompatible');

test('Victus model endpoint normalizes base URL', () => {
  assert.equal(trimEndpoint('http://127.0.0.1:8100'), 'http://127.0.0.1:8100/v1/chat/completions');
  assert.equal(trimEndpoint('http://127.0.0.1:8100/v1'), 'http://127.0.0.1:8100/v1/chat/completions');
  assert.equal(trimEndpoint('http://127.0.0.1:8100/v1/chat/completions'), 'http://127.0.0.1:8100/v1/chat/completions');
});

test('Victus model provider parses an OpenAI-compatible response', async () => {
  let captured = null;
  const provider = createVictusModelProvider({
    url: 'http://127.0.0.1:8100',
    model: 'victus-lm',
    fetchImpl: async (_url, options) => {
      captured = { _url, options };
      return { ok: true, async json() { return { choices: [{ message: { content: 'Victus response' } }] }; } };
    },
  });
  const out = await provider.call([{ role: 'user', content: 'Hello' }]);
  assert.equal(out, 'Victus response');
  assert.equal(captured.options.method, 'POST');
  assert.equal(JSON.parse(captured.options.body).model, 'victus-lm');
});

test('Victus model provider supports optional bearer auth', async () => {
  let headers;
  const provider = createVictusModelProvider({
    url: 'http://127.0.0.1:8100',
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      headers = options.headers;
      return { ok: true, async json() { return { choices: [{ message: { content: 'ok' } }] }; } };
    },
  });
  await provider.call([{ role: 'user', content: 'Hello' }]);
  assert.equal(headers.Authorization, 'Bearer test-key');
});
