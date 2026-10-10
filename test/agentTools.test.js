const test = require('node:test');
const assert = require('node:assert/strict');
const { makeTools } = require('../src/agents/tools');

function fakeFetch(response) {
  return async () => ({ ok: true, status: 200, ...response });
}

test('calculator evaluates a valid expression', async () => {
  const tools = makeTools(fakeFetch({}), async () => ({}));
  const result = await tools.calculator.run('12 * (5 + 3) / 2');
  assert.equal(result, '48');
});

test('calculator strips non-math characters before evaluating (injection safety)', async () => {
  const tools = makeTools(fakeFetch({}), async () => ({}));
  // Attempt to sneak in JS via require(). Letters/quotes get stripped by
  // the sanitizer, but the leftover stray parentheses make the remaining
  // string invalid syntax — so this safely errors rather than executing
  // anything. The property under test is "never executes injected code,"
  // not "always produces a clean numeric result from adversarial input."
  const result = await tools.calculator.run('1+1; require("fs")');
  assert.doesNotMatch(result, /fs|require/, 'must never leak or execute the injected code');
  assert.match(result, /^(Error|-?\d)/, 'must either safely error or return a plain number, nothing else');
});

test('calculator evaluates correctly when the input is already clean (no injection attempt)', async () => {
  const tools = makeTools(fakeFetch({}), async () => ({}));
  const result = await tools.calculator.run('1+1');
  assert.equal(result, '2');
});

test('calculator rejects an empty/invalid expression without throwing', async () => {
  const tools = makeTools(fakeFetch({}), async () => ({}));
  const result = await tools.calculator.run('   ');
  assert.match(result, /Error/);
});

test('calculator handles division by zero / non-finite results gracefully', async () => {
  const tools = makeTools(fakeFetch({}), async () => ({}));
  const result = await tools.calculator.run('1/0');
  assert.match(result, /Error/);
});

test('webSearch returns the abstract text when the fetch succeeds', async () => {
  const fakeSafeJson = async () => ({ AbstractText: 'Gold is a precious metal.' });
  const tools = makeTools(fakeFetch({}), fakeSafeJson);
  const result = await tools.webSearch.run('what is gold');
  assert.equal(result, 'Gold is a precious metal.');
});

test('webSearch falls back to a related topic when no direct abstract exists', async () => {
  const fakeSafeJson = async () => ({ AbstractText: '', RelatedTopics: [{ Text: 'A related fact.' }] });
  const tools = makeTools(fakeFetch({}), fakeSafeJson);
  const result = await tools.webSearch.run('obscure query');
  assert.equal(result, 'A related fact.');
});

test('webSearch reports a clean failure message on non-ok response, not a crash', async () => {
  const failingFetch = async () => ({ ok: false, status: 503 });
  const tools = makeTools(failingFetch, async () => ({}));
  const result = await tools.webSearch.run('anything');
  assert.match(result, /Search failed/);
});

test('webSearch reports a clean error message when fetch itself throws', async () => {
  const throwingFetch = async () => { throw new Error('network down'); };
  const tools = makeTools(throwingFetch, async () => ({}));
  const result = await tools.webSearch.run('anything');
  assert.match(result, /Search error/);
});
