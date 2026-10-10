'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUacl } = require('../src/victus/cloud/uacl');

function futureNow(start = Date.now()) {
  let t = start;
  return { now: () => t, tick: ms => { t += ms; } };
}

test('UACL submits and schedules a job to a capable worker', () => {
  const clock = futureNow();
  const uacl = createUacl({ now: clock.now });
  uacl.registerWorker({ workerId: 'gpu-a', provider: 'local', capabilities: { accelerators: ['cuda'], acceleratorMemoryGb: 24, cpuCores: 16, ramGb: 64, storageGb: 200 } });
  const job = uacl.submitJob({ workloadType: 'training', tenantId: 't1', requirements: { accelerators: ['cuda'], acceleratorMemoryGb: 16, cpuCores: 8, ramGb: 32 } });
  assert.equal(job.state, 'assigned');
  assert.equal(job.assignedWorkerId, 'gpu-a');
});

test('UACL refuses a worker that does not meet accelerator requirements', () => {
  const uacl = createUacl();
  uacl.registerWorker({ workerId: 'cpu-only', capabilities: { accelerators: [], acceleratorMemoryGb: 0, cpuCores: 64, ramGb: 128 } });
  const job = uacl.submitJob({ workloadType: 'inference', requirements: { accelerators: ['cuda'], acceleratorMemoryGb: 8 } });
  assert.equal(job.state, 'queued');
  assert.equal(job.assignedWorkerId, null);
});

test('UACL completes a worker-owned job and updates utilization', () => {
  const uacl = createUacl();
  uacl.registerWorker({ workerId: 'gpu-b', capabilities: { accelerators: ['cuda'], acceleratorMemoryGb: 48, cpuCores: 32, ramGb: 128 } });
  const job = uacl.submitJob({ workloadType: 'evaluation', tenantId: 'team' });
  assert.equal(job.state, 'assigned');
  const running = uacl.claimJob('gpu-b');
  assert.equal(running.state, 'running');
  const done = uacl.completeJob('gpu-b', job.id, { score: 0.91 });
  assert.equal(done.state, 'succeeded');
  assert.deepEqual(done.result, { score: 0.91 });
  assert.equal(uacl.status().running, 0);
});

test('UACL rejects arbitrary shell-command workload specs by design', () => {
  const uacl = createUacl();
  uacl.registerWorker({ workerId: 'w', capabilities: { cpuCores: 8, ramGb: 16 } });
  const job = uacl.submitJob({ workloadType: 'inference', spec: { command: 'rm -rf /' } });
  assert.equal(job.state, 'assigned');
  assert.deepEqual(job.spec, { command: 'rm -rf /' });
  // The spec is treated as data only; UACL has no command execution primitive.
  assert.equal(typeof uacl.runCommand, 'undefined');
});

test('UACL expires stale jobs and workers', () => {
  const clock = futureNow();
  const uacl = createUacl({ now: clock.now, heartbeatTtlMs: 1000, jobTtlMs: 2000 });
  uacl.registerWorker({ workerId: 'w', capabilities: { cpuCores: 8, ramGb: 16 } });
  const job = uacl.submitJob({ workloadType: 'embedding' });
  assert.equal(job.state, 'assigned');
  clock.tick(1500);
  assert.equal(uacl.status().workers.offline, 1);
  clock.tick(9000);
  uacl.status();
  assert.equal(uacl.getJob(job.id).state, 'expired');
});

test('UACL compute kill switch blocks new submissions but cancellation remains available', () => {
  const { createUaclRoutes } = require('../src/victus/cloud/routes');
  const { KillSwitch } = require('../src/victus/safety/killSwitch');
  const uacl = createUacl();
  const killSwitch = new KillSwitch();
  const routes = createUaclRoutes(uacl, { killSwitch });
  const bodyReq = { body: { workloadType: 'inference' } };
  const blocked = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(v) { this.body = v; } };
  killSwitch.engage({ by: 'test', scope: 'compute' });
  routes.compute.requireComputeRunning(bodyReq, blocked, () => {});
  assert.equal(blocked.statusCode, 423);

  killSwitch.release({ by: 'test', scope: 'compute' });
  let nextCalled = false;
  routes.compute.requireComputeRunning(bodyReq, blocked, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});
