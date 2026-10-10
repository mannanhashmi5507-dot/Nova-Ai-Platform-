// Tests for src/logging/logger.js
// Run with: node --test test/logger.test.js
// Uses Node's built-in test runner (available since Node 18) — no
// dependency install required, which matters since this repo currently
// has zero test infrastructure set up.

const test = require('node:test');
const assert = require('node:assert/strict');
const { logger, requestLogger, LEVELS } = require('../src/logging/logger');

// Helper: capture what a console method receives during a callback,
// then restore it — avoids actually polluting test output.
function captureConsole(method, fn) {
  const original = console[method];
  const calls = [];
  console[method] = (line) => calls.push(line);
  try {
    fn();
  } finally {
    console[method] = original;
  }
  return calls;
}

test('logger.info writes valid JSON with required fields', () => {
  const calls = captureConsole('log', () => {
    logger.info('test.event', { foo: 'bar' });
  });
  assert.equal(calls.length, 1);
  const parsed = JSON.parse(calls[0]);
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.message, 'test.event');
  assert.equal(parsed.foo, 'bar');
  assert.ok(parsed.timestamp, 'timestamp field must be present');
  assert.ok(!Number.isNaN(Date.parse(parsed.timestamp)), 'timestamp must be a valid date');
});

test('logger.error and logger.warn write to console.error, not console.log', () => {
  const errorCalls = captureConsole('error', () => {
    logger.error('test.error', { code: 500 });
  });
  assert.equal(errorCalls.length, 1);
  assert.equal(JSON.parse(errorCalls[0]).level, 'error');

  const warnCalls = captureConsole('error', () => {
    logger.warn('test.warn', {});
  });
  assert.equal(warnCalls.length, 1, 'warn should also route to stderr (console.error), matching prod log-collector conventions');
});

test('logger.debug and logger.info write to console.log, not console.error', () => {
  let errorCallCount = 0;
  const original = console.error;
  console.error = () => { errorCallCount++; };
  try {
    logger.debug('test.debug', {});
    logger.info('test.info', {});
  } finally {
    console.error = original;
  }
  assert.equal(errorCallCount, 0, 'debug/info must not go to stderr');
});

test('all four log levels are exposed and produce the correct level field', () => {
  assert.deepEqual(LEVELS, ['debug', 'info', 'warn', 'error']);
  for (const level of LEVELS) {
    const method = level === 'error' || level === 'warn' ? 'error' : 'log';
    const calls = captureConsole(method, () => logger[level]('x', {}));
    assert.equal(JSON.parse(calls[0]).level, level);
  }
});

test('logger does not throw on circular metadata, and logs a safe fallback line instead', () => {
  const circular = {};
  circular.self = circular;

  let calls;
  assert.doesNotThrow(() => {
    calls = captureConsole('error', () => {
      logger.error('circular.test', circular);
    });
  });

  assert.equal(calls.length, 1);
  const parsed = JSON.parse(calls[0]); // must still be valid, parseable JSON
  assert.equal(parsed.level, 'error');
  assert.ok(parsed.loggerError, 'should note that metadata could not be serialized, rather than silently dropping it');
});

test('requestLogger middleware assigns a request ID and sets the response header', () => {
  const req = { headers: {}, method: 'GET', path: '/test' };
  const listeners = {};
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    on(event, cb) { listeners[event] = cb; },
  };
  let nextCalled = false;

  requestLogger(req, res, () => { nextCalled = true; });

  assert.ok(req.id, 'req.id must be set');
  assert.equal(typeof req.id, 'string');
  assert.equal(res.headers['X-Request-Id'], req.id, 'response header must match req.id');
  assert.ok(nextCalled, 'next() must be called so the request proceeds');

  // Simulate the response finishing, and confirm it logs without throwing
  const calls = captureConsole('log', () => {
    listeners.finish();
  });
  assert.equal(calls.length, 1);
  const parsed = JSON.parse(calls[0]);
  assert.equal(parsed.message, 'request.complete');
  assert.equal(parsed.requestId, req.id);
  assert.equal(parsed.statusCode, 200);
  assert.ok(typeof parsed.durationMs === 'number' && parsed.durationMs >= 0);
});

test('requestLogger reuses an incoming X-Request-Id header instead of generating a new one', () => {
  const req = { headers: { 'x-request-id': 'existing-id-123' }, method: 'GET', path: '/test' };
  const res = { setHeader() {}, on() {} };
  requestLogger(req, res, () => {});
  assert.equal(req.id, 'existing-id-123');
});

test('requestLogger logs warn level for 4xx and error level for 5xx responses', () => {
  const req = { headers: {}, method: 'GET', path: '/test' };
  const listeners = {};
  const res = { statusCode: 404, setHeader() {}, on(event, cb) { listeners[event] = cb; } };
  requestLogger(req, res, () => {});

  const calls = captureConsole('error', () => listeners.finish()); // warn/error both route to console.error
  assert.equal(JSON.parse(calls[0]).level, 'warn');

  const req2 = { headers: {}, method: 'GET', path: '/test' };
  const listeners2 = {};
  const res2 = { statusCode: 500, setHeader() {}, on(event, cb) { listeners2[event] = cb; } };
  requestLogger(req2, res2, () => {});
  const calls2 = captureConsole('error', () => listeners2.finish());
  assert.equal(JSON.parse(calls2[0]).level, 'error');
});
