'use strict';

const { normalizeId, normalizeTimestamp } = require('./contracts');

const SOURCE_TYPES = Object.freeze([
  'government', 'official_documentation', 'academic', 'institution',
  'primary_company', 'reputable_journalism', 'public_dataset', 'secondary', 'unknown'
]);

function makeProvenance(input = {}) {
  const source = normalizeId(input.source, 'source');
  const sourceType = SOURCE_TYPES.includes(input.sourceType) ? input.sourceType : 'unknown';
  const retrievedAt = normalizeTimestamp(input.retrievedAt || new Date());
  const publishedAt = input.publishedAt ? normalizeTimestamp(input.publishedAt) : null;
  return {
    source,
    sourceType,
    retrievedAt,
    publishedAt,
    sourceReliability: clamp(input.sourceReliability == null ? 0.5 : input.sourceReliability),
    freshness: clamp(input.freshness == null ? 0.5 : input.freshness),
    excerpt: typeof input.excerpt === 'string' ? input.excerpt.slice(0, 1200) : null,
    uri: typeof input.uri === 'string' ? input.uri.slice(0, 2000) : null,
    promptInjectionDetected: input.promptInjectionDetected === true,
  };
}

function clamp(v) { return Math.min(1, Math.max(0, Number(v) || 0)); }

module.exports = { SOURCE_TYPES, makeProvenance, clamp };
