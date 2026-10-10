'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VictusWorldModel, InMemoryWorldRepository, safeAttributes, ENTITY_TYPES, RELATIONS } = require('../src/victus/world/model');

function makeModel() {
  return new VictusWorldModel({ repository: new InMemoryWorldRepository(), maxEntitiesPerTenant: 5, maxEdgesPerTenant: 10 });
}

test('world model exposes the required typed entity set', () => {
  assert.deepEqual(ENTITY_TYPES, ['USER','PROJECT','TASK','KNOWLEDGE','RESOURCE','TOOL','DEPENDENCY','EVENT','RESULT']);
  assert.ok(RELATIONS.includes('DEPENDS_ON'));
  assert.ok(RELATIONS.includes('PRODUCES'));
});

test('entities and relationships form a traversable graph', async () => {
  const model = makeModel();
  const user = await model.upsertEntity({ id: 'u1', type: 'USER', name: 'Owner' }, 'user:A');
  const project = await model.upsertEntity({ id: 'p1', type: 'PROJECT', name: 'Nova' }, 'user:A');
  const task = await model.upsertEntity({ id: 't1', type: 'TASK', name: 'World Model' }, 'user:A');
  await model.link({ fromId: user.id, toId: project.id, relation: 'OWNS' }, 'user:A');
  await model.link({ fromId: project.id, toId: task.id, relation: 'CONTAINS' }, 'user:A');
  const ctx = await model.context('user:A', ['u1'], { depth: 2 });
  assert.equal(ctx.entities.length, 3);
  assert.equal(ctx.edges.length, 2);
});

test('tenant isolation prevents cross-user graph linking and reads', async () => {
  const model = makeModel();
  await model.upsertEntity({ id: 'p1', type: 'PROJECT', name: 'Private' }, 'user:A');
  await assert.rejects(() => model.link({ fromId: 'p1', toId: 'p2', relation: 'RELATED_TO' }, 'user:B'), /endpoints/);
  assert.equal(await model.getEntity('user:B', 'p1'), null);
});

test('sensitive attributes are removed before storage', () => {
  const clean = safeAttributes({ public: 'ok', apiKey: 'secret', nested: { password: 'x', visible: true } });
  assert.deepEqual(clean, { public: 'ok', nested: { visible: true } });
});

test('invalid types and relations are rejected', async () => {
  const model = makeModel();
  await assert.rejects(() => model.upsertEntity({ type: 'MODEL', name: 'x' }, 'user:A'), /unsupported entity type/);
  await model.upsertEntity({ id: 'a', type: 'TASK', name: 'a' }, 'user:A');
  await model.upsertEntity({ id: 'b', type: 'TASK', name: 'b' }, 'user:A');
  await assert.rejects(() => model.link({ fromId: 'a', toId: 'b', relation: 'EXECUTES_SHELL' }, 'user:A'), /unsupported relation/);
});

test('in-memory world model enforces entity limits', async () => {
  const model = makeModel();
  for (let i = 0; i < 5; i++) await model.upsertEntity({ id: `e${i}`, type: 'EVENT', name: String(i) }, 'user:A');
  await assert.rejects(() => model.upsertEntity({ id: 'e5', type: 'EVENT', name: '5' }, 'user:A'), /limit reached/);
});

test('snapshot is bounded', async () => {
  const model = makeModel();
  for (let i = 0; i < 5; i++) await model.upsertEntity({ type: 'RESULT', name: `r${i}` }, 'user:A');
  const snap = await model.snapshot('user:A', { limit: 2 });
  assert.ok(snap.entities.length <= 2);
});

test('Victus goal execution enriches the World Model without making it critical', async () => {
  const { VictusEngine } = require('../src/victus/core/engine');
  const { ToolBus } = require('../src/victus/core/toolBus');
  const { PlanGraph } = require('../src/victus/core/planner');
  const bus = new ToolBus();
  bus.register({ toolId: 'ok', description: 'ok', permissions: [], preconditions: [], postconditions: [], execute: async () => ({ ok: true }) });
  const model = new VictusWorldModel({ repository: new InMemoryWorldRepository() });
  const engine = new VictusEngine({ toolBus: bus, worldModel: model });
  const plan = new PlanGraph('world model task');
  const step = plan.addStep({ id: 's', action: 'ok' });
  const result = await engine.runGoal({
    goal: 'world model task',
    plan,
    context: { tenantId: 'user:1', taskId: 'task-1' },
    verify: async () => ({ verified: true, confidence: 0.9 }),
  });
  assert.equal(result.success, true);
  const task = await model.getEntity('user:1', 'task-1');
  const out = await model.neighbors('user:1', task.id, { relation: 'PRODUCES' });
  assert.equal(task.status, 'COMPLETED');
  assert.equal(out.length, 1);
});
