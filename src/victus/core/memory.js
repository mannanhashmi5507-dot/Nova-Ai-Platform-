'use strict';

const crypto = require('crypto');
const { MEMORY_TIERS, normalizeTimestamp } = require('./contracts');
const { BM25Index } = require('./ranking');

class MemoryStore {
  constructor({ maxItems = 20000 } = {}) {
    this.maxItems = Math.max(100, maxItems);
    this.items = new Map();
    this.index = new BM25Index();
  }

  put(input = {}) {
    if (!MEMORY_TIERS.includes(input.tier)) throw new TypeError(`invalid memory tier: ${input.tier}`);
    const id = input.id || crypto.randomUUID();
    const item = {
      id,
      tier: input.tier,
      subject: input.subject || null,
      predicate: input.predicate || null,
      object: input.object || null,
      content: input.content || null,
      source: input.source || null,
      confidence: Math.min(1, Math.max(0, Number(input.confidence ?? 0.5))),
      createdAt: normalizeTimestamp(input.createdAt || new Date()),
      validFrom: input.validFrom ? normalizeTimestamp(input.validFrom) : null,
      validUntil: input.validUntil ? normalizeTimestamp(input.validUntil) : null,
      version: Number.isInteger(input.version) ? input.version : 1,
      tenantId: input.tier === 'USER' ? input.tenantId || null : null,
      metadata: input.metadata || {},
    };
    if (item.tier === 'USER' && !item.tenantId) throw new Error('USER memory requires tenantId');
    const existing = this.items.get(id);
    // A caller-chosen id must never let one tenant overwrite another tenant's (or a shared) memory.
    if (existing && (existing.tier !== item.tier || existing.tenantId !== item.tenantId)) throw new Error('memory id already belongs to another tier or tenant');
    this.items.set(id, item);
    while (this.items.size > this.maxItems) {
      const oldest = this.items.keys().next().value;
      this.index.remove(oldest);
      this.items.delete(oldest);
    }
    this.index.add(id, [item.subject, item.predicate, item.object, item.content].filter(Boolean).join(' '));
    return item;
  }

  search({ tier, tenantId, subject, predicate, query, limit = 20 } = {}) {
    const keep = i => (!tier || i.tier === tier)
      && (i.tier !== 'USER' || i.tenantId === tenantId)
      && (!subject || i.subject === subject)
      && (!predicate || i.predicate === predicate);
    if (String(query || '').trim()) {
      return this.index
        .search(query, { limit: this.items.size, allow: id => keep(this.items.get(id)) })
        .slice(0, limit)
        .map(r => this.items.get(r.id));
    }
    return [...this.items.values()].filter(keep)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  delete(id, { tenantId } = {}) {
    const item = this.items.get(id);
    if (!item) return false;
    if (item.tier === 'USER' && item.tenantId !== tenantId) return false;
    this.index.remove(id);
    return this.items.delete(id);
  }
}

module.exports = { MemoryStore };
