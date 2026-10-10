// ─── Team Features: Permissions (RBAC) ────────────────────────
// Phase 14. Pure logic, no I/O — real role-based access control, not
// just a role LABEL stored on a user with nothing checking it. Every
// team-scoped write in routes.js calls hasPermission() before touching
// the database.

const ROLES = ['owner', 'admin', 'member'];

// What each role can do. Explicit allowlist per action — safer than a
// numeric hierarchy shortcut (e.g. "admin >= member so admin can do
// anything member can"), because it's easy to audit exactly what a
// role can do by reading this table, and adding a new action forces a
// conscious decision about who gets it rather than inheriting it by
// accident.
const PERMISSIONS = {
  owner:  ['invite_member', 'remove_member', 'change_role', 'delete_organization', 'manage_billing', 'create_team', 'delete_team', 'share_conversation', 'manage_org_preferences', 'view'],
  admin:  ['invite_member', 'remove_member', 'change_role', 'create_team', 'delete_team', 'share_conversation', 'manage_org_preferences', 'view'],
  member: ['share_conversation', 'view'],
};

function hasPermission(role, action) {
  if (!ROLES.includes(role)) return false;
  return (PERMISSIONS[role] || []).includes(action);
}

// A few rules that need more than a flat permission check:
function canChangeRole(actorRole, targetCurrentRole, newRole) {
  if (!hasPermission(actorRole, 'change_role')) return false;
  // Only an owner can create or demote another owner — an admin
  // promoting someone to owner (or demoting the owner) would let admins
  // seize/strip top-level control, which defeats the point of the role.
  if (targetCurrentRole === 'owner' || newRole === 'owner') return actorRole === 'owner';
  return true;
}

function canRemoveMember(actorRole, targetRole) {
  if (!hasPermission(actorRole, 'remove_member')) return false;
  // An owner can never be removed via this path (must transfer
  // ownership or delete the org instead) — prevents an org from ending
  // up with no owner at all.
  if (targetRole === 'owner') return false;
  // Admins cannot remove other admins — only an owner can, so one
  // rogue/compromised admin can't purge every other admin.
  if (targetRole === 'admin' && actorRole !== 'owner') return false;
  return true;
}

module.exports = { ROLES, PERMISSIONS, hasPermission, canChangeRole, canRemoveMember };
