'use strict';

const crypto = require('crypto');

class EvolutionRegistry {
  constructor() {
    this.records = new Map();
    this.activeVersion = 'stable';
  }

  createProposal(input = {}) {
    if (!input.description) throw new TypeError('description is required');
    const versionId = input.versionId || `v-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
    const record = {
      versionId,
      parentVersion: input.parentVersion || this.activeVersion,
      description: input.description,
      reason: input.reason || null,
      filesChanged: Array.isArray(input.filesChanged) ? input.filesChanged : [],
      tests: [],
      benchmarks: [],
      security: [],
      deployment: null,
      rollback: null,
      outcome: 'PROPOSED',
      createdAt: new Date().toISOString(),
    };
    this.records.set(versionId, record);
    return record;
  }

  record(versionId, patch = {}) {
    const record = this.records.get(versionId);
    if (!record) throw new Error(`unknown evolution version: ${versionId}`);
    Object.assign(record, patch);
    return record;
  }

  decide(versionId, decision) {
    const record = this.records.get(versionId);
    if (!record) throw new Error(`unknown evolution version: ${versionId}`);
    if (!['ACCEPTED', 'REJECTED', 'ROLLED_BACK'].includes(decision)) throw new Error(`invalid decision: ${decision}`);
    record.outcome = decision;
    if (decision === 'ACCEPTED') this.activeVersion = versionId;
    return record;
  }

  get(versionId) { return this.records.get(versionId) || null; }
  list() { return [...this.records.values()]; }
}

function qualifiesForAcceptance(record) {
  const testsPass = record.tests.length > 0 && record.tests.every(t => t.passed === true);
  const securityPass = record.security.length > 0 && record.security.every(s => s.passed === true);
  const benchmarks = record.benchmarks.length > 0;
  const benchmarkPass = benchmarks && record.benchmarks.every(b => b.candidateBeatsBaseline === true);
  return testsPass && securityPass && benchmarkPass;
}

module.exports = { EvolutionRegistry, qualifiesForAcceptance };
