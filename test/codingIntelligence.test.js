'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectLanguage, estimateComplexity, securityFindings, buildCodingContext } = require('../src/devhub/codingIntelligence');

test('coding preflight detects common languages and complexity signals', () => {
  const code = `const add = async (a, b) => { if (a > 0) return a + b; return b; }`;
  assert.equal(detectLanguage(code), 'javascript');
  const c = estimateComplexity(code);
  assert.equal(c.functions, 0); // arrow functions are intentionally not counted as declarations here
  assert.equal(c.branches, 1);
  assert.ok(c.lines >= 1);
});

test('coding preflight detects security-sensitive patterns without executing code', () => {
  const findings = securityFindings(`const apiKey = "sk-secret"; eval(userInput);`);
  assert.ok(findings.some(x => x.name === 'credentials'));
  assert.ok(findings.some(x => x.name === 'dynamic-code'));
});

test('coding context exposes a structured map for the model', () => {
  const context = buildCodingContext({ code: 'function hello(){ return 1; }', mode: 'review' });
  assert.equal(context.language, 'javascript');
  assert.equal(context.mode, 'review');
  assert.ok(Array.isArray(context.symbols));
});
