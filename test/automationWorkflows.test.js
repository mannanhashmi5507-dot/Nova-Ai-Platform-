const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { WORKFLOWS, runPdfToCalendarWorkflow, runEmailToTaskWorkflow, youtubeWorkflowUnavailable } = require('../src/automation/workflows');

function withMockedDb(mocks, fn) {
  const originals = {};
  for (const key of Object.keys(mocks)) { originals[key] = db[key]; db[key] = mocks[key]; }
  return Promise.resolve(fn()).finally(() => { for (const key of Object.keys(originals)) db[key] = originals[key]; });
}

test('exactly 3 workflows are defined, matching the roadmap', () => {
  assert.equal(Object.keys(WORKFLOWS).length, 3);
  assert.ok(WORKFLOWS.pdf_to_calendar);
  assert.ok(WORKFLOWS.email_to_task);
  assert.ok(WORKFLOWS.youtube_to_shorts);
});

test('the YouTube workflow is explicitly marked unavailable, not silently missing', () => {
  assert.equal(WORKFLOWS.youtube_to_shorts.available, false);
});

test('youtubeWorkflowUnavailable throws a specific, honest error naming the missing infrastructure', () => {
  assert.throws(youtubeWorkflowUnavailable, /video-processing infrastructure.*YouTube API connection/s);
});

test('pdf_to_calendar and email_to_task are NOT marked unavailable (they are genuinely implemented)', () => {
  assert.notEqual(WORKFLOWS.pdf_to_calendar.available, false);
  assert.notEqual(WORKFLOWS.email_to_task.available, false);
});

// ── PDF → Calendar workflow ─────────────────────────────────────

test('runPdfToCalendarWorkflow throws if the document does not exist', async () => {
  await withMockedDb({ getDocument: async () => null }, async () => {
    await assert.rejects(
      () => runPdfToCalendarWorkflow({ documentId: 999, userId: 1 }, { getAIReply: async () => ({}) }),
      /not found/
    );
  });
});

test('runPdfToCalendarWorkflow creates a real calendar event for each dated action item', async () => {
  const createdEvents = [];
  await withMockedDb({
    getDocument: async () => ({ id: 1, filename: 'contract.pdf', extracted_text: 'Sign the contract by 2026-08-15. Send invoice by 2026-08-20.' }),
    createEvent: async (userId, event) => { createdEvents.push(event); return { id: createdEvents.length, ...event }; },
  }, async () => {
    const fakeGetAIReply = async () => ({
      reply: '[{"title": "Sign the contract", "date": "2026-08-15"}, {"title": "Send invoice", "date": "2026-08-20"}]'
    });
    const result = await runPdfToCalendarWorkflow({ documentId: 1, userId: 42 }, { getAIReply: fakeGetAIReply });
    assert.equal(result.actionItemsFound, 2);
    assert.equal(result.eventsCreated, 2);
    assert.equal(createdEvents.length, 2);
    assert.equal(createdEvents[0].title, 'Sign the contract');
  });
});

test('runPdfToCalendarWorkflow skips action items with no real date rather than inventing one', async () => {
  const createdEvents = [];
  await withMockedDb({
    getDocument: async () => ({ id: 1, filename: 'notes.pdf', extracted_text: 'Review the notes sometime.' }),
    createEvent: async (userId, event) => { createdEvents.push(event); return event; },
  }, async () => {
    const fakeGetAIReply = async () => ({ reply: '[{"title": "Review the notes", "date": null}]' });
    const result = await runPdfToCalendarWorkflow({ documentId: 1, userId: 42 }, { getAIReply: fakeGetAIReply });
    assert.equal(result.actionItemsFound, 1);
    assert.equal(result.eventsCreated, 0, 'no date means no invented calendar event');
  });
});

test('runPdfToCalendarWorkflow throws a clear error if the AI response is not valid JSON', async () => {
  await withMockedDb({
    getDocument: async () => ({ id: 1, filename: 'x.pdf', extracted_text: 'text' }),
  }, async () => {
    const fakeGetAIReply = async () => ({ reply: 'I cannot find any action items, sorry.' });
    await assert.rejects(
      () => runPdfToCalendarWorkflow({ documentId: 1, userId: 1 }, { getAIReply: fakeGetAIReply }),
      /Could not parse action items/
    );
  });
});

test('runPdfToCalendarWorkflow handles a genuinely empty action-item list without error', async () => {
  await withMockedDb({ getDocument: async () => ({ id: 1, filename: 'x.pdf', extracted_text: 'nothing actionable here' }) }, async () => {
    const fakeGetAIReply = async () => ({ reply: '[]' });
    const result = await runPdfToCalendarWorkflow({ documentId: 1, userId: 1 }, { getAIReply: fakeGetAIReply });
    assert.equal(result.actionItemsFound, 0);
    assert.equal(result.eventsCreated, 0);
  });
});

// ── Email → Task workflow ───────────────────────────────────────

test('runEmailToTaskWorkflow rejects empty email text', async () => {
  await assert.rejects(
    () => runEmailToTaskWorkflow({ emailText: '', userId: 1 }, { getAIReply: async () => ({}) }),
    /emailText is required/
  );
});

test('runEmailToTaskWorkflow creates a real task with the AI-extracted title and due date', async () => {
  let createdTask = null;
  await withMockedDb({
    createTask: async (userId, task) => { createdTask = task; return { id: 1, ...task }; },
  }, async () => {
    const fakeGetAIReply = async () => ({
      reply: '{"summary": "Client wants a revised proposal.", "taskTitle": "Send revised proposal", "dueDate": "2026-08-10"}'
    });
    const result = await runEmailToTaskWorkflow({ emailText: 'Hi, can you send a revised proposal by Aug 10?', userId: 5 }, { getAIReply: fakeGetAIReply });
    assert.equal(createdTask.title, 'Send revised proposal');
    assert.equal(createdTask.dueDate, '2026-08-10');
    assert.match(createdTask.description, /revised proposal/);
    assert.equal(result.summary, 'Client wants a revised proposal.');
  });
});

test('runEmailToTaskWorkflow throws a clear error when no task can be extracted', async () => {
  const fakeGetAIReply = async () => ({ reply: '{"summary": "Just a thank you note.", "taskTitle": null}' });
  await assert.rejects(
    () => runEmailToTaskWorkflow({ emailText: 'Thanks for everything!', userId: 1 }, { getAIReply: fakeGetAIReply }),
    /No task could be extracted/
  );
});

test('runEmailToTaskWorkflow passes projectId through to the created task', async () => {
  let createdTask = null;
  await withMockedDb({ createTask: async (userId, task) => { createdTask = task; return task; } }, async () => {
    const fakeGetAIReply = async () => ({ reply: '{"summary": "s", "taskTitle": "t", "dueDate": null}' });
    await runEmailToTaskWorkflow({ emailText: 'x', userId: 1, projectId: 7 }, { getAIReply: fakeGetAIReply });
    assert.equal(createdTask.projectId, 7);
  });
});
