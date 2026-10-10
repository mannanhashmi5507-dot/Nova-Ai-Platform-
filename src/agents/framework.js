// ─── Phase 5: Shared Agent Framework ─────────────────────────
// One real engine, many personas on top of it. Honest design note: most
// of the 8 requested agents (Business, Marketing, Finance, Tutor, Travel,
// Personal Assistant) have no real external API integration available
// here — no CRM, no travel-booking, no market-data feed. Rather than
// fake a "Travel Agent" that pretends to book flights, each persona
// below gets: a specialized system prompt, real tool access ONLY where
// a real tool exists (calculator, web search), and honest behavior
// otherwise (reasoning from training knowledge, not fabricated actions).
//
// The five cross-cutting requirements, and what actually provides each:
//
// MEMORY      — Victus's adaptive context (buildAdaptiveContext) is
//               folded into every persona's system prompt when a userId
//               is present. Not new infrastructure — reusing Phase 4's.
// STREAMING    — runPersonaAgent takes an onEvent callback; the route
//               layer turns those events into real SSE, same mechanism
//               /api/chat already uses.
// RETRIES      — getAIReply already retries across providers on failure
//               (Groq → Gemini → ChatGPT → ...). Not reinvented here;
//               that existing mechanism IS the retry layer.
// LOGGING      — every persona run emits structured log events (start,
//               each tool call, finish/error) via the Phase 1 logger.
// TOOL CALLING — the same ReAct-style loop as the original Nova Agent,
//               generalized to accept a persona-specific tool subset.

const { logger } = require('../logging/logger');

function buildSystemPrompt(persona, adaptiveContext) {
  return [persona.systemPrompt, adaptiveContext].filter(Boolean).join('\n\n');
}

// Real, shared ReAct loop — same mechanics as the original Nova Agent,
// generalized: takes the persona's own system prompt and only the tools
// that persona is allowed to use (many personas get zero tools, which is
// honest given no real API integration exists for their domain yet).
async function runPersonaAgent({ persona, userMessage, tools, adaptiveContext, getAIReply, signal, maxSteps = 3, onEvent = () => {}, requestId, userId }) {
  const toolNames = Object.keys(tools);
  const systemPrompt = buildSystemPrompt(persona, adaptiveContext);

  const toolInstructions = toolNames.length > 0
    ? `\n\nAvailable tools:\n${toolNames.map(name => `- ${name}(input): ${tools[name].description}`).join('\n')}\n\nOn EVERY turn, respond with ONLY ONE of:\nTOOL: toolName | input text\nFINAL: your complete final answer\n\nNever fabricate a tool result — wait for the real result.`
    : `\n\nYou have no tools available. Answer directly and plainly — respond with FINAL: your complete answer, nothing else.`;

  const messages = [
    { role: 'system', content: systemPrompt + toolInstructions },
    { role: 'user', content: userMessage }
  ];

  logger.info('agent.persona.start', { requestId, agent: persona.key, userId: userId || null, hasTools: toolNames.length > 0 });
  onEvent({ type: 'start', agent: persona.key });

  const steps = [];
  for (let i = 0; i < maxSteps; i++) {
    if (signal?.aborted) throw new Error('Client disconnected');

    const { reply, provider } = await getAIReply(messages, 'auto', signal, userMessage);
    const trimmed = reply.trim();

    const finalMatch = trimmed.match(/^FINAL:\s*([\s\S]*)/i);
    if (finalMatch) {
      const answer = finalMatch[1].trim();
      logger.info('agent.persona.complete', { requestId, agent: persona.key, provider, steps: steps.length });
      onEvent({ type: 'final', content: answer, provider });
      return { answer, steps, provider };
    }

    const toolMatch = toolNames.length > 0 ? trimmed.match(/^TOOL:\s*(\w+)\s*\|\s*([\s\S]*)/i) : null;
    if (toolMatch) {
      const [, toolName, toolInput] = toolMatch;
      const tool = tools[toolName.trim()];
      if (!tool) {
        messages.push({ role: 'assistant', content: trimmed });
        messages.push({ role: 'user', content: `Tool "${toolName}" does not exist. Available: ${toolNames.join(', ')}. Try again.` });
        steps.push({ type: 'error', content: `Unknown tool: ${toolName}` });
        logger.warn('agent.persona.unknown_tool', { requestId, agent: persona.key, toolName });
        continue;
      }
      onEvent({ type: 'tool_call', tool: toolName.trim(), input: toolInput.trim() });
      const result = await tool.run(toolInput.trim(), signal);
      steps.push({ type: 'tool', tool: toolName.trim(), input: toolInput.trim(), result });
      logger.info('agent.persona.tool_call', { requestId, agent: persona.key, tool: toolName.trim() });
      onEvent({ type: 'tool_result', tool: toolName.trim(), result });
      messages.push({ role: 'assistant', content: trimmed });
      messages.push({ role: 'user', content: `Tool result: ${result}` });
      continue;
    }

    // Didn't follow the TOOL/FINAL format — treat the raw reply as final
    // rather than looping forever or erroring on a minor format miss.
    logger.info('agent.persona.complete', { requestId, agent: persona.key, provider, steps: steps.length, note: 'raw_reply_fallback' });
    onEvent({ type: 'final', content: trimmed, provider });
    return { answer: trimmed, steps, provider };
  }

  logger.warn('agent.persona.max_steps', { requestId, agent: persona.key, maxSteps });
  const fallback = 'Reached the maximum number of steps without a final answer. Try a more specific request.';
  onEvent({ type: 'final', content: fallback, provider: null });
  return { answer: fallback, steps, provider: null };
}

module.exports = { runPersonaAgent, buildSystemPrompt };
