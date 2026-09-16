import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApplication } from '../../app.js';
import { buildPermissionManifest } from './manifest.builder.js';

async function freshApp() {
  return buildApplication({ nodeEnv: 'test', tokenSecret: 'test-secret', allowedOrigins: [], seed: false });
}

async function makeUserWithRole(
  app: Awaited<ReturnType<typeof freshApp>>,
  companyId: string,
  grants: { action: any; resource: any; scope: any }[],
  employeeOverrides: Partial<{ departmentId: string; branchId: string; managerEmployeeId: string }> = {},
) {
  const employee = await app.repos.employees.save({
    id: randomUUID(),
    companyId,
    fullName: 'Test Employee',
    email: `${randomUUID()}@test.local`,
    title: 'Tester',
    status: 'active',
    createdAt: new Date().toISOString(),
    ...employeeOverrides,
  });
  const user = await app.repos.users.save({
    id: randomUUID(),
    companyId,
    email: employee.email,
    passwordHash: 'x',
    userType: 'employee_user',
    employeeId: employee.id,
    locale: 'en',
    failedLoginCount: 0,
    createdAt: new Date().toISOString(),
  });
  const role = await app.repos.roles.save({ id: randomUUID(), companyId, name: 'test-role', isSystem: false });
  for (const g of grants) {
    await app.repos.grants.save({ id: randomUUID(), roleId: role.id, action: g.action, resource: g.resource, scope: g.scope, sensitivity: 'standard' });
  }
  await app.repos.userRoles.save({ id: randomUUID(), userId: user.id, roleId: role.id });
  return { user, employee, role };
}

test('default-deny: a user with zero grants is denied everything', async () => {
  const app = await freshApp();
  const { user } = await makeUserWithRole(app, 'company-1', []);
  const allowed = await app.services.rbac.can(user.id, 'view', 'lead');
  assert.equal(allowed, false);
});

test('company-scope grant allows access to any record in the company', async () => {
  const app = await freshApp();
  const { user } = await makeUserWithRole(app, 'company-1', [{ action: 'view', resource: 'lead', scope: 'company' }]);
  const allowed = await app.services.rbac.can(user.id, 'view', 'lead', { companyId: 'company-1', ownerUserId: 'someone-else' });
  assert.equal(allowed, true);
});

test('company scope never reaches into another tenant', async () => {
  const app = await freshApp();
  const { user } = await makeUserWithRole(app, 'company-1', [{ action: 'view', resource: 'lead', scope: 'company' }]);
  const allowed = await app.services.rbac.can(user.id, 'view', 'lead', { companyId: 'company-2' });
  assert.equal(allowed, false);
});

test('department scope allows a record owned by someone in the same department', async () => {
  const app = await freshApp();
  const { user } = await makeUserWithRole(
    app,
    'company-1',
    [{ action: 'view', resource: 'lead', scope: 'department' }],
    { departmentId: 'dept-sales' },
  );
  const allowed = await app.services.rbac.can(user.id, 'view', 'lead', { companyId: 'company-1', departmentId: 'dept-sales' });
  assert.equal(allowed, true);
});

test('department scope denies a record owned by a different department', async () => {
  const app = await freshApp();
  const { user } = await makeUserWithRole(
    app,
    'company-1',
    [{ action: 'view', resource: 'lead', scope: 'department' }],
    { departmentId: 'dept-sales' },
  );
  const allowed = await app.services.rbac.can(user.id, 'view', 'lead', { companyId: 'company-1', departmentId: 'dept-finance' });
  assert.equal(allowed, false);
});

test('branch scope resolves against the employee branchId', async () => {
  const app = await freshApp();
  const { user } = await makeUserWithRole(app, 'company-1', [{ action: 'view', resource: 'unit', scope: 'branch' }], { branchId: 'branch-cairo' });
  const allowed = await app.services.rbac.can(user.id, 'view', 'unit', { companyId: 'company-1', branchId: 'branch-cairo' });
  assert.equal(allowed, true);
});

test('team scope resolves against records owned by direct reports', async () => {
  const app = await freshApp();
  const { user, employee } = await makeUserWithRole(app, 'company-1', [{ action: 'view', resource: 'lead', scope: 'team' }]);
  const allowed = await app.services.rbac.can(user.id, 'view', 'lead', { companyId: 'company-1', managerEmployeeId: employee.id });
  assert.equal(allowed, true);
});

test('own scope only allows the acting user\'s own records', async () => {
  const app = await freshApp();
  const { user } = await makeUserWithRole(app, 'company-1', [{ action: 'view', resource: 'lead', scope: 'own' }]);
  const own = await app.services.rbac.can(user.id, 'view', 'lead', { companyId: 'company-1', ownerUserId: user.id });
  const other = await app.services.rbac.can(user.id, 'view', 'lead', { companyId: 'company-1', ownerUserId: 'someone-else' });
  assert.equal(own, true);
  assert.equal(other, false);
});

test('an active revoke override beats any grant', async () => {
  const app = await freshApp();
  const { user } = await makeUserWithRole(app, 'company-1', [{ action: 'view', resource: 'lead', scope: 'company' }]);
  await app.repos.overrides.save({ id: randomUUID(), userId: user.id, action: 'view', resource: 'lead', effect: 'revoke' });
  const allowed = await app.services.rbac.can(user.id, 'view', 'lead', { companyId: 'company-1' });
  assert.equal(allowed, false);
});

test('a grant override allows access even without any role grant', async () => {
  const app = await freshApp();
  const { user } = await makeUserWithRole(app, 'company-1', []);
  await app.repos.overrides.save({ id: randomUUID(), userId: user.id, action: 'view', resource: 'lead', effect: 'grant' });
  const allowed = await app.services.rbac.can(user.id, 'view', 'lead', { companyId: 'company-1' });
  assert.equal(allowed, true);
});

test('an expired override is ignored', async () => {
  const app = await freshApp();
  const { user } = await makeUserWithRole(app, 'company-1', []);
  await app.repos.overrides.save({
    id: randomUUID(),
    userId: user.id,
    action: 'view',
    resource: 'lead',
    effect: 'grant',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  const allowed = await app.services.rbac.can(user.id, 'view', 'lead', { companyId: 'company-1' });
  assert.equal(allowed, false);
});

test('an expired UserRole no longer grants access', async () => {
  const app = await freshApp();
  const { user, role } = await makeUserWithRole(app, 'company-1', [{ action: 'view', resource: 'lead', scope: 'company' }]);
  const userRoles = await app.repos.userRoles.findAll((ur) => ur.userId === user.id);
  for (const ur of userRoles) {
    await app.repos.userRoles.save({ ...ur, expiresAt: new Date(Date.now() - 1000).toISOString() });
  }
  const allowed = await app.services.rbac.can(user.id, 'view', 'lead', { companyId: 'company-1' });
  assert.equal(allowed, false);
  void role;
});

test('broker hard-wall: a broker_user is never broader than broker_own, even with a misconfigured company-scope grant', async () => {
  const app = await freshApp();
  const brokerCompany = await app.repos.brokerCompanies.save({ id: randomUUID(), companyId: 'company-1', name: 'Acme Brokers', status: 'approved', createdAt: new Date().toISOString() });
  const user = await app.repos.users.save({
    id: randomUUID(),
    companyId: 'company-1',
    email: 'broker@test.local',
    passwordHash: 'x',
    userType: 'broker_user',
    brokerCompanyId: brokerCompany.id,
    locale: 'en',
    failedLoginCount: 0,
    createdAt: new Date().toISOString(),
  });
  const role = await app.repos.roles.save({ id: randomUUID(), companyId: 'company-1', name: 'misconfigured-broker', isSystem: false });
  // Deliberately misconfigured: a company-wide scope grant.
  await app.repos.grants.save({ id: randomUUID(), roleId: role.id, action: 'view', resource: 'lead', scope: 'company', sensitivity: 'standard' });
  await app.repos.userRoles.save({ id: randomUUID(), userId: user.id, roleId: role.id });

  const ownLead = await app.services.rbac.can(user.id, 'view', 'lead', { companyId: 'company-1', submittedByUserId: user.id });
  const otherBrokersLead = await app.services.rbac.can(user.id, 'view', 'lead', { companyId: 'company-1', submittedByUserId: 'someone-else', brokerCompanyId: 'other-broker-co' });
  assert.equal(ownLead, true);
  assert.equal(otherBrokersLead, false);
});

test('getListAccessScope regression: a department-scoped grant resolves for list endpoints (the real bug that was found and fixed)', async () => {
  const app = await freshApp();
  const { user } = await makeUserWithRole(
    app,
    'company-1',
    [{ action: 'view', resource: 'lead', scope: 'department' }],
    { departmentId: 'dept-sales' },
  );
  const scope = await app.services.rbac.getListAccessScope(user.id, 'view', 'lead');
  assert.equal(scope.kind, 'department');
  if (scope.kind === 'department') {
    assert.equal(scope.departmentId, 'dept-sales');
  }
});

test('buildPermissionManifest returns an entry for every resource x action pair, reflecting allow/deny correctly', async () => {
  const app = await freshApp();
  const { user } = await makeUserWithRole(app, 'company-1', [{ action: 'view', resource: 'lead', scope: 'company' }]);
  const manifest = await buildPermissionManifest(app.services.rbac, user.id);
  const viewLead = manifest.entries.find((e) => e.resource === 'lead' && e.action === 'view');
  const createLead = manifest.entries.find((e) => e.resource === 'lead' && e.action === 'create');
  assert.equal(viewLead?.allowed, true);
  assert.equal(createLead?.allowed, false);
  assert.ok(manifest.entries.length > 20);
});
