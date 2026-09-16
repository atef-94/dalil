import type {
  AuditLogEntry,
  BrokerCompany,
  BrokerLead,
  Commission,
  CommissionRule,
  Company,
  Contract,
  Employee,
  Lead,
  Opportunity,
  Payment,
  PaymentPlanTemplate,
  PaymentScheduleLine,
  PermissionGrant,
  Receipt,
  Reservation,
  Role,
  Unit,
  UnitHold,
  User,
  UserRole,
} from './domain/types.js';
import type { DatabaseSync } from 'node:sqlite';
import { InMemoryRepository, type Repository } from './infra/repository.js';
import { SqliteRepository } from './infra/sqlite-repository.js';
import { HttpServer, type RequestContext } from './infra/http-server.js';
import { SlidingWindowRateLimiter } from './infra/rate-limiter.js';
import { paginate } from './infra/pagination.js';
import { AuditLog } from './infra/audit-log.js';
import { verifyToken } from './infra/security.js';
import { HttpError, TokenError, ValidationError, ForbiddenError, NotFoundError } from './infra/errors.js';
import { seedDemoData } from './infra/seed.js';

import { RbacEvaluator } from './modules/permissions/rbac.evaluator.js';
import { buildPermissionManifest } from './modules/permissions/manifest.builder.js';
import { filterByListScope, type ScopeOwnerKeys } from './modules/permissions/scope-filter.js';
import { OrganizationService } from './modules/organization/organization.service.js';
import { AuthService } from './modules/auth/auth.service.js';
import { CrmService } from './modules/crm/crm.service.js';
import { InventoryService } from './modules/inventory/inventory.service.js';
import { PaymentPlansService } from './modules/payment-plans/payment-plans.service.js';
import { SalesService } from './modules/sales/sales.service.js';
import { FinanceService } from './modules/finance/finance.service.js';
import { BrokersService } from './modules/brokers/brokers.service.js';
import { RoleManagementService } from './modules/permissions/role-management.service.js';
import { OnboardingService } from './modules/onboarding/onboarding.service.js';

export interface AppOptions {
  nodeEnv: string;
  tokenSecret: string;
  allowedOrigins: string[];
  staticDir?: string;
  seed?: boolean;
  /** Omit (or pass undefined) for in-memory storage — used by the test suite
   * for fast, isolated runs. Pass an open node:sqlite database for real,
   * on-disk persistence (what src/main.ts does at runtime). */
  db?: DatabaseSync;
  rateLimitWindowMs?: number;
  rateLimitMax?: number;
  authRateLimitMax?: number;
}

export interface Application {
  httpServer: HttpServer;
  repos: ReturnType<typeof buildRepos>;
  services: {
    rbac: RbacEvaluator;
    organization: OrganizationService;
    auth: AuthService;
    crm: CrmService;
    inventory: InventoryService;
    paymentPlans: PaymentPlansService;
    sales: SalesService;
    finance: FinanceService;
    brokers: BrokersService;
    auditLog: AuditLog;
    roleManagement: RoleManagementService;
    onboarding: OnboardingService;
  };
  seedResult?: Awaited<ReturnType<typeof seedDemoData>>;
}

function buildRepos(db?: DatabaseSync) {
  function repo<T extends { id: string }>(table: string): Repository<T> {
    return db ? new SqliteRepository<T>(db, table) : new InMemoryRepository<T>();
  }
  return {
    companies: repo<Company>('companies'),
    employees: repo<Employee>('employees'),
    users: repo<User>('users'),
    roles: repo<Role>('roles'),
    grants: repo<PermissionGrant>('permission_grants'),
    userRoles: repo<UserRole>('user_roles'),
    overrides: repo<import('./domain/types.js').PermissionOverride>('permission_overrides'),
    leads: repo<Lead>('leads'),
    units: repo<Unit>('units'),
    unitHolds: repo<UnitHold>('unit_holds'),
    reservations: repo<Reservation>('reservations'),
    templates: repo<PaymentPlanTemplate>('payment_plan_templates'),
    scheduleLines: repo<PaymentScheduleLine>('payment_schedule_lines'),
    opportunities: repo<Opportunity>('opportunities'),
    contracts: repo<Contract>('contracts'),
    payments: repo<Payment>('payments'),
    receipts: repo<Receipt>('receipts'),
    brokerCompanies: repo<BrokerCompany>('broker_companies'),
    brokerLeads: repo<BrokerLead>('broker_leads'),
    commissionRules: repo<CommissionRule>('commission_rules'),
    commissions: repo<Commission>('commissions'),
    auditEntries: repo<AuditLogEntry>('audit_entries'),
  };
}

interface Actor {
  userId: string;
  companyId: string;
  userType: string;
}

async function resolveActor(
  ctx: RequestContext,
  users: Repository<User>,
  tokenSecret: string,
  nodeEnv: string,
): Promise<Actor> {
  const authHeader = ctx.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length);
    try {
      const payload = verifyToken(token, tokenSecret);
      return { userId: payload.sub, companyId: payload.companyId, userType: payload.userType };
    } catch {
      throw new TokenError('invalid or expired token');
    }
  }

  // Demo bypass header — real login is not yet connected to real RBAC for
  // every account, so the manual test console authenticates this way. Never
  // honored in production: this is the fix for a previously-unfixed gap
  // where this bypass would have kept functioning under NODE_ENV=production.
  const demoUserHeader = ctx.headers['x-demo-user'];
  if (nodeEnv !== 'production' && typeof demoUserHeader === 'string' && demoUserHeader.length > 0) {
    const user = await users.findById(demoUserHeader);
    if (!user) throw new TokenError('unknown x-demo-user id');
    return { userId: user.id, companyId: user.companyId, userType: user.userType };
  }

  throw new TokenError('authentication required');
}

function parseJsonBody<T>(body: unknown): T {
  if (body === undefined || body === null || typeof body !== 'object') {
    throw new ValidationError('a JSON request body is required');
  }
  return body as T;
}

export async function assertProductionSafety(options: AppOptions): Promise<void> {
  if (options.nodeEnv === 'production') {
    if (!options.tokenSecret || options.tokenSecret === 'dev-secret') {
      throw new Error('refusing to boot in production without a real TOKEN_SECRET');
    }
    if (!options.db) {
      process.stderr.write('WARNING: no persistent database configured — data will not survive a restart.\n');
    } else if (!process.env.DATABASE_URL) {
      process.stderr.write('INFO: DATABASE_URL is not set — running on SQLite (see SQLITE_PATH), not yet migrated to Postgres.\n');
    }
  }
}

export async function buildApplication(options: AppOptions): Promise<Application> {
  await assertProductionSafety(options);

  const repos = buildRepos(options.db);

  const rbac = new RbacEvaluator({
    users: repos.users,
    employees: repos.employees,
    roles: repos.roles,
    grants: repos.grants,
    userRoles: repos.userRoles,
    overrides: repos.overrides,
  });
  const auditLog = new AuditLog(repos.auditEntries);
  const organization = new OrganizationService(repos.companies, repos.employees);
  const auth = new AuthService(repos.users, options.tokenSecret);
  const crm = new CrmService(repos.leads);
  const inventory = new InventoryService(repos.units, repos.unitHolds, repos.reservations);
  const paymentPlans = new PaymentPlansService(repos.templates, repos.scheduleLines);
  const sales = new SalesService(repos.opportunities, repos.contracts, inventory, paymentPlans);
  const finance = new FinanceService(repos.payments, repos.receipts, repos.scheduleLines);
  const brokers = new BrokersService(repos.brokerCompanies, repos.brokerLeads, repos.commissionRules, repos.commissions, crm);
  const roleManagement = new RoleManagementService(repos.roles, repos.grants, repos.userRoles);
  const onboarding = new OnboardingService(organization, auth, roleManagement);

  let seedResult: Awaited<ReturnType<typeof seedDemoData>> | undefined;
  if (options.seed !== false) {
    seedResult = await seedDemoData({
      companies: repos.companies,
      employees: repos.employees,
      users: repos.users,
      roles: repos.roles,
      grants: repos.grants,
      userRoles: repos.userRoles,
    });
  }

  const globalRateLimiter = new SlidingWindowRateLimiter(options.rateLimitWindowMs ?? 60_000, options.rateLimitMax ?? 300);
  const authRateLimiter = new SlidingWindowRateLimiter(options.rateLimitWindowMs ?? 60_000, options.authRateLimitMax ?? 20);
  const httpServer = new HttpServer({
    staticDir: options.staticDir,
    allowedOrigins: options.allowedOrigins,
    nodeEnv: options.nodeEnv,
    globalRateLimiter,
    authRateLimiter,
  });

  const actorOf = (ctx: RequestContext) => resolveActor(ctx, repos.users, options.tokenSecret, options.nodeEnv);

  const employeeScopeKeys = async (ownerUserId: string | undefined): Promise<ScopeOwnerKeys> => {
    if (!ownerUserId) return {};
    const user = await repos.users.findById(ownerUserId);
    if (!user?.employeeId) return { ownerUserId };
    const employee = await repos.employees.findById(user.employeeId);
    return {
      ownerUserId,
      departmentId: employee?.departmentId,
      branchId: employee?.branchId,
      managerEmployeeId: employee?.managerEmployeeId,
    };
  };

  // ---- Auth ----
  httpServer.post('/api/auth/register', async (ctx) => {
    const body = parseJsonBody<{ companyId: string; email: string; password: string; userType: string; locale: 'en' | 'ar' }>(ctx.body);
    if (!body.companyId?.trim()) throw new ValidationError('companyId is required');
    const user = await auth.register({
      companyId: body.companyId,
      email: body.email,
      password: body.password,
      userType: body.userType as User['userType'],
      locale: body.locale ?? 'en',
    });
    return { status: 201, body: { id: user.id, email: user.email, userType: user.userType } };
  });

  httpServer.post('/api/auth/login', async (ctx) => {
    const body = parseJsonBody<{ companyId: string; email: string; password: string }>(ctx.body);
    if (!body.companyId?.trim()) throw new ValidationError('companyId is required');
    const { token, user } = await auth.login({ companyId: body.companyId, email: body.email, password: body.password });
    return { status: 200, body: { token, userId: user.id, userType: user.userType, companyId: user.companyId } };
  });

  // Self-service tenant signup: creates the company, the founding employee,
  // the user account, and an unrestricted "Owner" role for that user in one
  // step — the real-users onboarding path (as opposed to the four fixed
  // demo accounts and low-level /api/auth/register + /api/organization/*).
  httpServer.post('/api/auth/signup', async (ctx) => {
    const body = parseJsonBody<{ companyName: string; fullName: string; email: string; password: string; locale?: 'en' | 'ar' }>(ctx.body);
    const result = await onboarding.signupNewCompany(body);
    return {
      status: 201,
      body: {
        token: result.token,
        userId: result.user.id,
        userType: result.user.userType,
        companyId: result.company.id,
        companyName: result.company.name,
      },
    };
  });

  // ---- Organization ----
  httpServer.post('/api/organization/companies', async (ctx) => {
    // Intentionally public: creating a company is tenant signup — there is
    // no user or role to gate it behind before the first company exists.
    const body = parseJsonBody<{ name: string }>(ctx.body);
    const company = await organization.createCompany({ name: body.name });
    return { status: 201, body: company };
  });

  httpServer.post('/api/organization/employees', async (ctx) => {
    const actor = await actorOf(ctx);
    // Fixed gap: this previously required only a valid token, never
    // checking create:employee. Any authenticated user could create
    // employee records regardless of grants.
    if (!(await rbac.can(actor.userId, 'create', 'employee'))) {
      throw new ForbiddenError('missing create:employee permission');
    }
    const body = parseJsonBody<{
      fullName: string;
      email: string;
      title: string;
      departmentId?: string;
      branchId?: string;
      teamId?: string;
      managerEmployeeId?: string;
    }>(ctx.body);
    const employee = await organization.createEmployee({ companyId: actor.companyId, ...body });
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'create', resource: 'employee', resourceId: employee.id });
    return { status: 201, body: employee };
  });

  httpServer.get('/api/organization/employees', async (ctx) => {
    const actor = await actorOf(ctx);
    const scope = await rbac.getListAccessScope(actor.userId, 'view', 'employee');
    if (scope.kind === 'none') return { status: 403, body: { error: 'missing view:employee permission' } };
    const all = await organization.listEmployees(actor.companyId);
    const filtered = await filterByListScope(all, scope, async (e) => ({
      departmentId: e.departmentId,
      branchId: e.branchId,
      managerEmployeeId: e.managerEmployeeId,
      // employees don't have a distinct "owner user" — the employee IS the
      // record's subject — so 'own' resolves against the employee's own user.
      ownerUserId: (await repos.users.findAll((u) => u.employeeId === e.id))[0]?.id,
    }));
    return { status: 200, body: paginate(filtered, ctx.query) };
  });

  httpServer.post('/api/organization/employees/:employeeId/reassign-manager', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'employee'))) {
      throw new ForbiddenError('missing edit:employee permission');
    }
    const body = parseJsonBody<{ newManagerEmployeeId: string }>(ctx.body);
    const employee = await organization.reassignManager(ctx.params.employeeId!, body.newManagerEmployeeId, actor.companyId);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'edit', resource: 'employee', resourceId: employee.id });
    return { status: 200, body: employee };
  });

  httpServer.post('/api/organization/employees/:employeeId/terminate', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'delete', 'employee'))) {
      throw new ForbiddenError('missing delete:employee permission');
    }
    const employee = await organization.terminate(ctx.params.employeeId!, actor.companyId);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'delete', resource: 'employee', resourceId: employee.id });
    return { status: 200, body: employee };
  });

  // ---- Permission Manifest ----
  httpServer.get('/api/me/manifest', async (ctx) => {
    const actor = await actorOf(ctx);
    const manifest = await buildPermissionManifest(rbac, actor.userId);
    return { status: 200, body: manifest };
  });

  httpServer.get('/api/me', async (ctx) => {
    const actor = await actorOf(ctx);
    const user = await repos.users.findById(actor.userId);
    if (!user) throw new NotFoundError('user not found');
    const employee = user.employeeId ? await repos.employees.findById(user.employeeId) : undefined;
    return {
      status: 200,
      body: { id: user.id, email: user.email, userType: user.userType, companyId: user.companyId, locale: user.locale, employee },
    };
  });

  // ---- Roles & permission management ----
  httpServer.post('/api/roles', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'role'))) {
      throw new ForbiddenError('missing create:role permission');
    }
    const body = parseJsonBody<{ name: string }>(ctx.body);
    const role = await roleManagement.createRole(actor.companyId, body.name);
    return { status: 201, body: role };
  });

  httpServer.get('/api/roles', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'role'))) {
      throw new ForbiddenError('missing view:role permission');
    }
    const roles = await roleManagement.listRoles(actor.companyId);
    return { status: 200, body: paginate(roles, ctx.query) };
  });

  httpServer.get('/api/roles/:roleId/grants', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'role'))) {
      throw new ForbiddenError('missing view:role permission');
    }
    const role = await roleManagement.getRole(ctx.params.roleId!);
    if (!role || role.companyId !== actor.companyId) throw new NotFoundError('role not found');
    const grants = await roleManagement.listGrants(role.id);
    return { status: 200, body: grants };
  });

  httpServer.post('/api/roles/:roleId/grants', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'role'))) {
      throw new ForbiddenError('missing edit:role permission');
    }
    const body = parseJsonBody<{ action: PermissionGrant['action']; resource: PermissionGrant['resource']; scope: PermissionGrant['scope']; sensitivity?: PermissionGrant['sensitivity'] }>(ctx.body);
    const grant = await roleManagement.addGrant(actor.companyId, ctx.params.roleId!, body);
    return { status: 201, body: grant };
  });

  httpServer.delete('/api/roles/:roleId/grants/:grantId', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'role'))) {
      throw new ForbiddenError('missing edit:role permission');
    }
    await roleManagement.removeGrant(actor.companyId, ctx.params.roleId!, ctx.params.grantId!);
    return { status: 204 };
  });

  // ---- Users & role assignment ----
  httpServer.get('/api/users', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'employee'))) {
      throw new ForbiddenError('missing view:employee permission');
    }
    const users = await repos.users.findAll((u) => u.companyId === actor.companyId);
    const mapped = users.map((u) => ({ id: u.id, email: u.email, userType: u.userType, employeeId: u.employeeId }));
    return { status: 200, body: paginate(mapped, ctx.query) };
  });

  httpServer.get('/api/users/:userId/roles', async (ctx) => {
    const actor = await actorOf(ctx);
    const targetUser = await repos.users.findById(ctx.params.userId!);
    if (!targetUser || targetUser.companyId !== actor.companyId) throw new NotFoundError('user not found');
    if (actor.userId !== targetUser.id && !(await rbac.can(actor.userId, 'view', 'role'))) {
      throw new ForbiddenError('missing view:role permission');
    }
    const userRoles = await roleManagement.listUserRoles(targetUser.id);
    return { status: 200, body: userRoles };
  });

  httpServer.post('/api/users/:userId/roles', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'assign', 'role'))) {
      throw new ForbiddenError('missing assign:role permission');
    }
    const targetUser = await repos.users.findById(ctx.params.userId!);
    if (!targetUser || targetUser.companyId !== actor.companyId) throw new NotFoundError('user not found');
    const body = parseJsonBody<{ roleId: string; expiresAt?: string }>(ctx.body);
    const role = await roleManagement.getRole(body.roleId);
    if (!role || role.companyId !== actor.companyId) throw new NotFoundError('role not found');
    const userRole = await roleManagement.assignRole(targetUser.id, body.roleId, body.expiresAt);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'assign', resource: 'role', resourceId: role.id, metadata: { targetUserId: targetUser.id } });
    return { status: 201, body: userRole };
  });

  httpServer.delete('/api/users/:userId/roles/:userRoleId', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'assign', 'role'))) {
      throw new ForbiddenError('missing assign:role permission');
    }
    const targetUser = await repos.users.findById(ctx.params.userId!);
    if (!targetUser || targetUser.companyId !== actor.companyId) throw new NotFoundError('user not found');
    await roleManagement.revokeUserRole(targetUser.id, ctx.params.userRoleId!);
    return { status: 204 };
  });

  // ---- Payment Plan Templates ----
  httpServer.post('/api/payment-plan-templates', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'payment_plan_template'))) {
      throw new ForbiddenError('missing create:payment_plan_template permission');
    }
    const body = parseJsonBody<Parameters<PaymentPlansService['createTemplate']>[0]>(ctx.body);
    const template = await paymentPlans.createTemplate({ ...body, companyId: actor.companyId });
    return { status: 201, body: template };
  });

  httpServer.get('/api/payment-plan-templates', async (ctx) => {
    const actor = await actorOf(ctx);
    const scope = await rbac.getListAccessScope(actor.userId, 'view', 'payment_plan_template');
    if (scope.kind === 'none') return { status: 403, body: { error: 'missing view:payment_plan_template permission' } };
    const templates = await paymentPlans.listTemplates(actor.companyId);
    return { status: 200, body: paginate(templates, ctx.query) };
  });

  httpServer.post('/api/contracts/:contractId/payment-schedule/preview', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'payment_plan_template'))) {
      throw new ForbiddenError('missing view:payment_plan_template permission');
    }
    const body = parseJsonBody<{ templateId: string; totalPrice: number; discountPercent?: number; escalationPercentPerYear?: number }>(ctx.body);
    const lines = await paymentPlans.previewSchedule(body.templateId, actor.companyId, body.totalPrice, body.discountPercent, body.escalationPercentPerYear);
    return { status: 200, body: lines };
  });

  httpServer.post('/api/contracts/:contractId/payment-schedule/generate', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'payment_plan_template'))) {
      throw new ForbiddenError('missing create:payment_plan_template permission');
    }
    const body = parseJsonBody<{ templateId: string; totalPrice: number; discountPercent?: number; escalationPercentPerYear?: number }>(ctx.body);
    const lines = await paymentPlans.generateForContract(
      ctx.params.contractId!,
      actor.companyId,
      body.templateId,
      body.totalPrice,
      body.discountPercent,
      body.escalationPercentPerYear,
    );
    return { status: 201, body: lines };
  });

  httpServer.get('/api/contracts/:contractId/payment-schedule', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'payment_schedule'))) {
      throw new ForbiddenError('missing view:payment_schedule permission');
    }
    const lines = await paymentPlans.getScheduleForContract(ctx.params.contractId!, actor.companyId);
    return { status: 200, body: lines };
  });

  // ---- Inventory ----
  httpServer.post('/api/inventory/units', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'unit'))) {
      throw new ForbiddenError('missing create:unit permission');
    }
    const body = parseJsonBody<{ projectId: string; code: string; unitType: string; areaSqm: number; listPrice: number }>(ctx.body);
    const unit = await inventory.createUnit({ companyId: actor.companyId, ...body });
    return { status: 201, body: unit };
  });

  httpServer.get('/api/inventory/units', async (ctx) => {
    const actor = await actorOf(ctx);
    const scope = await rbac.getListAccessScope(actor.userId, 'view', 'unit');
    if (scope.kind === 'none') return { status: 403, body: { error: 'missing view:unit permission' } };
    const projectId = ctx.query.get('projectId') ?? undefined;
    const units = await inventory.listUnits(actor.companyId, projectId);
    return { status: 200, body: paginate(units, ctx.query) };
  });

  httpServer.post('/api/inventory/units/:unitId/hold', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'unit'))) {
      throw new ForbiddenError('missing edit:unit permission');
    }
    const hold = await inventory.holdUnit(ctx.params.unitId!, actor.userId, actor.companyId);
    return { status: 201, body: hold };
  });

  httpServer.post('/api/inventory/units/:unitId/reserve', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'unit'))) {
      throw new ForbiddenError('missing edit:unit permission');
    }
    const body = parseJsonBody<{ clientId: string; opportunityId?: string }>(ctx.body);
    const reservation = await inventory.reserveUnit(ctx.params.unitId!, body.clientId, actor.companyId, body.opportunityId);
    return { status: 201, body: reservation };
  });

  // ---- CRM ----
  httpServer.post('/api/crm/leads', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'lead'))) {
      throw new ForbiddenError('missing create:lead permission');
    }
    const body = parseJsonBody<{ fullName: string; phone: string; email?: string; sourceId?: string }>(ctx.body);
    const lead = await crm.createLead({ companyId: actor.companyId, ownerEmployeeUserId: actor.userId, ...body });
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'create', resource: 'lead', resourceId: lead.id });
    return { status: 201, body: lead };
  });

  httpServer.get('/api/crm/leads', async (ctx) => {
    const actor = await actorOf(ctx);
    const scope = await rbac.getListAccessScope(actor.userId, 'view', 'lead');
    if (scope.kind === 'none') return { status: 403, body: { error: 'missing view:lead permission' } };
    const leads = await crm.listForScope(scope, (lead) => employeeScopeKeys(lead.ownerEmployeeUserId));
    return { status: 200, body: paginate(leads, ctx.query) };
  });

  httpServer.patch('/api/crm/leads/:leadId/status', async (ctx) => {
    const actor = await actorOf(ctx);
    const lead = await crm.getLead(ctx.params.leadId!);
    if (!lead || lead.companyId !== actor.companyId) throw new NotFoundError('lead not found');
    const ownerKeys = await employeeScopeKeys(lead.ownerEmployeeUserId);
    const allowed = await rbac.can(actor.userId, 'edit', 'lead', {
      companyId: lead.companyId,
      ownerUserId: lead.ownerEmployeeUserId,
      departmentId: ownerKeys.departmentId,
      branchId: ownerKeys.branchId,
      managerEmployeeId: ownerKeys.managerEmployeeId,
    });
    if (!allowed) throw new ForbiddenError('missing edit:lead permission for this lead');
    const body = parseJsonBody<{ status: Lead['status']; lostReason?: string }>(ctx.body);
    const updated = await crm.updateStatus(ctx.params.leadId!, body.status, body.lostReason);
    return { status: 200, body: updated };
  });

  // ---- Sales ----
  httpServer.post('/api/sales/opportunities', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'opportunity'))) {
      throw new ForbiddenError('missing create:opportunity permission');
    }
    const body = parseJsonBody<{ leadId: string }>(ctx.body);
    const opportunity = await sales.createOpportunity({ companyId: actor.companyId, leadId: body.leadId, ownerEmployeeUserId: actor.userId });
    return { status: 201, body: opportunity };
  });

  httpServer.get('/api/sales/opportunities', async (ctx) => {
    const actor = await actorOf(ctx);
    const scope = await rbac.getListAccessScope(actor.userId, 'view', 'opportunity');
    if (scope.kind === 'none') return { status: 403, body: { error: 'missing view:opportunity permission' } };
    const all = await sales.listOpportunities(actor.companyId);
    const filtered = await filterByListScope(all, scope, (o) => employeeScopeKeys(o.ownerEmployeeUserId));
    return { status: 200, body: paginate(filtered, ctx.query) };
  });

  httpServer.post('/api/sales/opportunities/:opportunityId/reserve-unit', async (ctx) => {
    const actor = await actorOf(ctx);
    const opportunity = await sales.getOpportunity(ctx.params.opportunityId!);
    if (!opportunity || opportunity.companyId !== actor.companyId) throw new NotFoundError('opportunity not found');
    const ownerKeys = await employeeScopeKeys(opportunity.ownerEmployeeUserId);
    const allowed = await rbac.can(actor.userId, 'create', 'opportunity', {
      companyId: opportunity.companyId,
      ownerUserId: opportunity.ownerEmployeeUserId,
      departmentId: ownerKeys.departmentId,
      branchId: ownerKeys.branchId,
      managerEmployeeId: ownerKeys.managerEmployeeId,
    });
    if (!allowed) throw new ForbiddenError('missing create:opportunity permission for this opportunity');
    const body = parseJsonBody<{ unitId: string }>(ctx.body);
    const reservation = await sales.reserveUnitForOpportunity(ctx.params.opportunityId!, body.unitId, actor.companyId);
    return { status: 201, body: reservation };
  });

  httpServer.get('/api/sales/contracts', async (ctx) => {
    const actor = await actorOf(ctx);
    const scope = await rbac.getListAccessScope(actor.userId, 'view', 'contract');
    if (scope.kind === 'none') return { status: 403, body: { error: 'missing view:contract permission' } };
    const all = await sales.listContracts(actor.companyId);
    const filtered = await filterByListScope(all, scope, (c) => employeeScopeKeys(c.creditedEmployeeUserId));
    return { status: 200, body: paginate(filtered, ctx.query) };
  });

  httpServer.get('/api/sales/contracts/:contractId', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'contract'))) {
      throw new ForbiddenError('missing view:contract permission');
    }
    const contract = await sales.getContract(ctx.params.contractId!);
    if (!contract || contract.companyId !== actor.companyId) throw new NotFoundError('contract not found');
    return { status: 200, body: contract };
  });

  httpServer.post('/api/sales/contracts', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'contract'))) {
      throw new ForbiddenError('missing create:contract permission');
    }
    const body = parseJsonBody<{
      reservationId: string;
      paymentPlanTemplateId: string;
      totalPrice: number;
      discountPercent?: number;
      escalationPercentPerYear?: number;
    }>(ctx.body);
    const contract = await sales.signContract({
      companyId: actor.companyId,
      reservationId: body.reservationId,
      creditedEmployeeUserId: actor.userId,
      paymentPlanTemplateId: body.paymentPlanTemplateId,
      totalPrice: body.totalPrice,
      discountPercent: body.discountPercent,
      escalationPercentPerYear: body.escalationPercentPerYear,
    });
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'create', resource: 'contract', resourceId: contract.id });
    return { status: 201, body: contract };
  });

  httpServer.post('/api/sales/contracts/:contractId/cancel', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'contract'))) {
      throw new ForbiddenError('missing edit:contract permission');
    }
    const contract = await sales.cancelContract(ctx.params.contractId!, actor.companyId);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'edit', resource: 'contract', resourceId: contract.id, metadata: { cancelled: true } });
    return { status: 200, body: contract };
  });

  // ---- Finance ----
  httpServer.post('/api/finance/payments', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'payment_schedule'))) {
      throw new ForbiddenError('missing edit:payment_schedule permission');
    }
    const body = parseJsonBody<{ contractId: string; paymentScheduleLineId: string; amount: number; method: Payment['method'] }>(ctx.body);
    const result = await finance.recordPayment({ companyId: actor.companyId, recordedByUserId: actor.userId, ...body });
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'edit', resource: 'payment_schedule', resourceId: result.line.id, metadata: { amount: body.amount } });
    return { status: 201, body: result };
  });

  httpServer.get('/api/finance/contracts/:contractId/balance', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'payment_schedule'))) {
      throw new ForbiddenError('missing view:payment_schedule permission');
    }
    const balance = await finance.getBalance(ctx.params.contractId!, actor.companyId);
    return { status: 200, body: balance };
  });

  httpServer.post('/api/finance/sweep-overdue', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'payment_schedule'))) {
      throw new ForbiddenError('missing edit:payment_schedule permission');
    }
    const count = await finance.sweepOverdue();
    return { status: 200, body: { swept: count } };
  });

  // ---- Brokers ----
  httpServer.get('/api/brokers/companies', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'broker_company'))) {
      throw new ForbiddenError('missing view:broker_company permission');
    }
    const companies = await brokers.listBrokerCompanies(actor.companyId);
    return { status: 200, body: paginate(companies, ctx.query) };
  });

  httpServer.post('/api/brokers/companies', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'broker_company'))) {
      throw new ForbiddenError('missing create:broker_company permission');
    }
    const body = parseJsonBody<{ name: string }>(ctx.body);
    const brokerCompany = await brokers.registerBrokerCompany({ companyId: actor.companyId, name: body.name });
    return { status: 201, body: brokerCompany };
  });

  httpServer.post('/api/brokers/companies/:brokerCompanyId/approve', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'approve', 'broker_company'))) {
      throw new ForbiddenError('missing approve:broker_company permission');
    }
    const brokerCompany = await brokers.approveBrokerCompany(ctx.params.brokerCompanyId!, actor.companyId);
    return { status: 200, body: brokerCompany };
  });

  httpServer.post('/api/brokers/companies/:brokerCompanyId/suspend', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'broker_company'))) {
      throw new ForbiddenError('missing edit:broker_company permission');
    }
    const brokerCompany = await brokers.suspendBrokerCompany(ctx.params.brokerCompanyId!, actor.companyId);
    return { status: 200, body: brokerCompany };
  });

  httpServer.post('/api/brokers/leads', async (ctx) => {
    const actor = await actorOf(ctx);
    if (actor.userType !== 'broker_user') {
      throw new ForbiddenError('only broker_user accounts may submit broker leads');
    }
    const user = await repos.users.findById(actor.userId);
    if (!user?.brokerCompanyId) throw new ForbiddenError('this account is not linked to a broker company');
    const body = parseJsonBody<{ fullName: string; phone: string; email?: string }>(ctx.body);
    const brokerLead = await brokers.submitBrokerLead({
      companyId: actor.companyId,
      brokerCompanyId: user.brokerCompanyId,
      submittedByUserId: actor.userId,
      ...body,
    });
    return { status: 201, body: brokerLead };
  });

  httpServer.get('/api/brokers/leads', async (ctx) => {
    const actor = await actorOf(ctx);
    const all = await brokers.listBrokerLeads(actor.companyId);
    // A broker_user only ever sees their own broker company's submissions
    // (mirrors the broker hard-wall in the RBAC evaluator); internal staff
    // reviewing the quarantine queue need view:broker_company instead.
    if (actor.userType === 'broker_user') {
      const user = await repos.users.findById(actor.userId);
      const own = all.filter((bl) => bl.brokerCompanyId === user?.brokerCompanyId);
      return { status: 200, body: paginate(own, ctx.query) };
    }
    if (!(await rbac.can(actor.userId, 'view', 'broker_company'))) {
      throw new ForbiddenError('missing view:broker_company permission');
    }
    return { status: 200, body: paginate(all, ctx.query) };
  });

  httpServer.post('/api/brokers/leads/:brokerLeadId/approve', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'lead'))) {
      throw new ForbiddenError('missing create:lead permission');
    }
    const brokerLead = await brokers.approveBrokerLead(ctx.params.brokerLeadId!, actor.companyId, actor.userId);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'approve', resource: 'lead', resourceId: brokerLead.leadId ?? brokerLead.id });
    return { status: 200, body: brokerLead };
  });

  // ---- Broker commissions ----
  httpServer.get('/api/brokers/commission-rules', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'broker_company'))) {
      throw new ForbiddenError('missing view:broker_company permission');
    }
    const rules = await brokers.listCommissionRules(actor.companyId);
    return { status: 200, body: rules };
  });

  httpServer.post('/api/brokers/commission-rules', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'broker_company'))) {
      throw new ForbiddenError('missing edit:broker_company permission');
    }
    const body = parseJsonBody<{ ratePercent: number; brokerCompanyId?: string }>(ctx.body);
    const rule = await brokers.setCommissionRule(actor.companyId, body.ratePercent, body.brokerCompanyId);
    return { status: 201, body: rule };
  });

  httpServer.get('/api/brokers/commissions', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'broker_company'))) {
      throw new ForbiddenError('missing view:broker_company permission');
    }
    const brokerCompanyId = ctx.query.get('brokerCompanyId') ?? undefined;
    const commissions = await brokers.listCommissions(actor.companyId, brokerCompanyId);
    return { status: 200, body: paginate(commissions, ctx.query) };
  });

  httpServer.post('/api/brokers/companies/:brokerCompanyId/commissions', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'broker_company'))) {
      throw new ForbiddenError('missing edit:broker_company permission');
    }
    const body = parseJsonBody<{ contractId: string; contractAmount: number }>(ctx.body);
    const commission = await brokers.recordCommissionForContract(actor.companyId, ctx.params.brokerCompanyId!, body.contractId, body.contractAmount);
    return { status: 201, body: commission };
  });

  httpServer.post('/api/brokers/commissions/:commissionId/approve', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'approve', 'broker_company'))) {
      throw new ForbiddenError('missing approve:broker_company permission');
    }
    const commission = await brokers.approveCommission(ctx.params.commissionId!, actor.companyId);
    return { status: 200, body: commission };
  });

  // ---- Audit ----
  httpServer.get('/api/audit-log', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'audit_log'))) {
      throw new ForbiddenError('missing view:audit_log permission');
    }
    const entries = await auditLog.listForCompany(actor.companyId);
    return { status: 200, body: paginate(entries, ctx.query) };
  });

  // ---- Health / dev-only ----
  httpServer.get('/health', async () => ({ status: 200, body: { status: 'ok' } }));

  httpServer.get('/api/seed-info', async () => {
    if (options.nodeEnv === 'production') {
      throw new HttpError(404, 'not found');
    }
    return { status: 200, body: seedResult ?? { seeded: false } };
  });

  return {
    httpServer,
    repos,
    services: { rbac, organization, auth, crm, inventory, paymentPlans, sales, finance, brokers, auditLog, roleManagement, onboarding },
    seedResult,
  };
}
