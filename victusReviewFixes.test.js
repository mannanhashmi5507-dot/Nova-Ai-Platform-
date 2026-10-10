'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyChange, isImmutablePath, normalizeChangePath } = require('../src/victus/core/policy');
const { createVictusSafety, PolicyViolationError } = require('../src/victus/safety');
const { ToolBus } = require('../src/victus/core/toolBus');
const { PlanGraph } = require('../src/victus/core/planner');
const { VictusEngine } = require('../src/victus');
const { Telemetry } = require('../src/victus/core/telemetry');
const { ExperienceStore } = require('../src/victus/core/experience');
const { MemoryStore } = require('../src/victus/core/memory');
const { KnowledgeGraph, makeClaim } = require('../src/victus/core/knowledge');
const { VictusSelfMonitor } = require('../src/victus/core/selfMonitor');
const { createVictusModelProvider, trimEndpoint } = require('../src/victus/model/openaiCompatible');

const victus = { type: 'victus', id: 'victus' };
const human = { type: 'human', id: 'owner@example.com' };
const base = { title: 'Change', description: 'desc' };
const res = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

// ── safety lock ─────────────────────────────────────────────
test('the locked control plane covers the real files, not just imaginary security/ folders', () => {
  for (const p of ['src/victus/safety/killSwitch.js', 'src/victus/cloud/uacl.js', 'src/victus/research/safeResearchFetcher.js', 'src/victus/core/policy.js',
    'src/index.js', 'src/middleware/usageGate.js', 'src/db/index.js', 'models/victus-lm/README.md', 'package.json', 'scripts/uacl-worker.js', '.env']) {
    assert.equal(isImmutablePath(p), true, p);
  }
  for (const p of ['docs/faq.md', 'public/index.html', 'test/foo.test.js', 'src/victus-notes.txt']) assert.equal(isImmutablePath(p), false, p);
});

test('locked-path checks cannot be dodged with traversal, case, encoding, separators or absolute paths', () => {
  for (const p of ['./src/victus/x.js', 'src/../src/victus/x.js', 'SRC/Victus/x.js', 'src//victus//x.js', 'src\\victus\\x.js', '%2e%2e/src/victus/x.js',
    '%252e%252e/src/victus/x.js', '/app/src/victus/x.js', 'docs/../src/index.js', 'src/victus/', '.ENV']) {
    assert.equal(isImmutablePath(p), true, p);
  }
  assert.equal(isImmutablePath('bad\0path/ok.md'), true, 'unparseable paths fail closed');
  assert.equal(isImmutablePath(42), true);
  assert.equal(normalizeChangePath('a/./b/../c'), 'a/c');
});

test('Victus cannot smuggle a locked-file change through the diff or under-declared filesChanged', () => {
  const { queue } = createVictusSafety({ env: {} });
  const diff = 'diff --git a/src/victus/safety/killSwitch.js b/src/victus/safety/killSwitch.js\n--- a/src/victus/safety/killSwitch.js\n+++ b/src/victus/safety/killSwitch.js\n@@ -1 +1 @@\n-x\n+y\n';
  assert.throws(() => queue.submit({ ...base, filesChanged: ['docs/faq.md'], diff }, victus), PolicyViolationError);
  assert.throws(() => queue.submit({ ...base, filesChanged: ['src/victus/core/policy.js'] }, victus), PolicyViolationError);
  assert.throws(() => queue.submit({ ...base, diff: '--- a/package.json\n+++ b/package.json\n' }, victus), PolicyViolationError);
  const ok = queue.submit({ ...base, filesChanged: ['docs/faq.md'], diff: '--- a/docs/faq.md\n+++ b/docs/faq.md\n' }, victus);
  assert.equal(ok.status, 'PENDING');
  const humanOne = queue.submit({ ...base, filesChanged: ['src/victus/core/policy.js'] }, human);
  assert.equal(humanOne.risk.touchesImmutable, true);
  assert.throws(() => queue.approve(humanOne.id, { by: human }), /confirmHighRisk/);
  assert.equal(classifyChange({ paths: ['docs/a.md'] }).requiresHumanApproval, false);
});

test('tool bus: high-risk tools need explicit human approval, and declared output limits are enforced', async () => {
  const bus = new ToolBus();
  const exec = async () => ({ ok: true });
  bus.register({ toolId: 'deploy', description: 'd', actionType: 'DEPLOY', permissions: [], preconditions: [], postconditions: [], execute: exec });
  bus.register({ toolId: 'big', description: 'b', permissions: [], preconditions: [], postconditions: [], resourceLimits: { maxOutputBytes: 100 }, execute: async () => 'x'.repeat(1000) });
  bus.register({ toolId: 'small', description: 's', permissions: [], preconditions: [], postconditions: [], resourceLimits: { maxOutputBytes: 100 }, execute: async () => 'ok' });
  await assert.rejects(() => bus.execute('deploy', {}, {}), /requires human approval/);
  await assert.rejects(() => bus.execute('deploy', {}, { humanApproval: 'true' }), /requires human approval/);
  assert.ok(await bus.execute('deploy', {}, { humanApproval: true }));
  await assert.rejects(() => bus.execute('big', {}, {}), /exceeds 100 bytes/);
  assert.ok(await bus.execute('small', {}, {}));
});

// ── engine control flow ─────────────────────────────────────
test('engine: a failing retrieval closes the monitor session and records the failure; a faulty listener cannot break a goal', async () => {
  const engine = new VictusEngine({ toolBus: new ToolBus() });
  await assert.rejects(() => engine.runGoal({ goal: 'g', workflow: 'w', retrieve: async () => { throw new Error('memory down'); } }), /memory down/);
  assert.equal(engine.selfMonitor.active().length, 0, 'no leaked session');
  assert.equal(engine.experience.records.at(-1).success, false);
  const r = await engine.runGoal({ goal: 'g2', workflow: 'w', onEvent: () => { throw new Error('listener bug'); } });
  assert.equal(r.success, true);
});

test('engine: replan/verify loops are bounded even if a caller asks for an enormous limit', async () => {
  const bus = new ToolBus();
  bus.register({ toolId: 'bad', description: 'x', permissions: [], preconditions: [], postconditions: [], execute: async () => { throw new Error('nope'); } });
  const engine = new VictusEngine({ toolBus: bus });
  let replans = 0;
  const mk = () => { const p = new PlanGraph('g'); p.addStep({ id: 's', action: 'bad' }); return p; };
  await assert.rejects(() => engine.runGoal({ goal: 'g', workflow: 'w', plan: mk(), maxAutonomousCycles: 1e9, replan: async () => { replans += 1; return mk(); } }));
  assert.ok(replans <= 5, `replanned ${replans} times`);
});

test('engine: REVISE → fix → PASS counts as success; a final failure counts as failure (intermediate attempts are not the outcome)', async () => {
  const bus = new ToolBus();
  bus.register({ toolId: 'ok', description: 'x', permissions: [], preconditions: [], postconditions: [], execute: async () => ({}) });
  const mk = () => { const p = new PlanGraph('g'); p.addStep({ id: 's', action: 'ok' }); return p; };
  const engine = new VictusEngine({ toolBus: bus });
  const fixed = await engine.runGoal({ goal: 'fix it', workflow: 'deep', plan: mk(), verify: async () => ({ verified: true, confidence: 0.92 }) });
  assert.equal(fixed.success, true);
  const broken = await engine.runGoal({ goal: 'fix it', workflow: 'deep', plan: mk(), verify: async () => ({ verified: false, confidence: 0.35 }) });
  assert.equal(broken.success, false);
});

// ── bounded state ───────────────────────────────────────────
test('in-memory stores are bounded so a long-running server cannot leak', () => {
  const t = new Telemetry({ maxEvents: 100 }); for (let i = 0; i < 500; i++) t.record({ type: 'x' });
  assert.equal(t.events.length, 100);
  const x = new ExperienceStore({ maxRecords: 100 }); for (let i = 0; i < 500; i++) x.record({ goal: 'g', workflow: 'w', success: true });
  assert.equal(x.records.length, 100);
  const m = new MemoryStore({ maxItems: 100 }); for (let i = 0; i < 300; i++) m.put({ tier: 'SEMANTIC', content: `fact number ${i}` });
  assert.equal(m.items.size, 100);
  assert.equal(m.search({ query: 'fact number 0' }).some(i => i.content === 'fact number 0'), false, 'evicted items leave the search index too');
  const g = new KnowledgeGraph({ maxClaims: 100 }); for (let i = 0; i < 300; i++) g.addClaim(makeClaim({ subject: `s${i}`, predicate: 'p', object: 'o', source: 'x' }));
  assert.equal(g.size(), 100);
  assert.equal(g.find('s0', 'p').length, 0);
  const sm = new VictusSelfMonitor({ maxSessions: 10 }); for (let i = 0; i < 50; i++) sm.begin({ goal: `g${i}` });
  assert.ok(sm.active().length <= 10);
});

test('memory: a caller-chosen id cannot overwrite another tenant\'s memory', () => {
  const m = new MemoryStore();
  m.put({ id: 'shared-id', tier: 'USER', tenantId: 'alice', content: 'alice secret' });
  assert.throws(() => m.put({ id: 'shared-id', tier: 'USER', tenantId: 'bob', content: 'bob overwrite' }), /another tier or tenant/);
  assert.throws(() => m.put({ id: 'shared-id', tier: 'SEMANTIC', content: 'public overwrite' }), /another tier or tenant/);
  assert.equal(m.search({ query: 'secret', tenantId: 'alice' })[0].content, 'alice secret');
  assert.doesNotThrow(() => m.put({ id: 'shared-id', tier: 'USER', tenantId: 'alice', content: 'alice update' }));
});

test('knowledge graph: a higher-confidence claim replaces the stale one in lookups', () => {
  const g = new KnowledgeGraph();
  g.addClaim(makeClaim({ subject: 'a', predicate: 'is', object: 'b', confidence: 0.3, source: 'x' }));
  g.addClaim(makeClaim({ subject: 'a', predicate: 'is', object: 'b', confidence: 0.9, source: 'y' }));
  const found = g.find('a', 'is');
  assert.equal(found.length, 1);
  assert.equal(found[0].confidence, 0.9);
});

test('kill switch status reports when the stop cannot be persisted', () => {
  const blocker = require('path').join(require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'ks-')), 'iam-a-file');
  require('fs').writeFileSync(blocker, 'x'); // a file where a directory is needed → ENOTDIR on save
  const { killSwitch } = createVictusSafety({ env: { VICTUS_SAFETY_STATE_FILE: require('path').join(blocker, 'state.json') } });
  killSwitch.engage({ by: 'ops', scope: 'compute' });
  const s = killSwitch.status();
  assert.equal(s.engaged, true);
  assert.equal(s.persisted, false);
  assert.ok(s.persistError);
});

// ── model provider ──────────────────────────────────────────
test('model provider: validates the URL, protects the API key, handles malformed responses and aborts', async () => {
  assert.throws(() => trimEndpoint('file:///etc/passwd'), /http/);
  assert.throws(() => trimEndpoint('https://user:pw@host.example'), /credentials/);
  assert.throws(() => trimEndpoint('not a url'), /valid URL/);
  assert.equal(trimEndpoint('https://m.example/v1'), 'https://m.example/v1/chat/completions');

  const ok = fetchImpl => createVictusModelProvider({ url: 'https://m.example', apiKey: 'k', fetchImpl });
  assert.equal(await ok(async () => res({ choices: [{ message: { content: ' hi ' } }] })).call([]), 'hi');
  for (const body of [{}, { choices: [] }, { choices: [{ message: { content: ['x'] } }] }, { choices: [{ message: { content: '  ' } }] }, { choices: [{ message: { content: { a: 1 } } }] }]) {
    await assert.rejects(() => ok(async () => res(body)).call([]), /empty or non-text/);
  }
  await assert.rejects(() => ok(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); } })).call([]), /malformed JSON/);
  await assert.rejects(() => ok(async () => res({ secret: 'sk-live-abc' }, 500)).call([]), e => /HTTP 500/.test(e.message) && !/sk-live/.test(e.message));
  await assert.rejects(() => ok(async () => res({}, 429)).call([]), e => e.name === 'RateLimitError');
  await assert.rejects(() => createVictusModelProvider({ url: 'http://remote.example', apiKey: 'k', fetchImpl: async () => res({}) }).call([]), /plain http/);
  assert.ok(await createVictusModelProvider({ url: 'http://localhost:8000', apiKey: 'k', fetchImpl: async () => res({ choices: [{ message: { content: 'x' } }] }) }).call([]));
  const ac = new AbortController(); ac.abort();
  let called = false;
  await assert.rejects(() => ok(async () => { called = true; return res({}); }).call([], ac.signal), e => e.name === 'AbortError');
  assert.equal(called, false, 'an already-aborted request never reaches the model');
});
