'use strict';

const ACTION_TYPES = Object.freeze(['READ', 'WRITE', 'EXECUTE', 'DEPLOY', 'DELETE', 'ADMIN']);
const TRUST_LEVELS = Object.freeze(['IMMUTABLE', 'CONTROLLED', 'EVOLVING']);
const MEMORY_TIERS = Object.freeze(['WORKING', 'EPISODIC', 'SEMANTIC', 'PROCEDURAL', 'USER']);

function assertNonEmpty(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
}

function normalizeId(value, field = 'id') {
  assertNonEmpty(value, field);
  return value.trim();
}

function normalizeTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('timestamp must be a valid date');
  return date.toISOString();
}

module.exports = { ACTION_TYPES, TRUST_LEVELS, MEMORY_TIERS, assertNonEmpty, normalizeId, normalizeTimestamp };
