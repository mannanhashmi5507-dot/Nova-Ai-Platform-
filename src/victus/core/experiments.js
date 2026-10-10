'use strict';

class ExperimentRegistry {
  constructor() { this.experiments = new Map(); }

  create(input = {}) {
    if (!input.name || !input.hypothesis) throw new TypeError('name and hypothesis are required');
    const id = input.id || `exp-${Date.now()}-${this.experiments.size + 1}`;
    const record = {
      id,
      name: input.name,
      hypothesis: input.hypothesis,
      baseline: input.baseline || null,
      candidate: input.candidate || null,
      metrics: Array.isArray(input.metrics) ? input.metrics : [],
      dataset: input.dataset || null,
      resourceBudget: input.resourceBudget || null,
      result: null,
      decision: 'PENDING',
      createdAt: new Date().toISOString(),
    };
    this.experiments.set(id, record);
    return record;
  }

  complete(id, result, decision) {
    const exp = this.experiments.get(id);
    if (!exp) throw new Error(`unknown experiment: ${id}`);
    if (!['ACCEPT', 'REJECT', 'INCONCLUSIVE'].includes(decision)) throw new Error('invalid experiment decision');
    exp.result = result || null;
    exp.decision = decision;
    return exp;
  }

  get(id) { return this.experiments.get(id) || null; }
  list() { return [...this.experiments.values()]; }
}

function compareMetric(baseline, candidate, direction = 'higher') {
  if (!Number.isFinite(baseline) || !Number.isFinite(candidate)) return { comparable: false, better: false };
  return { comparable: true, better: direction === 'lower' ? candidate < baseline : candidate > baseline };
}

module.exports = { ExperimentRegistry, compareMetric };
