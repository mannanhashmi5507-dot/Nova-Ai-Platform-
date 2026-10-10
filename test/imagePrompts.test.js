const test = require('node:test');
const assert = require('node:assert/strict');
const { buildImagePrompt, VALID_STYLES } = require('../src/creator/imagePrompts');

test('all 5 expected styles exist', () => {
  for (const style of ['general', 'logo', 'poster', 'product', 'thumbnail']) {
    assert.ok(VALID_STYLES.includes(style));
  }
});

test('general style passes the idea through unchanged', () => {
  assert.equal(buildImagePrompt('general', 'a red sports car'), 'a red sports car');
});

test('logo style wraps the idea with logo-specific design language', () => {
  const prompt = buildImagePrompt('logo', 'a coffee shop called Bean There');
  assert.match(prompt, /logo/i);
  assert.match(prompt, /Bean There/);
  assert.match(prompt, /vector|minimalist/i);
});

test('poster style wraps the idea with poster-specific design language', () => {
  const prompt = buildImagePrompt('poster', 'a music festival');
  assert.match(prompt, /poster/i);
});

test('product style wraps the idea with product-photography language', () => {
  const prompt = buildImagePrompt('product', 'a wireless mouse');
  assert.match(prompt, /product photography/i);
  assert.match(prompt, /studio lighting/i);
});

test('thumbnail style wraps the idea with thumbnail-specific language', () => {
  const prompt = buildImagePrompt('thumbnail', 'a gaming video about strategy');
  assert.match(prompt, /thumbnail/i);
});

test('rejects an unknown style', () => {
  assert.throws(() => buildImagePrompt('not-a-style', 'something'), /style must be one of/);
});

test('rejects empty/missing idea', () => {
  assert.throws(() => buildImagePrompt('logo', ''), /required/);
  assert.throws(() => buildImagePrompt('logo', undefined), /required/);
});

test('caps an extremely long idea rather than producing an unbounded prompt', () => {
  const longIdea = 'a '.repeat(500);
  const prompt = buildImagePrompt('general', longIdea);
  assert.ok(prompt.length < longIdea.length + 50);
});
