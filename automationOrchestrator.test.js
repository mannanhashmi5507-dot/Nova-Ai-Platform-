const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { executeWorkflow, registerWorkflowJobHandlers } = require('../src/automation/orchestrator');

function withMockedDb(mocks, fn) {
  const originals = {};
  for (const key of Object.keys(mocks)) { originals[key] = db[key]; db[key] = mocks[key]; }
  return Promise.resolve(fn()).finally(() => { for (const key of Object.keys(originals)) db[key] = originals[key]; });
}

test('executeWorkflow rejects an unknown workflow type', async () => {
  await assert.rejects(() => executeWorkflow('not_a_real_workflow', {}, 1, {}), /Unknown workflow/);
});

test('executeWorkflow immediately surfaces the honest error for the unavailable YouTube workflow, without creating a run record', async () => {
  let runCreated = false;
  await withMockedDb({ createWorkflowRun: async () => { runCreated = true; } }, async () => {
    await assert.rejects(() => executeWorkflow('youtube_to_shorts', {}, 1, {}), /video-processing infrastructure/);
    assert.equal(runCreated, false, 'no workflow_runs row should be created for a workflow that never actually ran');
  });
});

test('executeWorkflow creates a run record, executes the workflow, and marks it completed on success', async () => {
  let createdRun = null;
  let completedRunId = null;
  let completedResult = null;

  await withMockedDb({
    createWorkflowRun: async (userId, type) => { createdRun = { id: 1, userId, type }; return createdRun; },
    completeWorkflowRun: async (id, result) => { completedRunId = id; completedResult = result; },
    createTask: async (userId, task) => ({ id: 1, ...task }),
  }, async () => {
    const fakeGetAIReply = async () => ({ reply: '{"summary": "s", "taskTitle": "Follow up", "dueDate": null}' });
    const result = await executeWorkflow('email_to_task', { emailText: 'please follow up' }, 42, { getAIReply: fakeGetAIReply });

    assert.equal(createdRun.userId, 42);
    assert.equal(createdRun.type, 'email_to_task');
    assert.equal(completedRunId, 1);
    assert.equal(result.status, 'completed');
    assert.ok(completedResult.task);
  });
});

test('executeWorkflow marks the run as failed (not completed) when the workflow throws, and re-throws the error', async () => {
  let failedRunId = null;
  let failedError = null;

  await withMockedDb({
    createWorkflowRun: async () => ({ id: 2 }),
    failWorkflowRun: async (id, error) => { failedRunId = id; failedError = error; },
  }, async () => {
    const fakeGetAIReply = async () => ({ reply: 'not valid json' });
    await assert.rejects(
      () => executeWorkflow('email_to_task', { emailText: 'x' }, 1, { getAIReply: fakeGetAIReply }),
      /Could not parse/
    );
    assert.equal(failedRunId, 2);
    assert.match(failedError, /Could not parse/);
  });
});

test('registerWorkflowJobHandlers registers a handler for every AVAILABLE workflow, and none for the unavailable one', () => {
  const registered = [];
  const fakeJobQueue = { registerHandler: (type) => registered.push(type) };
  registerWorkflowJobHandlers(fakeJobQueue, {});
  assert.ok(registered.includes('workflow:pdf_to_calendar'));
  assert.ok(registered.includes('workflow:email_to_task'));
  assert.ok(!registered.includes('workflow:youtube_to_shorts'), 'must not register a handler for a workflow that cannot actually run');
});
