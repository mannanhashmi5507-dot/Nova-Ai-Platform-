'use strict';

const { clamp } = require('./provenance');

function verifyClaims(claims, options = {}) {
  const list = Array.isArray(claims) ? claims : [];
  const minSources = Number.isInteger(options.minSources) ? options.minSources : 2;
  const sourceSet = new Set(list.map(c => c.source).filter(Boolean));
  const independentTypes = new Set(list.map(c => c.sourceType).filter(Boolean));
  const contradictionSet = new Set();
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (list[i].subject === list[j].subject && list[i].predicate === list[j].predicate && list[i].object !== list[j].object) {
        contradictionSet.add(`${list[i].claimId}|${list[j].claimId}`);
      }
    }
  }
  const avgReliability = list.length ? list.reduce((sum, c) => sum + clamp(c.provenance?.sourceReliability ?? 0.5), 0) / list.length : 0;
  const avgFreshness = list.length ? list.reduce((sum, c) => sum + clamp(c.provenance?.freshness ?? 0.5), 0) / list.length : 0;
  const corroboration = Math.min(1, sourceSet.size / minSources);
  const independence = Math.min(1, independentTypes.size / minSources);
  const contradictionPenalty = Math.min(0.6, contradictionSet.size * 0.2);
  const confidence = clamp(
    (avgReliability * 0.30) +
    (avgFreshness * 0.20) +
    (corroboration * 0.30) +
    (independence * 0.20) -
    contradictionPenalty
  );
  return {
    verified: list.length > 0 && sourceSet.size >= minSources && contradictionSet.size === 0,
    confidence,
    sourceCount: sourceSet.size,
    independentSourceTypeCount: independentTypes.size,
    contradictions: [...contradictionSet],
    evidence: list.map(c => ({ claimId: c.claimId, source: c.source, sourceType: c.sourceType, timestamp: c.timestamp })),
  };
}

module.exports = { verifyClaims };
