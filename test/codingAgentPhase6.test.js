const test = require('node:test');
const assert = require('node:assert/strict');
const { runCodingAgent, VALID_MODES, DESCRIPTION_MODES } = require('../src/devhub/codingAgent');

test('VALID_MODES now includes the Phase 6 additions', () => {
  for (const mode of ['generate', 'test', 'scaffold']) {
    assert.ok(VALID_MODES.includes(mode), `missing new mode: ${mode}`);
  }
  // Phase-earlier modes must still be present — no regressions
  for (const mode of ['explain', 'fix', 'review', 'refactor', 'docs']) {
    assert.ok(VALID_MODES.includes(mode));
  }
});

test('generate and scaffold are correctly marked as description-based modes', () => {
  assert.deepEqual(DESCRIPTION_MODES.sort(), ['generate', 'scaffold']);
});

test('generate mode builds a code-writing prompt from a description', async () => {
  let captured = null;
  const fakeGetAIReply = async (messages) => { captured = messages; return { reply: 'code here', provider: 'Test' }; };
  await runCodingAgent({ mode: 'generate', code: 'a function that reverses a string', language: 'python' }, fakeGetAIReply);
  assert.match(captured[0].content, /writing new code from a description/i);
  assert.match(captured[1].content, /reverses a string/);
});

test('test mode includes the specified framework when given', async () => {
  let captured = null;
  const fakeGetAIReply = async (messages) => { captured = messages; return { reply: 'tests here', provider: 'Test' }; };
  await runCodingAgent({ mode: 'test', code: 'function add(a,b){return a+b}', language: 'javascript', extra: { framework: 'jest' } }, fakeGetAIReply);
  assert.match(captured[0].content, /using jest/i);
});

test('test mode falls back to "idiomatic" framework language when none is specified', async () => {
  let captured = null;
  const fakeGetAIReply = async (messages) => { captured = messages; return { reply: 'tests here', provider: 'Test' }; };
  await runCodingAgent({ mode: 'test', code: 'function add(a,b){return a+b}' }, fakeGetAIReply);
  assert.match(captured[0].content, /idiomatic test framework/i);
});

test('scaffold mode builds a project-structure prompt and is explicit it is a starting point only', async () => {
  let captured = null;
  const fakeGetAIReply = async (messages) => { captured = messages; return { reply: 'file tree here', provider: 'Test' }; };
  await runCodingAgent({ mode: 'scaffold', code: 'a simple Express REST API' }, fakeGetAIReply);
  assert.match(captured[0].content, /STARTING POINT/);
  assert.match(captured[1].content, /simple Express REST API/);
});

test('description-mode validation error says "description is required", not "code"', async () => {
  await assert.rejects(
    () => runCodingAgent({ mode: 'generate', code: '' }, async () => ({})),
    /description is required/
  );
});

test('code-mode validation error still says "code is required" for non-description modes', async () => {
  await assert.rejects(
    () => runCodingAgent({ mode: 'review', code: '' }, async () => ({})),
    /code is required/
  );
});

test('rejects an unknown mode', async () => {
  await assert.rejects(
    () => runCodingAgent({ mode: 'not-a-real-mode', code: 'x' }, async () => ({})),
    /mode must be one of/
  );
});
