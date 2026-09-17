import { randomUUID } from 'node:crypto';
import type {
  ActionName,
  Company,
  Employee,
  PermissionGrant,
  ResourceName,
  Role,
  ScopeName,
  User,
  UserRole,
} from '../domain/types.js';
import type { Repository } from './repository.js';
import { hashPassword } from './security.js';

export interface SeedRepos {
  companies: Repository<Company>;
  employees: Repository<Employee>;
  users: Repository<User>;
  roles: Repository<Role>;
  grants: Repository<PermissionGrant>;
  userRoles: Repository<UserRole>;
}

export interface SeedResult {
  companyId: string;
  demoUsers: { label: string; userId: string; email: string }[];
}

const DEMO_LABELS: Record<string, string> = {
  'ceo@demo.local': 'CEO',
  'sales.manager@demo.local': 'Sales Manager',
  'sales.agent@demo.local': 'Sales Agent',
  'finance@demo.local': 'Finance',
};

const ALL_RESOURCES: ResourceName[] = [
  'employee',
  'lead',
  'opportunity',
  'unit',
  'payment_plan_template',
  'payment_schedule',
  'contract',
  'broker_company',
  'audit_log',
  'role',
  'branch',
  'department',
  'project',
  'leave_request',
  'maintenance_ticket',
  'legal_document',
  'vendor',
  'purchase_order',
  'campaign',
  'message',
  'analytics',
  'portal_access',
  'workflow',
  'workflow_run',
  'approval',
  'secret',
  'task',
  'ai_action',
  'integration_connection',
  'sales_commission',
  'forecast',
];

/**
 * Four demo accounts (CEO / Sales Manager / Sales Agent / Finance) used by
 * the manual `x-demo-user` dev header. Real self-service tenants and their
 * own roles are created through POST /api/auth/signup instead (see
 * modules/organization + modules/permissions role-management routes in
 * app.ts) — this seed only ever provisions the fixed demo company.
 *
 * Idempotent: with persistent storage, main.ts calls this on every boot, so
 * it skips seeding if the demo company already exists on disk.
 */
export async function seedDemoData(repos: SeedRepos): Promise<SeedResult> {
  const companyId = 'company-demo';

  const existing = await repos.companies.findById(companyId);
  if (existing) {
    const demoUsers = await repos.users.findAll((u) => u.companyId === companyId);
    return {
      companyId,
      demoUsers: demoUsers
        .map((u) => ({ label: DEMO_LABELS[u.email] ?? u.email, userId: u.id, email: u.email }))
        .sort((a, b) => a.email.localeCompare(b.email)),
    };
  }

  await repos.companies.save({ id: companyId, companyId, name: 'Demo Real Estate Co', createdAt: new Date().toISOString() });

  const ceoEmployee: Employee = {
    id: 'emp-ceo',
    companyId,
    fullName: 'Nadia CEO',
    email: 'ceo@demo.local',
    title: 'CEO',
    status: 'active',
    createdAt: new Date().toISOString(),
  };
  const salesManagerEmployee: Employee = {
    id: 'emp-sales-manager',
    companyId,
    fullName: 'Omar Sales Manager',
    email: 'sales.manager@demo.local',
    title: 'Sales Manager',
    departmentId: 'dept-sales',
    managerEmployeeId: ceoEmployee.id,
    status: 'active',
    createdAt: new Date().toISOString(),
  };
  const salesAgentEmployee: Employee = {
    id: 'emp-sales-agent',
    companyId,
    fullName: 'Laila Sales Agent',
    email: 'sales.agent@demo.local',
    title: 'Sales Agent',
    departmentId: 'dept-sales',
    managerEmployeeId: salesManagerEmployee.id,
    status: 'active',
    createdAt: new Date().toISOString(),
  };
  const financeEmployee: Employee = {
    id: 'emp-finance',
    companyId,
    fullName: 'Youssef Finance',
    email: 'finance@demo.local',
    title: 'Finance Officer',
    departmentId: 'dept-finance',
    managerEmployeeId: ceoEmployee.id,
    status: 'active',
    createdAt: new Date().toISOString(),
  };

  for (const employee of [ceoEmployee, salesManagerEmployee, salesAgentEmployee, financeEmployee]) {
    await repos.employees.save(employee);
  }

  const demoPasswordHash = hashPassword('demo-password-not-for-production');

  const ceoUser: User = {
    id: 'user-ceo',
    companyId,
    email: ceoEmployee.email,
    passwordHash: demoPasswordHash,
    userType: 'employee_user',
    employeeId: ceoEmployee.id,
    locale: 'en',
    failedLoginCount: 0,
    createdAt: new Date().toISOString(),
  };
  const salesManagerUser: User = {
    id: 'user-sales-manager',
    companyId,
    email: salesManagerEmployee.email,
    passwordHash: demoPasswordHash,
    userType: 'employee_user',
    employeeId: salesManagerEmployee.id,
    locale: 'en',
    failedLoginCount: 0,
    createdAt: new Date().toISOString(),
  };
  const salesAgentUser: User = {
    id: 'user-sales-agent',
    companyId,
    email: salesAgentEmployee.email,
    passwordHash: demoPasswordHash,
    userType: 'employee_user',
    employeeId: salesAgentEmployee.id,
    locale: 'en',
    failedLoginCount: 0,
    createdAt: new Date().toISOString(),
  };
  const financeUser: User = {
    id: 'user-finance',
    companyId,
    email: financeEmployee.email,
    passwordHash: demoPasswordHash,
    userType: 'employee_user',
    employeeId: financeEmployee.id,
    locale: 'en',
    failedLoginCount: 0,
    createdAt: new Date().toISOString(),
  };

  for (const user of [ceoUser, salesManagerUser, salesAgentUser, financeUser]) {
    await repos.users.save(user);
  }

  const ceoRole: Role = { id: 'role-ceo', companyId, name: 'CEO', isSystem: true };
  const salesManagerRole: Role = { id: 'role-sales-manager', companyId, name: 'Sales Manager', isSystem: true };
  const salesAgentRole: Role = { id: 'role-sales-agent', companyId, name: 'Sales Agent', isSystem: true };
  const financeRole: Role = { id: 'role-finance', companyId, name: 'Finance', isSystem: true };
  for (const role of [ceoRole, salesManagerRole, salesAgentRole, financeRole]) {
    await repos.roles.save(role);
  }

  const addGrant = async (roleId: string, action: ActionName, resource: ResourceName, scope: ScopeName) => {
    const grant: PermissionGrant = { id: randomUUID(), roleId, action, resource, scope, sensitivity: 'standard' };
    await repos.grants.save(grant);
  };

  // CEO: full company-wide visibility and control.
  for (const resource of ALL_RESOURCES) {
    for (const action of ['view', 'create', 'edit', 'approve', 'delete'] as ActionName[]) {
      await addGrant(ceoRole.id, action, resource, 'company');
    }
  }
  await addGrant(ceoRole.id, 'assign', 'role', 'company');

  // Sales Manager: department-scoped visibility over CRM/Sales/Inventory,
  // plus the ability to see their department's roster.
  for (const resource of ['lead', 'opportunity'] as ResourceName[]) {
    await addGrant(salesManagerRole.id, 'view', resource, 'department');
    await addGrant(salesManagerRole.id, 'edit', resource, 'department');
    await addGrant(salesManagerRole.id, 'create', resource, 'department');
  }
  await addGrant(salesManagerRole.id, 'view', 'employee', 'department');
  await addGrant(salesManagerRole.id, 'view', 'unit', 'company');
  await addGrant(salesManagerRole.id, 'edit', 'unit', 'company');
  await addGrant(salesManagerRole.id, 'view', 'payment_plan_template', 'company');
  await addGrant(salesManagerRole.id, 'create', 'contract', 'department');
  await addGrant(salesManagerRole.id, 'view', 'contract', 'department');
  // Override commission lines land on the manager themselves (see
  // SalesCommissionService), so "own" is enough to see their own override
  // earnings; "department" additionally lets them see their team's base
  // commissions the way they already see the team's leads/contracts.
  await addGrant(salesManagerRole.id, 'view', 'sales_commission', 'department');
  // Lets a sales manager decide approvals raised by their own team
  // (discount overrides, contract amendments, refunds — every action
  // type the Universal Approval Engine gates).
  await addGrant(salesManagerRole.id, 'view', 'approval', 'company');
  await addGrant(salesManagerRole.id, 'approve', 'approval', 'company');
  // Sales/portfolio forecasting and scenario simulation.
  await addGrant(salesManagerRole.id, 'view', 'forecast', 'company');

  // Sales Agent: own-scoped CRM/Sales, company-wide unit visibility (units
  // are not individually owned), can create/edit their own unit holds.
  await addGrant(salesAgentRole.id, 'create', 'lead', 'own');
  await addGrant(salesAgentRole.id, 'view', 'lead', 'own');
  await addGrant(salesAgentRole.id, 'edit', 'lead', 'own');
  await addGrant(salesAgentRole.id, 'create', 'opportunity', 'own');
  await addGrant(salesAgentRole.id, 'view', 'opportunity', 'own');
  await addGrant(salesAgentRole.id, 'view', 'unit', 'company');
  await addGrant(salesAgentRole.id, 'edit', 'unit', 'company');
  await addGrant(salesAgentRole.id, 'view', 'payment_plan_template', 'company');
  await addGrant(salesAgentRole.id, 'create', 'contract', 'own');
  await addGrant(salesAgentRole.id, 'view', 'contract', 'own');
  // Lets an agent cancel or request an amendment on their own contract
  // (amendments always go through the Universal Approval Engine — this
  // only lets them raise the request, not apply it unilaterally).
  await addGrant(salesAgentRole.id, 'edit', 'contract', 'own');
  await addGrant(salesAgentRole.id, 'view', 'sales_commission', 'own');

  // Finance: company-wide financial visibility and payment recording.
  await addGrant(financeRole.id, 'view', 'payment_schedule', 'company');
  await addGrant(financeRole.id, 'edit', 'payment_schedule', 'company');
  await addGrant(financeRole.id, 'view', 'contract', 'company');
  await addGrant(financeRole.id, 'view', 'payment_plan_template', 'company');
  await addGrant(financeRole.id, 'view', 'audit_log', 'company');
  await addGrant(financeRole.id, 'view', 'sales_commission', 'company');
  await addGrant(financeRole.id, 'edit', 'sales_commission', 'company');
  await addGrant(financeRole.id, 'approve', 'sales_commission', 'company');
  // Finance can request refunds (POST) and see their status, and can
  // see the forecast/cash-flow picture, but deciding a refund approval
  // is left to Sales Manager/CEO — separation of duties: the requester
  // doesn't also approve their own reversal of collected money.
  await addGrant(financeRole.id, 'view', 'approval', 'company');
  await addGrant(financeRole.id, 'view', 'forecast', 'company');

  const linkRole = async (userId: string, roleId: string) => {
    const userRole: UserRole = { id: randomUUID(), userId, roleId };
    await repos.userRoles.save(userRole);
  };
  await linkRole(ceoUser.id, ceoRole.id);
  await linkRole(salesManagerUser.id, salesManagerRole.id);
  await linkRole(salesAgentUser.id, salesAgentRole.id);
  await linkRole(financeUser.id, financeRole.id);

  return {
    companyId,
    demoUsers: [
      { label: 'CEO', userId: ceoUser.id, email: ceoUser.email },
      { label: 'Sales Manager', userId: salesManagerUser.id, email: salesManagerUser.email },
      { label: 'Sales Agent', userId: salesAgentUser.id, email: salesAgentUser.email },
      { label: 'Finance', userId: financeUser.id, email: financeUser.email },
    ],
  };
}
