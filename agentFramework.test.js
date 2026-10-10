const test = require('node:test');
const assert = require('node:assert/strict');
const { runPersonaAgent } = require('../src/agents/framework');

const testPersona = { key: 'test_agent', name: 'Test Agent', systemPrompt: 'You are a test agent.' };

function scriptedGetAIReply(replies) {
  let i = 0;
  return async () => {
    const reply = replies[Math.min(i, replies.length - 1)];
    i++;
    return { reply, provider: 'TestProvider' };
  };
}

test('returns a FINAL answer directly with no tool calls', async () => {
  const getAIReply = scriptedGetAIReply(['FINAL: The answer is 42.']);
  const result = await runPersonaAgent({
    persona: testPersona, userMessage: 'what is the answer', tools: {}, adaptiveContext: '', getAIReply,
  });
  assert.equal(result.answer, 'The answer is 42.');
  assert.equal(result.steps.length, 0);
});

test('executes a tool call, feeds the result back, and reaches a final answer', async () => {
  const getAIReply = scriptedGetAIReply([
    'TOOL: calculator | 2+2',
    'FINAL: The result is 4.',
  ]);
  const calculatorRun = async (input) => (input === '2+2' ? '4' : 'error');
  const tools = { calculator: { description: 'math', run: calculatorRun } };

  const result = await runPersonaAgent({
    persona: testPersona, userMessage: 'what is 2+2', tools, adaptiveContext: '', getAIReply,
  });

  assert.equal(result.answer, 'The result is 4.');
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].type, 'tool');
  assert.equal(result.steps[0].tool, 'calculator');
  assert.equal(result.steps[0].result, '4');
});

test('handles an unknown tool name gracefully and keeps going instead of crashing', async () => {
  const getAIReply = scriptedGetAIReply([
    'TOOL: nonexistentTool | some input',
    'FINAL: recovered after tool error.',
  ]);
  const result = await runPersonaAgent({
    persona: testPersona, userMessage: 'test', tools: { calculator: { description: 'x', run: async () => 'x' } }, adaptiveContext: '', getAIReply,
  });
  assert.equal(result.answer, 'recovered after tool error.');
  assert.equal(result.steps[0].type, 'error');
});

test('falls back to treating a non-conforming raw reply as the final answer', async () => {
  const getAIReply = scriptedGetAIReply(['I just answered without following the format.']);
  const result = await runPersonaAgent({
    persona: testPersona, userMessage: 'test', tools: {}, adaptiveContext: '', getAIReply,
  });
  assert.equal(result.answer, 'I just answered without following the format.');
});

test('returns a graceful fallback message after exhausting maxSteps without a final answer', async () => {
  const getAIReply = scriptedGetAIReply(['TOOL: calculator | 1+1']); // never says FINAL
  const tools = { calculator: { description: 'math', run: async () => '2' } };
  const result = await runPersonaAgent({
    persona: testPersona, userMessage: 'test', tools, adaptiveContext: '', getAIReply, maxSteps: 2,
  });
  assert.match(result.answer, /maximum number of steps/i);
});

test('a persona with zero tools never attempts TOOL parsing, even if the model tries', async () => {
  // Even if the model ignores instructions and outputs a TOOL line, a
  // persona with no tools should not execute anything — since
  // toolMatch is only attempted when toolNames.length > 0.
  const getAIReply = scriptedGetAIReply(['TOOL: calculator | 1+1', 'FINAL: no tools here.']);
  const result = await runPersonaAgent({
    persona: testPersona, userMessage: 'test', tools: {}, adaptiveContext: '', getAIReply, maxSteps: 3,
  });
  // With tools: {}, the "TOOL:" line won't match (toolNames.length === 0
  // short-circuits toolMatch to null), so it falls through to the raw-reply
  // fallback on the FIRST turn already.
  assert.equal(result.answer, 'TOOL: calculator | 1+1');
});

test('onEvent fires start, tool_call, tool_result, and final events in order', async () => {
  const getAIReply = scriptedGetAIReply([
    'TOOL: calculator | 5+5',
    'FINAL: done.',
  ]);
  const tools = { calculator: { description: 'math', run: async () => '10' } };
  const events = [];
  await runPersonaAgent({
    persona: testPersona, userMessage: 'test', tools, adaptiveContext: '', getAIReply,
    onEvent: (e) => events.push(e.type),
  });
  assert.deepEqual(events, ['start', 'tool_call', 'tool_result', 'final']);
});

test('propagates disconnect (AbortError-style) instead of continuing to call the AI provider', async () => {
  const controller = new AbortController();
  controller.abort();
  const getAIReply = async () => { throw new Error('should not be called after abort'); };
  await assert.rejects(
    () => runPersonaAgent({ persona: testPersona, userMessage: 'test', tools: {}, adaptiveContext: '', getAIReply, signal: controller.signal }),
    /disconnected/i
  );
});

test('adaptiveContext (Victus memory) is included in the system prompt sent to the model', async () => {
  let capturedMessages = null;
  const getAIReply = async (messages) => { capturedMessages = messages; return { reply: 'FINAL: ok', provider: 'Test' }; };
  await runPersonaAgent({
    persona: testPersona, userMessage: 'test', tools: {}, adaptiveContext: 'User prefers short answers.', getAIReply,
  });
  assert.match(capturedMessages[0].content, /User prefers short answers\./);
});
