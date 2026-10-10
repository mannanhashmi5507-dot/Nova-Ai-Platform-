const test = require('node:test');
const assert = require('node:assert/strict');
const { parseReminder, parseAndValidateResponse, RECURRENCE_OPTIONS } = require('../src/productivity/reminderParser');

test('rejects empty input', async () => {
  await assert.rejects(() => parseReminder('', async () => ({})), /naturalLanguageInput is required/);
});

test('parseAndValidateResponse correctly parses a clean JSON response', () => {
  const result = parseAndValidateResponse('{"title": "Call mom", "dueAt": "2026-08-01T17:00:00.000Z", "recurrence": "none"}');
  assert.equal(result.title, 'Call mom');
  assert.equal(result.recurrence, 'none');
});

test('parseAndValidateResponse strips a markdown code fence if the model adds one despite instructions', () => {
  const wrapped = '```json\n{"title": "Buy milk", "dueAt": "2026-08-01T09:00:00.000Z", "recurrence": "none"}\n```';
  const result = parseAndValidateResponse(wrapped);
  assert.equal(result.title, 'Buy milk');
});

test('parseAndValidateResponse throws a clear, actionable error on unparseable output', () => {
  assert.throws(() => parseAndValidateResponse('Sorry, I cannot help with that.'), /Could not parse the reminder/);
});

test('parseAndValidateResponse rejects a response missing a title', () => {
  assert.throws(() => parseAndValidateResponse('{"dueAt": "2026-08-01T09:00:00.000Z"}'), /missing a title/);
});

test('parseAndValidateResponse rejects an invalid dueAt', () => {
  assert.throws(() => parseAndValidateResponse('{"title": "x", "dueAt": "not-a-date"}'), /invalid due date/);
});

test('parseAndValidateResponse fails safe to "none" recurrence rather than rejecting an unexpected value', () => {
  const result = parseAndValidateResponse('{"title": "x", "dueAt": "2026-08-01T09:00:00.000Z", "recurrence": "fortnightly"}');
  assert.equal(result.recurrence, 'none');
});

test('all 4 recurrence options are valid and accepted as-is', () => {
  for (const r of RECURRENCE_OPTIONS) {
    const result = parseAndValidateResponse(`{"title": "x", "dueAt": "2026-08-01T09:00:00.000Z", "recurrence": "${r}"}`);
    assert.equal(result.recurrence, r);
  }
});

test('parseReminder passes the current time to the AI so relative dates ("tomorrow") can be resolved correctly', async () => {
  let capturedMessages = null;
  const fakeGetAIReply = async (messages) => {
    capturedMessages = messages;
    return { reply: '{"title": "Team meeting", "dueAt": "2026-08-01T10:00:00.000Z", "recurrence": "none"}', provider: 'Test' };
  };
  const now = new Date('2026-07-31T12:00:00Z');
  await parseReminder('remind me about the team meeting tomorrow at 10am', fakeGetAIReply, undefined, now);
  assert.match(capturedMessages[0].content, /2026-07-31T12:00:00/);
});

test('parseReminder returns the original input alongside the parsed result, for auditability', async () => {
  const fakeGetAIReply = async () => ({ reply: '{"title": "x", "dueAt": "2026-08-01T09:00:00.000Z", "recurrence": "none"}', provider: 'Test' });
  const result = await parseReminder('remind me tomorrow', fakeGetAIReply);
  assert.equal(result.originalInput, 'remind me tomorrow');
  assert.equal(result.provider, 'Test');
});
