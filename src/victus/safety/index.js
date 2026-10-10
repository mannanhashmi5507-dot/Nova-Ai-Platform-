'use strict';

const { AuditLog } = require('./auditLog');
const { KillSwitch } = require('./killSwitch');
const { UpgradeProposalQueue } = require('./proposalQueue');
const { createSafetyRoutes } = require('./routes');
const errors = require('./errors');

function createVictusSafety({ env = process.env, now } = {}) {
  const audit = new AuditLog({ filePath: env.VICTUS_AUDIT_FILE || null });
  const on = String(env.VICTUS_KILL_SWITCH || '').toLowerCase();
  const killSwitch = new KillSwitch({
    stateFile: env.VICTUS_SAFETY_STATE_FILE || null,
    initiallyEngaged: ['1', 'true', 'on', 'yes'].includes(on),
    audit,
  });
  const queue = new UpgradeProposalQueue({ audit, killSwitch, ttlDays: Number(env.VICTUS_PROPOSAL_TTL_DAYS) || 14, ...(now ? { now } : {}) });
  const routes = createSafetyRoutes({ audit, killSwitch, queue, env });
  return { audit, killSwitch, queue, routes };
}

module.exports = { createVictusSafety, AuditLog, KillSwitch, UpgradeProposalQueue, createSafetyRoutes, ...errors };
