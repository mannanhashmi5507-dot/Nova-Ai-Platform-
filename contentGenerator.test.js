const test = require('node:test');
const assert = require('node:assert/strict');
const { generateCaption, generateTitles, generateHashtags, PLATFORM_LIMITS, VALID_PLATFORMS } = require('../src/social/contentGenerator');

test('all 6 requested platforms exist with defined limits', () => {
  for (const p of ['instagram', 'youtube', 'tiktok', 'facebook', 'x', 'linkedin']) {
    assert.ok(VALID_PLATFORMS.includes(p));
    assert.ok(PLATFORM_LIMITS[p].captionChars > 0);
  }
});

test('X has the tightest real character limit (280) among all platforms', () => {
  assert.equal(PLATFORM_LIMITS.x.captionChars, 280);
  for (const p of VALID_PLATFORMS) {
    if (p !== 'x') assert.ok(PLATFORM_LIMITS[p].captionChars > 280);
  }
});

test('generateCaption rejects an unknown platform before calling the AI', async () => {
  let called = false;
  const fakeGetAIReply = async () => { called = true; return { reply: 'x', provider: 'Test' }; };
  await assert.rejects(() => generateCaption('myspace', 'a cat video', fakeGetAIReply), /platform must be one of/);
  assert.equal(called, false);
});

test('generateCaption rejects a missing description', async () => {
  await assert.rejects(() => generateCaption('x', '', async () => ({})), /description is required/);
});

test('generateCaption reports whether the result fits the real platform limit', async () => {
  const shortReply = async () => ({ reply: 'Short caption.', provider: 'Test' });
  const result = await generateCaption('x', 'a sunset photo', shortReply);
  assert.equal(result.fitsLimit, true);
  assert.equal(result.characterLimit, 280);
  assert.equal(result.characterCount, 'Short caption.'.length);
});

test('generateCaption correctly flags fitsLimit=false when the AI ignores the limit', async () => {
  const longReply = async () => ({ reply: 'a'.repeat(300), provider: 'Test' });
  const result = await generateCaption('x', 'a sunset photo', longReply);
  assert.equal(result.fitsLimit, false);
});

test('generateTitles parses numbered list output into a clean array', async () => {
  const fakeGetAIReply = async () => ({ reply: '1. First Title\n2. Second Title\n3. Third Title', provider: 'Test' });
  const result = await generateTitles('youtube', 'a cooking tutorial', fakeGetAIReply);
  assert.deepEqual(result.titles, ['First Title', 'Second Title', 'Third Title']);
});

test('generateTitles handles varied numbering formats (1. / 1) / 1:)', async () => {
  const fakeGetAIReply = async () => ({ reply: '1) One\n2: Two\n3. Three', provider: 'Test' });
  const result = await generateTitles('youtube', 'x', fakeGetAIReply);
  assert.deepEqual(result.titles, ['One', 'Two', 'Three']);
});

test('generateHashtags extracts only real hashtags (words starting with #)', async () => {
  const fakeGetAIReply = async () => ({ reply: '#travel #wanderlust #adventure', provider: 'Test' });
  const result = await generateHashtags('instagram', 'a mountain trip', fakeGetAIReply);
  assert.deepEqual(result.hashtags, ['#travel', '#wanderlust', '#adventure']);
});

test('generateHashtags filters out any non-hashtag stray text the model might add', async () => {
  const fakeGetAIReply = async () => ({ reply: 'Here: #travel #adventure', provider: 'Test' });
  const result = await generateHashtags('instagram', 'x', fakeGetAIReply);
  assert.ok(result.hashtags.every(h => h.startsWith('#')));
  assert.ok(!result.hashtags.includes('Here:'));
});
