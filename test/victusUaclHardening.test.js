'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUacl, UaclError } = require('../src/victus/cloud/uacl');
const { createUaclRoutes, mountUaclRoutes } = require('../src/victus/cloud/routes');
const { createUaclWorkerAgent } = require('../src/victus/cloud/workerAgent');
const { KillSwitch } = require('../src/victus/safety/killSwitch');

const clock = (start = 1_700_000_000_000) => { let t = start; return { now: () => t, tick: ms => { t += ms; } }; };
const cpu = (id, extra = {}) => ({ workerId: id, capabilities: { cpuCores: 8, ramGb: 16, ...(extra.caps || {}) }, ...extra.rest });
const code = fn => { try { fn(); } catch (e) { return e.code; } return null; };

// ── lifecycle ───────────────────────────────────────────────
test('two workers cannot both get the same job', () => {
  const u = createUacl();
  u.registerWorker(cpu('a')); u.registerWorker(cpu('b'));
  const job = u.submitJob({ workloadType: 'inference' });
  const [x, y] = [u.claimJob('a'), u.claimJob('b')];
  assert.equal([x, y].filter(Boolean).length, 1, 'exactly one claim wins');
  assert.equal([x, y].find(Boolean).id, job.id);
  assert.equal(u.claimJob(job.assignedWorkerId), null, 'second claim by the owner finds nothing');
});

test('a worker only holds as many jobs as its maxConcurrentJobs', () => {
  const u = createUacl();
  u.registerWorker(cpu('solo'));
  const jobs = [1, 2, 3].map(() => u.submitJob({ workloadType: 'inference' }));
  assert.deepEqual(jobs.map(j => u.getJob(j.id).state), ['assigned', 'queued', 'queued']);
  u.claimJob('solo'); u.completeJob('solo', jobs[0].id, { ok: 1 });
  assert.equal(u.getJob(jobs[1].id).state, 'assigned', 'next job is scheduled when a slot frees');
});

test('worker crash after claim: job is re-queued, retried elsewhere, and a late result from the dead worker is refused', () => {
  const c = clock();
  const u = createUacl({ now: c.now, heartbeatTtlMs: 1000 });
  u.registerWorker(cpu('dead')); const j = u.submitJob({ workloadType: 'training' });
  u.claimJob('dead');
  u.registerWorker(cpu('alive'));
  c.tick(1500); u.heartbeat('alive'); u.sweep();
  let job = u.getJob(j.id);
  assert.equal(job.assignedWorkerId, 'alive');
  assert.equal(job.attempts, 2);
  assert.equal(job.state, 'assigned');
  assert.equal(code(() => u.completeJob('dead', j.id, { late: true })), 'FORBIDDEN');
  u.claimJob('alive'); u.completeJob('alive', j.id, { ok: true });
  assert.equal(u.getJob(j.id).state, 'succeeded');
});

test('retry limit: a job whose workers keep dying fails instead of looping forever', () => {
  const c = clock();
  const u = createUacl({ now: c.now, heartbeatTtlMs: 1000, maxAttempts: 2 });
  const j = u.submitJob({ workloadType: 'inference' });
  for (const id of ['w1', 'w2']) { u.registerWorker(cpu(id)); u.claimJob(id); c.tick(1500); u.sweep(); }
  const job = u.getJob(j.id);
  assert.equal(job.state, 'failed');
  assert.match(job.error, /retry limit/);
  assert.equal(u.status().running + u.status().assigned, 0);
});

test('a worker that comes back after being offline is usable again and cannot finish a job it lost', () => {
  const c = clock();
  const u = createUacl({ now: c.now, heartbeatTtlMs: 1000 });
  u.registerWorker(cpu('flaky')); const j = u.submitJob({ workloadType: 'inference' }); u.claimJob('flaky');
  c.tick(1500); u.sweep();
  assert.equal(u.getJob(j.id).state, 'queued');
  assert.equal(u.getWorker('flaky').state, 'offline');
  u.heartbeat('flaky');
  assert.equal(u.getWorker('flaky').state, 'online');
  assert.equal(u.getJob(j.id).attempts, 2, 're-assigned as a new attempt');
  assert.equal(code(() => u.completeJob('flaky', j.id, {}, '', 1)), 'CONFLICT', 'stale attempt number refused');
  assert.equal(u.status().workers.online, 1);
});

test('duplicate and delayed heartbeats are harmless', () => {
  const c = clock(); const u = createUacl({ now: c.now, heartbeatTtlMs: 1000 });
  u.registerWorker(cpu('w'));
  for (let i = 0; i < 5; i++) u.heartbeat('w');
  c.tick(900); u.heartbeat('w'); c.tick(900); u.sweep();
  assert.equal(u.getWorker('w').state, 'online');
  assert.equal(code(() => u.heartbeat('ghost')), 'NOT_FOUND');
});

test('cancel during execution: worker is told via heartbeat and its late result is refused', () => {
  const u = createUacl();
  u.registerWorker(cpu('w')); const j = u.submitJob({ workloadType: 'inference' }); u.claimJob('w');
  u.cancelJob(j.id);
  assert.deepEqual(u.heartbeat('w').cancelJobIds, [j.id]);
  assert.equal(code(() => u.completeJob('w', j.id, { x: 1 })), 'CONFLICT');
  assert.deepEqual(u.heartbeat('w').cancelJobIds, [], 'notice is cleared once the worker has learned');
  assert.equal(u.getJob(j.id).state, 'cancelled');
  assert.equal(u.getWorker('w').activeJobs, 0, 'slot is freed');
});

test('illegal transitions are refused and terminal jobs stay terminal', () => {
  const u = createUacl();
  u.registerWorker(cpu('w')); const j = u.submitJob({ workloadType: 'inference' });
  assert.equal(code(() => u.completeJob('w', j.id, {})), 'CONFLICT', 'cannot complete before claiming');
  u.claimJob('w'); u.completeJob('w', j.id, { a: 1 });
  assert.equal(code(() => u.failJob('w', j.id, 'x')), 'CONFLICT');
  assert.equal(u.cancelJob(j.id).state, 'succeeded', 'cancelling a finished job is a no-op');
});

test('job runtime limit: a stuck running job expires and frees its worker', () => {
  const c = clock(); const u = createUacl({ now: c.now, heartbeatTtlMs: 10 * 60_000 });
  u.registerWorker(cpu('w')); const j = u.submitJob({ workloadType: 'training', maxRuntimeMs: 5000 }); u.claimJob('w');
  c.tick(6000); u.sweep();
  assert.equal(u.getJob(j.id).state, 'expired');
  assert.equal(u.getWorker('w').activeJobs, 0);
});

// ── capacity / scale / state growth ─────────────────────────
test('finished jobs are discarded so the queue never fills up permanently', () => {
  const u = createUacl({ maxQueueSize: 50, maxRetainedTerminal: 10, maxActiveJobsPerTenant: 1000 });
  u.registerWorker(cpu('w'));
  for (let i = 0; i < 300; i++) {            // 6x the queue size, one at a time
    const j = u.submitJob({ workloadType: 'inference' });
    u.claimJob('w'); u.completeJob('w', j.id, { i });
  }
  assert.doesNotThrow(() => u.submitJob({ workloadType: 'inference' }), 'still accepts work after 300 completions');
  assert.ok(u.status().succeeded <= 10, 'terminal history is bounded');
});

test('one tenant cannot fill the queue: queued jobs count against the tenant limit', () => {
  const u = createUacl({ maxActiveJobsPerTenant: 3 });   // no workers, so everything stays queued
  for (let i = 0; i < 3; i++) u.submitJob({ workloadType: 'inference', tenantId: 'a' });
  assert.equal(code(() => u.submitJob({ workloadType: 'inference', tenantId: 'a' })), 'TENANT_LIMIT');
  assert.doesNotThrow(() => u.submitJob({ workloadType: 'inference', tenantId: 'b' }));
});

test('thousands of jobs: bounded queue, fast scheduling, correct accounting', () => {
  const u = createUacl({ maxQueueSize: 5000, maxActiveJobsPerTenant: 10_000 });
  for (let i = 0; i < 20; i++) u.registerWorker(cpu(`w${i}`, { caps: { maxConcurrentJobs: 4 } }));
  const t = Date.now();
  for (let i = 0; i < 5000; i++) u.submitJob({ workloadType: 'inference', tenantId: `t${i % 50}` });
  assert.equal(code(() => u.submitJob({ workloadType: 'inference' })), 'QUEUE_FULL');
  const s = u.status();
  assert.equal(s.assigned, 80);
  assert.equal(s.queued, 4920);
  assert.ok(Date.now() - t < 8000, `scheduling 5000 jobs took ${Date.now() - t}ms`);
});

test('no workers / incompatible workers: jobs wait, then expire cleanly', () => {
  const c = clock(); const u = createUacl({ now: c.now, jobTtlMs: 20_000 });
  u.registerWorker(cpu('small'));
  const j = u.submitJob({ workloadType: 'training', requirements: { accelerators: ['cuda'], acceleratorMemoryGb: 80 } });
  assert.equal(j.state, 'queued');
  c.tick(25_000); u.sweep();
  assert.equal(u.getJob(j.id).state, 'expired');
  assert.equal(u.status().queued, 0);
});

test('duplicate submissions with the same idempotency key return the same job', () => {
  const u = createUacl();
  const a = u.submitJob({ workloadType: 'inference', tenantId: 't', idempotencyKey: 'k1' });
  const b = u.submitJob({ workloadType: 'inference', tenantId: 't', idempotencyKey: 'k1' });
  const other = u.submitJob({ workloadType: 'inference', tenantId: 'other', idempotencyKey: 'k1' });
  assert.equal(a.id, b.id); assert.notEqual(a.id, other.id);
});

// ── input validation / malicious workers ────────────────────
test('malformed and hostile registrations are rejected or clamped', () => {
  const u = createUacl();
  for (const bad of ['', 'a'.repeat(65), '../etc/passwd', 'a b', 'x/y', '<script>']) {
    if (bad === '') continue; // empty means "generate one"
    assert.equal(code(() => u.registerWorker({ workerId: bad })), 'INVALID_INPUT', bad);
  }
  assert.equal(code(() => u.registerWorker(null)), 'INVALID_INPUT');
  assert.equal(code(() => u.registerWorker({ workerId: 'p', metadata: JSON.parse('{"__proto__":{"admin":true}}') })), 'INVALID_INPUT');
  assert.equal(code(() => u.registerWorker({ workerId: 'big', metadata: { blob: 'x'.repeat(20000) } })), 'PAYLOAD_TOO_LARGE');
  const w = u.registerWorker({ workerId: 'liar', pricePerHour: -5, capabilities: { cpuCores: 1e308, ramGb: Infinity, acceleratorMemoryGb: 1e30, maxConcurrentJobs: 1e9 } });
  assert.ok(w.capabilities.cpuCores <= 4096 && w.capabilities.maxConcurrentJobs <= 64 && w.capabilities.acceleratorMemoryGb <= 4096);
  assert.equal(w.pricePerHour, 0);
  assert.equal({}.admin, undefined, 'no prototype pollution');
});

test('hostile job input is rejected: bad types, oversized or deeply nested specs, forbidden keys', () => {
  const u = createUacl();
  assert.equal(code(() => u.submitJob({ workloadType: 'rm -rf' })), 'INVALID_INPUT');
  assert.equal(code(() => u.submitJob(null)), 'INVALID_INPUT');
  assert.equal(code(() => u.submitJob({ workloadType: 'inference', spec: [1] })), 'INVALID_INPUT');
  assert.equal(code(() => u.submitJob({ workloadType: 'inference', spec: { blob: 'x'.repeat(300_000) } })), 'PAYLOAD_TOO_LARGE');
  let deep = {}; const root = deep; for (let i = 0; i < 40; i++) { deep.n = {}; deep = deep.n; }
  assert.equal(code(() => u.submitJob({ workloadType: 'inference', spec: root })), 'INVALID_INPUT');
  assert.equal(code(() => u.submitJob({ workloadType: 'inference', spec: JSON.parse('{"a":{"constructor":1}}') })), 'INVALID_INPUT');
  const j = u.submitJob({ workloadType: 'inference', requirements: { cpuCores: 1e300 }, priority: 1e9 });
  assert.ok(j.requirements.cpuCores <= 4096 && j.priority <= 100);
});

test('an invalid or oversized worker result fails the job instead of being stored', () => {
  const u = createUacl({ maxResultBytes: 1000 });
  u.registerWorker(cpu('w')); const j = u.submitJob({ workloadType: 'inference' }); u.claimJob('w');
  const done = u.completeJob('w', j.id, { blob: 'x'.repeat(5000) });
  assert.equal(done.state, 'failed'); assert.equal(done.result, null);
  assert.equal(u.getWorker('w').activeJobs, 0);
});

// ── authentication: per-worker credentials ──────────────────
test('worker credentials: enrollment key registers, only the per-worker token can act as that worker', () => {
  const u = createUacl({ workerSecret: 'enroll-secret-123' });
  assert.equal(code(() => u.registerWorker(cpu('w'), 'wrong')), 'UNAUTHORIZED');
  const reg = u.registerWorker(cpu('w'), 'enroll-secret-123');
  assert.ok(reg.credential && reg.credential.length >= 32);
  assert.equal(reg.tokenHash, undefined, 'hash is never exposed');
  const job = u.submitJob({ workloadType: 'inference' });
  assert.equal(code(() => u.claimJob('w', 'enroll-secret-123')), 'UNAUTHORIZED', 'the shared key is not a worker identity');
  assert.equal(code(() => u.claimJob('w')), 'UNAUTHORIZED');
  assert.equal(u.claimJob('w', reg.credential).id, job.id);
  const evil = u.registerWorker(cpu('evil'), 'enroll-secret-123');
  assert.equal(code(() => u.completeJob('w', job.id, {}, evil.credential)), 'UNAUTHORIZED', "worker B's token cannot finish worker A's job");
  assert.equal(code(() => u.completeJob('evil', job.id, {}, evil.credential)), 'FORBIDDEN');
});

test('a live worker id cannot be hijacked; a dead one can be replaced and its jobs are re-queued', () => {
  const c = clock(); const u = createUacl({ now: c.now, workerSecret: 'enroll-secret-123', heartbeatTtlMs: 1000 });
  const a = u.registerWorker(cpu('gpu1'), 'enroll-secret-123');
  assert.equal(code(() => u.registerWorker(cpu('gpu1'), 'enroll-secret-123')), 'CONFLICT');
  const job = u.submitJob({ workloadType: 'inference' }); u.claimJob('gpu1', a.credential);
  const same = u.registerWorker(cpu('gpu1'), 'enroll-secret-123', a.credential);   // owner re-registers
  assert.ok(same.credential && same.credential !== a.credential, 'token is rotated');
  assert.equal(u.getJob(job.id).state, 'running', 'owner keeps its running job');
  c.tick(2000);
  const replaced = u.registerWorker(cpu('gpu1'), 'enroll-secret-123');             // old one died
  assert.ok(replaced.credential);
  assert.notEqual(u.getJob(job.id).state, 'running');
});

// ── kill switch ─────────────────────────────────────────────
test('kill switch (core): blocks new work and claims; cancel, heartbeat, complete and fail still work', () => {
  let halted = false;
  const u = createUacl({ isHalted: () => halted });
  u.registerWorker(cpu('w'));
  const running = u.submitJob({ workloadType: 'inference' }); u.claimJob('w');
  const waiting = u.submitJob({ workloadType: 'inference' });
  const doomed = u.submitJob({ workloadType: 'inference' });
  halted = true;
  assert.equal(code(() => u.submitJob({ workloadType: 'inference' })), 'KILL_SWITCH_ENGAGED');
  assert.equal(code(() => u.claimJob('w')), 'KILL_SWITCH_ENGAGED');
  assert.equal(code(() => u.registerWorker(cpu('new'))), 'KILL_SWITCH_ENGAGED');
  assert.doesNotThrow(() => u.heartbeat('w'));
  assert.equal(u.cancelJob(doomed.id).state, 'cancelled');
  assert.equal(u.completeJob('w', running.id, { done: 1 }).state, 'succeeded', 'running work can finish safely');
  u.schedule();
  assert.equal(u.getJob(waiting.id).state, 'queued', 'nothing new is assigned while stopped');
  halted = false; u.schedule();
  assert.equal(u.getJob(waiting.id).state, 'assigned', 'resumes after release');
});

test('kill switch (HTTP): every route that starts compute is blocked, no alternative path exists', async () => {
  const ks = new KillSwitch();
  const u = createUacl({ isHalted: () => ks.isEngaged('compute') });
  const app = fakeApp();
  mountUaclRoutes(app, u, { adminSecret: 'a'.repeat(24), workerSecret: 'w'.repeat(24), killSwitch: ks });
  const startsCompute = ['POST /api/victus/cloud/jobs', 'POST /api/victus/cloud/workers/register', 'POST /api/victus/cloud/workers/:workerId/claim'];
  const stillAllowed = ['POST /api/victus/cloud/jobs/:jobId/cancel', 'POST /api/victus/cloud/workers/:workerId/heartbeat', 'POST /api/victus/cloud/workers/:workerId/jobs/:jobId/complete', 'POST /api/victus/cloud/workers/:workerId/jobs/:jobId/fail'];
  for (const scope of ['compute', 'all']) {
    ks.engage({ by: 't', scope });
    ks.engage({ by: 't', scope }); // repeated activation is harmless
    for (const key of startsCompute) {
      const res = await runChain(app.routes[key], req());
      assert.equal(res.statusCode, 423, `${key} (${scope})`);
    }
    for (const key of stillAllowed) {
      const res = await runChain(app.routes[key], req());
      assert.notEqual(res.statusCode, 423, `${key} must stay available (${scope})`);
    }
    ks.release({ by: 't', scope }); ks.release({ by: 't', scope });
  }
  assert.equal(ks.isEngaged('compute'), false);
  const routeKeys = Object.keys(app.routes).filter(k => k.startsWith('POST') && !stillAllowed.includes(k) && !startsCompute.includes(k));
  assert.deepEqual(routeKeys, [], 'no unreviewed mutating route exists');
});

test('kill switch survives restart while engaged', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uacl-')), 'state.json');
  new KillSwitch({ stateFile: file }).engage({ by: 'ops', scope: 'compute' });
  const restarted = new KillSwitch({ stateFile: file });
  const u = createUacl({ isHalted: () => restarted.isEngaged('compute') });
  assert.equal(code(() => u.submitJob({ workloadType: 'inference' })), 'KILL_SWITCH_ENGAGED');
});

// ── HTTP layer: authz, IDOR, status codes ───────────────────
function mockRes() { return { statusCode: 200, body: null, headersSent: false, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } }; }
function fakeApp() { const routes = {}; const reg = m => (p, ...h) => { routes[`${m} ${p}`] = h; }; return { routes, get: reg('GET'), post: reg('POST') }; }
async function runChain(chain, req, _x, sync) {
  const res = mockRes();
  for (const fn of chain) {
    let nexted = false;
    const r = fn(req, res, () => { nexted = true; });
    if (r && typeof r.then === 'function') await r;
    if (!nexted) break;
  }
  return res;
}
function req(over = {}) {
  const headers = over.headers || {};
  return { body: {}, params: {}, query: {}, path: '/x', get: k => headers[k.toLowerCase()], ...over };
}
const ADMIN = 'a'.repeat(32), WKEY = 'w'.repeat(32);

test('admin and worker endpoints fail CLOSED when keys are not configured, and compare keys safely', async () => {
  const u = createUacl();
  const r = createUaclRoutes(u, {});
  assert.equal((await runChain([r.admin.requireAdmin, r.events], req())).statusCode, 503);
  assert.equal((await runChain([r.worker.requireEnrollment, r.registerWorker], req({ body: { workerId: 'x' } }))).statusCode, 503);
  assert.equal((await runChain([r.worker.requireWorker, r.heartbeat], req({ params: { workerId: 'x' } }))).statusCode, 503);

  const configured = createUaclRoutes(u, { adminSecret: ADMIN, workerSecret: WKEY });
  assert.equal((await runChain([configured.admin.requireAdmin, configured.events], req({ headers: { 'x-victus-admin-key': 'nope' } }))).statusCode, 401);
  assert.equal((await runChain([configured.admin.requireAdmin, configured.events], req())).statusCode, 401);
  assert.equal((await runChain([configured.admin.requireAdmin, configured.events], req({ headers: { 'x-victus-admin-key': ADMIN } }))).statusCode, 200);

  const dev = createUaclRoutes(u, { allowInsecureDev: true });
  assert.equal((await runChain([dev.admin.requireAdmin, dev.events], req())).statusCode, 200, 'explicit dev opt-in works');
});

test('IDOR: tenants only see and cancel their own jobs; the body cannot choose the tenant', async () => {
  const u = createUacl();
  const r = createUaclRoutes(u, { adminSecret: ADMIN, workerSecret: WKEY });
  const alice = { dbUser: { id: 1 } }, bob = { dbUser: { id: 2 } };
  const created = await runChain([r.submit], req({ ...alice, body: { workloadType: 'inference', tenantId: 'user:2', priority: 100 } }));
  assert.equal(created.statusCode, 200);
  const job = created.body.job;
  assert.equal(job.tenantId, 'user:1', 'client-supplied tenantId is ignored');
  assert.equal(job.priority, 50, 'non-admin priority is capped');
  assert.equal((await runChain([r.getJob], req({ ...bob, params: { jobId: job.id } }))).statusCode, 404);
  assert.equal((await runChain([r.cancelJob], req({ ...bob, params: { jobId: job.id }, body: { tenantId: 'user:1' } }))).statusCode, 404);
  assert.equal(u.getJob(job.id).state, 'queued', "bob could not cancel alice's job");
  assert.equal((await runChain([r.getJob], req({ ...alice, params: { jobId: job.id } }))).statusCode, 200);
  assert.equal((await runChain([r.getJob], req({ params: { jobId: job.id } }))).statusCode, 401, 'anonymous callers are refused');
  assert.equal((await runChain([r.submit], req({ body: { workloadType: 'inference' } }))).statusCode, 401);
  assert.equal((await runChain([r.getJob], req({ headers: { 'x-victus-admin-key': ADMIN }, params: { jobId: job.id } }))).statusCode, 200, 'admin can read');
  assert.equal((await runChain([r.cancelJob], req({ ...alice, params: { jobId: job.id } }))).body.job.state, 'cancelled');
});

test('routes return meaningful status codes (404/409/401/413/422) and never leak internals', async () => {
  const u = createUacl({ workerSecret: WKEY });
  const r = createUaclRoutes(u, { adminSecret: ADMIN, workerSecret: WKEY });
  const reg = await runChain([r.worker.requireEnrollment, r.registerWorker], req({ headers: { 'x-victus-worker-key': WKEY }, body: { workerId: 'gpu' } }));
  assert.equal(reg.statusCode, 200);
  const token = reg.body.credential; assert.ok(token); assert.equal(reg.body.worker.credential, undefined);
  assert.equal((await runChain([r.heartbeat], req({ params: { workerId: 'ghost' }, headers: { 'x-victus-worker-token': token } }))).statusCode, 404);
  assert.equal((await runChain([r.heartbeat], req({ params: { workerId: 'gpu' }, headers: { 'x-victus-worker-token': 'bad' } }))).statusCode, 401);
  assert.equal((await runChain([r.worker.requireEnrollment, r.registerWorker], req({ headers: { 'x-victus-worker-key': WKEY }, body: { workerId: '../x' } }))).statusCode, 422);
  assert.equal((await runChain([r.worker.requireEnrollment, r.registerWorker], req({ headers: { 'x-victus-worker-key': WKEY }, body: { workerId: 'gpu' } }))).statusCode, 409);
  assert.equal((await runChain([r.limitBody], req({ headers: { 'content-length': String(5 * 1024 * 1024) } }))).statusCode, 413);
  const broken = createUaclRoutes({ ...u, status: () => { throw new Error('secret db password leaked'); } }, {});
  const res = await runChain([broken.status], req());
  assert.equal(res.statusCode, 500); assert.doesNotMatch(JSON.stringify(res.body), /secret|password/);
  assert.equal((await runChain([r.events], req({ query: { limit: 'abc' } }))).body.events.length <= 100, true, 'junk limit no longer returns the whole log');
});

// ── worker agent ────────────────────────────────────────────
const okRes = body => ({ ok: true, status: 200, json: async () => body });
const errRes = (status, error) => ({ ok: false, status, json: async () => ({ error }) });

test('agent: overlapping polls never run more than one job at a time', async () => {
  let active = 0, peak = 0, claims = 0;
  const agent = createUaclWorkerAgent({
    baseUrl: 'https://nova.example', workerId: 'w', handlers: { inference: async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 40)); active--; return {}; } },
    fetchImpl: async url => (/claim$/.test(url) ? okRes({ job: { id: `j${++claims}`, workloadType: 'inference', attempts: 1 } }) : okRes({})),
  });
  await Promise.all([agent.pollOnce(), agent.pollOnce(), agent.pollOnce()]);
  assert.equal(peak, 1);
  assert.equal(claims, 1, 'extra polls did not even claim more work');
});

test('agent: re-registers when the broker lost its state, and a lost report is not rewritten as a failure', async () => {
  const calls = [];
  let hb = 0;
  const agent = createUaclWorkerAgent({
    baseUrl: 'http://localhost:5000', workerId: 'w', workerKey: 'k', reportBackoffMs: 1,
    handlers: { inference: async () => ({ ok: 1 }) },
    fetchImpl: async url => {
      calls.push(url);
      if (/register$/.test(url)) return okRes({ worker: {}, credential: 'tok' });
      if (/heartbeat$/.test(url)) return ++hb === 1 ? errRes(404, 'Worker not found') : okRes({ worker: { cancelJobIds: [] } });
      if (/claim$/.test(url)) return okRes({ job: { id: 'j1', workloadType: 'inference', attempts: 1 } });
      if (/complete$/.test(url)) return errRes(503, 'down');
      return okRes({});
    },
  });
  await agent.heartbeat();
  assert.deepEqual(calls.filter(u => /register$|heartbeat$/.test(u)).map(u => u.split('/').pop()), ['heartbeat', 'register', 'heartbeat']);
  await agent.pollOnce();
  assert.equal(calls.filter(u => /complete$/.test(u)).length, 3, 'report retried');
  assert.equal(calls.filter(u => /fail$/.test(u)).length, 0, 'never turned a successful job into a failure');
});

test('agent: a cancelled job aborts the running handler', async () => {
  let aborted = false;
  const agent = createUaclWorkerAgent({
    baseUrl: 'https://nova.example', workerId: 'w',
    handlers: { training: (job, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => { aborted = true; rej(new Error('stopped')); })) },
    fetchImpl: async url => {
      if (/claim$/.test(url)) return okRes({ job: { id: 'j1', workloadType: 'training', attempts: 1 } });
      if (/heartbeat$/.test(url)) return okRes({ worker: { cancelJobIds: ['j1'] } });
      return okRes({});
    },
  });
  const run = agent.pollOnce();
  await new Promise(r => setTimeout(r, 10));
  await agent.heartbeat();
  await run;
  assert.equal(aborted, true);
});

test('agent: refuses to send credentials over plain http to a remote host', () => {
  assert.throws(() => createUaclWorkerAgent({ baseUrl: 'http://nova.example', workerId: 'w', fetchImpl: async () => okRes({}) }), /https/);
  assert.doesNotThrow(() => createUaclWorkerAgent({ baseUrl: 'http://localhost:5000', workerId: 'w', fetchImpl: async () => okRes({}) }));
});

test('end to end through the HTTP handlers: submit → schedule → claim → complete, then API restart recovery', async () => {
  const mk = () => createUacl({ workerSecret: WKEY });
  let uacl = mk();
  let routes = createUaclRoutes(uacl, { adminSecret: ADMIN, workerSecret: WKEY });
  const dispatch = async (handler, r) => { const res = await runChain(Array.isArray(handler) ? handler : [handler], r); return { ok: res.statusCode < 400, status: res.statusCode, json: async () => res.body }; };
  const fetchImpl = async (url, o) => {
    const h = Object.fromEntries(Object.entries(o.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = o.body ? JSON.parse(o.body) : {};
    const m = url.match(/workers\/([^/]+)\/(heartbeat|claim)$/) || url.match(/workers\/([^/]+)\/jobs\/([^/]+)\/(complete|fail)$/);
    const base = { get: k => h[k.toLowerCase()], body, params: {}, query: {}, path: url };
    if (/workers\/register$/.test(url)) return dispatch([routes.worker.requireEnrollment, routes.registerWorker], base);
    if (m && m[2] === 'heartbeat') return dispatch([routes.worker.requireWorker, routes.heartbeat], { ...base, params: { workerId: m[1] } });
    if (m && m[2] === 'claim') return dispatch([routes.worker.requireWorker, routes.claim], { ...base, params: { workerId: m[1] } });
    if (m) return dispatch([routes.worker.requireWorker, m[3] === 'complete' ? routes.complete : routes.fail], { ...base, params: { workerId: m[1], jobId: m[2] } });
    throw new Error(`unrouted ${url}`);
  };
  const agent = createUaclWorkerAgent({ baseUrl: 'https://nova.example', workerId: 'gpu-1', workerKey: WKEY, handlers: { inference: async j => ({ echo: j.spec.q }) }, fetchImpl });
  await agent.register(); await agent.heartbeat();
  const job = uacl.submitJob({ workloadType: 'inference', tenantId: 'user:1', spec: { q: 'hi' } });
  await agent.pollOnce();
  assert.deepEqual(uacl.getJob(job.id).result, { echo: 'hi' });
  // API restarts: broker memory is gone. The agent's next heartbeat re-registers it transparently.
  uacl = mk(); routes = createUaclRoutes(uacl, { adminSecret: ADMIN, workerSecret: WKEY });
  await agent.heartbeat();
  assert.equal(uacl.getWorker('gpu-1').state, 'online');
  const job2 = uacl.submitJob({ workloadType: 'inference', spec: { q: 'again' } });
  await agent.pollOnce();
  assert.equal(uacl.getJob(job2.id).state, 'succeeded');
});
