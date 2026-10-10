'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createVictusSafety, AuditLog, KillSwitch, UpgradeProposalQueue, KillSwitchEngagedError, PolicyViolationError } = require('../src/victus/safety');

const human = { type: 'human', id: 'owner@example.com' };
const victus = { type: 'victus', id: 'victus' };
const good = { title: 'Cache research results', description: 'Cache fetched pages for 10 minutes.', reason: 'Fewer fetches', sources: ['https://example.com/a'], filesChanged: ['docs/faq.md'] };

function setup(opts = {}) {
  const audit = new AuditLog();
  const killSwitch = new KillSwitch({ audit });
  let t = Date.now();
  const queue = new UpgradeProposalQueue({ audit, killSwitch, now: () => t, ...opts });
  return { audit, killSwitch, queue, advance: ms => { t += ms; } };
}
function mockRes() {
  return { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}

test('audit log is hash-chained, redacts secrets, and detects tampering', () => {
  const log = new AuditLog();
  log.append({ actor: 'a', action: 'x', metadata: { apiKey: 'sk-secret', nested: { password: 'p', ok: 1 } } });
  log.append({ actor: 'a', action: 'y' });
  log.append({ actor: 'a', action: 'z' });
  assert.equal(log.verify().valid, true);
  const first = log.list({ limit: 10 }).find(e => e.action === 'x');
  assert.equal(first.metadata.apiKey, '[REDACTED]');
  assert.equal(first.metadata.nested.password, '[REDACTED]');
  assert.equal(first.metadata.nested.ok, 1);
  log.entries[1].actor = 'someone-else';
  const v = log.verify();
  assert.equal(v.valid, false);
  assert.equal(v.brokenAtSeq, 2);
});

test('audit log detects a deleted entry and survives restart from file', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'victus-')), 'audit.jsonl');
  const a = new AuditLog({ filePath: file });
  a.append({ actor: 'a', action: 'one' }); a.append({ actor: 'a', action: 'two' }); a.append({ actor: 'a', action: 'three' });
  const b = new AuditLog({ filePath: file });
  assert.equal(b.entries.length, 3);
  assert.equal(b.verify().valid, true);
  b.append({ actor: 'a', action: 'four' });
  assert.equal(b.verify().valid, true);
  b.entries.splice(1, 1);
  assert.equal(b.verify().valid, false);
});

test('kill switch: all stops everything, narrow release cannot lift all, state persists, corrupt state fails closed', () => {
  const { killSwitch, audit } = setup();
  killSwitch.assertRunning('research');
  killSwitch.engage({ by: 'owner', scope: 'research', reason: 'testing' });
  assert.throws(() => killSwitch.assertRunning('research'), KillSwitchEngagedError);
  killSwitch.assertRunning('coding');
  killSwitch.engage({ by: 'owner', scope: 'all' });
  assert.throws(() => killSwitch.assertRunning('coding'), KillSwitchEngagedError);
  killSwitch.release({ by: 'owner', scope: 'research' });
  assert.equal(killSwitch.isEngaged('coding'), true);
  killSwitch.release({ by: 'owner', scope: 'all' });
  assert.equal(killSwitch.status().engaged, false);
  assert.ok(audit.list({ action: 'killswitch.engaged' }).length >= 2);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'victus-'));
  const stateFile = path.join(dir, 'state.json');
  new KillSwitch({ stateFile }).engage({ by: 'owner' });
  assert.equal(new KillSwitch({ stateFile }).isEngaged('research'), true, 'stop survives restart');
  fs.writeFileSync(stateFile, '{not json');
  assert.equal(new KillSwitch({ stateFile }).isEngaged('research'), true, 'corrupt state fails closed');
  assert.equal(new KillSwitch({ initiallyEngaged: true }).isEngaged('coding'), true);
});

test('Victus can propose but can never approve, reject, or apply', () => {
  const { queue, audit } = setup();
  const p = queue.submit(good, victus);
  assert.equal(p.status, 'PENDING');
  for (const fn of [() => queue.approve(p.id, { by: victus }), () => queue.reject(p.id, { by: victus }), () => queue.markApplied(p.id, { by: victus }), () => queue.approve(p.id, {})]) {
    assert.throws(fn, PolicyViolationError);
  }
  assert.equal(queue.get(p.id).status, 'PENDING');
  assert.ok(audit.list({ action: 'proposal.approve' }).some(e => e.outcome === 'blocked'));
});

test('human approval flow: approve once, then apply; decisions are final and audited', () => {
  const { queue, audit } = setup();
  const p = queue.submit(good, victus);
  const approved = queue.approve(p.id, { by: human, note: 'looks fine' });
  assert.equal(approved.status, 'APPROVED');
  assert.equal(approved.decision.by, human.id);
  assert.throws(() => queue.reject(p.id, { by: human }), /not PENDING/);
  assert.throws(() => queue.approve(p.id, { by: human }), /not PENDING/);
  assert.equal(queue.markApplied(p.id, { by: human }).status, 'APPLIED');
  assert.ok(audit.list({ action: 'proposal.applied' }).length === 1);
  assert.equal(audit.verify().valid, true);
});

test('locked safety core: Victus cannot queue it; humans need explicit high-risk confirmation', () => {
  const { queue } = setup();
  const core = { ...good, title: 'Edit kill switch', filesChanged: ['security/emergency-shutdown/switch.js'] };
  assert.throws(() => queue.submit(core, victus), /locked safety core/);
  const p = queue.submit(core, human);
  assert.throws(() => queue.approve(p.id, { by: human }), /confirmHighRisk/);
  assert.equal(queue.approve(p.id, { by: human, confirmHighRisk: true }).status, 'APPROVED');
  const deploy = queue.submit({ ...good, actionType: 'DEPLOY' }, victus);
  assert.throws(() => queue.approve(deploy.id, { by: human }), /confirmHighRisk/);
});

test('kill switch blocks new proposals and approvals, but rejecting stays allowed', () => {
  const { queue, killSwitch } = setup();
  const p = queue.submit(good, victus);
  killSwitch.engage({ by: 'owner', scope: 'proposals' });
  assert.throws(() => queue.submit(good, victus), KillSwitchEngagedError);
  assert.throws(() => queue.approve(p.id, { by: human }), KillSwitchEngagedError);
  assert.equal(queue.reject(p.id, { by: human, note: 'stopped' }).status, 'REJECTED');
});

test('proposals expire, invalid input is rejected, and the queue is capped', () => {
  const { queue, advance } = setup({ ttlDays: 1 });
  const p = queue.submit(good, victus);
  advance(2 * 24 * 3600 * 1000);
  assert.equal(queue.get(p.id).status, 'EXPIRED');
  assert.throws(() => queue.approve(p.id, { by: human }), /EXPIRED/);
  assert.throws(() => queue.submit({ ...good, title: '' }, victus), /title is required/);
  assert.throws(() => queue.submit({ ...good, sources: ['javascript:alert(1)'] }, victus), /http/);
  assert.throws(() => queue.submit({ ...good, diff: 'x'.repeat(100001) }, victus), /too long/);
  const q2 = setup().queue;
  for (let i = 0; i < 100; i++) q2.submit(good, victus);
  assert.throws(() => q2.submit(good, victus), /too many pending/);
});

test('approval is bound to content: a tampered proposal cannot be marked applied', () => {
  const { queue } = setup();
  const p = queue.submit({ ...good, diff: 'safe change' }, victus);
  queue.approve(p.id, { by: human });
  const stored = queue.items.get(p.id);
  queue.items.set(p.id, Object.freeze({ ...stored, diff: 'malicious change' }));
  assert.throws(() => queue.markApplied(p.id, { by: human }), /changed after approval/);
});

test('admin routes fail closed and work only for the owner', async () => {
  const env = { ADMIN_EMAILS: 'owner@example.com', VICTUS_ADMIN_TOKEN: 'a'.repeat(32) };
  const { routes, killSwitch } = createVictusSafety({ env });

  let res = mockRes(); await routes.status({ headers: {}, dbUser: { email: 'stranger@example.com' } }, res);
  assert.equal(res.code, 403);
  res = mockRes(); await routes.status({ headers: {} }, res);
  assert.equal(res.code, 403);

  res = mockRes(); await routes.engage({ headers: {}, dbUser: { email: 'OWNER@example.com' }, body: { scope: 'research', reason: 'test' } }, res);
  assert.equal(res.code, 200);
  assert.equal(killSwitch.isEngaged('research'), true);

  res = mockRes(); await routes.release({ headers: { 'x-victus-admin-token': 'wrong'.repeat(8) }, body: {} }, res);
  assert.equal(res.code, 403);
  res = mockRes(); await routes.release({ headers: { 'x-victus-admin-token': 'a'.repeat(32) }, body: {} }, res);
  assert.equal(res.code, 200);
  assert.equal(killSwitch.status().engaged, false);

  const none = createVictusSafety({ env: {} }).routes;
  res = mockRes(); await none.engage({ headers: { 'x-victus-admin-token': '' }, dbUser: { email: '' }, body: {} }, res);
  assert.equal(res.code, 403, 'no admin configured means nobody is admin');
  const short = createVictusSafety({ env: { VICTUS_ADMIN_TOKEN: 'short' } }).routes;
  res = mockRes(); await short.engage({ headers: { 'x-victus-admin-token': 'short' }, body: {} }, res);
  assert.equal(res.code, 403, 'tokens under 24 chars are refused');
});

test('proposal approval over HTTP handlers uses the authenticated human, never a client-supplied identity', async () => {
  const env = { ADMIN_EMAILS: 'owner@example.com' };
  const { routes, queue } = createVictusSafety({ env });
  const p = queue.submit(good, victus);
  let res = mockRes();
  await routes.proposalApprove({ headers: {}, dbUser: { email: 'stranger@example.com' }, params: { id: p.id }, body: { by: human } }, res);
  assert.equal(res.code, 403);
  res = mockRes();
  await routes.proposalApprove({ headers: {}, dbUser: { email: 'owner@example.com' }, params: { id: p.id }, body: { by: { type: 'victus', id: 'x' } } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.proposal.decision.by, 'owner@example.com');
});

test('kill switch started from env stops research/coding scopes immediately', () => {
  const { killSwitch } = createVictusSafety({ env: { VICTUS_KILL_SWITCH: 'on' } });
  assert.throws(() => killSwitch.assertRunning('research'), KillSwitchEngagedError);
  assert.throws(() => killSwitch.assertRunning('coding'), KillSwitchEngagedError);
});
