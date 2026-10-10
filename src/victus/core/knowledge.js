'use strict';

const crypto = require('crypto');
const { makeProvenance, clamp } = require('./provenance');
const { normalizeId, normalizeTimestamp } = require('./contracts');

function claimId(subject, predicate, object) {
  return crypto.createHash('sha256')
    .update(`${subject}\u0000${predicate}\u0000${object}`)
    .digest('hex');
}

function makeClaim(input = {}) {
  const subject = normalizeId(input.subject, 'subject');
  const predicate = normalizeId(input.predicate, 'predicate');
  const object = normalizeId(input.object, 'object');
  const provenance = makeProvenance(input.provenance || { source: input.source || 'unknown' });
  return {
    claimId: claimId(subject, predicate, object),
    subject, predicate, object,
    source: provenance.source,
    sourceType: provenance.sourceType,
    timestamp: normalizeTimestamp(input.timestamp || provenance.retrievedAt),
    confidence: clamp(input.confidence == null ? 0.5 : input.confidence),
    validFrom: input.validFrom ? normalizeTimestamp(input.validFrom) : null,
    validUntil: input.validUntil ? normalizeTimestamp(input.validUntil) : null,
    version: Number.isInteger(input.version) && input.version > 0 ? input.version : 1,
    provenance,
    derivation: Array.isArray(input.derivation) ? input.derivation.slice(0, 20) : [],
  };
}

function claimsContradict(a, b) {
  return a.subject === b.subject && a.predicate === b.predicate && a.object !== b.object;
}

class KnowledgeGraph {
  constructor({ maxClaims = 50000 } = {}) {
    this.maxClaims = Math.max(100, maxClaims);
    this.claims = new Map();
    this.bySP = new Map();
  }

  addClaim(input) {
    const claim = input.claimId ? { ...input, provenance: input.provenance || null } : makeClaim(input);
    const key = `${claim.subject}\u0000${claim.predicate}`;
    const siblings = this.bySP.get(key) || [];
    const contradictions = siblings.filter(existing => claimsContradict(existing, claim));
    const existing = this.claims.get(claim.claimId);
    if (existing && existing.confidence >= claim.confidence) return { claim: existing, inserted: false, contradictions };
    this.claims.set(claim.claimId, claim);
    // Replace the old entry: previously find() kept returning the superseded, lower-confidence claim.
    const at = siblings.findIndex(x => x.claimId === claim.claimId);
    if (at >= 0) siblings[at] = claim; else siblings.push(claim);
    this.bySP.set(key, siblings);
    while (this.claims.size > this.maxClaims) this._evictOldest();
    return { claim, inserted: !existing, contradictions };
  }

  find(subject, predicate) {
    return [...(this.bySP.get(`${subject}\u0000${predicate}`) || [])]
      .sort((a, b) => b.confidence - a.confidence || b.timestamp.localeCompare(a.timestamp));
  }

  _evictOldest() {
    const id = this.claims.keys().next().value;
    const old = this.claims.get(id);
    this.claims.delete(id);
    if (!old) return;
    const key = `${old.subject}\u0000${old.predicate}`;
    const rest = (this.bySP.get(key) || []).filter(x => x.claimId !== id);
    if (rest.length) this.bySP.set(key, rest); else this.bySP.delete(key);
  }

  get(id) { return this.claims.get(id) || null; }

  size() { return this.claims.size; }
}

module.exports = { KnowledgeGraph, makeClaim, claimsContradict, claimId };
