import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { RoleManagementService } from './role-management.service.js';
import type { PermissionGrant, Role, UserRole } from '../../domain/types.js';

function freshService() {
  return new RoleManagementService(new InMemoryRepository<Role>(), new InMemoryRepository<PermissionGrant>(), new InMemoryRepository<UserRole>());
}

test('createRole rejects an empty name', async () => {
  const svc = freshService();
  await assert.rejects(() => svc.createRole('c1', '  '));
});

test('createRole then listRoles returns it, scoped to the company', async () => {
  const svc = freshService();
  await svc.createRole('c1', 'Sales Manager');
  await svc.createRole('c2', 'Other Company Role');
  const roles = await svc.listRoles('c1');
  assert.equal(roles.length, 1);
  assert.equal(roles[0]!.name, 'Sales Manager');
});

test('addGrant rejects a role from a different company', async () => {
  const svc = freshService();
  const role = await svc.createRole('c1', 'Manager');
  await assert.rejects(() => svc.addGrant('c2', role.id, { action: 'view', resource: 'lead', scope: 'company' }));
});

test('addGrant then listGrants returns the new grant', async () => {
  const svc = freshService();
  const role = await svc.createRole('c1', 'Manager');
  await svc.addGrant('c1', role.id, { action: 'view', resource: 'lead', scope: 'company' });
  const grants = await svc.listGrants(role.id);
  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.action, 'view');
});

test('removeGrant deletes the grant and rejects a grant that belongs to a different role', async () => {
  const svc = freshService();
  const roleA = await svc.createRole('c1', 'A');
  const roleB = await svc.createRole('c1', 'B');
  const grant = await svc.addGrant('c1', roleA.id, { action: 'view', resource: 'lead', scope: 'company' });
  await assert.rejects(() => svc.removeGrant('c1', roleB.id, grant.id));
  await svc.removeGrant('c1', roleA.id, grant.id);
  assert.equal((await svc.listGrants(roleA.id)).length, 0);
});

test('assignRole then listUserRoles returns the assignment; revokeUserRole removes it', async () => {
  const svc = freshService();
  const role = await svc.createRole('c1', 'Manager');
  const assignment = await svc.assignRole('user-1', role.id);
  const assignments = await svc.listUserRoles('user-1');
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0]!.id, assignment.id);
  await svc.revokeUserRole('user-1', assignment.id);
  assert.equal((await svc.listUserRoles('user-1')).length, 0);
});

test('revokeUserRole rejects an assignment that belongs to a different user', async () => {
  const svc = freshService();
  const role = await svc.createRole('c1', 'Manager');
  const assignment = await svc.assignRole('user-1', role.id);
  await assert.rejects(() => svc.revokeUserRole('user-2', assignment.id));
});

test('assignRole rejects a nonexistent role', async () => {
  const svc = freshService();
  await assert.rejects(() => svc.assignRole('user-1', 'nonexistent-role'));
});
