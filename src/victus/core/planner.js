'use strict';

const crypto = require('crypto');

function nodeId(prefix = 'step') { return `${prefix}_${crypto.randomUUID()}`; }

function makeStep(input = {}) {
  if (!input.action || typeof input.action !== 'string') throw new TypeError('action is required');
  return {
    id: input.id || nodeId('step'),
    description: input.description || input.action,
    preconditions: Array.isArray(input.preconditions) ? input.preconditions : [],
    action: input.action,
    expectedResult: input.expectedResult || null,
    postconditions: Array.isArray(input.postconditions) ? input.postconditions : [],
    failureConditions: Array.isArray(input.failureConditions) ? input.failureConditions : [],
    recoveryStrategy: input.recoveryStrategy || 'stop',
    dependsOn: Array.isArray(input.dependsOn) ? input.dependsOn : [],
    status: 'PENDING',
    attempts: 0,
  };
}

class PlanGraph {
  constructor(goal, constraints = []) {
    this.goal = goal;
    this.constraints = constraints;
    this.steps = new Map();
  }

  addStep(stepInput) {
    const step = makeStep(stepInput);
    for (const dep of step.dependsOn) {
      if (!this.steps.has(dep)) throw new Error(`unknown dependency: ${dep}`);
    }
    this.steps.set(step.id, step);
    return step;
  }

  readySteps() {
    return [...this.steps.values()].filter(step =>
      step.status === 'PENDING' && step.dependsOn.every(dep => this.steps.get(dep)?.status === 'SUCCEEDED')
    );
  }

  mark(stepId, status, details = {}) {
    const step = this.steps.get(stepId);
    if (!step) throw new Error(`unknown step: ${stepId}`);
    step.status = status;
    Object.assign(step, details);
    return step;
  }

  isComplete() { return [...this.steps.values()].every(s => s.status === 'SUCCEEDED'); }

  hasFailure() { return [...this.steps.values()].some(s => s.status === 'FAILED'); }

  toJSON() { return { goal: this.goal, constraints: this.constraints, steps: [...this.steps.values()] }; }
}

module.exports = { PlanGraph, makeStep };
