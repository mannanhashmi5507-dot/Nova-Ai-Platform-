// ─── Automation: Workflows ─────────────────────────────────────
// Phase 13. Two of the three example workflows from the roadmap are
// genuinely buildable end-to-end using capabilities THIS APP ALREADY
// HAS — no new external integration needed. The third is explicitly
// declined below, with the specific missing pieces named.

const db = require('../db');

// ── Workflow 1: PDF → Extract actions → Calendar ────────────────
// Fully real: reads a document already uploaded (Phase 11), asks the AI
// to extract concrete action items with dates, creates real calendar
// events (Phase 12) for each one found.
async function runPdfToCalendarWorkflow({ documentId, userId }, { getAIReply, signal } = {}) {
  const document = await db.getDocument(documentId, userId);
  if (!document) throw new Error(`Document ${documentId} not found`);

  const messages = [
    {
      role: 'system',
      content: `Extract concrete, dateable action items from this document. Respond with ONLY a JSON array, no other text, in this shape:
[{"title": "short action description", "date": "YYYY-MM-DD or null if no date is mentioned/inferable"}]
If there are no clear action items, respond with an empty array: []`
    },
    { role: 'user', content: document.extracted_text.slice(0, 6000) }
  ];

  const { reply } = await getAIReply(messages, 'auto', signal);
  let actionItems;
  try {
    actionItems = JSON.parse(reply.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim());
  } catch {
    throw new Error('Could not parse action items from the AI response');
  }
  if (!Array.isArray(actionItems)) throw new Error('Expected an array of action items');

  const createdEvents = [];
  for (const item of actionItems) {
    if (!item.title) continue;
    const startTime = item.date && !isNaN(Date.parse(item.date)) ? new Date(item.date + 'T09:00:00Z').toISOString() : null;
    if (!startTime) continue; // no real date to schedule — skip rather than inventing one
    const event = await db.createEvent(userId, { title: item.title, description: `Auto-extracted from "${document.filename}"`, startTime });
    createdEvents.push(event);
  }

  return { documentId, filename: document.filename, actionItemsFound: actionItems.length, eventsCreated: createdEvents.length, events: createdEvents };
}

// ── Workflow 2: Email → Summary → Task ──────────────────────────
// Real for the "process this email text" half. HONEST LIMITATION: this
// is manually triggered with pasted email text, not automatically
// triggered by a real incoming email — that would need a real email
// integration (Gmail API OAuth + push notifications or IMAP polling),
// which doesn't exist in this app. The OAuth framework from Phase 8
// COULD support connecting Gmail if configured, but no code here reads
// a real inbox.
async function runEmailToTaskWorkflow({ emailText, userId, projectId }, { getAIReply, signal } = {}) {
  if (!emailText || !emailText.trim()) throw new Error('emailText is required');

  const messages = [
    {
      role: 'system',
      content: `Summarize this email in 2-3 sentences, then extract ONE clear follow-up task from it. Respond with ONLY JSON, no other text:
{"summary": "...", "taskTitle": "...", "dueDate": "YYYY-MM-DD or null if no deadline is implied"}`
    },
    { role: 'user', content: emailText.slice(0, 4000) }
  ];

  const { reply } = await getAIReply(messages, 'auto', signal);
  let parsed;
  try {
    parsed = JSON.parse(reply.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim());
  } catch {
    throw new Error('Could not parse the email summary/task from the AI response');
  }
  if (!parsed.taskTitle) throw new Error('No task could be extracted from this email');

  const task = await db.createTask(userId, {
    projectId, title: parsed.taskTitle,
    description: `From email: ${parsed.summary}`,
    dueDate: parsed.dueDate && !isNaN(Date.parse(parsed.dueDate)) ? parsed.dueDate : null,
  });

  return { summary: parsed.summary, task };
}

// ── Workflow 3: YouTube → Shorts → Captions → Schedule ──────────
// NOT IMPLEMENTED. Explicitly declined, not silently missing. This
// needs BOTH:
//   1. Real video processing (clip extraction/editing) — declined in
//      Phase 7 (Creator Studio) because it needs ffmpeg + persistent
//      file storage, neither of which exists in this app.
//   2. Real YouTube API posting — the Phase 8 OAuth framework can
//      connect a YouTube account if configured with real credentials,
//      but no code anywhere actually calls the YouTube Data API to
//      upload/schedule a video.
// Faking this workflow would mean either silently no-op-ing on the
// video step or pretending a video was posted when it wasn't — both
// worse than clearly not offering it.
function youtubeWorkflowUnavailable() {
  throw new Error('The YouTube \u2192 Shorts \u2192 Captions \u2192 Schedule workflow needs real video-processing infrastructure (Phase 7) and a live YouTube API connection (Phase 8) that don\u2019t exist yet in this app — not implemented, by design, rather than faked.');
}

const WORKFLOWS = {
  pdf_to_calendar: { run: runPdfToCalendarWorkflow, name: 'PDF \u2192 Extract actions \u2192 Calendar' },
  email_to_task:   { run: runEmailToTaskWorkflow, name: 'Email \u2192 Summary \u2192 Task' },
  youtube_to_shorts: { run: youtubeWorkflowUnavailable, name: 'YouTube \u2192 Shorts \u2192 Captions \u2192 Schedule', available: false },
};

module.exports = { WORKFLOWS, runPdfToCalendarWorkflow, runEmailToTaskWorkflow, youtubeWorkflowUnavailable };
