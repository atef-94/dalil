import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { OrganizationService } from '../organization/organization.service.js';
import { AuthService } from '../auth/auth.service.js';
import { RoleManagementService } from '../permissions/role-management.service.js';
import { RbacEvaluator } from '../permissions/rbac.evaluator.js';
import { OnboardingService } from './onboarding.service.js';
import { RESOURCES, ACTIONS } from '../permissions/manifest.builder.js';
import type { Company, Employee, PermissionGrant, PermissionOverride, Role, User, UserRole } from '../../domain/types.js';

function freshOnboarding() {
  const repos = {
    companies: new InMemoryRepository<Company>(),
    employees: new InMemoryRepository<Employee>(),
    users: new InMemoryRepository<User>(),
    roles: new InMemoryRepository<Role>(),
    grants: new InMemoryRepository<PermissionGrant>(),
    userRoles: new InMemoryRepository<UserRole>(),
    overrides: new InMemoryRepository<PermissionOverride>(),
  };
  const organization = new OrganizationService(repos.companies, repos.employees);
  const auth = new AuthService(repos.users, 'test-secret');
  const roleManagement = new RoleManagementService(repos.roles, repos.grants, repos.userRoles);
  const rbac = new RbacEvaluator(repos);
  const onboarding = new OnboardingService(organization, auth, roleManagement);
  return { onboarding, rbac, repos };
}

test('signup creates a company, a founding employee, a user, and a token', async () => {
  const { onboarding } = freshOnboarding();
  const result = await onboarding.signupNewCompany({
    companyName: 'Acme Realty',
    fullName: 'Jordan Owner',
    email: 'jordan@acme.example',
    password: 'longenough1',
  });
  assert.ok(result.token);
  assert.equal(result.company.name, 'Acme Realty');
  assert.equal(result.employee.title, 'Owner');
  assert.equal(result.user.email, 'jordan@acme.example');
  assert.equal(result.role.name, 'Owner');
});

test('the signed-up user has full unrestricted access via the RBAC evaluator (not just the demo accounts)', async () => {
  const { onboarding, rbac } = freshOnboarding();
  const result = await onboarding.signupNewCompany({
    companyName: 'Acme Realty',
    fullName: 'Jordan Owner',
    email: 'jordan@acme.example',
    password: 'longenough1',
  });
  for (const resource of RESOURCES) {
    for (const action of ACTIONS) {
      const scope = await rbac.getListAccessScope(result.user.id, action, resource);
      assert.notEqual(scope.kind, 'none', `expected access to ${action}:${resource}`);
    }
  }
});

test('a second company signed up independently is fully isolated from the first', async () => {
  const { onboarding, rbac } = freshOnboarding();
  const first = await onboarding.signupNewCompany({
    companyName: 'Acme Realty',
    fullName: 'Jordan Owner',
    email: 'jordan@acme.example',
    password: 'longenough1',
  });
  const second = await onboarding.signupNewCompany({
    companyName: 'Second Realty',
    fullName: 'Sam Owner',
    email: 'sam@second.example',
    password: 'longenough1',
  });
  assert.notEqual(first.company.id, second.company.id);
  const crossTenantAccess = await rbac.can(second.user.id, 'view', 'lead', { companyId: first.company.id });
  assert.equal(crossTenantAccess, false);
});

test('signup rejects a weak password via the same validation AuthService.register enforces', async () => {
  const { onboarding } = freshOnboarding();
  await assert.rejects(() =>
    onboarding.signupNewCompany({ companyName: 'Acme Realty', fullName: 'Jordan Owner', email: 'jordan@acme.example', password: 'short' }),
  );
});
