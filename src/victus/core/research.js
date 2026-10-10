'use strict';

const { makeClaim } = require('./knowledge');
const { SOURCE_TYPES } = require('./provenance');

const DEFAULT_SOURCE_WEIGHTS = Object.freeze({
  government: 1.0,
  official_documentation: 0.98,
  academic: 0.96,
  institution: 0.92,
  primary_company: 0.90,
  public_dataset: 0.88,
  reputable_journalism: 0.82,
  secondary: 0.55,
  unknown: 0.25,
});

class ResearchPipeline {
  constructor({ search, fetchDocument, extractClaims, sourceWeights = DEFAULT_SOURCE_WEIGHTS } = {}) {
    if (typeof search !== 'function') throw new TypeError('search adapter is required');
    this.search = search;
    this.fetchDocument = fetchDocument || (async x => x);
    this.extractClaims = extractClaims || defaultClaimExtractor;
    this.sourceWeights = sourceWeights;
  }

  async research(goal, options = {}) {
    if (!goal || typeof goal !== 'string') throw new TypeError('research goal is required');
    const queries = await buildQueries(goal, options.queryPlanner);
    const discovered = Array.isArray(options.directSources) ? options.directSources.slice() : [];
    if (!discovered.length) {
      for (const query of queries.slice(0, options.maxQueries || 4)) {
        const results = await this.search(query, options.signal);
        discovered.push(...(Array.isArray(results) ? results : []));
      }
    }
    const deduped = dedupeByUri(discovered);
    const documents = [];
    for (const result of deduped.slice(0, options.maxDocuments || 12)) {
      try {
        documents.push(await this.fetchDocument(result, options.signal, options));
      } catch (error) {
        documents.push({ ...result, fetchError: error.message });
      }
    }
    const claims = [];
    for (const document of documents) {
      const extracted = await this.extractClaims(document, goal);
      for (const raw of (Array.isArray(extracted) ? extracted : [])) {
        const sourceType = normalizeSourceType(raw.sourceType);
        claims.push(makeClaim({
          ...raw,
          provenance: {
            ...(raw.provenance || {}),
            source: raw.source || document.uri || document.url || document.title || 'unknown',
            sourceType,
            sourceReliability: this.sourceWeights[sourceType] ?? 0.25,
            freshness: freshnessCoefficient(raw.publishedAt || document.publishedAt),
            uri: document.uri || document.url || null,
            excerpt: raw.provenance?.excerpt || document.text?.slice(0, 1200) || null,
            promptInjectionDetected: Boolean(raw.provenance?.promptInjectionDetected || document.promptInjection?.detected),
          },
        }));
      }
    }
    return {
      goal,
      queries,
      sources: deduped.map(s => ({ title: s.title || null, uri: s.uri || s.url || null, sourceType: normalizeSourceType(s.sourceType) })),
      claims,
      fetchedCount: documents.filter(d => !d.fetchError).length,
      failedFetchCount: documents.filter(d => d.fetchError).length,
      security: {
        promptInjectionDetected: documents.some(d => d.promptInjection?.detected === true),
        promptInjectionSources: documents.filter(d => d.promptInjection?.detected === true).map(d => d.uri || d.url).filter(Boolean),
      },
    };
  }
}

async function buildQueries(goal, queryPlanner) {
  if (typeof queryPlanner === 'function') {
    const custom = await queryPlanner(goal);
    if (Array.isArray(custom) && custom.length) return custom.filter(Boolean).map(String);
  }
  return [
    goal,
    `${goal} official documentation`,
    `${goal} primary source`,
    `${goal} recent evidence`,
  ];
}

function dedupeByUri(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = item.uri || item.url || `${item.title || ''}|${item.snippet || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeSourceType(type) {
  return SOURCE_TYPES.includes(type) ? type : 'unknown';
}

function freshnessCoefficient(value, now = Date.now()) {
  if (!value) return 0.5;
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return 0.5;
  const ageDays = Math.max(0, (now - t) / 86400000);
  return Math.max(0.05, Math.exp(-ageDays / 365));
}

function defaultClaimExtractor(document) {
  if (!document?.claim) return [];
  return [{
    subject: document.claim.subject,
    predicate: document.claim.predicate,
    object: document.claim.object,
    source: document.uri || document.url || 'unknown',
    sourceType: document.sourceType || 'unknown',
  }];
}

module.exports = { ResearchPipeline, buildQueries, dedupeByUri, freshnessCoefficient, DEFAULT_SOURCE_WEIGHTS };
