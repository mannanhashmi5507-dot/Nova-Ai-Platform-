const test = require('node:test');
const assert = require('node:assert/strict');
const { DISCLAIMER, withDisclaimer } = require('../src/finance/disclaimers');

test('DISCLAIMER text explicitly states this is not personalized advice', () => {
  assert.match(DISCLAIMER, /not personalized|not.*advice/i);
});

test('DISCLAIMER explicitly recommends consulting a licensed advisor', () => {
  assert.match(DISCLAIMER, /licensed financial advisor/i);
});

test('withDisclaimer attaches the disclaimer field without mutating the original payload', () => {
  const original = { total: 100 };
  const wrapped = withDisclaimer(original);
  assert.equal(wrapped.total, 100);
  assert.equal(wrapped.disclaimer, DISCLAIMER);
  assert.equal(original.disclaimer, undefined, 'must not mutate the original object');
});

test('withDisclaimer works on an empty payload', () => {
  const wrapped = withDisclaimer({});
  assert.equal(wrapped.disclaimer, DISCLAIMER);
});

test('withDisclaimer never lets an existing field silently override the disclaimer', () => {
  // Even if a caller's payload happens to have a "disclaimer" key already,
  // the real compliance disclaimer must win — not caller-supplied text.
  const wrapped = withDisclaimer({ disclaimer: 'something else' });
  assert.equal(wrapped.disclaimer, DISCLAIMER);
});
