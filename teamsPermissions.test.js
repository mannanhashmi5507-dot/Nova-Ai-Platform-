const test = require('node:test');
const assert = require('node:assert/strict');
const { hasPermission, canChangeRole, canRemoveMember, ROLES, PERMISSIONS } = require('../src/teams/permissions');

test('owner has every permission that admin has, plus owner-only ones', () => {
  for (const action of PERMISSIONS.admin) {
    assert.ok(hasPermission('owner', action), `owner should have admin's "${action}" permission`);
  }
  assert.ok(hasPermission('owner', 'delete_organization'));
  assert.ok(hasPermission('owner', 'manage_billing'));
});

test('member has only the minimal permissions (view, share_conversation)', () => {
  assert.ok(hasPermission('member', 'view'));
  assert.ok(hasPermission('member', 'share_conversation'));
  assert.equal(hasPermission('member', 'invite_member'), false);
  assert.equal(hasPermission('member', 'delete_organization'), false);
  assert.equal(hasPermission('member', 'manage_billing'), false);
});

test('admin cannot delete the organization or manage billing (owner-only actions)', () => {
  assert.equal(hasPermission('admin', 'delete_organization'), false);
  assert.equal(hasPermission('admin', 'manage_billing'), false);
});

test('an unknown/invalid role has no permissions at all', () => {
  assert.equal(hasPermission('superadmin', 'view'), false);
  assert.equal(hasPermission('', 'view'), false);
  assert.equal(hasPermission(null, 'view'), false);
});

test('an unknown action returns false for every role, rather than throwing', () => {
  for (const role of ROLES) {
    assert.equal(hasPermission(role, 'launch_nuclear_missiles'), false);
  }
});

// ── canChangeRole: the owner-protection rules ──────────────────

test('owner can promote a member to admin', () => {
  assert.equal(canChangeRole('owner', 'member', 'admin'), true);
});

test('owner can demote an admin to member', () => {
  assert.equal(canChangeRole('owner', 'admin', 'member'), true);
});

test('owner can transfer ownership to another member', () => {
  assert.equal(canChangeRole('owner', 'member', 'owner'), true);
});

test('CRITICAL: admin cannot promote anyone to owner', () => {
  assert.equal(canChangeRole('admin', 'member', 'owner'), false);
});

test('CRITICAL: admin cannot demote the owner', () => {
  assert.equal(canChangeRole('admin', 'owner', 'member'), false);
});

test('admin CAN promote a member to admin (not an owner-only action)', () => {
  assert.equal(canChangeRole('admin', 'member', 'admin'), true);
});

test('member cannot change any role at all', () => {
  assert.equal(canChangeRole('member', 'member', 'admin'), false);
});

// ── canRemoveMember: the owner-protection + admin-vs-admin rules ──

test('CRITICAL: the owner can never be removed via this function, even by another owner-permission actor', () => {
  assert.equal(canRemoveMember('owner', 'owner'), false);
});

test('owner can remove an admin', () => {
  assert.equal(canRemoveMember('owner', 'admin'), true);
});

test('owner can remove a member', () => {
  assert.equal(canRemoveMember('owner', 'member'), true);
});

test('CRITICAL: an admin cannot remove another admin (only the owner can)', () => {
  assert.equal(canRemoveMember('admin', 'admin'), false);
});

test('an admin CAN remove a regular member', () => {
  assert.equal(canRemoveMember('admin', 'member'), true);
});

test('a member cannot remove anyone', () => {
  assert.equal(canRemoveMember('member', 'member'), false);
  assert.equal(canRemoveMember('member', 'admin'), false);
});

test('exactly 3 roles are defined, matching the roadmap (Owner/Admin/Member)', () => {
  assert.deepEqual(ROLES, ['owner', 'admin', 'member']);
});
