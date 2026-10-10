// ─── Productivity: AI Reminders ───────────────────────────────
// Phase 12. HONEST SCOPE, same pattern as the Phase 8 content calendar:
// this PARSES a natural-language reminder request into structured data
// and STORES it. It does not send notifications/emails/push alerts at
// the scheduled time — there is no background job worker in this app
// yet to do that (see Phase 13, Automation, where that infrastructure
// would actually live). A reminder created here is a real row in the
// database with a real due time; nothing currently wakes up and acts on
// it.

const RECURRENCE_OPTIONS = ['none', 'daily', 'weekly', 'monthly'];

function buildParsePrompt(naturalLanguageInput, nowIso) {
  return [
    {
      role: 'system',
      content: `Parse a natural-language reminder request into structured JSON. Current date/time (ISO 8601, for resolving relative dates like "tomorrow" or "next Monday"): ${nowIso}.
Respond with ONLY a JSON object, no other text, in exactly this shape:
{"title": "short reminder text", "dueAt": "ISO 8601 datetime", "recurrence": "none|daily|weekly|monthly"}
If no specific time is mentioned, default to 9:00 AM on the resolved date. If the request is recurring (e.g. "every Monday"), set recurrence accordingly and dueAt to the first occurrence.`
    },
    { role: 'user', content: naturalLanguageInput }
  ];
}

function parseAndValidateResponse(reply) {
  let parsed;
  try {
    // Models sometimes wrap JSON in a code fence despite instructions — strip it defensively.
    const cleaned = reply.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('Could not parse the reminder — try rephrasing it more explicitly (e.g. "remind me to call mom tomorrow at 5pm")');
  }

  if (!parsed.title || typeof parsed.title !== 'string') throw new Error('Parsed reminder is missing a title');
  if (!parsed.dueAt || isNaN(Date.parse(parsed.dueAt))) throw new Error('Parsed reminder has an invalid due date/time');
  if (!RECURRENCE_OPTIONS.includes(parsed.recurrence)) parsed.recurrence = 'none'; // fail safe to a sane default rather than rejecting

  return { title: parsed.title.trim(), dueAt: new Date(parsed.dueAt).toISOString(), recurrence: parsed.recurrence };
}

async function parseReminder(naturalLanguageInput, getAIReply, signal, now = new Date()) {
  if (!naturalLanguageInput || !naturalLanguageInput.trim()) throw new Error('naturalLanguageInput is required');

  const { reply, provider } = await getAIReply(buildParsePrompt(naturalLanguageInput, now.toISOString()), 'auto', signal);
  const parsed = parseAndValidateResponse(reply);
  return { ...parsed, provider, originalInput: naturalLanguageInput };
}

module.exports = { parseReminder, parseAndValidateResponse, RECURRENCE_OPTIONS };
