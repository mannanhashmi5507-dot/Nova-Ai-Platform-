'use strict';

const path = require('path');

// The locked control plane. Victus may reason about, and recommend changes to,
// these — but it may never SUBMIT a change to them; only a human can (and then
// only with explicit high-risk confirmation). The first group are logical zones
// used by older docs; the rest are the real files/directories in this repo.
const IMMUTABLE_PATHS = Object.freeze([
  // logical security zones
  'security/authentication',
  'security/authorization',
  'security/audit',
  'security/secrets',
  'security/isolation',
  'security/emergency-shutdown',
  // Victus' own control logic, safety rules, tool policy, research allowlist, model config, kill switch, compute layer
  'src/victus',
  // authentication, authorization, rate limits, usage gates
  'src/middleware',
  // server entry point (wires everything), configuration, data layer
  'src/index.js',
  'src/config',
  'src/db',
  // training rules and model configuration
  'models',
  // dependency manifests, deployment and secrets
  'package.json',
  'package-lock.json',
  'dockerfile',
  'railway.json',
  'railway.toml',
  'nixpacks.toml',
  '.github',
  '.env',
  'scripts',
]);
const HIGH_RISK_ACTIONS = Object.freeze(['DEPLOY', 'DELETE', 'ADMIN']);

// Canonical form used for every path comparison: decoded, forward slashes,
// no "." / ".." segments, lower-case, no leading or trailing slash. This stops
// "src/../src/victus/x", "SRC/Victus", "src//victus", "%2e%2e/" style tricks.
function normalizeChangePath(p) {
  if (typeof p !== 'string' || p.includes('\0')) return null;
  let s = p;
  for (let i = 0; i < 3; i += 1) {
    try { const d = decodeURIComponent(s); if (d === s) break; s = d; } catch { break; }
  }
  s = s.replace(/\\/g, '/').trim();
  s = path.posix.normalize(`/${s}`).replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
  return s;
}

// A path is locked if a locked root appears on a segment boundary anywhere in it,
// so absolute paths and nested checkouts ("/app/src/victus/...") are caught too.
function isImmutablePath(p) {
  const n = normalizeChangePath(p);
  if (n === null) return true; // unparseable → fail closed
  const hay = `/${n}/`;
  return IMMUTABLE_PATHS.some(root => hay.includes(`/${root}/`));
}

function classifyChange(change = {}) {
  const paths = Array.isArray(change.paths) ? change.paths : [];
  const action = change.actionType || 'WRITE';
  const touchesImmutable = paths.some(isImmutablePath);
  return {
    requiresHumanApproval: touchesImmutable || HIGH_RISK_ACTIONS.includes(action) || change.irreversible === true,
    touchesImmutable,
    action,
  };
}

function assertEvolutionAllowed(change, approval = {}) {
  const c = classifyChange(change);
  if (c.touchesImmutable && approval.approved !== true) throw new Error('human authorization required for immutable security boundary change');
  if (c.requiresHumanApproval && approval.approved !== true) throw new Error('human authorization required for high-risk evolution');
  return true;
}

module.exports = { IMMUTABLE_PATHS, HIGH_RISK_ACTIONS, classifyChange, assertEvolutionAllowed, normalizeChangePath, isImmutablePath };
