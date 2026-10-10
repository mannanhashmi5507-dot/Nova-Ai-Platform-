// ─── Automation: Job Queue Worker ─────────────────────────────
// Phase 13. The actual worker logic is split into two parts on purpose:
//   - processNextJob(): claims and processes ONE job, fully testable
//     with a mocked db and fake handlers, no timers involved.
//   - startWorker(): the real polling loop (setInterval) that calls
//     processNextJob() repeatedly — this part is thin by design, since
//     interval-based code is inherently harder to unit test well; all
//     the actual logic worth testing lives in processNextJob().

const db = require('../db');
const { logger } = require('../logging/logger');

const handlers = new Map();

// A job "handler" is an async function: (payload, context) => result.
// `type` must match what's passed to db.enqueueJob.
function registerHandler(type, handlerFn) {
  handlers.set(type, handlerFn);
}

// Claims and fully processes at most one pending, due job. Returns
// { processed: false } if there was nothing to do, or
// { processed: true, jobId, success, error? } otherwise — genuinely
// useful for tests to assert on, and for the poller to log.
async function processNextJob(context = {}) {
  const job = await db.claimNextJob();
  if (!job) return { processed: false };

  const handler = handlers.get(job.type);
  if (!handler) {
    await db.failJob(job.id, `No handler registered for job type "${job.type}"`, 0);
    logger.error('automation.job.no_handler', { jobId: job.id, type: job.type });
    return { processed: true, jobId: job.id, success: false, error: 'no handler registered' };
  }

  try {
    const result = await handler(job.payload, { ...context, jobId: job.id, userId: job.user_id });
    await db.completeJob(job.id, result);
    logger.info('automation.job.completed', { jobId: job.id, type: job.type });
    return { processed: true, jobId: job.id, success: true, result };
  } catch (err) {
    const { retried } = await db.failJob(job.id, err.message);
    logger.warn('automation.job.failed', { jobId: job.id, type: job.type, error: err.message, willRetry: retried });
    return { processed: true, jobId: job.id, success: false, error: err.message, willRetry: retried };
  }
}

// The real polling loop. Deliberately simple: poll every few seconds,
// process at most one job per tick (keeps behavior predictable and
// resource use bounded — this isn't trying to be a high-throughput
// queue, it's a reliable one for the scale this app actually needs).
function startWorker({ pollIntervalMs = 5000, context = {} } = {}) {
  if (!db.isEnabled()) {
    logger.warn('automation.worker.not_started', { reason: 'Database not configured' });
    return () => {};
  }
  const interval = setInterval(() => {
    processNextJob(context).catch(err => {
      logger.error('automation.worker.tick_error', { error: err.message });
    });
  }, pollIntervalMs);

  logger.info('automation.worker.started', { pollIntervalMs });
  return () => clearInterval(interval); // returns a stop function
}

module.exports = { registerHandler, processNextJob, startWorker, handlers };
