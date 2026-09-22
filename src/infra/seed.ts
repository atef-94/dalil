import { randomUUID } from 'node:crypto';
import type {
  ActionName,
  Company,
  CrmStage,
  Employee,
  Lead,
  PermissionGrant,
  ResourceName,
  Role,
  ScopeName,
  User,
  UserRole,
} from '../domain/types.js';
import type { Repository } from './repository.js';
import { hashPassword } from './security.js';
import { CrmStageService } from '../modules/crm/crm-stage.service.js';
import { CrmService } from '../modules/crm/crm.service.js';

export interface SeedRepos {
  companies: Repository<Company>;
  employees: Repository<Employee>;
  users: Repository<User>;
  roles: Repository<Role>;
  grants: Repository<PermissionGrant>;
  userRoles: Repository<UserRole>;
  crmStages: Repository<CrmStage>;
  leads: Repository<Lead>;
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
  'crm_stage',
  'opportunity',
  'unit',
  'quotation',
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
  'ai_memory',
  'integration_connection',
  'sales_commission',
  'forecast',
  'signature_envelope',
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

  // Runs on every boot, existing company or not — seedDefaultStages() is a
  // no-op once a company has stages, and migrateLegacyStatuses() is a no-op
  // once every lead has a stageId, so this is cheap and safe to repeat.
  const crmStages = new CrmStageService(repos.crmStages);
  await crmStages.seedDefaultStages(companyId);
  await new CrmService(repos.leads, crmStages).migrateLegacyStatuses(companyId);

  const existing = await repos.companies.findById(companyId);
  if (existing) {
    // A company seeded before a given resource/grant existed never
    // retroactively gets it — only the fresh-creation path below runs the
    // full grant setup. This reconciles just the grants added alongside
    // the CRM stage engine (crm_stage/task/message) so an
    // already-running deployment's demo company keeps working, without
    // touching any grant a real tenant may have since customized.
    await ensureCrmPhase1GrantsExist(repos, companyId);
    await ensureQuotationGrantsExist(repos, companyId);
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
  // Stage *configuration* (adding/renaming/reordering CRM stages) stays
  // admin-only per the CRM permission table — a Sales Manager can view the
  // pipeline and edit a stage's non-structural fields, but not create or
  // archive one; stage *movement* for their own leads is already covered
  // by their existing edit:lead grant above.
  await addGrant(salesManagerRole.id, 'view', 'crm_stage', 'department');
  await addGrant(salesManagerRole.id, 'edit', 'crm_stage', 'department');
  await addGrant(salesManagerRole.id, 'view', 'employee', 'department');
  await addGrant(salesManagerRole.id, 'view', 'unit', 'company');
  await addGrant(salesManagerRole.id, 'edit', 'unit', 'company');
  await addGrant(salesManagerRole.id, 'view', 'payment_plan_template', 'company');
  // Quotation Generator: department-wide, matching lead/opportunity scope.
  await addGrant(salesManagerRole.id, 'view', 'quotation', 'department');
  await addGrant(salesManagerRole.id, 'create', 'quotation', 'department');
  await addGrant(salesManagerRole.id, 'edit', 'quotation', 'department');
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
  // The Leads page's "Ask AI" button (and the AI page itself) call
  // create:ai_action/view:ai_action — without these, that button is shown
  // to every sales manager but always 403s.
  await addGrant(salesManagerRole.id, 'view', 'ai_action', 'department');
  await addGrant(salesManagerRole.id, 'create', 'ai_action', 'department');
  // AI Memory: a manager can inspect and correct (invalidate) what the AI
  // layer has recorded about their department's leads/customers.
  await addGrant(salesManagerRole.id, 'view', 'ai_memory', 'department');
  await addGrant(salesManagerRole.id, 'create', 'ai_memory', 'department');
  await addGrant(salesManagerRole.id, 'edit', 'ai_memory', 'department');
  // Scheduling a follow-up from a lead's CRM detail view creates a Task —
  // without these, that button is shown but always 403s.
  await addGrant(salesManagerRole.id, 'view', 'task', 'department');
  await addGrant(salesManagerRole.id, 'create', 'task', 'department');
  await addGrant(salesManagerRole.id, 'edit', 'task', 'department');
  // Logging a call/WhatsApp/note against a lead from its CRM detail view
  // creates a Message — without these, that composer is shown but 403s.
  await addGrant(salesManagerRole.id, 'view', 'message', 'department');
  await addGrant(salesManagerRole.id, 'create', 'message', 'department');

  // Sales Agent: own-scoped CRM/Sales, company-wide unit visibility (units
  // are not individually owned), can create/edit their own unit holds.
  await addGrant(salesAgentRole.id, 'create', 'lead', 'own');
  await addGrant(salesAgentRole.id, 'view', 'lead', 'own');
  await addGrant(salesAgentRole.id, 'edit', 'lead', 'own');
  // Read-only: an agent needs to see the pipeline's stage names to move
  // their own leads through it, but stage configuration stays out of reach.
  await addGrant(salesAgentRole.id, 'view', 'crm_stage', 'own');
  await addGrant(salesAgentRole.id, 'create', 'opportunity', 'own');
  await addGrant(salesAgentRole.id, 'view', 'opportunity', 'own');
  await addGrant(salesAgentRole.id, 'view', 'unit', 'company');
  await addGrant(salesAgentRole.id, 'edit', 'unit', 'company');
  await addGrant(salesAgentRole.id, 'view', 'payment_plan_template', 'company');
  // Quotation Generator: own-scoped, matching lead/opportunity scope.
  await addGrant(salesAgentRole.id, 'view', 'quotation', 'own');
  await addGrant(salesAgentRole.id, 'create', 'quotation', 'own');
  await addGrant(salesAgentRole.id, 'edit', 'quotation', 'own');
  await addGrant(salesAgentRole.id, 'create', 'contract', 'own');
  await addGrant(salesAgentRole.id, 'view', 'contract', 'own');
  // Lets an agent cancel or request an amendment on their own contract
  // (amendments always go through the Universal Approval Engine — this
  // only lets them raise the request, not apply it unilaterally).
  await addGrant(salesAgentRole.id, 'edit', 'contract', 'own');
  await addGrant(salesAgentRole.id, 'view', 'sales_commission', 'own');
  // Same "Ask AI" button fix as the sales manager above — an agent is the
  // one actually clicking it on their own leads day to day.
  await addGrant(salesAgentRole.id, 'view', 'ai_action', 'own');
  await addGrant(salesAgentRole.id, 'create', 'ai_action', 'own');
  await addGrant(salesAgentRole.id, 'view', 'ai_memory', 'own');
  await addGrant(salesAgentRole.id, 'create', 'ai_memory', 'own');
  // Scheduling a follow-up from a lead's CRM detail view creates a Task —
  // without these, that button is shown but always 403s.
  await addGrant(salesAgentRole.id, 'view', 'task', 'own');
  await addGrant(salesAgentRole.id, 'create', 'task', 'own');
  await addGrant(salesAgentRole.id, 'edit', 'task', 'own');
  // Logging a call/WhatsApp/note against a lead from its CRM detail view
  // creates a Message — without these, that composer is shown but 403s.
  await addGrant(salesAgentRole.id, 'view', 'message', 'own');
  await addGrant(salesAgentRole.id, 'create', 'message', 'own');

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

/**
 * The demo company's role grants are otherwise only ever set up once (see
 * the fresh-creation path above) — a deployment that already had a
 * persisted "company-demo" before crm_stage/task/message grants existed
 * would never retroactively get them, since PermissionGrant rows are
 * additive and nothing re-runs on an existing company. This reconciles
 * just the grants the CRM restructuring added, idempotently (skips any
 * that already exist), so an already-running deployment's demo roles keep
 * working after this upgrade without touching anything a real tenant may
 * have since customized.
 */
async function ensureCrmPhase1GrantsExist(repos: SeedRepos, companyId: string): Promise<void> {
  const roles = await repos.roles.findAll((r) => r.companyId === companyId);
  const ceoRole = roles.find((r) => r.name === 'CEO');
  const salesManagerRole = roles.find((r) => r.name === 'Sales Manager');
  const salesAgentRole = roles.find((r) => r.name === 'Sales Agent');

  const ensureGrant = async (roleId: string, action: ActionName, resource: ResourceName, scope: ScopeName) => {
    const matches = await repos.grants.findAll((g) => g.roleId === roleId && g.action === action && g.resource === resource);
    if (matches.length === 0) {
      await repos.grants.save({ id: randomUUID(), roleId, action, resource, scope, sensitivity: 'standard' });
    }
  };

  if (ceoRole) {
    for (const action of ['view', 'create', 'edit', 'approve', 'delete'] as ActionName[]) {
      await ensureGrant(ceoRole.id, action, 'crm_stage', 'company');
    }
  }
  if (salesManagerRole) {
    await ensureGrant(salesManagerRole.id, 'view', 'crm_stage', 'department');
    await ensureGrant(salesManagerRole.id, 'edit', 'crm_stage', 'department');
    await ensureGrant(salesManagerRole.id, 'view', 'task', 'department');
    await ensureGrant(salesManagerRole.id, 'create', 'task', 'department');
    await ensureGrant(salesManagerRole.id, 'edit', 'task', 'department');
    await ensureGrant(salesManagerRole.id, 'view', 'message', 'department');
    await ensureGrant(salesManagerRole.id, 'create', 'message', 'department');
  }
  if (salesAgentRole) {
    await ensureGrant(salesAgentRole.id, 'view', 'crm_stage', 'own');
    await ensureGrant(salesAgentRole.id, 'view', 'task', 'own');
    await ensureGrant(salesAgentRole.id, 'create', 'task', 'own');
    await ensureGrant(salesAgentRole.id, 'edit', 'task', 'own');
    await ensureGrant(salesAgentRole.id, 'view', 'message', 'own');
    await ensureGrant(salesAgentRole.id, 'create', 'message', 'own');
  }
}

/**
 * Same reconciliation pattern as ensureCrmPhase1GrantsExist, for the
 * Quotation Generator's 'quotation' resource added afterward — an
 * already-running deployment's demo roles never retroactively get a new
 * ALL_RESOURCES entry via the fresh-creation loop, so this grants CEO full
 * CRUD and mirrors Sales Manager/Agent's existing lead/opportunity scope.
 */
async function ensureQuotationGrantsExist(repos: SeedRepos, companyId: string): Promise<void> {
  const roles = await repos.roles.findAll((r) => r.companyId === companyId);
  const ceoRole = roles.find((r) => r.name === 'CEO');
  const salesManagerRole = roles.find((r) => r.name === 'Sales Manager');
  const salesAgentRole = roles.find((r) => r.name === 'Sales Agent');

  const ensureGrant = async (roleId: string, action: ActionName, resource: ResourceName, scope: ScopeName) => {
    const matches = await repos.grants.findAll((g) => g.roleId === roleId && g.action === action && g.resource === resource);
    if (matches.length === 0) {
      await repos.grants.save({ id: randomUUID(), roleId, action, resource, scope, sensitivity: 'standard' });
    }
  };

  if (ceoRole) {
    for (const action of ['view', 'create', 'edit', 'approve', 'delete'] as ActionName[]) {
      await ensureGrant(ceoRole.id, action, 'quotation', 'company');
    }
  }
  if (salesManagerRole) {
    await ensureGrant(salesManagerRole.id, 'view', 'quotation', 'department');
    await ensureGrant(salesManagerRole.id, 'create', 'quotation', 'department');
    await ensureGrant(salesManagerRole.id, 'edit', 'quotation', 'department');
  }
  if (salesAgentRole) {
    await ensureGrant(salesAgentRole.id, 'view', 'quotation', 'own');
    await ensureGrant(salesAgentRole.id, 'create', 'quotation', 'own');
    await ensureGrant(salesAgentRole.id, 'edit', 'quotation', 'own');
  }
}
