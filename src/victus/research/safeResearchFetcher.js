'use strict';

const dns = require('dns').promises;
const net = require('net');
const { URL } = require('url');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { promisify } = require('util');

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const inflateRaw = promisify(zlib.inflateRaw);
const brotli = promisify(zlib.brotliDecompress);
const MAX_DEFAULT_BYTES = 2 * 1024 * 1024;
const MAX_DEFAULT_REDIRECTS = 3;
const ALLOWED_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'application/json',
]);

class ResearchSecurityError extends Error {
  constructor(message, code = 'RESEARCH_SECURITY') {
    super(message);
    this.name = 'ResearchSecurityError';
    this.code = code;
  }
}

class SafeResearchFetcher {
  constructor({
    allowedDomains = [],
    fetchImpl = globalThis.fetch,
    lookup = dns.lookup,
    maxBytes = MAX_DEFAULT_BYTES,
    maxRedirects = MAX_DEFAULT_REDIRECTS,
    timeoutMs = 12000,
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    if (typeof lookup !== 'function') throw new TypeError('DNS lookup implementation is required');
    this.allowedDomains = normalizeAllowlist(allowedDomains);
    this.fetchImpl = fetchImpl;
    this.lookup = lookup;
    this.maxBytes = clampInteger(maxBytes, 32 * 1024, 10 * 1024 * 1024);
    this.maxRedirects = clampInteger(maxRedirects, 0, 5);
    this.timeoutMs = clampInteger(timeoutMs, 1000, 30000);
  }

  isAllowedHost(hostname, extraAllowedDomains = []) {
    const effective = this.effectiveAllowlist(extraAllowedDomains);
    const host = normalizeHostname(hostname);
    return effective.some(domain => domainMatches(host, domain));
  }

  // A caller may only NARROW the server allowlist, never replace or widen it.
  // If a caller asks for domains and none overlap the server list, nothing is allowed.
  effectiveAllowlist(requested) {
    if (!Array.isArray(requested) || !requested.length) return this.allowedDomains;
    return narrowAllowlist(this.allowedDomains, normalizeAllowlist(requested));
  }

  async fetchDocument(input, options = {}) {
    const url = typeof input === 'string' ? input : input?.uri || input?.url;
    if (!url) throw new TypeError('research URL is required');

    const maxBytes = clampInteger(options.maxBytes ?? this.maxBytes, 32 * 1024, this.maxBytes);
    const allowedDomains = this.effectiveAllowlist(options.allowedDomains);
    const first = validateResearchUrl(url, {
      allowedDomains,
      allowPrivateAddresses: options.allowPrivateAddresses === true,
    });

    let current = first;
    for (let redirect = 0; redirect <= this.maxRedirects; redirect += 1) {
      const pinned = await this.assertPublicAddress(current, options);

      const response = await this.fetchOnce(current.href, options.signal, pinned);
      if (isRedirect(response.status)) {
        const location = response.headers?.get?.('location');
        if (!location) throw new Error(`redirect from ${current.href} has no location`);
        if (redirect === this.maxRedirects) throw new Error('research redirect limit exceeded');
        current = validateResearchUrl(new URL(location, current.href).href, {
          allowedDomains,
          allowPrivateAddresses: options.allowPrivateAddresses === true,
        });
        continue;
      }

      if (!response.ok) {
        throw new Error(`research source returned HTTP ${response.status}`);
      }

      const contentType = normalizeContentType(response.headers?.get?.('content-type'));
      if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        throw new ResearchSecurityError(`unsupported research content type: ${contentType || 'unknown'}`, 'UNSUPPORTED_CONTENT_TYPE');
      }

      const encoding = normalizeContentEncoding(response.headers?.get?.('content-encoding'));
      let buffer = await readLimitedBody(response, maxBytes, options.signal);
      buffer = await decodeBody(buffer, encoding, maxBytes);

      const raw = buffer.toString('utf8');
      const extracted = extractReadableText(raw, contentType);
      const filtered = filterPromptInjection(extracted.text);
      return {
        url: current.href,
        uri: current.href,
        title: extracted.title || current.hostname,
        contentType,
        text: filtered.text,
        originalTextLength: extracted.text.length,
        hiddenContentRemoved: extracted.hiddenRemoved || 0,
        promptInjection: filtered.report,
        sourceType: inferSourceType(current.hostname),
        fetchedAt: new Date().toISOString(),
      };
    }

    throw new Error('research fetch did not complete');
  }

  async fetchOnce(url, externalSignal, pinned = null) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      return await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        compress: false, // node-fetch: ask for the raw bytes; we decode (and size-limit) ourselves
        ...(pinned ? { agent: makePinnedAgent(url, pinned) } : {}),
        headers: {
          'accept-encoding': 'identity',
          'accept': 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.1',
          'user-agent': 'NovaAI-Victus-Research/1.0 (+read-only)',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
    }
  }

  // Resolves the host, rejects private/reserved targets, and returns the
  // validated addresses so the actual connection can be pinned to them
  // (closing the DNS-rebinding gap between "check" and "connect").
  async assertPublicAddress(url, options = {}) {
    if (options.allowPrivateAddresses === true) return null;
    const records = await this.lookup(url.hostname, { all: true, verbatim: false });
    if (!Array.isArray(records) || !records.length) {
      throw new ResearchSecurityError(`could not resolve research host: ${url.hostname}`, 'DNS_RESOLUTION_FAILED');
    }
    for (const record of records) {
      if (isPrivateOrReservedIp(record.address)) {
        throw new ResearchSecurityError(`research host resolves to a private/reserved address: ${url.hostname}`, 'SSRF_BLOCKED');
      }
    }
    return records.map(r => ({ address: r.address, family: r.family || net.isIP(r.address) }));
  }
}


function makePinnedAgent(urlString, addresses) {
  const lookup = (hostname, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (opts && opts.all) return cb(null, addresses.map(a => ({ ...a })));
    return cb(null, addresses[0].address, addresses[0].family);
  };
  const Agent = new URL(urlString).protocol === 'https:' ? https.Agent : http.Agent;
  return new Agent({ lookup, keepAlive: false });
}

const GZIP_MAGIC = (b) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
function looksLikeText(buffer) {
  const sample = buffer.subarray(0, 2048);
  for (const byte of sample) if (byte === 0) return false;
  return true;
}

// Real HTTP clients (node-fetch, undici) usually decompress for us but leave the
// Content-Encoding header in place, so the header alone cannot be trusted.
// Decode by what the bytes actually are, and cap the OUTPUT size so a tiny
// compressed file can't expand into gigabytes (a "decompression bomb").
async function decodeBody(buffer, encoding, maxBytes) {
  const opts = { maxOutputLength: maxBytes };
  const tooLarge = () => new ResearchSecurityError('research response exceeds byte limit', 'RESPONSE_TOO_LARGE');
  const attempt = async fn => {
    try { return await fn(); } catch (err) {
      if (err && err.code === 'ERR_BUFFER_TOO_LARGE') throw tooLarge();
      return null;
    }
  };
  let out = null;
  if (GZIP_MAGIC(buffer)) {
    out = await attempt(() => gunzip(buffer, opts));
    if (!out) throw new ResearchSecurityError('could not decode gzip research response', 'UNSUPPORTED_CONTENT_ENCODING');
  } else if (encoding === 'br') {
    out = await attempt(() => brotli(buffer, opts));
  } else if (encoding === 'deflate') {
    out = (await attempt(() => inflate(buffer, opts))) || (await attempt(() => inflateRaw(buffer, opts)));
  }
  if (!out) {
    // Already decoded by the HTTP client (or sent as identity).
    if (!looksLikeText(buffer)) throw new ResearchSecurityError(`unsupported research content encoding: ${encoding || 'unknown'}`, 'UNSUPPORTED_CONTENT_ENCODING');
    out = buffer;
  }
  if (out.length > maxBytes) throw tooLarge();
  return out;
}

// Hidden text is a classic prompt-injection hiding place: invisible to a human
// reader but extracted as plain text. Drop elements that are styled or marked
// hidden. Single linear pass (no backtracking regex), so hostile HTML can't
// make this quadratic.
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);
const HIDDEN_STYLE = /(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px|pt|em|rem|%)?\s*(?:;|$)|opacity\s*:\s*0\s*(?:;|$)|(?:left|top|text-indent)\s*:\s*-\d{3,}px)/i;

function isHiddenElement(tag, attrs) {
  if (/^(html|body|head|title|script|style)$/.test(tag)) return false;
  return HIDDEN_STYLE.test(attrs) || /(?:^|\s)hidden(?:\s|=|$)/i.test(attrs) || /aria-hidden\s*=\s*["']?true/i.test(attrs);
}

function stripHiddenElements(html) {
  const tagRe = /<(\/?)([a-z][a-z0-9]*)\b([^>]*)>/gi;
  let out = '';
  let last = 0;
  let removed = 0;
  let hiddenTag = null;
  let depth = 0;
  let m;
  while ((m = tagRe.exec(html))) {
    const close = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3] || '';
    const selfClosing = /\/\s*$/.test(attrs) || VOID_TAGS.has(tag);
    if (hiddenTag) {
      if (tag === hiddenTag && !selfClosing) {
        if (close) {
          depth -= 1;
          if (depth === 0) { last = m.index + m[0].length; hiddenTag = null; removed += 1; out += ' '; }
        } else depth += 1;
      }
      continue;
    }
    if (!close && !selfClosing && isHiddenElement(tag, attrs)) {
      out += html.slice(last, m.index);
      hiddenTag = tag;
      depth = 1;
    }
  }
  if (hiddenTag) { removed += 1; return { html: out, removed }; } // unclosed hidden element: drop the rest
  return { html: out + html.slice(last), removed };
}

function narrowAllowlist(base, requested) {
  const out = new Set();
  for (const req of requested) {
    for (const root of base) {
      if (root === '*') { out.add(req); continue; }
      if (req === root || req.endsWith(`.${root}`)) out.add(req);        // inside the allowed domain: keep the narrower request
      else if (root.endsWith(`.${req}`)) out.add(root);                  // request is broader than the allowed domain: clamp to the server's domain
    }
  }
  return [...out];
}

function validateResearchUrl(raw, { allowedDomains = [], allowPrivateAddresses = false } = {}) {
  let url;
  try { url = new URL(raw); } catch { throw new TypeError('invalid research URL'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new ResearchSecurityError('only HTTP(S) research URLs are allowed', 'BAD_PROTOCOL');
  if (url.username || url.password) throw new ResearchSecurityError('research URLs cannot contain credentials', 'URL_CREDENTIALS_BLOCKED');
  if (url.port && !['80', '443'].includes(url.port)) throw new ResearchSecurityError('research URLs must use ports 80 or 443', 'PORT_BLOCKED');
  const host = normalizeHostname(url.hostname);
  if (!allowedDomains.some(domainMatches.bind(null, host))) {
    throw new ResearchSecurityError(`domain not allowlisted: ${host}`, 'DOMAIN_NOT_ALLOWLISTED');
  }
  if (!allowPrivateAddresses && isPrivateOrReservedHostname(host)) {
    throw new ResearchSecurityError(`private/reserved research host blocked: ${host}`, 'SSRF_BLOCKED');
  }
  url.hash = '';
  return url;
}

async function readLimitedBody(response, maxBytes, signal) {
  if (Number(response.headers?.get?.('content-length')) > maxBytes) {
    throw new ResearchSecurityError('research response exceeds byte limit', 'RESPONSE_TOO_LARGE');
  }
  const chunks = [];
  let total = 0;
  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of response.body) {
      if (signal?.aborted) throw new Error('research request aborted');
      total += chunk.length;
      if (total > maxBytes) throw new ResearchSecurityError('research response exceeds byte limit', 'RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length > maxBytes) throw new ResearchSecurityError('research response exceeds byte limit', 'RESPONSE_TOO_LARGE');
  return buffer;
}

function extractReadableText(raw, contentType) {
  // (raw is reassigned below after hidden-content removal)
  if (contentType === 'application/json') {
    try {
      const parsed = JSON.parse(raw);
      return { title: parsed?.title || null, text: JSON.stringify(parsed, null, 2) };
    } catch {
      return { title: null, text: raw };
    }
  }
  const hidden = stripHiddenElements(raw);
  raw = hidden.html;
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = decodeEntities(stripTags(titleMatch?.[1] || '')).trim().slice(0, 300) || null;
  const withoutNoise = raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(withoutNoise).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, text, hiddenRemoved: hidden.removed };
}

// Heuristic defence-in-depth, NOT a guarantee. The real protections are that the
// extractor model is told page text is untrusted data and that the research path
// gives the model no tools to act with. This filter removes the common attacks
// so they never reach the model, and flags the page so callers can distrust it.
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u00ad]/g;
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i' };
const INJECTION_PATTERNS = [
  /\b(ignore|disregard|forget|override|bypass|skip)\b[^.\n]{0,40}\b(previous|prior|above|earlier|preceding|all|any|your|the)\b[^.\n]{0,30}\b(instructions?|prompts?|rules?|guidelines?|directives?|training|context|told)\b/gi,
  /\b(forget|disregard|ignore)\s+(everything|all)\b[^.\n]{0,40}\b(told|said|know|learned|above|before)\b/gi,
  /\b(system|developer|assistant|admin|root)\s+(message|prompt|instructions?|override|note)\s*:/gi,
  /\b(new|updated|real|actual|secret)\s+(instructions?|task|goal|objective|directive)\s*:/gi,
  /\b(reveal|print|show|output|display|repeat|leak|tell me)\b[^.\n]{0,30}\b(system|developer|hidden|secret|initial|original)\s+(prompt|instructions?|rules?|message)/gi,
  /\bfollow\s+these\s+instructions?\b/gi,
  /\byou\s+are\s+(now|no longer)\b[^.\n]{0,60}/gi,
  /\bfrom\s+now\s+on,?\s+(you|ignore|always|never)\b/gi,
  /\b(do\s+not|don'?t|never)\s+(tell|inform|alert|mention|reveal)\b[^.\n]{0,30}\b(user|human|operator|anyone)\b/gi,
  /\b(send|post|upload|email|forward|exfiltrate|leak|transmit)\b[^.\n]{0,40}\b(user|users|conversation|chat|history|credentials?|passwords?|secrets?|api keys?|tokens?|private|personal|prompt|system)\b[^.\n]{0,40}\b(to|at)\s+(https?:\/\/|\S+@|\S+\.[a-z]{2,})/gi,
  /\btool\s*call\s*:/gi,
  /\bupload\s+(this|the following)\s+file\b/gi,
  /\bignor(e|ez|a|iere|a)\b[^.\n]{0,25}\b(instructions?|instrucciones|anweisungen|instructions? pr[eé]c[eé]dentes)\b/gi,
  /\b(ignorez|ignora|ignoriere|ignorar)\b[^.\n]{0,40}/gi,
  /(忽略|无视|忽视)[^。\n]{0,10}(指令|指示|说明|提示|规则)/g,
  /(игнорируй|забудь)[^.\n]{0,40}(инструкци|указани|правил)/gi,
];

function filterPromptInjection(text, maxMatches = 12) {
  const cleaned = String(text || '').normalize('NFKC').replace(INVISIBLE, '');
  // Same-length copy with look-alike digits/symbols mapped to letters, so "1gn0re" is caught.
  const skeleton = cleaned.replace(/[0134578@$!]/g, c => LEET[c] || c).toLowerCase();
  const ranges = [];
  for (const pattern of INJECTION_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(skeleton))) {
      if (m[0].length === 0) { pattern.lastIndex += 1; continue; }
      ranges.push([m.index, m.index + m[0].length]);
      if (ranges.length > 200) break;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const prev = merged[merged.length - 1];
    if (prev && r[0] <= prev[1]) prev[1] = Math.max(prev[1], r[1]); else merged.push([...r]);
  }
  let out = '';
  let cursor = 0;
  const matches = [];
  for (const [a, b] of merged) {
    out += cleaned.slice(cursor, a) + '[UNTRUSTED INSTRUCTION REMOVED]';
    if (matches.length < maxMatches) matches.push(cleaned.slice(a, b).slice(0, 120));
    cursor = b;
  }
  out += cleaned.slice(cursor);
  return {
    text: out,
    report: { detected: merged.length > 0, count: merged.length, examples: matches.slice(0, maxMatches) },
  };
}

function parseDuckDuckGoResults(html, limit = 8) {
  const results = [];
  const seen = new Set();
  const re = /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html)) && results.length < limit) {
    let href = decodeEntities(match[1]);
    try {
      if (href.startsWith('//')) href = `https:${href}`;
      const parsed = new URL(href);
      const target = parsed.searchParams.get('uddg');
      const finalUrl = target ? decodeURIComponent(target) : parsed.href;
      const url = new URL(finalUrl);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      const key = url.href;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        uri: key,
        title: decodeEntities(stripTags(match[2])).replace(/\s+/g, ' ').trim().slice(0, 300),
      });
    } catch {}
  }
  return results;
}

function makeDuckDuckGoSearch({ fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  return async function search(query, signal) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { accept: 'text/html', 'user-agent': 'NovaAI-Victus-Research/1.0 (+read-only)' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`research search returned HTTP ${response.status}`);
      const html = await response.text();
      return parseDuckDuckGoResults(html);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  };
}

function normalizeAllowlist(values) {
  if (typeof values === 'string') values = values.split(',');
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(value => String(value).trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '')).filter(Boolean))];
}

function domainMatches(host, domain) {
  if (domain === '*') return true;
  return host === domain || host.endsWith(`.${domain}`);
}

function normalizeHostname(hostname) {
  return String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function normalizeContentType(value) {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

function normalizeContentEncoding(value) {
  return String(value || '').split(',')[0].trim().toLowerCase();
}

function stripTags(value) { return String(value || '').replace(/<[^>]+>/g, ' '); }

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'");
}

function inferSourceType(hostname) {
  const host = normalizeHostname(hostname);
  if (/\.gov(?:\.|$)/.test(host)) return 'government';
  if (/\.edu(?:\.|$)/.test(host)) return 'academic';
  if (/^(docs?|developer|developers|support)\./.test(host)) return 'official_documentation';
  if (/^(github|gitlab|bitbucket)\./.test(host)) return 'public_dataset';
  return 'unknown';
}

function isRedirect(status) { return [301, 302, 303, 307, 308].includes(status); }

function clampInteger(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function isPrivateOrReservedHostname(host) {
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal' || host.endsWith('.local')) return true;
  if (net.isIP(host)) return isPrivateOrReservedIp(host);
  return false;
}

function isPrivateOrReservedIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return true;
}

function isPrivateIpv4(ip) {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c, d] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) || (a === 198 && b === 51 && c === 100) ||
    (a === 192 && b === 88 && c === 99) || (a === 192 && b === 175 && c === 48) ||
    (a === 240);
}

function isPrivateIpv6(ip) {
  const normalized = ip.toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1') return true;
  const value = ipv6ToBigInt(normalized);
  if (value == null) return true;
  const checks = [
    ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32],
    ['2001:10::', 28], ['::ffff:0:0', 96],
  ];
  return checks.some(([base, prefix]) => inIpv6Cidr(value, ipv6ToBigInt(base), prefix));
}

function ipv6ToBigInt(ip) {
  if (!ip.includes(':')) return null;
  const parts = ip.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':').filter(Boolean) : [];
  const right = parts[1] ? parts[1].split(':').filter(Boolean) : [];
  function expand(items) {
    const out = [];
    for (const part of items) {
      if (part.includes('.')) {
        const octets = part.split('.').map(Number);
        if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        out.push(((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16));
      } else out.push(part);
    }
    return out;
  }
  const l = expand(left); const r = expand(right);
  if (!l || !r) return null;
  const missing = 8 - l.length - r.length;
  if (parts.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = parts.length === 2 ? [...l, ...Array(missing).fill('0'), ...r] : [...l, ...r];
  if (groups.length !== 8) return null;
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(parseInt(group || '0', 16)), 0n);
}

function inIpv6Cidr(value, base, prefix) {
  if (base == null) return false;
  const shift = 128n - BigInt(prefix);
  return (value >> shift) === (base >> shift);
}

module.exports = {
  SafeResearchFetcher,
  ResearchSecurityError,
  filterPromptInjection,
  parseDuckDuckGoResults,
  makeDuckDuckGoSearch,
  validateResearchUrl,
  inferSourceType,
  isPrivateOrReservedIp,
  narrowAllowlist,
  domainMatches,
  decodeBody,
  stripHiddenElements,
};
