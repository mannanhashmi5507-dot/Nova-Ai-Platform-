'use strict';

const { EvolutionRegistry, qualifiesForAcceptance } = require('./registry');
const { assertEvolutionAllowed } = require('../core/policy');

async function runEvolutionCycle(input, adapters = {}) {
  const registry = adapters.registry || new EvolutionRegistry();
  const proposal = registry.createProposal(input);
  assertEvolutionAllowed(input.change || {}, input.approval || {});

  const run = async (name, fallback) => {
    const fn = adapters[name];
    if (typeof fn !== 'function') return fallback;
    return fn(proposal);
  };

  proposal.tests = await run('runTests', []);
  proposal.security = await run('runSecurityChecks', []);
  proposal.benchmarks = await run('runBenchmarks', []);

  const acceptable = qualifiesForAcceptance(proposal);
  if (!acceptable) {
    registry.decide(proposal.versionId, 'REJECTED');
    return { decision: 'REJECTED', proposal };
  }

  const deployment = await run('canaryDeploy', { status: 'SKIPPED' });
  proposal.deployment = deployment;
  if (deployment && deployment.status === 'FAILED') {
    proposal.rollback = await run('rollback', { status: 'COMPLETED' });
    registry.decide(proposal.versionId, 'ROLLED_BACK');
    return { decision: 'ROLLED_BACK', proposal };
  }

  registry.decide(proposal.versionId, 'ACCEPTED');
  return { decision: 'ACCEPTED', proposal };
}

module.exports = { runEvolutionCycle };
