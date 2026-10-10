'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runCodingAgent, VALID_MODES, MAX_CODE_LENGTH } = require('../src/devhub/codingAgent');

test('upgraded coding agent exposes new engineering modes', () => {
  for (const mode of ['architect', 'optimize', 'security', 'migrate']) assert.ok(VALID_MODES.includes(mode));
  assert.ok(MAX_CODE_LENGTH > 20000);
});

test('deep coding mode performs plan, implementation and verification passes', async () => {
  const calls = [];
  const fake = async messages => {
    calls.push(messages[0].content);
    if (calls.length === 1) return { reply: 'OBJECTIVE\nfix bug\nPLAN\n1. inspect\nVERIFICATION\nrun tests', provider: 'Test' };
    if (calls.length === 2) return { reply: 'ROOT CAUSE: x\nFIX: y', provider: 'Test' };
    return { reply: 'PASS\nNo unsupported claims.', provider: 'Test' };
  };
  const result = await runCodingAgent({ mode: 'fix', depth: 'deep', code: 'function x(){ return 1; }' }, fake);
  assert.equal(calls.length, 3);
  assert.equal(result.trace.length, 4);
  assert.deepEqual(result.trace.map(x => x.stage), ['preflight', 'plan', 'implementation', 'verification']);
  assert.match(result.result, /ROOT CAUSE/);
  assert.match(result.verification, /PASS/);
});

test('fast mode keeps coding agent to one model call', async () => {
  let calls = 0;
  const result = await runCodingAgent({ mode: 'security', depth: 'fast', code: 'const x = 1;' }, async () => {
    calls += 1;
    return { reply: 'security review', provider: 'Test' };
  });
  assert.equal(calls, 1);
  assert.equal(result.result, 'security review');
});


test('deep coding mode judges a revised final result as success after final verification', async () => {
  const calls = [];
  const fake = async messages => {
    calls.push(messages[0].content);
    if (calls.length === 1) return { reply: 'PLAN\n1. fix', provider: 'Test' };
    if (calls.length === 2) return { reply: 'draft answer', provider: 'Test' };
    if (calls.length === 3) return { reply: 'REVISE\nFix the issue.', provider: 'Test' };
    if (calls.length === 4) return { reply: 'corrected final answer', provider: 'Test' };
    return { reply: 'PASS\nFinal answer is correct.', provider: 'Test' };
  };
  const result = await runCodingAgent({ mode: 'fix', depth: 'deep', code: 'const x = 1;' }, fake);
  assert.equal(calls.length, 5);
  assert.equal(result.result, 'corrected final answer');
  assert.match(result.verification, /PASS/);
  assert.deepEqual(result.trace.map(x => x.stage), ['preflight', 'plan', 'implementation', 'verification', 'revision', 'final-verification']);
});
