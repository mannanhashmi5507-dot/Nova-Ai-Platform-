const test = require('node:test');
const assert = require('node:assert/strict');
const { generateReplySuggestions, TONES } = require('../src/social/replyAssistant');

test('all 4 tones are valid options', () => {
  assert.deepEqual(TONES, ['friendly', 'professional', 'witty', 'brief']);
});

test('rejects an empty comment', async () => {
  await assert.rejects(() => generateReplySuggestions('', async () => ({})), /comment is required/);
});

test('rejects an invalid tone', async () => {
  await assert.rejects(
    () => generateReplySuggestions('nice post!', async () => ({}), undefined, { tone: 'sarcastic' }),
    /tone must be one of/
  );
});

test('parses 3 numbered reply suggestions correctly', async () => {
  const fakeGetAIReply = async () => ({ reply: '1. Thanks so much!\n2. Really appreciate it!\n3. Glad you liked it!', provider: 'Test' });
  const result = await generateReplySuggestions('Great post!', fakeGetAIReply);
  assert.equal(result.suggestions.length, 3);
  assert.equal(result.suggestions[0], 'Thanks so much!');
});

test('defaults to friendly tone when none is specified', async () => {
  let captured = null;
  const fakeGetAIReply = async (messages) => { captured = messages; return { reply: '1. ok', provider: 'Test' }; };
  const result = await generateReplySuggestions('nice!', fakeGetAIReply);
  assert.equal(result.tone, 'friendly');
  assert.match(captured[0].content, /warm and approachable/);
});

test('includes context in the prompt when provided, omits it when not', async () => {
  let captured = null;
  const fakeGetAIReply = async (messages) => { captured = messages; return { reply: '1. ok', provider: 'Test' }; };

  await generateReplySuggestions('question about pricing', fakeGetAIReply, undefined, { context: 'This is a SaaS pricing post' });
  assert.match(captured[1].content, /SaaS pricing post/);

  await generateReplySuggestions('question about pricing', fakeGetAIReply);
  assert.doesNotMatch(captured[1].content, /Context about/);
});

test('the comment text itself is passed through to the prompt exactly', async () => {
  let captured = null;
  const fakeGetAIReply = async (messages) => { captured = messages; return { reply: '1. ok', provider: 'Test' }; };
  await generateReplySuggestions('Is this available in blue?', fakeGetAIReply);
  assert.match(captured[1].content, /Is this available in blue\?/);
});
