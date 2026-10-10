const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const jobQueue = require('../src/automation/jobQueue');

function withMockedDb(mocks, fn) {
  const originals = {};
  for (const key of Object.keys(mocks)) { originals[key] = db[key]; db[key] = mocks[key]; }
  return Promise.resolve(fn()).finally(() => { for (const key of Object.keys(originals)) db[key] = originals[key]; });
}

test('processNextJob returns processed:false when there is nothing to claim', async () => {
  await withMockedDb({ claimNextJob: async () => null }, async () => {
    const result = await jobQueue.processNextJob();
    assert.deepEqual(result, { processed: false });
  });
});

test('processNextJob runs the registered handler and marks the job completed on success', async () => {
  let completedWith = null;
  jobQueue.registerHandler('test.success', async (payload) => ({ echoed: payload.value }));

  await withMockedDb({
    claimNextJob: async () => ({ id: 1, type: 'test.success', payload: { value: 42 }, user_id: 7 }),
    completeJob: async (id, result) => { completedWith = { id, result }; },
  }, async () => {
    const result = await jobQueue.processNextJob();
    assert.equal(result.processed, true);
    assert.equal(result.success, true);
    assert.deepEqual(result.result, { echoed: 42 });
    assert.equal(completedWith.id, 1);
  });
});

test('processNextJob passes userId and jobId through to the handler via context', async () => {
  let capturedContext = null;
  jobQueue.registerHandler('test.context', async (payload, context) => { capturedContext = context; return {}; });

  await withMockedDb({
    claimNextJob: async () => ({ id: 5, type: 'test.context', payload: {}, user_id: 99 }),
    completeJob: async () => {},
  }, async () => {
    await jobQueue.processNextJob({ extra: 'value' });
    assert.equal(capturedContext.jobId, 5);
    assert.equal(capturedContext.userId, 99);
    assert.equal(capturedContext.extra, 'value');
  });
});

test('processNextJob fails the job with a clear error when no handler is registered for its type', async () => {
  let failedWith = null;
  await withMockedDb({
    claimNextJob: async () => ({ id: 2, type: 'test.nonexistent_type_xyz', payload: {}, user_id: 1 }),
    failJob: async (id, error, backoff) => { failedWith = { id, error, backoff }; return { retried: false }; },
  }, async () => {
    const result = await jobQueue.processNextJob();
    assert.equal(result.success, false);
    assert.match(failedWith.error, /No handler registered/);
    assert.equal(failedWith.backoff, 0, 'a missing handler should fail immediately, not retry with backoff — retrying will never fix a missing handler');
  });
});

test('processNextJob catches a handler that throws and fails the job with retry info', async () => {
  jobQueue.registerHandler('test.throws', async () => { throw new Error('something went wrong in the handler'); });
  let failedWith = null;

  await withMockedDb({
    claimNextJob: async () => ({ id: 3, type: 'test.throws', payload: {}, user_id: 1 }),
    failJob: async (id, error) => { failedWith = { id, error }; return { retried: true }; },
  }, async () => {
    const result = await jobQueue.processNextJob();
    assert.equal(result.success, false);
    assert.equal(result.willRetry, true);
    assert.equal(failedWith.error, 'something went wrong in the handler');
  });
});

test('startWorker returns a working stop function and does not throw when DB is disabled', () => {
  const originalIsEnabled = db.isEnabled;
  db.isEnabled = () => false;
  try {
    const stop = jobQueue.startWorker();
    assert.equal(typeof stop, 'function');
    assert.doesNotThrow(() => stop());
  } finally {
    db.isEnabled = originalIsEnabled;
  }
});

test('startWorker with DB enabled returns a real stop function that clears the interval', async () => {
  const originalIsEnabled = db.isEnabled;
  db.isEnabled = () => true;
  await withMockedDb({ claimNextJob: async () => null }, async () => {
    try {
      const stop = jobQueue.startWorker({ pollIntervalMs: 100000 }); // long interval, won't actually fire during the test
      assert.equal(typeof stop, 'function');
      stop(); // must not throw
    } finally {
      db.isEnabled = originalIsEnabled;
    }
  });
});
