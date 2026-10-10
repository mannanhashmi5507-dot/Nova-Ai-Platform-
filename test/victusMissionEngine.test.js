'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MissionEngine, InMemoryMissionRepository, normalizeMission, detectCycles } = require('../src/victus/mission/engine');
const { VictusWorldModel, InMemoryWorldRepository } = require('../src/victus/world/model');

function makeToolBus(handlers = {}) {
  return { execute: async (action, input, context) => {
    if (!handlers[action]) throw new Error(`unknown tool: ${action}`);
    return { toolId: action, result: await handlers[action](input, context) };
  } };
}

function makeEngine(handlers = {}) {
  return new MissionEngine({
    repository: new InMemoryMissionRepository(),
    toolBus: makeToolBus(handlers),
  });
}

test('mission engine validates the DAG and rejects cycles', () => {
  assert.throws(() => normalizeMission({ goal: 'x', tasks: [
    { id: 'a', action: 'a', dependsOn: ['b'] },
    { id: 'b', action: 'b', dependsOn: ['a'] },
  ] }, 'user:1'), /cycle/);
  assert.doesNotThrow(() => detectCycles([
    { id: 'a', dependsOn: [] }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: ['b'] },
  ]));
});

test('mission engine creates bounded missions and computes ready tasks', async () => {
  const engine = makeEngine();
  const mission = await engine.createMission({ goal: 'Build', name: 'Build', tasks: [
    { id: 'a', action: 'a' },
    { id: 'b', action: 'b', dependsOn: ['a'] },
  ] }, 'user:1');
  assert.deepEqual(engine.readyTasks(mission).map(t => t.id), ['a']);
});

test('mission execution respects dependencies and reaches success', async () => {
  const order = [];
  const engine = makeEngine({
    a: async () => { order.push('a'); return { ok: true }; },
    b: async () => { order.push('b'); return { ok: true }; },
  });
  const mission = await engine.createMission({ goal: 'Build', tasks: [
    { id: 'a', action: 'a' },
    { id: 'b', action: 'b', dependsOn: ['a'] },
  ] }, 'user:1');
  const result = await engine.startMission('user:1', mission.id);
  assert.equal(result.status, 'SUCCEEDED');
  assert.deepEqual(order, ['a', 'b']);
});

test('verification failure can retry and eventually succeed', async () => {
  let calls = 0;
  const engine = makeEngine({ a: async () => ({ n: ++calls }) });
  const mission = await engine.createMission({ goal: 'Verify', tasks: [{ id: 'a', action: 'a', recoveryStrategy: 'retry', maxAttempts: 2 }] }, 'user:1');
  const result = await engine.startMission('user:1', mission.id, {
    verifyTask: async ({ task }) => ({ verified: task.attempts >= 2, confidence: 0.9 }),
  });
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.tasks[0].attempts, 2);
});

test('approval-required tasks pause until explicit human approval', async () => {
  const engine = makeEngine({ a: async () => ({ ok: true }) });
  const mission = await engine.createMission({ goal: 'Approve', tasks: [{ id: 'a', action: 'a', requiresApproval: true }] }, 'user:1');
  const paused = await engine.startMission('user:1', mission.id);
  assert.equal(paused.status, 'PAUSED');
  const resumed = await engine.startMission('user:1', mission.id, { humanApproval: true });
  assert.equal(resumed.status, 'SUCCEEDED');
});

test('kill switch blocks mission execution', async () => {
  const killSwitch = { assertRunning: () => { throw new Error('stopped'); } };
  const engine = new MissionEngine({ repository: new InMemoryMissionRepository(), toolBus: makeToolBus({ a: async () => ({}) }), killSwitch });
  const mission = await engine.createMission({ goal: 'Stop', tasks: [{ id: 'a', action: 'a' }] }, 'user:1');
  await assert.rejects(() => engine.startMission('user:1', mission.id), /stopped/);
});

test('cancelled missions stop before subsequent tasks and preserve tenant isolation', async () => {
  let ran = 0;
  const engine = makeEngine({ a: async () => ({ ok: ++ran }) });
  const mission = await engine.createMission({ goal: 'Cancel', tasks: [{ id: 'a', action: 'a' }] }, 'user:1');
  const other = await engine.getMission('user:2', mission.id);
  assert.equal(other, null);
  const cancelled = await engine.cancelMission('user:1', mission.id);
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(ran, 0);
});

test('World Model receives mission, task, dependency, and result state', async () => {
  const world = new VictusWorldModel({ repository: new InMemoryWorldRepository() });
  const engine = new MissionEngine({ repository: new InMemoryMissionRepository(), toolBus: makeToolBus({ a: async () => ({ ok: true }) }), worldModel: world });
  const mission = await engine.createMission({ name: 'World', goal: 'World', tasks: [{ id: 'a', action: 'a' }] }, 'user:1');
  const result = await engine.startMission('user:1', mission.id);
  assert.equal(result.status, 'SUCCEEDED');
  const snapshot = await world.snapshot('user:1');
  assert.ok(snapshot.entities.some(e => e.id === `mission:${mission.id}`));
  assert.ok(snapshot.entities.some(e => e.id === `mission:${mission.id}:task:a:result`));
  assert.ok(snapshot.edges.some(e => e.relation === 'CONTAINS'));
  assert.ok(snapshot.edges.some(e => e.relation === 'PRODUCES'));
});

test('mission engine can convert an existing PlanGraph into a mission', async () => {
  const engine = makeEngine({ a: async () => ({ ok: true }), b: async () => ({ ok: true }) });
  const plan = {
    steps: [
      { id: 'a', action: 'a', description: 'First' },
      { id: 'b', action: 'b', description: 'Second', dependsOn: ['a'] },
    ],
  };
  const mission = await engine.createMissionFromPlan({ goal: 'Plan', plan }, 'user:1');
  assert.equal(mission.tasks.length, 2);
  const result = await engine.startMission('user:1', mission.id);
  assert.equal(result.status, 'SUCCEEDED');
});

test('pause requests stop after the current task instead of cancelling the mission', async () => {
  let release;
  const first = new Promise(resolve => { release = resolve; });
  const engine = makeEngine({ a: async () => { await first; return { ok: true }; }, b: async () => ({ ok: true }) });
  const mission = await engine.createMission({ goal: 'Pause', tasks: [
    { id: 'a', action: 'a' }, { id: 'b', action: 'b', dependsOn: ['a'] },
  ] }, 'user:1');
  const running = engine.startMission('user:1', mission.id);
  while (!engine.activeRuns.has(`user:1:${mission.id}`)) await new Promise(r => setTimeout(r, 1));
  await engine.pauseMission('user:1', mission.id);
  release();
  const paused = await running;
  assert.equal(paused.status, 'PAUSED');
  assert.equal(paused.tasks[0].status, 'SUCCEEDED');
  assert.equal(paused.tasks[1].status, 'PENDING');
});


test('Postgres repository uses optimistic mission versions', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.trim().startsWith('INSERT')) return { rows: [{
      id:'m', tenant_id:'user:1', name:'N', goal:'G', status:'READY', constraints:{}, metadata:{}, tasks:[], version:1,
      created_at:new Date().toISOString(), updated_at:new Date().toISOString(), started_at:null, completed_at:null,
    }]};
    return { rows: [{
      id:'m', tenant_id:'user:1', name:'N', goal:'G', status:'RUNNING', constraints:{}, metadata:{}, tasks:[], version:2,
      created_at:new Date().toISOString(), updated_at:new Date().toISOString(), started_at:new Date().toISOString(), completed_at:null,
    }]};
  }};
  const { PostgresMissionRepository } = require('../src/victus/mission/engine');
  const repo = new PostgresMissionRepository(pool);
  const created = await repo.create({ id:'m', tenantId:'user:1', name:'N', goal:'G', status:'READY', constraints:{}, metadata:{}, tasks:[], version:1, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() });
  const saved = await repo.save({ ...created, status:'RUNNING', startedAt:new Date().toISOString() });
  assert.equal(saved.version, 2);
  assert.match(calls[1].sql, /WHERE tenant_id=\$10 AND id=\$11 AND version=\$12/);
});
