// ─── Enterprise: Error Reporting ──────────────────────────────
// Phase 15. Real, DB-backed error log — works standalone, no external
// service required. Also supports an optional SENTRY_DSN forward, same
// "slot" pattern as every other optional integration.

const MAX_MESSAGE_LENGTH = 2000;
const MAX_STACK_LENGTH = 5000;

function sanitizeErrorForStorage(err, context = {}) {
  let message = String(err?.message || err || 'Unknown error').slice(0, MAX_MESSAGE_LENGTH);
  let stack = err?.stack ? String(err.stack).slice(0, MAX_STACK_LENGTH) : null;

  const secretPattern = /(Bearer\s+[A-Za-z0-9\-_.]{20,}|nova_[a-f0-9]{64}|sk-[A-Za-z0-9]{20,}|[A-Za-z0-9+/]{40,}={0,2})/g;
  message = message.replace(secretPattern, '[REDACTED]');
  if (stack) stack = stack.replace(secretPattern, '[REDACTED]');

  return {
    message,
    stack,
    requestId: context.requestId || null,
    userId: context.userId || null,
    path: context.path || null,
  };
}

async function reportError(err, context, db, fetchWithTimeout) {
  const sanitized = sanitizeErrorForStorage(err, context);

  if (db?.isEnabled?.()) {
    try {
      await db.recordErrorLog(sanitized);
    } catch {
      // Don't let error-logging itself throw and mask the original error.
    }
  }

  const sentryDsn = (process.env.SENTRY_DSN || '').trim();
  if (sentryDsn && fetchWithTimeout) {
    try {
      const dsnMatch = sentryDsn.match(/^https:\/\/([^@]+)@([^/]+)\/(\d+)$/);
      if (dsnMatch) {
        const [, publicKey, host, projectId] = dsnMatch;
        await fetchWithTimeout(
          `https://${host}/api/${projectId}/store/`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${publicKey}` },
            body: JSON.stringify({ message: sanitized.message, level: 'error', extra: { requestId: sanitized.requestId, path: sanitized.path } }),
          },
          5000
        );
      }
    } catch {
      // Sentry forwarding is best-effort — never let it break error handling.
    }
  }

  return sanitized;
}

module.exports = { sanitizeErrorForStorage, reportError, MAX_MESSAGE_LENGTH, MAX_STACK_LENGTH };
