'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { KnowledgeGraph, makeClaim, verifyClaims, PlanGraph, ToolBus, MemoryStore } = require('../src/victus');
const { classifyChange, assertEvolutionAllowed } = require('../src/victus/core/policy');
const { EvolutionRegistry, qualifiesForAcceptance } = require('../src/victus/evolution/registry');
const { runEvolutionCycle } = require('../src/victus/evolution/controller');

test('knowledge graph preserves contradictions instead of overwriting them', () => {
  const kg = new KnowledgeGraph();
  const a = kg.addClaim({ subject: 'X', predicate: 'status', object: 'active', provenance: { source: 's1', sourceType: 'official_documentation', sourceReliability: 0.9, freshness: 0.9 } });
  const b = kg.addClaim({ subject: 'X', predicate: 'status', object: 'retired', provenance: { source: 's2', sourceType: 'reputable_journalism', sourceReliability: 0.8, freshness: 0.8 } });
  assert.equal(a.inserted, true);
  assert.equal(b.inserted, true);
  assert.equal(b.contradictions.length, 1);
  assert.equal(kg.find('X', 'status').length, 2);
});

test('verification requires independent corroboration and penalizes contradictions', () => {
  const a = makeClaim({ subject: 'X', predicate: 'status', object: 'active', confidence: 0.9, provenance: { source: 's1', sourceType: 'official_documentation', sourceReliability: 1, freshness: 1 } });
  const b = makeClaim({ subject: 'X', predicate: 'status', object: 'active', confidence: 0.8, provenance: { source: 's2', sourceType: 'government', sourceReliability: 1, freshness: 1 } });
  const result = verifyClaims([a, b]);
  assert.equal(result.verified, true);
  assert.ok(result.confidence > 0.7);
});

test('planner exposes executable DAG readiness', () => {
  const plan = new PlanGraph('collect and verify evidence');
  const a = plan.addStep({ id: 'search', action: 'search_web' });
  const b = plan.addStep({ id: 'verify', action: 'verify_sources', dependsOn: ['search'] });
  assert.deepEqual(plan.readySteps().map(s => s.id), ['search']);
  plan.mark(a.id, 'SUCCEEDED');
  assert.deepEqual(plan.readySteps().map(s => s.id), ['verify']);
  plan.mark(b.id, 'SUCCEEDED');
  assert.equal(plan.isComplete(), true);
});

test('tool bus enforces policy before execution', async () => {
  let called = false;
  const bus = new ToolBus({ policy: { isAllowed: ({ context }) => context.role === 'reader' } });
  bus.register({ toolId: 'memory.read', description: 'read memory', permissions: ['READ'], preconditions: [], postconditions: [], actionType: 'READ', execute: async () => { called = true; return 42; } });
  await assert.rejects(() => bus.execute('memory.read', {}, { role: 'guest' }), /denied/);
  assert.equal(called, false);
  const result = await bus.execute('memory.read', {}, { role: 'reader' });
  assert.equal(result.result, 42);
});

test('tool bus enforces preconditions, postconditions, and timeout', async () => {
  const { ToolBus } = require('../src/victus/core/toolBus');
  const bus = new ToolBus();
  bus.register({
    toolId: 'secure.read', description: 'secure read', permissions: ['READ'], actionType: 'READ',
    preconditions: ['input.token'],
    postconditions: ['result.ok'],
    timeoutMs: 100,
    execute: async input => ({ ok: input.token === 'yes' }),
  });
  await assert.rejects(() => bus.execute('secure.read', {}), /precondition failed/);
  const result = await bus.execute('secure.read', { token: 'yes' });
  assert.equal(result.result.ok, true);
  bus.register({
    toolId: 'slow', description: 'slow tool', permissions: ['EXECUTE'], actionType: 'EXECUTE',
    preconditions: [], postconditions: [], timeoutMs: 5, execute: async () => new Promise(r => setTimeout(() => r('done'), 20)),
  });
  await assert.rejects(() => bus.execute('slow', {}), /timeout/);
});

test('user memory is tenant-isolated', () => {
  const memory = new MemoryStore();
  memory.put({ tier: 'USER', tenantId: 'A', content: 'likes concise answers' });
  memory.put({ tier: 'USER', tenantId: 'B', content: 'likes detailed answers' });
  assert.equal(memory.search({ tier: 'USER', tenantId: 'A', query: 'answers' }).length, 1);
  assert.equal(memory.search({ tier: 'USER', tenantId: 'A', query: 'detailed' }).length, 0);
});

test('security boundary requires explicit human authorization', () => {
  const c = classifyChange({ paths: ['security/authorization/policy.js'], actionType: 'WRITE' });
  assert.equal(c.touchesImmutable, true);
  assert.throws(() => assertEvolutionAllowed({ paths: ['security/authorization/policy.js'], actionType: 'WRITE' }), /human authorization/);
  assert.equal(assertEvolutionAllowed({ paths: ['search/ranking.js'], actionType: 'WRITE' }, { approved: true }), true);
});

test('evolution qualification requires tests, security, and beating the baseline', () => {
  const registry = new EvolutionRegistry();
  const proposal = registry.createProposal({ description: 'improve ranking', change: {} });
  proposal.tests = [{ name: 'unit', passed: true }];
  proposal.security = [{ name: 'sandbox', passed: true }];
  proposal.benchmarks = [{ metric: 'accuracy', candidateBeatsBaseline: true }];
  assert.equal(qualifiesForAcceptance(proposal), true);
});

test('evolution controller rejects an unproven candidate and records it', async () => {
  const result = await runEvolutionCycle(
    { description: 'candidate search optimization', change: { paths: ['search/ranking.js'], actionType: 'WRITE' } },
    {
      runTests: async () => [{ name: 'unit', passed: true }],
      runSecurityChecks: async () => [{ name: 'static', passed: true }],
      runBenchmarks: async () => [{ metric: 'latency', candidateBeatsBaseline: false }],
    }
  );
  assert.equal(result.decision, 'REJECTED');
  assert.equal(result.proposal.outcome, 'REJECTED');
});

test('research pipeline creates provenance-bearing claims from fetched evidence', async () => {
  const { ResearchPipeline } = require('../src/victus/core/research');
  const pipeline = new ResearchPipeline({
    search: async () => [
      { uri: 'https://a.example', title: 'A', sourceType: 'official_documentation', publishedAt: new Date().toISOString() },
      { uri: 'https://b.example', title: 'B', sourceType: 'government', publishedAt: new Date().toISOString() },
    ],
    fetchDocument: async result => result,
    extractClaims: async document => [{ subject: 'Victus', predicate: 'has_source', object: document.title }],
  });
  const result = await pipeline.research('Victus architecture');
  assert.equal(result.fetchedCount, 2);
  assert.equal(result.claims.length, 2);
  assert.ok(result.claims[0].provenance.source);
});

test('experiment registry records explicit accept/reject decisions', () => {
  const { ExperimentRegistry, compareMetric } = require('../src/victus/core/experiments');
  const registry = new ExperimentRegistry();
  const exp = registry.create({ name: 'ranker-v2', hypothesis: 'better ranking improves quality', metrics: ['quality'] });
  assert.equal(compareMetric(0.8, 0.9).better, true);
  registry.complete(exp.id, { quality: 0.9 }, 'ACCEPT');
  assert.equal(registry.get(exp.id).decision, 'ACCEPT');
});

test('BM25 memory search ranks rarer, denser matches above common ones and keeps tenant isolation', () => {
  const m = new MemoryStore();
  m.put({ tier: 'SEMANTIC', content: 'postgres connection pooling tuning guide' });
  m.put({ tier: 'SEMANTIC', content: 'the guide to guide writing and more guide notes' });
  m.put({ tier: 'USER', tenantId: 'a', content: 'secret postgres password rotation' });
  const hits = m.search({ query: 'postgres pooling', tenantId: 'b' });
  assert.equal(hits[0].content, 'postgres connection pooling tuning guide');
  assert.ok(!hits.some(h => h.tenantId === 'a'));
  const own = m.search({ query: 'postgres', tenantId: 'a' });
  assert.ok(own.some(h => h.tenantId === 'a'));
  const del = m.search({ query: 'pooling' })[0];
  m.delete(del.id);
  assert.equal(m.search({ query: 'pooling' }).length, 0);
});

test('experience store prefers proven workflows and is not fooled by one lucky run', () => {
  const { ExperienceStore } = require('../src/victus');
  const x = new ExperienceStore();
  for (let i = 0; i < 8; i++) x.record({ goal: 'summarize report', workflow: 'steady', success: i !== 0 });
  x.record({ goal: 'summarize report', workflow: 'lucky', success: true });
  assert.equal(x.best('summarize report', ['lucky', 'steady']).workflow, 'steady');
  assert.equal(x.best('never seen goal', ['a', 'b']).runs, 0);
});

test('engine runs a unified goal loop with memory and verification', async () => {
  const bus = new ToolBus();
  bus.register({ toolId: 'answer', description: 'answer', permissions: [], preconditions: [], postconditions: [], execute: async input => ({ text: input.text }) });
  const { VictusEngine } = require('../src/victus');
  const memory = new MemoryStore();
  memory.put({ tier: 'SEMANTIC', content: 'use verified answer workflow' });
  const engine = new VictusEngine({ toolBus: bus, memory });
  const plan = new PlanGraph('answer goal');
  plan.addStep({ id: 'answer', action: 'answer', input: { text: 'ok' } });
  const result = await engine.runGoal({
    goal: 'answer goal',
    workflows: ['safe'],
    plan,
    verify: async ({ results }) => ({ verified: results.length === 1, confidence: 0.95 }),
  });
  assert.equal(result.success, true);
  assert.equal(result.memories.length, 1);
  assert.equal(result.verification.verified, true);
});

test('engine records plan outcomes into experience memory', async () => {
  const { VictusEngine } = require('../src/victus');
  const bus = new ToolBus();
  bus.register({ toolId: 'ok', description: 'ok', permissions: [], preconditions: [], postconditions: [], execute: async () => 1 });
  bus.register({ toolId: 'bad', description: 'bad', permissions: [], preconditions: [], postconditions: [], execute: async () => { throw new Error('x'); } });
  const engine = new VictusEngine({ toolBus: bus });
  const good = new PlanGraph('deploy site'); good.addStep({ id: 's', action: 'ok' });
  const bad = new PlanGraph('deploy site'); bad.addStep({ id: 's', action: 'bad' });
  await engine.executePlan(good, { workflow: 'A' });
  await assert.rejects(() => engine.executePlan(bad, { workflow: 'B' }));
  assert.equal(engine.chooseWorkflow('deploy site', ['B', 'A']).workflow, 'A');
});


test('experience learning can use a stable explicit family independent of goal text', async () => {
  const { VictusEngine } = require('../src/victus');
  const { ToolBus } = require('../src/victus/core/toolBus');
  const { PlanGraph } = require('../src/victus/core/planner');
  const engine = new VictusEngine({ toolBus: new ToolBus() });
  engine.toolBus.register({ toolId: 'ok', description: 'ok', permissions: [], preconditions: [], postconditions: [], execute: async () => ({ ok: true }) });
  const plan = new PlanGraph('code');
  plan.addStep({ id: 's', action: 'ok' });
  const result = await engine.runGoal({
    goal: 'fix coding request',
    workflows: ['coding:js:deep'],
    plan,
    context: { experienceFamily: 'coding:javascript:fix' },
    verify: async () => ({ verified: true, confidence: 0.95 }),
  });
  assert.equal(result.success, true);
  assert.equal(engine.experience.records.at(-1).family, 'coding:javascript:fix');
});
