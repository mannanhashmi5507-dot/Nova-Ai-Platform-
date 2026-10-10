'use strict';

// Upgrade proposal queue. Victus may PROPOSE changes; only an authenticated
// human can approve them. Nothing here applies code: APPROVED means "a human
// said yes", and APPLIED is recorded by a human after they apply it themselves.

const crypto = require('crypto');
const { classifyChange, IMMUTABLE_PATHS } = require('../core/policy');
const { PolicyViolationError, ValidationError, NotFoundError, StateError } = require('./errors');

const STATUS = Object.freeze({ PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED', EXPIRED: 'EXPIRED', APPLIED: 'APPLIED' });
const LIMITS = Object.freeze({ title: 200, description: 5000, reason: 2000, diff: 100000, note: 1000, files: 50, sources: 20, maxPending: 100 });
const DAY_MS = 24 * 3600 * 1000;

function isHuman(actor) { return actor && actor.type === 'human' && typeof actor.id === 'string' && actor.id.length > 0; }
function needText(v, name, max, required = true) {
  if (v == null || v === '') { if (required) throw new ValidationError(`${name} is required`); return null; }
  if (typeof v !== 'string') throw new ValidationError(`${name} must be a string`);
  if (v.length > max) throw new ValidationError(`${name} too long (max ${max})`);
  return v;
}
function cleanSources(list) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > LIMITS.sources) throw new ValidationError(`sources must be an array of up to ${LIMITS.sources} URLs`);
  return list.map(u => {
    let parsed;
    try { parsed = new URL(u); } catch { throw new ValidationError('sources must be valid URLs'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new ValidationError('sources must be http(s) URLs');
    return parsed.href;
  });
}
function cleanFiles(list) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > LIMITS.files || list.some(f => typeof f !== 'string' || !f || f.length > 300)) throw new ValidationError(`filesChanged must be an array of up to ${LIMITS.files} paths`);
  return list.map(f => f.replace(/\\/g, '/').replace(/^\.\//, ''));
}
// A diff can modify files that `filesChanged` doesn't mention. Read the paths out
// of the diff itself so the locked-core check can't be bypassed by under-declaring.
function diffPaths(diff) {
  if (!diff) return [];
  const out = new Set();
  for (const line of String(diff).split('\n')) {
    let m;
    if ((m = line.match(/^diff --git a\/(.+?) b\/(.+)$/))) { out.add(m[1]); out.add(m[2]); }
    else if ((m = line.match(/^(?:---|\+\+\+) (?:[ab]\/)?(\S.*?)(?:\t.*)?$/)) && m[1] !== '/dev/null') out.add(m[1]);
    else if ((m = line.match(/^(?:rename|copy) (?:from|to) (.+)$/))) out.add(m[1]);
  }
  return [...out].slice(0, 500);
}
function hashContent(p) {
  return crypto.createHash('sha256').update(JSON.stringify([p.title, p.description, p.reason, p.sources, p.filesChanged, p.actionType, p.diff])).digest('hex');
}

class UpgradeProposalQueue {
  constructor({ audit, killSwitch, ttlDays = 14, now = () => Date.now() } = {}) {
    if (!audit || !killSwitch) throw new TypeError('audit and killSwitch are required');
    this.audit = audit;
    this.killSwitch = killSwitch;
    this.ttlMs = ttlDays * DAY_MS;
    this.now = now;
    this.items = new Map();
  }

  submit(input = {}, proposer = { type: 'victus', id: 'victus' }) {
    this.killSwitch.assertRunning('proposals');
    this._expireStale();
    const actorLabel = `${proposer.type}:${proposer.id}`;
    try {
      if ([...this.items.values()].filter(p => p.status === STATUS.PENDING).length >= LIMITS.maxPending) throw new StateError('too many pending proposals; review the queue first');
      const proposal = {
        title: needText(input.title, 'title', LIMITS.title),
        description: needText(input.description, 'description', LIMITS.description),
        reason: needText(input.reason, 'reason', LIMITS.reason, false),
        diff: needText(input.diff, 'diff', LIMITS.diff, false),
        sources: Object.freeze(cleanSources(input.sources)),
        filesChanged: Object.freeze(cleanFiles(input.filesChanged)),
        actionType: ['WRITE', 'DEPLOY', 'DELETE', 'ADMIN'].includes(input.actionType) ? input.actionType : 'WRITE',
      };
      const risk = classifyChange({ paths: [...proposal.filesChanged, ...diffPaths(proposal.diff)], actionType: proposal.actionType, irreversible: input.irreversible === true });
      // The locked safety core: Victus may never even queue a change to it.
      if (risk.touchesImmutable && proposer.type !== 'human') {
        throw new PolicyViolationError(`proposals touching the locked safety core (${IMMUTABLE_PATHS.join(', ')}) can only be submitted by a human`);
      }
      const id = `prop-${crypto.randomBytes(6).toString('hex')}`;
      const record = Object.freeze({
        id, ...proposal, risk,
        contentHash: hashContent(proposal),
        proposedBy: { type: proposer.type, id: proposer.id },
        status: STATUS.PENDING,
        decision: null,
        createdAt: new Date(this.now()).toISOString(),
        expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
      });
      this.items.set(id, record);
      this.audit.append({ actor: actorLabel, action: 'proposal.submitted', target: id, metadata: { title: proposal.title, risk, sources: proposal.sources.length, contentHash: record.contentHash } });
      return { ...record };
    } catch (err) {
      this.audit.append({ actor: actorLabel, action: 'proposal.submit', outcome: 'blocked', metadata: { error: err.message } });
      throw err;
    }
  }

  approve(id, { by, note = '', confirmHighRisk = false } = {}) {
    this.killSwitch.assertRunning('proposals');
    const p = this._pending(id, by, 'approve');
    if (p.risk.requiresHumanApproval && confirmHighRisk !== true) {
      this.audit.append({ actor: `human:${by.id}`, action: 'proposal.approve', target: id, outcome: 'blocked', metadata: { reason: 'high-risk needs confirmHighRisk' } });
      throw new PolicyViolationError('this proposal is high-risk; approval requires confirmHighRisk: true');
    }
    return this._decide(p, STATUS.APPROVED, by, note);
  }

  // Rejecting stays possible while the kill switch is engaged: saying "no" is always safe.
  reject(id, { by, note = '' } = {}) {
    const p = this._pending(id, by, 'reject');
    return this._decide(p, STATUS.REJECTED, by, note);
  }

  markApplied(id, { by, note = '' } = {}) {
    if (!isHuman(by)) throw new PolicyViolationError('only a human can mark a proposal as applied');
    const p = this._get(id);
    if (p.status !== STATUS.APPROVED) throw new StateError(`only APPROVED proposals can be marked applied (status is ${p.status})`);
    if (hashContent(p) !== p.contentHash) throw new PolicyViolationError('proposal content changed after approval');
    const next = Object.freeze({ ...p, status: STATUS.APPLIED, appliedBy: by.id, appliedAt: new Date(this.now()).toISOString() });
    this.items.set(id, next);
    this.audit.append({ actor: `human:${by.id}`, action: 'proposal.applied', target: id, metadata: { note: String(note).slice(0, LIMITS.note) } });
    return { ...next };
  }

  get(id) { this._expireStale(); return { ...this._get(id) }; }

  list({ status, limit = 50 } = {}) {
    this._expireStale();
    const n = Math.min(200, Math.max(1, Number(limit) || 50));
    return [...this.items.values()].filter(p => !status || p.status === status).slice(-n).reverse().map(p => ({ ...p }));
  }

  _get(id) {
    const p = this.items.get(id);
    if (!p) throw new NotFoundError('proposal not found');
    return p;
  }

  _pending(id, by, verb) {
    this._expireStale();
    if (!isHuman(by)) {
      this.audit.append({ actor: by ? `${by.type}:${by.id}` : 'unknown', action: `proposal.${verb}`, target: id, outcome: 'blocked', metadata: { reason: 'not a human' } });
      throw new PolicyViolationError(`only a human can ${verb} proposals`);
    }
    const p = this._get(id);
    if (p.status !== STATUS.PENDING) throw new StateError(`proposal is ${p.status}, not PENDING`);
    return p;
  }

  _decide(p, status, by, note) {
    const next = Object.freeze({ ...p, status, decision: { by: by.id, note: String(note).slice(0, LIMITS.note), at: new Date(this.now()).toISOString() } });
    this.items.set(p.id, next);
    this.audit.append({ actor: `human:${by.id}`, action: `proposal.${status.toLowerCase()}`, target: p.id, metadata: { note: String(note).slice(0, LIMITS.note), contentHash: p.contentHash } });
    return { ...next };
  }

  _expireStale() {
    const t = this.now();
    for (const [id, p] of this.items) {
      if (p.status === STATUS.PENDING && Date.parse(p.expiresAt) <= t) {
        this.items.set(id, Object.freeze({ ...p, status: STATUS.EXPIRED }));
        this.audit.append({ actor: 'system', action: 'proposal.expired', target: id });
      }
    }
  }
}

module.exports = { UpgradeProposalQueue, STATUS, LIMITS };
