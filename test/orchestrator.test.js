const test = require('node:test');
const assert = require('node:assert/strict');
const { routeMessage } = require('../src/victus/orchestrator');

test('routes plain questions to chat', () => {
  const result = routeMessage('What is the capital of France?');
  assert.equal(result.target, 'chat');
});

test('routes math questions to the agent', () => {
  const result = routeMessage('What is 847 * 23?');
  assert.equal(result.target, 'agent');
});

test('routes current-info questions to the agent', () => {
  const result = routeMessage('What is the current price of gold today?');
  assert.equal(result.target, 'agent');
});

test('routes messages containing a code block to the coding agent', () => {
  const result = routeMessage('```js\nfunction add(a,b) { return a+b }\n```\ncan you review this?');
  assert.equal(result.target, 'coding_agent');
  assert.equal(result.codingMode, 'review');
});

test('detects "fix" intent from code + bug language', () => {
  const result = routeMessage('```\nfunction foo() { return x }\n```\nthis is throwing an error, can you fix it?');
  assert.equal(result.target, 'coding_agent');
  assert.equal(result.codingMode, 'fix');
});

test('detects "explain" intent from code + explanation language', () => {
  const result = routeMessage('```\nconst x = arr.reduce((a,b) => a+b)\n```\ncan you explain what this does?');
  assert.equal(result.target, 'coding_agent');
  assert.equal(result.codingMode, 'explain');
});

test('detects "refactor" intent', () => {
  const result = routeMessage('```\nfunction f(x){if(x){return true}else{return false}}\n```\ncan you refactor this to be cleaner?');
  assert.equal(result.codingMode, 'refactor');
});

test('detects "docs" intent', () => {
  const result = routeMessage('```\nfunction add(a, b) { return a + b; }\n```\nplease add jsdoc comments');
  assert.equal(result.codingMode, 'docs');
});

test('code with no specific intent keyword defaults to explain, not an error', () => {
  const result = routeMessage('```\nconst x = 5;\n```');
  assert.equal(result.target, 'coding_agent');
  assert.equal(result.codingMode, 'explain');
});

test('code detection also catches code without triple backticks (raw pasted code)', () => {
  const result = routeMessage('function add(a, b) { return a + b; }\nwhy does this error out sometimes?');
  assert.equal(result.target, 'coding_agent');
});

test('handles empty or invalid input without throwing', () => {
  assert.equal(routeMessage('').target, 'chat');
  assert.equal(routeMessage(null).target, 'chat');
  assert.equal(routeMessage(undefined).target, 'chat');
});

test('a message needing both math and current info is still routed to agent (not chat)', () => {
  const result = routeMessage('What is the current gold price today, and what would 5 grams cost?');
  assert.equal(result.target, 'agent');
});
