// Tests for src/aihub/router.js — the model routing layer.
// Pure function, no mocking needed beyond simple fake provider objects.

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectProviderOrder } = require('../src/aihub/router');

function provider(name, isAvailable = true) {
  return { name, available: () => isAvailable };
}

test('drops unavailable providers entirely', () => {
  const providers = [provider('Groq', true), provider('Claude', false), provider('Gemini', true)];
  const result = selectProviderOrder(providers, 'auto', new Map());
  assert.deepEqual(result.map(p => p.name), ['Groq', 'Gemini']);
});

test('drops providers currently in a cooldown window', () => {
  const providers = [provider('Groq'), provider('Claude'), provider('Gemini')];
  const now = 1_000_000;
  const cooldowns = new Map([['Claude', now + 30_000]]); // still 30s left
  const result = selectProviderOrder(providers, 'auto', cooldowns, now);
  assert.deepEqual(result.map(p => p.name), ['Groq', 'Gemini']);
});

test('includes a provider again once its cooldown has expired', () => {
  const providers = [provider('Groq'), provider('Claude')];
  const now = 1_000_000;
  const cooldowns = new Map([['Claude', now - 1]]); // expired 1ms ago
  const result = selectProviderOrder(providers, 'auto', cooldowns, now);
  assert.deepEqual(result.map(p => p.name), ['Groq', 'Claude']);
});

test('with no real preference ("auto"), keeps original registration order', () => {
  const providers = [provider('Groq'), provider('Gemini'), provider('ChatGPT')];
  const result = selectProviderOrder(providers, 'auto', new Map());
  assert.deepEqual(result.map(p => p.name), ['Groq', 'Gemini', 'ChatGPT']);
});

test('"victor" is treated as a pipeline mode, not a provider preference — no reordering', () => {
  const providers = [provider('Groq'), provider('Claude'), provider('Gemini')];
  const result = selectProviderOrder(providers, 'victor', new Map());
  assert.deepEqual(result.map(p => p.name), ['Groq', 'Claude', 'Gemini']);
});

test('moves the preferred provider to the front when available', () => {
  const providers = [provider('Groq'), provider('Claude'), provider('Gemini'), provider('ChatGPT')];
  const result = selectProviderOrder(providers, 'gemini', new Map()); // lowercase, as the frontend sends it
  assert.deepEqual(result.map(p => p.name), ['Gemini', 'Groq', 'Claude', 'ChatGPT']);
});

test('preference matching is case-insensitive', () => {
  const providers = [provider('Groq'), provider('Claude')];
  const result = selectProviderOrder(providers, 'CLAUDE', new Map());
  assert.equal(result[0].name, 'Claude');
});

test('falls back gracefully when the preferred provider is unavailable, instead of throwing', () => {
  const providers = [provider('Groq'), provider('Claude', false), provider('Gemini')];
  const result = selectProviderOrder(providers, 'claude', new Map());
  // Claude isn't available, so it should simply be excluded — Groq/Gemini
  // keep their normal order, no error, no crash.
  assert.deepEqual(result.map(p => p.name), ['Groq', 'Gemini']);
});

test('falls back gracefully when the preferred provider is in cooldown', () => {
  const providers = [provider('Groq'), provider('Claude'), provider('Gemini')];
  const now = 1_000_000;
  const cooldowns = new Map([['Claude', now + 60_000]]);
  const result = selectProviderOrder(providers, 'claude', cooldowns, now);
  assert.deepEqual(result.map(p => p.name), ['Groq', 'Gemini']);
});

test('preferred provider already first: no-op, no duplicate, no crash', () => {
  const providers = [provider('Groq'), provider('Claude')];
  const result = selectProviderOrder(providers, 'groq', new Map());
  assert.deepEqual(result.map(p => p.name), ['Groq', 'Claude']);
});

test('returns an empty array (not an error) when every provider is unavailable', () => {
  const providers = [provider('Groq', false), provider('Claude', false)];
  const result = selectProviderOrder(providers, 'auto', new Map());
  assert.deepEqual(result, []);
  // The caller (getAIReply in index.js) is responsible for turning an
  // empty result into a real error — this pure function just reports state.
});

test('unknown preferred name (typo, or a provider that was removed) falls back to normal order', () => {
  const providers = [provider('Groq'), provider('Gemini')];
  const result = selectProviderOrder(providers, 'gpt-9-that-does-not-exist', new Map());
  assert.deepEqual(result.map(p => p.name), ['Groq', 'Gemini']);
});
