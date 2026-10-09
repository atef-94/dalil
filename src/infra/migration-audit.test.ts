import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { InMemoryRepository } from './repository.js';
import { runMigrationAudit } from './migration-audit.js';
import type { Company, Role, User, UserRole } from '../domain/types.js';
import { PLATFORM_COMPANY_ID } from '../modules/permissions/platform-owner.js';

function freshRepos() {
  return {
    companies: new InMemoryRepository<Company>(),
    users: new InMemoryRepository<User>(),
    roles: new InMemoryRepository<Role>(),
    userRoles: new InMemoryRepository<UserRole>(),
  };
}

function makeUser(companyId: string, overrides: Partial<User> = {}): User {
  return {
    id: randomUUID(),
    companyId,
    email: `${randomUUID()}@test.local`,
    passwordHash: 'x',
    userType: 'employee_user',
    locale: 'en',
    failedLoginCount: 0,
    createdAt: new Date().toISOString(),
    totpEnabled: false,
    ...overrides,
  };
}

test('a clean dataset is reported safe to enforce', async () => {
  const repos = freshRepos();
  const company = await repos.companies.save({ id: randomUUID(), companyId: '', name: 'Acme', createdAt: new Date().toISOString() });
  company.companyId = company.id;
  await repos.companies.save(company);
  const user = await repos.users.save(makeUser(company.id));
  const role = await repos.roles.save({ id: randomUUID(), companyId: company.id, name: 'Owner', isSystem: true });
  await repos.userRoles.save({ id: randomUUID(), userId: user.id, roleId: role.id });

  const report = await runMigrationAudit(repos);
  assert.equal(report.safeToEnforce, true);
  assert.equal(report.usersWithOrphanedCompanyId.length, 0);
  assert.equal(report.crossCompanyRoleAssignments.length, 0);
});

test('a user whose companyId does not resolve to any real company is flagged, not silently mapped', async () => {
  const repos = freshRepos();
  const user = await repos.users.save(makeUser('does-not-exist'));
  const report = await runMigrationAudit(repos);
  assert.equal(report.safeToEnforce, false);
  assert.equal(report.usersWithOrphanedCompanyId.length, 1);
  assert.equal(report.usersWithOrphanedCompanyId[0]!.userId, user.id);
});

test('a role assigned to a user from a different company is flagged as a cross-company role assignment', async () => {
  const repos = freshRepos();
  const companyA = await repos.companies.save({ id: 'company-a', companyId: 'company-a', name: 'A', createdAt: new Date().toISOString() });
  const companyB = await repos.companies.save({ id: 'company-b', companyId: 'company-b', name: 'B', createdAt: new Date().toISOString() });
  const user = await repos.users.save(makeUser(companyA.id));
  const role = await repos.roles.save({ id: randomUUID(), companyId: companyB.id, name: 'Admin', isSystem: false });
  await repos.userRoles.save({ id: randomUUID(), userId: user.id, roleId: role.id });

  const report = await runMigrationAudit(repos);
  assert.equal(report.safeToEnforce, false);
  assert.equal(report.crossCompanyRoleAssignments.length, 1);
  assert.equal(report.crossCompanyRoleAssignments[0]!.userId, user.id);
  assert.equal(report.crossCompanyRoleAssignments[0]!.roleCompanyId, companyB.id);
});

test('a UserRole pointing at a deleted role is flagged as an orphaned assignment, not silently dropped', async () => {
  const repos = freshRepos();
  const company = await repos.companies.save({ id: 'c1', companyId: 'c1', name: 'A', createdAt: new Date().toISOString() });
  const user = await repos.users.save(makeUser(company.id));
  await repos.userRoles.save({ id: randomUUID(), userId: user.id, roleId: 'role-that-was-deleted' });

  const report = await runMigrationAudit(repos);
  assert.equal(report.safeToEnforce, false);
  assert.equal(report.orphanedUserRoleAssignments.length, 1);
  assert.equal(report.orphanedUserRoleAssignments[0]!.reason, 'missing_role');
});

test('a role whose companyId collides with the reserved platform sentinel is flagged', async () => {
  const repos = freshRepos();
  await repos.roles.save({ id: randomUUID(), companyId: PLATFORM_COMPANY_ID, name: 'Sneaky', isSystem: false });
  const report = await runMigrationAudit(repos);
  assert.equal(report.safeToEnforce, false);
  assert.equal(report.platformSentinelCollisions.length, 1);
  assert.equal(report.platformSentinelCollisions[0]!.kind, 'role');
});

test('the real platform company (named exactly "ACTIVE Platform") is never flagged as a collision', async () => {
  const repos = freshRepos();
  await repos.companies.save({ id: PLATFORM_COMPANY_ID, companyId: PLATFORM_COMPANY_ID, name: 'ACTIVE Platform', createdAt: new Date().toISOString() });
  const report = await runMigrationAudit(repos);
  assert.equal(report.platformSentinelCollisions.length, 0);
});
