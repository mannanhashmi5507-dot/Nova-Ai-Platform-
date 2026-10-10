const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeMessages, toInstruction } = require('../src/victus/styleFingerprint');

test('analyzeMessages returns null when there are no user messages', () => {
  const result = analyzeMessages([{ role: 'assistant', content: 'hi there' }]);
  assert.equal(result, null);
});

test('detects casual tone from casual markers', () => {
  const messages = [
    { role: 'user', content: 'hey whats up, can u help me with this lol' },
    { role: 'user', content: 'yo i kinda need this done soon' },
    { role: 'user', content: 'thx, gonna try that now' },
  ];
  const fp = analyzeMessages(messages);
  assert.equal(fp.formality, 'casual');
});

test('detects formal tone from formal markers without casual ones', () => {
  const messages = [
    { role: 'user', content: 'Dear team, could you kindly review the attached document at your earliest convenience.' },
    { role: 'user', content: 'Regards, I would appreciate a prompt response.' },
    { role: 'user', content: 'Sincerely requesting an update on this matter.' },
  ];
  const fp = analyzeMessages(messages);
  assert.equal(fp.formality, 'formal');
});

test('detects brief vs detailed verbosity from average message length', () => {
  const briefMessages = [
    { role: 'user', content: 'fix this' },
    { role: 'user', content: 'still broken' },
    { role: 'user', content: 'ok thanks' },
  ];
  assert.equal(analyzeMessages(briefMessages).verbosity, 'brief');

  const longMsg = 'a '.repeat(150); // ~300 chars
  const detailedMessages = [
    { role: 'user', content: longMsg },
    { role: 'user', content: longMsg },
    { role: 'user', content: longMsg },
  ];
  assert.equal(analyzeMessages(detailedMessages).verbosity, 'detailed');
});

test('detects emoji usage', () => {
  const messages = [
    { role: 'user', content: 'hey! 😊 how is this going' },
    { role: 'user', content: 'thanks so much 🙏' },
    { role: 'user', content: 'looks great 🎉' },
  ];
  assert.equal(analyzeMessages(messages).usesEmoji, true);
});

test('toInstruction returns empty string for insufficient sample size (avoids overconfident guesses)', () => {
  const fp = { formality: 'casual', verbosity: 'brief', usesEmoji: false, sampleSize: 1 };
  assert.equal(toInstruction(fp), '');
});

test('toInstruction returns empty string for null fingerprint', () => {
  assert.equal(toInstruction(null), '');
});

test('toInstruction produces a real, non-empty instruction with enough signal', () => {
  const fp = { formality: 'casual', verbosity: 'brief', usesEmoji: true, sampleSize: 5 };
  const instruction = toInstruction(fp);
  assert.ok(instruction.length > 0);
  assert.ok(instruction.toLowerCase().includes('casual'));
  assert.ok(instruction.toLowerCase().includes('short'));
});

test('toInstruction stays neutral (minimal output) for neutral/moderate fingerprints', () => {
  const fp = { formality: 'neutral', verbosity: 'moderate', usesEmoji: false, sampleSize: 5 };
  const instruction = toInstruction(fp);
  assert.equal(instruction, ''); // nothing distinctive enough to instruct on
});
