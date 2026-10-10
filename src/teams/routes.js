const express = require('express');
const db = require('../db');
const { hasPermission, canChangeRole, canRemoveMember, ROLES } = require('./permissions');
const { logger } = require('../logging/logger');

const router = express.Router();

function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated() && req.dbUser) return next();
  return res.status(401).json({ error: 'Sign in to use Team Features.' });
}
function notReadyIfNoDb(req, res, next) {
  if (!db.isEnabled()) return res.status(503).json({ error: 'This feature isn\u2019t configured on this server yet.' });
  next();
}
router.use(requireAuth, notReadyIfNoDb);

// Loads the caller's membership for :orgId and attaches it as
// req.membership — used by every org-scoped route below to check
// permissions consistently instead of re-querying each time.
async function loadMembership(req, res, next) {
  const orgId = parseInt(req.params.orgId, 10);
  if (!Number.isInteger(orgId)) return res.status(400).json({ error: 'invalid organization id' });
  const membership = await db.getOrgMembership(orgId, req.dbUser.id);
  if (!membership) return res.status(403).json({ error: 'You are not a member of this organization' });
  req.orgId = orgId;
  req.membership = membership;
  next();
}

// ── Organizations ────────────────────────────────────────────
router.get('/organizations', async (req, res) => {
  res.json({ organizations: await db.listUserOrganizations(req.dbUser.id) });
});

router.post('/organizations', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const org = await db.createOrganization(req.dbUser.id, name.trim());
  res.json({ organization: org });
});

router.delete('/organizations/:orgId', loadMembership, async (req, res) => {
  if (!hasPermission(req.membership.role, 'delete_organization')) {
    return res.status(403).json({ error: 'Only the organization owner can delete it' });
  }
  await db.recordAuditLog({ userId: req.dbUser.id, orgId: req.orgId, action: 'organization.deleted' });
  await db.deleteOrganization(req.orgId);
  res.json({ deleted: true });
});

// ── Members ──────────────────────────────────────────────────
router.get('/organizations/:orgId/members', loadMembership, async (req, res) => {
  res.json({ members: await db.listOrgMembers(req.orgId) });
});

router.post('/organizations/:orgId/members', loadMembership, async (req, res) => {
  if (!hasPermission(req.membership.role, 'invite_member')) {
    return res.status(403).json({ error: 'You do not have permission to add members' });
  }
  const { email, role } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });
  const targetUser = await db.findUserByEmail(email);
  if (!targetUser) return res.status(404).json({ error: 'No user found with that email \u2014 they need to have signed in to Nova AI at least once' });

  const member = await db.addOrgMember(req.orgId, targetUser.id, role && ROLES.includes(role) && role !== 'owner' ? role : 'member');
  if (!member) return res.status(409).json({ error: 'That user is already a member' });
  res.json({ member });
});

router.patch('/organizations/:orgId/members/:userId/role', loadMembership, async (req, res) => {
  const targetUserId = parseInt(req.params.userId, 10);
  const { role: newRole } = req.body;
  if (!ROLES.includes(newRole)) return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });

  const target = await db.getOrgMembership(req.orgId, targetUserId);
  if (!target) return res.status(404).json({ error: 'Member not found' });

  if (!canChangeRole(req.membership.role, target.role, newRole)) {
    return res.status(403).json({ error: 'You do not have permission to make this role change' });
  }
  const updated = await db.updateOrgMemberRole(req.orgId, targetUserId, newRole);
  await db.recordAuditLog({ userId: req.dbUser.id, orgId: req.orgId, action: 'member.role_changed', targetType: 'organization_member', targetId: targetUserId, metadata: { fromRole: target.role, toRole: newRole } });
  res.json({ member: updated });
});

router.delete('/organizations/:orgId/members/:userId', loadMembership, async (req, res) => {
  const targetUserId = parseInt(req.params.userId, 10);
  const target = await db.getOrgMembership(req.orgId, targetUserId);
  if (!target) return res.status(404).json({ error: 'Member not found' });

  if (!canRemoveMember(req.membership.role, target.role)) {
    return res.status(403).json({ error: 'You do not have permission to remove this member' });
  }
  await db.removeOrgMember(req.orgId, targetUserId);
  await db.recordAuditLog({ userId: req.dbUser.id, orgId: req.orgId, action: 'member.removed', targetType: 'organization_member', targetId: targetUserId, metadata: { removedRole: target.role } });
  res.json({ removed: true });
});

// ── Teams ────────────────────────────────────────────────────
router.get('/organizations/:orgId/teams', loadMembership, async (req, res) => {
  res.json({ teams: await db.listOrgTeams(req.orgId) });
});

router.post('/organizations/:orgId/teams', loadMembership, async (req, res) => {
  if (!hasPermission(req.membership.role, 'create_team')) return res.status(403).json({ error: 'You do not have permission to create teams' });
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  res.json({ team: await db.createTeam(req.orgId, name.trim()) });
});

router.delete('/organizations/:orgId/teams/:teamId', loadMembership, async (req, res) => {
  if (!hasPermission(req.membership.role, 'delete_team')) return res.status(403).json({ error: 'You do not have permission to delete teams' });
  const deleted = await db.deleteTeam(parseInt(req.params.teamId, 10), req.orgId);
  if (!deleted) return res.status(404).json({ error: 'Team not found' });
  res.json({ deleted: true });
});

router.post('/organizations/:orgId/teams/:teamId/members', loadMembership, async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  const targetMembership = await db.getOrgMembership(req.orgId, userId);
  if (!targetMembership) return res.status(400).json({ error: 'That user is not a member of this organization' });
  await db.addTeamMember(parseInt(req.params.teamId, 10), userId);
  res.json({ added: true });
});

router.get('/organizations/:orgId/teams/:teamId/members', loadMembership, async (req, res) => {
  res.json({ members: await db.listTeamMembers(parseInt(req.params.teamId, 10)) });
});

// ── Shared workspaces ────────────────────────────────────────
router.post('/organizations/:orgId/shared-conversations', loadMembership, async (req, res) => {
  if (!hasPermission(req.membership.role, 'share_conversation')) return res.status(403).json({ error: 'You do not have permission to share conversations' });
  const { conversationId } = req.body;
  if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });
  // Ownership check: can only share a conversation that's actually yours.
  const owned = await db.getConversation(conversationId, req.dbUser.id);
  if (!owned) return res.status(404).json({ error: 'Conversation not found or not yours' });
  await db.shareConversation(conversationId, req.orgId, req.dbUser.id);
  res.json({ shared: true });
});

router.delete('/organizations/:orgId/shared-conversations/:conversationId', loadMembership, async (req, res) => {
  await db.unshareConversation(req.params.conversationId, req.orgId);
  res.json({ unshared: true });
});

router.get('/organizations/:orgId/shared-conversations', loadMembership, async (req, res) => {
  res.json({ conversations: await db.listSharedConversations(req.orgId) });
});

// ── Shared AI memory ─────────────────────────────────────────
router.get('/organizations/:orgId/preferences', loadMembership, async (req, res) => {
  res.json({ preferences: await db.listOrgPreferences(req.orgId) });
});

router.post('/organizations/:orgId/preferences', loadMembership, async (req, res) => {
  if (!hasPermission(req.membership.role, 'manage_org_preferences')) return res.status(403).json({ error: 'You do not have permission to set shared team preferences' });
  const { key, value } = req.body;
  if (!key || !value) return res.status(400).json({ error: 'key and value are required' });
  res.json({ preference: await db.setOrgPreference(req.orgId, key, value, req.dbUser.id) });
});

router.delete('/organizations/:orgId/preferences/:key', loadMembership, async (req, res) => {
  if (!hasPermission(req.membership.role, 'manage_org_preferences')) return res.status(403).json({ error: 'You do not have permission to remove shared team preferences' });
  const deleted = await db.deleteOrgPreference(req.orgId, req.params.key);
  if (!deleted) return res.status(404).json({ error: 'Preference not found' });
  res.json({ deleted: true });
});

// ── Team billing ─────────────────────────────────────────────
router.get('/organizations/:orgId/billing', loadMembership, async (req, res) => {
  const subscription = await db.getOrgSubscription(req.orgId);
  res.json({ subscription: subscription || { tier: 'free', status: 'active', note: 'No team subscription set \u2014 members fall back to their personal plans.' } });
});

module.exports = { router };
