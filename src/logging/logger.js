// ─── Structured Logging ──────────────────────────────────────
// Phase 1, Item 3 (Core Stability).
//
// Deliberately dependency-free: a small, well-tested logger rather than
// pulling in pino/winston. For this project's scale, a real, readable
// implementation you fully understand beats a heavier dependency you
// don't — and it means these tests run with zero install step.
//
// Every log line is one JSON object on one line ("JSON lines" format).
// That's what actually matters for production: Railway/any log
// aggregator can parse, filter, and search JSON lines. Plain
// console.log("something happened") can't be queried later —
// "did payment webhooks fail for user X last Tuesday" becomes
// grep-and-pray instead of a real filter.

const crypto = require('crypto');

const LEVELS = ['debug', 'info', 'warn', 'error'];

function write(level, message, meta = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  };

  let line;
  try {
    line = JSON.stringify(entry);
  } catch (err) {
    // BUG FIX: JSON.stringify throws on circular references or BigInt
    // values. A logger that can crash the process just because someone
    // logged an unusual object (e.g. certain error objects, DB rows with
    // circular refs) is worse than useless — it turns "log an error" into
    // "crash while trying to log an error." Fall back to a safe line.
    line = JSON.stringify({
      timestamp: entry.timestamp,
      level,
      message,
      loggerError: 'metadata could not be serialized: ' + err.message,
    });
  }

  // errors/warnings to stderr, everything else to stdout — standard
  // convention most log collectors (including Railway) already expect.
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
  return entry;
}

const logger = {
  debug: (message, meta) => write('debug', message, meta),
  info:  (message, meta) => write('info', message, meta),
  warn:  (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta),
};

// Express middleware: assigns a request ID, logs request start/finish
// with method/path/status/duration. Attach this early in the middleware
// chain (before routes) so req.id is available everywhere downstream,
// including inside route handlers that want to log with the same ID.
function requestLogger(req, res, next) {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  const startedAt = Date.now();

  res.setHeader('X-Request-Id', req.id);

  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    write(level, 'request.complete', {
      requestId: req.id,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs,
      userId: req.dbUser?.id || null,
    });
  });

  next();
}

module.exports = { logger, requestLogger, LEVELS };
