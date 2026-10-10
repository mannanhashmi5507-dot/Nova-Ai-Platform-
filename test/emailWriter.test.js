const test = require('node:test');
const assert = require('node:assert/strict');
const { writeEmail, parseEmailResponse, VALID_TYPES } = require('../src/business/emailWriter');

test('all 7 expected email types exist', () => {
  for (const t of ['cold_outreach', 'follow_up', 'invoice_reminder', 'thank_you', 'proposal', 'apology', 'meeting_request']) {
    assert.ok(VALID_TYPES.includes(t));
  }
});

test('rejects an unknown email type', async () => {
  await assert.rejects(() => writeEmail('carrier_pigeon', 'brief', async () => ({})), /type must be one of/);
});

test('rejects a missing brief', async () => {
  await assert.rejects(() => writeEmail('thank_you', '', async () => ({})), /brief is required/);
});

test('parseEmailResponse correctly splits subject from body', () => {
  const raw = 'Subject: Following up on our call\n\nHi John,\n\nJust checking in.\n\nBest,\n[Your Name]';
  const { subject, body } = parseEmailResponse(raw);
  assert.equal(subject, 'Following up on our call');
  assert.match(body, /Hi John/);
  assert.doesNotMatch(body, /^Subject:/);
});

test('parseEmailResponse handles a response with no subject line gracefully', () => {
  const raw = 'Just a plain email body with no subject line at all.';
  const { subject, body } = parseEmailResponse(raw);
  assert.equal(subject, null);
  assert.equal(body, raw);
});

test('writeEmail returns a real subject/body/provider from the AI response', async () => {
  const fakeGetAIReply = async () => ({ reply: 'Subject: Thank you!\n\nDear Sam,\n\nThanks for your business.\n\n[Your Name]', provider: 'Test' });
  const result = await writeEmail('thank_you', 'a client just completed their first project with us', fakeGetAIReply);
  assert.equal(result.subject, 'Thank you!');
  assert.match(result.body, /Dear Sam/);
  assert.equal(result.provider, 'Test');
  assert.equal(result.type, 'thank_you');
});

test('recipientName and senderName options are reflected in the prompt sent to the AI', async () => {
  let captured = null;
  const fakeGetAIReply = async (messages) => { captured = messages; return { reply: 'Subject: x\n\nbody', provider: 'Test' }; };
  await writeEmail('follow_up', 'checking on the proposal', fakeGetAIReply, undefined, { recipientName: 'Priya', senderName: 'Alex' });
  assert.match(captured[0].content, /Priya/);
  assert.match(captured[0].content, /Alex/);
});

test('defaults to leaving [Your Name] when no senderName is given', async () => {
  let captured = null;
  const fakeGetAIReply = async (messages) => { captured = messages; return { reply: 'Subject: x\n\nbody', provider: 'Test' }; };
  await writeEmail('follow_up', 'checking on the proposal', fakeGetAIReply);
  assert.match(captured[0].content, /\[Your Name\]/);
});
