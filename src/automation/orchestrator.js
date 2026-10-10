// ─── Automation: Workflow Orchestrator ────────────────────────
// Phase 13. Wraps a workflow's execution with a tracked run record
// (workflow_runs) so a user can see status/result/errors without
// digging through raw job rows. Used both for synchronous "run it now"
// API calls and for jobs picked up by the queue worker.

const db = require('../db');
const { WORKFLOWS } = require('./workflows');
const { logger } = require('../logging/logger');

async function executeWorkflow(workflowType, payload, userId, context = {}) {
  const workflow = WORKFLOWS[workflowType];
  if (!workflow) throw new Error(`Unknown workflow: ${workflowType}`);
  if (workflow.available === false) {
    // Calls the workflow's own function so its specific, honest
    // "why not" error message is what the caller actually sees.
    return workflow.run();
  }

  const run = await db.createWorkflowRun(userId, workflowType);
  try {
    const result = await workflow.run({ ...payload, userId }, context);
    if (run) await db.completeWorkflowRun(run.id, result);
    logger.info('automation.workflow.completed', { workflowType, runId: run?.id, userId });
    return { runId: run?.id, status: 'completed', result };
  } catch (err) {
    if (run) await db.failWorkflowRun(run.id, err.message);
    logger.warn('automation.workflow.failed', { workflowType, runId: run?.id, userId, error: err.message });
    throw err;
  }
}

// Registers each available workflow as a job-queue handler, so
// POST /api/automation/workflows/:type/queue can schedule one to run in
// the background instead of blocking the HTTP request.
function registerWorkflowJobHandlers(jobQueue, context) {
  for (const [type, workflow] of Object.entries(WORKFLOWS)) {
    if (workflow.available === false) continue; // don't register a handler for the declined workflow
    jobQueue.registerHandler(`workflow:${type}`, async (payload, jobContext) => {
      return executeWorkflow(type, payload, payload.userId, { ...context, ...jobContext });
    });
  }
}

module.exports = { executeWorkflow, registerWorkflowJobHandlers };
