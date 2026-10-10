'use strict';

// Framework-light HTTP handlers (req, res) for the safety control plane.
// Every handler is admin-only and fails closed: with no ADMIN_EMAILS and no
// VICTUS_ADMIN_TOKEN configured, nobody is an admin.

const crypto = require('crypto');
const { SafetyError } = require('./errors');

function sha(v) { return crypto.createHash('sha256').update(String(v)).digest(); }
function safeEqual(a, b) { return crypto.timingSafeEqual(sha(a), sha(b)); }

function createAdminAuth({ env = process.env, audit } = {}) {
  return function authenticateAdmin(req) {
    const token = (env.VICTUS_ADMIN_TOKEN || '').trim();
    const provided = req.headers?.['x-victus-admin-token'];
    if (token.length >= 24 && typeof provided === 'string' && safeEqual(provided, token)) return { type: 'human', id: 'admin-token' };
    const admins = (env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    const email = (req.dbUser?.email || '').toLowerCase();
    if (email && admins.includes(email)) return { type: 'human', id: email };
    audit?.append({ actor: email || 'anonymous', action: 'admin.denied', outcome: 'blocked', metadata: { path: req.path || null } });
    return null;
  };
}

function createSafetyRoutes({ audit, killSwitch, queue, env = process.env } = {}) {
  const authenticateAdmin = createAdminAuth({ env, audit });

  const guard = fn => async (req, res) => {
    const admin = authenticateAdmin(req);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });
    try {
      const body = await fn(req, admin);
      res.json(body);
    } catch (err) {
      if (err instanceof SafetyError) return res.status(err.status).json({ error: err.message, code: err.code });
      res.status(500).json({ error: 'Safety control plane error' });
    }
  };

  return {
    authenticateAdmin,
    status: guard(() => ({ killSwitch: killSwitch.status(), audit: audit.verify(), pendingProposals: queue.list({ status: 'PENDING', limit: 200 }).length })),
    engage: guard((req, admin) => killSwitch.engage({ by: `${admin.type}:${admin.id}`, reason: req.body?.reason, scope: req.body?.scope })),
    release: guard((req, admin) => killSwitch.release({ by: `${admin.type}:${admin.id}`, scope: req.body?.scope })),
    auditList: guard(req => ({ entries: audit.list({ limit: req.query?.limit, action: req.query?.action }) })),
    auditVerify: guard(() => audit.verify()),
    proposalsList: guard(req => ({ proposals: queue.list({ status: req.query?.status, limit: req.query?.limit }) })),
    proposalGet: guard(req => ({ proposal: queue.get(req.params.id) })),
    proposalCreate: guard((req, admin) => ({ proposal: queue.submit(req.body || {}, admin) })),
    proposalApprove: guard((req, admin) => ({ proposal: queue.approve(req.params.id, { by: admin, note: req.body?.note, confirmHighRisk: req.body?.confirmHighRisk === true }) })),
    proposalReject: guard((req, admin) => ({ proposal: queue.reject(req.params.id, { by: admin, note: req.body?.note }) })),
    proposalApplied: guard((req, admin) => ({ proposal: queue.markApplied(req.params.id, { by: admin, note: req.body?.note }) })),
  };
}

module.exports = { createSafetyRoutes, createAdminAuth };
