'use strict';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const MAX_REPLY_CHARS = 200_000;

function trimEndpoint(baseUrl) {
  const value = String(baseUrl || '').trim().replace(/\/$/, '');
  if (!value) throw new Error('Victus model URL is required');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('Victus model URL is not a valid URL'); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Victus model URL must be http(s)');
  if (parsed.username || parsed.password) throw new Error('Victus model URL must not contain credentials; use VICTUS_MODEL_KEY');
  if (value.endsWith('/v1/chat/completions')) return value;
  if (value.endsWith('/v1')) return `${value}/chat/completions`;
  return `${value}/v1/chat/completions`;
}

// The bearer key must never travel over plain http to a remote host.
function assertKeySafe(endpoint, apiKey) {
  if (!apiKey) return;
  const u = new URL(endpoint);
  if (u.protocol !== 'https:' && !LOCAL_HOSTS.has(u.hostname)) {
    throw new Error('Refusing to send VICTUS_MODEL_KEY over plain http to a non-local host; use https');
  }
}

function createVictusModelProvider({ url, model = 'victus-lm', apiKey = '', fetchImpl, timeoutMs = 25000 } = {}) {
  const fetchFn = fetchImpl || global.fetch;
  if (typeof fetchFn !== 'function') throw new Error('fetch implementation is required');

  return {
    name: 'Victus',
    available: () => !!String(url || '').trim(),
    call: async (messages, signal) => {
      if (signal?.aborted) { const e = new Error('Client disconnected'); e.name = 'AbortError'; throw e; }
      const endpoint = trimEndpoint(url);
      assertKeySafe(endpoint, apiKey);
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
      const forwardAbort = () => controller.abort();
      signal?.addEventListener('abort', forwardAbort, { once: true });

      try {
        const res = await fetchFn(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model, messages, max_tokens: 2048, temperature: 0.7 }),
          signal: controller.signal,
        });
        if (res.status === 429) { const e = new Error('Victus rate limited'); e.name = 'RateLimitError'; throw e; }
        if (!res.ok) {
          // Never echo the upstream body: it may contain request details or secrets.
          await res.text().catch(() => '');
          throw new Error(`Victus model returned HTTP ${res.status}`);
        }
        let data;
        try { data = await res.json(); } catch { throw new Error('Victus model returned malformed JSON'); }
        const text = data?.choices?.[0]?.message?.content;
        if (typeof text !== 'string' || !text.trim()) throw new Error('Victus returned an empty or non-text response');
        return text.trim().slice(0, MAX_REPLY_CHARS);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', forwardAbort);
      }
    },
  };
}

module.exports = { createVictusModelProvider, trimEndpoint, assertKeySafe };
