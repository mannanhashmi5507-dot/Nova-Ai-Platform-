'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VictusSelfMonitor, AutonomousReasoner } = require('../src/victus/core/selfMonitor');
const { VictusEngine } = require('../src/victus/core/engine');
const { ToolBus } = require('../src/victus/core/toolBus');
const { PlanGraph } = require('../src/victus/core/planner');

test('self monitor tracks an operational task without pretending it is consciousness', () => {
  const monitor = new VictusSelfMonitor({ reasoner: new AutonomousReasoner() });
  const started = monitor.begin({ goal: 'check a coding answer', workflow: 'coding:js:deep' });
  assert.equal(started.status, 'RUNNING');
  monitor.checkpoint(started.taskId, 'EXECUTION', { stepCount: 2, toolCalls: 2 });
  const done = monitor.complete(started.taskId, { success: true, confidence: 0.94, reason: 'passed' });
  assert.equal(done.status, 'COMPLETED');
  assert.equal(done.finalSuccess, true);
  assert.equal(monitor.status().health, 'HEALTHY');
});

test('reasoner asks for one more verification when confidence is low', () => {
  const monitor = new VictusSelfMonitor();
  const s = monitor.begin({ goal: 'verify result' });
  const decision = monitor.decide(s.taskId, { verification: { verified: false, confidence: 0.45 } });
  assert.equal(decision.action, 'VERIFY_AGAIN');
  assert.equal(monitor.snapshot(s.taskId).verifyCount, 1);
});

test('reasoner escalates after recovery budgets are exhausted', () => {
  const monitor = new VictusSelfMonitor({ reasoner: new AutonomousReasoner({ maxRetries: 0, maxReplans: 0 }) });
  const s = monitor.begin({ goal: 'recover failed task' });
  const decision = monitor.decide(s.taskId, { error: new Error('failure') });
  assert.equal(decision.action, 'ESCALATE');
});

test('engine can autonomously replan once after a failed verification', async () => {
  const bus = new ToolBus();
  bus.register({ toolId: 'v1', description: 'v1', permissions: [], preconditions: [], postconditions: [], execute: async () => ({ version: 1 }) });
  bus.register({ toolId: 'v2', description: 'v2', permissions: [], preconditions: [], postconditions: [], execute: async () => ({ version: 2 }) });
  const engine = new VictusEngine({ toolBus: bus, selfMonitor: new VictusSelfMonitor() });

  const first = new PlanGraph('autonomous recovery');
  first.addStep({ id: 'step1', action: 'v1' });

  let replans = 0;
  const result = await engine.runGoal({
    goal: 'autonomous recovery',
    workflows: ['safe'],
    plan: first,
    replan: async () => {
      replans += 1;
      const next = new PlanGraph('autonomous recovery');
      next.addStep({ id: 'step2', action: 'v2' });
      return next;
    },
    verify: async ({ results }) => ({ verified: results[0]?.output?.result?.version === 2, confidence: results[0]?.output?.result?.version === 2 ? 0.95 : 0.2 }),
  });

  assert.equal(replans, 1);
  assert.equal(result.success, true);
  assert.equal(result.autonomous.cycles, 1);
  assert.equal(result.autonomous.decision.action, 'CONTINUE');
  assert.ok(result.trace.some(t => t.stage === 'replan'));
});

test('self monitor records high-severity anomalies for later inspection', () => {
  const monitor = new VictusSelfMonitor();
  const s = monitor.begin({ goal: 'monitor anomaly' });
  monitor.signal(s.taskId, { name: 'tool_timeout', severity: 'HIGH', detail: 'provider timeout' });
  const snap = monitor.snapshot(s.taskId);
  assert.equal(snap.anomalies.length, 1);
  assert.equal(snap.anomalies[0].type, 'tool_timeout');
});
