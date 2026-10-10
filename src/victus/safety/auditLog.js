'use strict';

// Tamper-evident audit log. Each entry's hash covers the previous entry's
// hash, so editing or deleting any retained entry breaks verify(). Entries are
// append-only; there is no update or delete API. Secrets are redacted before
// anything is stored.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const GENESIS = '0'.repeat(64);
const SENSITIVE_KEY = /(key|token|secret|password|authorization|cookie|credential)/i;

function redact(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 4) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 20).map(v => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 40)) out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    return out;
  }
  return String(value);
}

function hashEntry(e) {
  const body = JSON.stringify([e.seq, e.ts, e.actor, e.action, e.target, e.outcome, e.metadata, e.prevHash]);
  return crypto.createHash('sha256').update(body).digest('hex');
}

class AuditLog {
  constructor({ filePath = null, maxEntries = 5000, now = () => new Date() } = {}) {
    this.filePath = filePath;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = [];
    this.nextSeq = 1;
    this.loadError = null;
    if (filePath) this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) { fs.mkdirSync(path.dirname(this.filePath), { recursive: true }); return; }
      const lines = fs.readFileSync(this.filePath, 'utf8').split('\n').filter(Boolean);
      this.entries = lines.slice(-this.maxEntries).map(l => JSON.parse(l));
      if (this.entries.length) this.nextSeq = this.entries[this.entries.length - 1].seq + 1;
    } catch (err) {
      this.loadError = err.message;
    }
  }

  append({ actor, action, target = null, outcome = 'ok', metadata = {} } = {}) {
    if (!actor || !action) throw new TypeError('actor and action are required');
    const prev = this.entries[this.entries.length - 1];
    const entry = {
      seq: this.nextSeq++,
      ts: this.now().toISOString(),
      actor: String(actor).slice(0, 200),
      action: String(action).slice(0, 100),
      target: target == null ? null : String(target).slice(0, 200),
      outcome: String(outcome).slice(0, 40),
      metadata: redact(metadata),
      prevHash: prev ? prev.hash : GENESIS,
    };
    entry.hash = hashEntry(entry);
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.shift();
    if (this.filePath) {
      try { fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`); }
      catch (err) { this.loadError = `write failed: ${err.message}`; }
    }
    return entry;
  }

  list({ limit = 100, action } = {}) {
    const n = Math.min(500, Math.max(1, Number(limit) || 100));
    const rows = action ? this.entries.filter(e => e.action === action) : this.entries;
    return rows.slice(-n).reverse().map(e => ({ ...e }));
  }

  // Checks every retained entry links to the one before it and re-hashes to
  // its stored value. The oldest retained entry's prevHash is the trust anchor.
  verify() {
    for (let i = 0; i < this.entries.length; i += 1) {
      const e = this.entries[i];
      if (e.hash !== hashEntry(e)) return { valid: false, checked: i, brokenAtSeq: e.seq, reason: 'entry contents do not match hash' };
      if (i > 0 && e.prevHash !== this.entries[i - 1].hash) return { valid: false, checked: i, brokenAtSeq: e.seq, reason: 'chain link broken' };
    }
    return { valid: !this.loadError, checked: this.entries.length, brokenAtSeq: null, reason: this.loadError || null };
  }
}

module.exports = { AuditLog, redact, GENESIS };
