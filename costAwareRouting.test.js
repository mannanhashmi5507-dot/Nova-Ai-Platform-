const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateComplexity, applyCostBias, selectProviderOrderCostAware } = require('../src/aihub/router');

function provider(name) { return { name, available: () => true }; }

test('estimateComplexity: short plain text is simple', () => {
  assert.equal(estimateComplexity('what time is it'), 'simple');
});

test('estimateComplexity: long text is complex', () => {
  assert.equal(estimateComplexity('a '.repeat(300)), 'complex');
});

test('estimateComplexity: code content is complex regardless of length', () => {
  assert.equal(estimateComplexity('function add(a,b) { return a+b }'), 'complex');
});

test('estimateComplexity: multiple questions in one message is complex', () => {
  assert.equal(estimateComplexity('What is X? And also, what is Y? And how do they relate?'), 'complex');
});

test('estimateComplexity: medium-length plain text is moderate', () => {
  const msg = 'Can you help me understand how this particular process generally works in practice';
  assert.equal(estimateComplexity(msg), 'moderate');
});

test('applyCostBias leaves order unchanged for non-simple complexity', () => {
  const providers = [provider('Claude'), provider('Groq')];
  const result = applyCostBias(providers, 'complex');
  assert.deepEqual(result.map(p => p.name), ['Claude', 'Groq']);
});

test('applyCostBias reorders by cost tier for simple messages with no explicit preference', () => {
  const providers = [provider('Claude'), provider('Groq'), provider('ChatGPT')];
  const result = applyCostBias(providers, 'simple', false);
  // Groq is "cheap", ChatGPT is "mid", Claude is "premium" — cheap first
  assert.equal(result[0].name, 'Groq');
  assert.equal(result[result.length - 1].name, 'Claude');
});

test('applyCostBias keeps an explicit preference pinned at the front even for simple messages', () => {
  const providers = [provider('Claude'), provider('Groq'), provider('ChatGPT')]; // Claude explicitly preferred, listed first
  const result = applyCostBias(providers, 'simple', true);
  assert.equal(result[0].name, 'Claude', 'explicit user choice must not be overridden by cost heuristic');
});

test('selectProviderOrderCostAware combines availability/preference routing with cost bias', () => {
  const providers = [provider('Claude'), provider('Groq'), provider('DeepSeek')];
  const result = selectProviderOrderCostAware(providers, 'auto', new Map(), 'hi');
  // 'hi' is simple + no explicit preference => cheap providers first
  assert.notEqual(result[0].name, 'Claude');
});

test('selectProviderOrderCostAware does not reorder for a complex message', () => {
  const providers = [provider('Groq'), provider('Claude'), provider('DeepSeek')];
  const complexMsg = 'function foo() { ' + 'a'.repeat(600) + ' }';
  const result = selectProviderOrderCostAware(providers, 'auto', new Map(), complexMsg);
  assert.deepEqual(result.map(p => p.name), ['Groq', 'Claude', 'DeepSeek'], 'complex messages keep normal priority order, not cost order');
});
