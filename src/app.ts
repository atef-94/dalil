import type {
  AiActionRequest,
  AiPolicy,
  ApprovalRequest,
  AuditLogEntry,
  Branch,
  BrokerCompany,
  BrokerLead,
  Campaign,
  Commission,
  CommissionRule,
  Company,
  Contract,
  Customer,
  Department,
  Employee,
  Lead,
  LeaveRequest,
  LegalDocument,
  MaintenanceTicket,
  Message,
  Opportunity,
  Payment,
  PaymentPlanTemplate,
  PaymentScheduleLine,
  PermissionGrant,
  Project,
  PurchaseOrder,
  Receipt,
  Reservation,
  Role,
  Secret,
  Task,
  Unit,
  UnitHold,
  User,
  UserRole,
  Vendor,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStepRun,
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
import { EventBus, type DomainEvent } from './infra/event-bus.js';

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
import { HrService } from './modules/hr/hr.service.js';
import { OperationsService } from './modules/operations/operations.service.js';
import { LegalService } from './modules/legal/legal.service.js';
import { PurchasingService } from './modules/purchasing/purchasing.service.js';
import { MarketingService } from './modules/marketing/marketing.service.js';
import { CommunicationService } from './modules/communication/communication.service.js';
import { AnalyticsService } from './modules/analytics/analytics.service.js';
import { LeadScoringService } from './modules/ai/lead-scoring.service.js';
import { PortalService } from './modules/portal/portal.service.js';
import { TaskService } from './modules/tasks/task.service.js';
import { AutomationService, type WorkflowStepInput } from './modules/automation/automation.service.js';
import { AiAgentService } from './modules/ai/ai-agent.service.js';

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
  /** Key used to encrypt automation webhook/API credentials at rest (see
   * infra/security.ts encryptSecret). Falls back to tokenSecret when unset —
   * fine for dev, but production should set SECRET_STORE_KEY separately so
   * rotating one secret never invalidates the other. */
  secretStoreKey?: string;
  /** Base delay (ms) before a retried automation step attempt, doubled each
   * attempt up to a 30s cap. Defaults to 0 (instant retry) for fast tests;
   * main.ts passes a real value at runtime. */
  automationRetryBaseDelayMs?: number;
  /** Max workflow runs the Automation Engine executes concurrently,
   * process-wide. Defaults to 10. */
  automationMaxConcurrentRuns?: number;
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
    hr: HrService;
    operations: OperationsService;
    legal: LegalService;
    purchasing: PurchasingService;
    marketing: MarketingService;
    communication: CommunicationService;
    analytics: AnalyticsService;
    leadScoring: LeadScoringService;
    portal: PortalService;
    tasks: TaskService;
    automation: AutomationService;
    eventBus: EventBus;
    aiAgent: AiAgentService;
    /** Sweeps overdue payment schedule lines AND emits one
     * `payment.overdue_swept` domain event per swept line — use this
     * instead of `finance.sweepOverdue()` wherever the sweep should also
     * feed the Automation Engine (the HTTP route and main.ts's tick both
     * do). `finance.sweepOverdue()` itself stays event-free for existing
     * callers/tests that only care about the count. */
    sweepOverdueAndEmit: () => Promise<number>;
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
    branches: repo<Branch>('branches'),
    departments: repo<Department>('departments'),
    projects: repo<Project>('projects'),
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
    leaveRequests: repo<LeaveRequest>('leave_requests'),
    maintenanceTickets: repo<MaintenanceTicket>('maintenance_tickets'),
    legalDocuments: repo<LegalDocument>('legal_documents'),
    vendors: repo<Vendor>('vendors'),
    purchaseOrders: repo<PurchaseOrder>('purchase_orders'),
    campaigns: repo<Campaign>('campaigns'),
    messages: repo<Message>('messages'),
    customers: repo<Customer>('customers'),
    tasks: repo<Task>('tasks'),
    workflows: repo<WorkflowDefinition>('workflows'),
    workflowRuns: repo<WorkflowRun>('workflow_runs'),
    workflowStepRuns: repo<WorkflowStepRun>('workflow_step_runs'),
    approvals: repo<ApprovalRequest>('approval_requests'),
    secrets: repo<Secret>('secrets'),
    aiActionRequests: repo<AiActionRequest>('ai_action_requests'),
    aiPolicies: repo<AiPolicy>('ai_policies'),
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
  const organization = new OrganizationService(repos.companies, repos.employees, repos.branches, repos.departments);
  const auth = new AuthService(repos.users, options.tokenSecret);
  const crm = new CrmService(repos.leads);
  const inventory = new InventoryService(repos.units, repos.unitHolds, repos.reservations, repos.projects);
  const paymentPlans = new PaymentPlansService(repos.templates, repos.scheduleLines);
  const sales = new SalesService(repos.opportunities, repos.contracts, inventory, paymentPlans);
  const finance = new FinanceService(repos.payments, repos.receipts, repos.scheduleLines);
  const brokers = new BrokersService(repos.brokerCompanies, repos.brokerLeads, repos.commissionRules, repos.commissions, crm);
  const roleManagement = new RoleManagementService(repos.roles, repos.grants, repos.userRoles);
  const onboarding = new OnboardingService(organization, auth, roleManagement);
  const hr = new HrService(repos.leaveRequests, repos.employees);
  const operations = new OperationsService(repos.maintenanceTickets, repos.units);
  const legal = new LegalService(repos.legalDocuments, repos.contracts);
  const purchasing = new PurchasingService(repos.vendors, repos.purchaseOrders);
  const marketing = new MarketingService(repos.campaigns, repos.leads);
  const communication = new CommunicationService(repos.messages);
  const analytics = new AnalyticsService(repos.leads, repos.opportunities, repos.contracts, repos.scheduleLines, repos.units, repos.commissions);
  const leadScoring = new LeadScoringService(repos.leads);
  const portal = new PortalService(repos.customers, repos.leads, repos.contracts, repos.scheduleLines, auth);
  const tasks = new TaskService(repos.tasks);
  const eventBus = new EventBus();
  const automation = new AutomationService(
    { workflows: repos.workflows, runs: repos.workflowRuns, stepRuns: repos.workflowStepRuns, approvals: repos.approvals, secrets: repos.secrets },
    rbac,
    tasks,
    communication,
    crm,
    marketing,
    auditLog,
    options.secretStoreKey ?? options.tokenSecret,
    undefined,
    options.automationRetryBaseDelayMs ?? 0,
    options.automationMaxConcurrentRuns ?? 10,
  );
  // The engine is the sole subscriber today: every domain event emitted
  // from a route handler below is offered to every active event-triggered
  // workflow. EventBus.emit() never throws — a broken workflow can never
  // take down the request that triggered it.
  eventBus.subscribe(async (event: DomainEvent) => {
    await automation.handleEvent(event);
  });
  const aiAgent = new AiAgentService(
    { actionRequests: repos.aiActionRequests, policies: repos.aiPolicies, approvals: repos.approvals },
    rbac,
    automation,
    crm,
    leadScoring,
    auditLog,
  );

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

  // Fires every event-triggered workflow synchronously (so an automation's
  // side effects, e.g. a created task, are visible by the time the request
  // that triggered them returns — this system has no async job queue or
  // websocket push, so that's the only way the UI ever sees them promptly).
  // EventBus.emit() already can't throw (each handler is try/caught
  // internally), but this wrapper is a second, defense-in-depth guarantee
  // that a broken workflow can never break the API response that triggered
  // it.
  const emitEvent = async (event: DomainEvent): Promise<void> => {
    try {
      await eventBus.emit(event);
    } catch (err) {
      process.stderr.write(`automation event emission failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  };

  // Shared by the manual sweep route below and main.ts's periodic tick, so
  // both paths emit the same `payment.overdue_swept` event per line instead
  // of duplicating the sweep-then-emit logic.
  const sweepOverdueAndEmit = async (): Promise<number> => {
    const swept = await finance.sweepOverdueDetailed();
    for (const line of swept) {
      await emitEvent({
        companyId: line.companyId,
        type: 'payment.overdue_swept',
        payload: { ...line },
        dedupeKey: `payment.overdue_swept:${line.id}`,
      });
    }
    return swept.length;
  };

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
    await emitEvent({ companyId: actor.companyId, type: 'employee.created', payload: { ...employee }, actorUserId: actor.userId, dedupeKey: `employee.created:${employee.id}` });
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
    const target = await organization.getEmployee(ctx.params.employeeId!);
    if (!target || target.companyId !== actor.companyId) throw new NotFoundError('employee not found');
    const targetOwnerUserId = (await repos.users.findAll((u) => u.employeeId === target.id))[0]?.id;
    const allowed = await rbac.can(actor.userId, 'edit', 'employee', {
      companyId: target.companyId,
      ownerUserId: targetOwnerUserId,
      departmentId: target.departmentId,
      branchId: target.branchId,
      managerEmployeeId: target.managerEmployeeId,
    });
    if (!allowed) throw new ForbiddenError('missing edit:employee permission for this employee');
    const body = parseJsonBody<{ newManagerEmployeeId: string }>(ctx.body);
    const employee = await organization.reassignManager(ctx.params.employeeId!, body.newManagerEmployeeId, actor.companyId);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'edit', resource: 'employee', resourceId: employee.id });
    return { status: 200, body: employee };
  });

  httpServer.post('/api/organization/employees/:employeeId/terminate', async (ctx) => {
    const actor = await actorOf(ctx);
    const target = await organization.getEmployee(ctx.params.employeeId!);
    if (!target || target.companyId !== actor.companyId) throw new NotFoundError('employee not found');
    const targetOwnerUserId = (await repos.users.findAll((u) => u.employeeId === target.id))[0]?.id;
    const allowed = await rbac.can(actor.userId, 'delete', 'employee', {
      companyId: target.companyId,
      ownerUserId: targetOwnerUserId,
      departmentId: target.departmentId,
      branchId: target.branchId,
      managerEmployeeId: target.managerEmployeeId,
    });
    if (!allowed) throw new ForbiddenError('missing delete:employee permission for this employee');
    const employee = await organization.terminate(ctx.params.employeeId!, actor.companyId);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'delete', resource: 'employee', resourceId: employee.id });
    return { status: 200, body: employee };
  });

  // ---- Branches & Departments ----
  httpServer.post('/api/organization/branches', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'branch'))) {
      throw new ForbiddenError('missing create:branch permission');
    }
    const body = parseJsonBody<{ name: string; address?: string }>(ctx.body);
    const branch = await organization.createBranch({ companyId: actor.companyId, ...body });
    return { status: 201, body: branch };
  });

  httpServer.get('/api/organization/branches', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'branch'))) {
      throw new ForbiddenError('missing view:branch permission');
    }
    const branches = await organization.listBranches(actor.companyId);
    return { status: 200, body: paginate(branches, ctx.query) };
  });

  httpServer.post('/api/organization/departments', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'department'))) {
      throw new ForbiddenError('missing create:department permission');
    }
    const body = parseJsonBody<{ name: string; branchId?: string }>(ctx.body);
    const department = await organization.createDepartment({ companyId: actor.companyId, ...body });
    return { status: 201, body: department };
  });

  httpServer.get('/api/organization/departments', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'department'))) {
      throw new ForbiddenError('missing view:department permission');
    }
    const departments = await organization.listDepartments(actor.companyId);
    return { status: 200, body: paginate(departments, ctx.query) };
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
    const contract = await sales.getContract(ctx.params.contractId!);
    if (!contract || contract.companyId !== actor.companyId) throw new NotFoundError('contract not found');
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
  httpServer.post('/api/inventory/projects', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'project'))) {
      throw new ForbiddenError('missing create:project permission');
    }
    const body = parseJsonBody<{ name: string; location?: string }>(ctx.body);
    const project = await inventory.createProject({ companyId: actor.companyId, ...body });
    return { status: 201, body: project };
  });

  httpServer.get('/api/inventory/projects', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'project'))) {
      throw new ForbiddenError('missing view:project permission');
    }
    const projects = await inventory.listProjects(actor.companyId);
    return { status: 200, body: paginate(projects, ctx.query) };
  });

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
    await emitEvent({ companyId: actor.companyId, type: 'lead.created', payload: { ...lead }, actorUserId: actor.userId, dedupeKey: `lead.created:${lead.id}` });
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
    await emitEvent({
      companyId: actor.companyId,
      type: 'lead.status_changed',
      payload: { ...updated },
      actorUserId: actor.userId,
      dedupeKey: `lead.status_changed:${updated.id}:${updated.status}`,
    });
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
    await emitEvent({
      companyId: actor.companyId,
      type: 'opportunity.created',
      payload: { ...opportunity },
      actorUserId: actor.userId,
      dedupeKey: `opportunity.created:${opportunity.id}`,
    });
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
    await emitEvent({ companyId: actor.companyId, type: 'contract.signed', payload: { ...contract }, actorUserId: actor.userId, dedupeKey: `contract.signed:${contract.id}` });
    return { status: 201, body: contract };
  });

  httpServer.post('/api/sales/contracts/:contractId/cancel', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'contract'))) {
      throw new ForbiddenError('missing edit:contract permission');
    }
    const contract = await sales.cancelContract(ctx.params.contractId!, actor.companyId);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'edit', resource: 'contract', resourceId: contract.id, metadata: { cancelled: true } });
    await emitEvent({ companyId: actor.companyId, type: 'contract.cancelled', payload: { ...contract }, actorUserId: actor.userId, dedupeKey: `contract.cancelled:${contract.id}` });
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
    await emitEvent({
      companyId: actor.companyId,
      type: 'payment.recorded',
      payload: { ...result },
      actorUserId: actor.userId,
      dedupeKey: `payment.recorded:${result.payment.id}`,
    });
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
    const count = await sweepOverdueAndEmit();
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
    await emitEvent({
      companyId: actor.companyId,
      type: 'broker_lead.submitted',
      payload: { ...brokerLead },
      actorUserId: actor.userId,
      dedupeKey: `broker_lead.submitted:${brokerLead.id}`,
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

  // ---- HR: leave requests ----
  httpServer.post('/api/hr/leave-requests', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'leave_request'))) {
      throw new ForbiddenError('missing create:leave_request permission');
    }
    const body = parseJsonBody<{ employeeId: string; type: LeaveRequest['type']; startDate: string; endDate: string; reason?: string }>(ctx.body);
    const leaveRequest = await hr.requestLeave({ companyId: actor.companyId, ...body });
    await emitEvent({
      companyId: actor.companyId,
      type: 'leave_request.created',
      payload: { ...leaveRequest },
      actorUserId: actor.userId,
      dedupeKey: `leave_request.created:${leaveRequest.id}`,
    });
    return { status: 201, body: leaveRequest };
  });

  httpServer.get('/api/hr/leave-requests', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'leave_request'))) {
      throw new ForbiddenError('missing view:leave_request permission');
    }
    const requests = await hr.listForCompany(actor.companyId);
    return { status: 200, body: paginate(requests, ctx.query) };
  });

  httpServer.get('/api/hr/my-leave-requests', async (ctx) => {
    const actor = await actorOf(ctx);
    const user = await repos.users.findById(actor.userId);
    if (!user?.employeeId) return { status: 200, body: paginate([], ctx.query) };
    const requests = await hr.listForEmployee(user.employeeId, actor.companyId);
    return { status: 200, body: paginate(requests, ctx.query) };
  });

  httpServer.post('/api/hr/leave-requests/:leaveRequestId/approve', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'approve', 'leave_request'))) {
      throw new ForbiddenError('missing approve:leave_request permission');
    }
    const leaveRequest = await hr.approveLeave(ctx.params.leaveRequestId!, actor.companyId, actor.userId);
    await emitEvent({
      companyId: actor.companyId,
      type: 'leave_request.decided',
      payload: { ...leaveRequest },
      actorUserId: actor.userId,
      dedupeKey: `leave_request.decided:${leaveRequest.id}`,
    });
    return { status: 200, body: leaveRequest };
  });

  httpServer.post('/api/hr/leave-requests/:leaveRequestId/reject', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'approve', 'leave_request'))) {
      throw new ForbiddenError('missing approve:leave_request permission');
    }
    const leaveRequest = await hr.rejectLeave(ctx.params.leaveRequestId!, actor.companyId, actor.userId);
    await emitEvent({
      companyId: actor.companyId,
      type: 'leave_request.decided',
      payload: { ...leaveRequest },
      actorUserId: actor.userId,
      dedupeKey: `leave_request.decided:${leaveRequest.id}`,
    });
    return { status: 200, body: leaveRequest };
  });

  httpServer.post('/api/hr/leave-requests/:leaveRequestId/cancel', async (ctx) => {
    const actor = await actorOf(ctx);
    const user = await repos.users.findById(actor.userId);
    if (!user?.employeeId) throw new ForbiddenError('this account is not linked to an employee record');
    const leaveRequest = await hr.cancelLeave(ctx.params.leaveRequestId!, actor.companyId, user.employeeId);
    return { status: 200, body: leaveRequest };
  });

  // ---- Operations: maintenance tickets ----
  httpServer.post('/api/operations/tickets', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'maintenance_ticket'))) {
      throw new ForbiddenError('missing create:maintenance_ticket permission');
    }
    const body = parseJsonBody<{ unitId: string; title: string; description?: string; priority: MaintenanceTicket['priority'] }>(ctx.body);
    const ticket = await operations.createTicket({ companyId: actor.companyId, reportedByUserId: actor.userId, ...body });
    await emitEvent({
      companyId: actor.companyId,
      type: 'maintenance_ticket.created',
      payload: { ...ticket },
      actorUserId: actor.userId,
      dedupeKey: `maintenance_ticket.created:${ticket.id}`,
    });
    return { status: 201, body: ticket };
  });

  httpServer.get('/api/operations/tickets', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'maintenance_ticket'))) {
      throw new ForbiddenError('missing view:maintenance_ticket permission');
    }
    const unitId = ctx.query.get('unitId');
    const tickets = unitId ? await operations.listForUnit(unitId, actor.companyId) : await operations.listForCompany(actor.companyId);
    return { status: 200, body: paginate(tickets, ctx.query) };
  });

  httpServer.post('/api/operations/tickets/:ticketId/assign', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'maintenance_ticket'))) {
      throw new ForbiddenError('missing edit:maintenance_ticket permission');
    }
    const body = parseJsonBody<{ assignedToUserId: string }>(ctx.body);
    const ticket = await operations.assignTicket(ctx.params.ticketId!, actor.companyId, body.assignedToUserId);
    return { status: 200, body: ticket };
  });

  httpServer.post('/api/operations/tickets/:ticketId/status', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'maintenance_ticket'))) {
      throw new ForbiddenError('missing edit:maintenance_ticket permission');
    }
    const body = parseJsonBody<{ status: MaintenanceTicket['status'] }>(ctx.body);
    const ticket = await operations.updateStatus(ctx.params.ticketId!, actor.companyId, body.status);
    await emitEvent({
      companyId: actor.companyId,
      type: 'maintenance_ticket.status_changed',
      payload: { ...ticket },
      actorUserId: actor.userId,
      dedupeKey: `maintenance_ticket.status_changed:${ticket.id}:${ticket.status}`,
    });
    return { status: 200, body: ticket };
  });

  // ---- Legal: contract documents ----
  httpServer.post('/api/legal/documents', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'legal_document'))) {
      throw new ForbiddenError('missing create:legal_document permission');
    }
    const body = parseJsonBody<{ contractId: string; type: LegalDocument['type']; name: string; notes?: string }>(ctx.body);
    const document = await legal.addDocument({ companyId: actor.companyId, uploadedByUserId: actor.userId, ...body });
    return { status: 201, body: document };
  });

  httpServer.get('/api/legal/documents', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'legal_document'))) {
      throw new ForbiddenError('missing view:legal_document permission');
    }
    const contractId = ctx.query.get('contractId');
    const documents = contractId
      ? await legal.listForContract(contractId, actor.companyId)
      : await legal.listForCompany(actor.companyId);
    return { status: 200, body: paginate(documents, ctx.query) };
  });

  httpServer.post('/api/legal/documents/:documentId/received', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'legal_document'))) {
      throw new ForbiddenError('missing edit:legal_document permission');
    }
    const document = await legal.markReceived(ctx.params.documentId!, actor.companyId);
    await emitEvent({
      companyId: actor.companyId,
      type: 'legal_document.status_changed',
      payload: { ...document },
      actorUserId: actor.userId,
      dedupeKey: `legal_document.status_changed:${document.id}:${document.status}`,
    });
    return { status: 200, body: document };
  });

  httpServer.post('/api/legal/documents/:documentId/verify', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'approve', 'legal_document'))) {
      throw new ForbiddenError('missing approve:legal_document permission');
    }
    const document = await legal.verifyDocument(ctx.params.documentId!, actor.companyId);
    await emitEvent({
      companyId: actor.companyId,
      type: 'legal_document.status_changed',
      payload: { ...document },
      actorUserId: actor.userId,
      dedupeKey: `legal_document.status_changed:${document.id}:${document.status}`,
    });
    return { status: 200, body: document };
  });

  httpServer.post('/api/legal/documents/:documentId/reject', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'legal_document'))) {
      throw new ForbiddenError('missing edit:legal_document permission');
    }
    const body = parseJsonBody<{ notes?: string }>(ctx.body);
    const document = await legal.rejectDocument(ctx.params.documentId!, actor.companyId, body.notes);
    await emitEvent({
      companyId: actor.companyId,
      type: 'legal_document.status_changed',
      payload: { ...document },
      actorUserId: actor.userId,
      dedupeKey: `legal_document.status_changed:${document.id}:${document.status}`,
    });
    return { status: 200, body: document };
  });

  // ---- Purchasing: vendors & purchase orders ----
  httpServer.post('/api/purchasing/vendors', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'vendor'))) {
      throw new ForbiddenError('missing create:vendor permission');
    }
    const body = parseJsonBody<{ name: string; category: string; contactPhone?: string; contactEmail?: string }>(ctx.body);
    const vendor = await purchasing.registerVendor({ companyId: actor.companyId, ...body });
    return { status: 201, body: vendor };
  });

  httpServer.get('/api/purchasing/vendors', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'vendor'))) {
      throw new ForbiddenError('missing view:vendor permission');
    }
    const vendors = await purchasing.listVendors(actor.companyId);
    return { status: 200, body: paginate(vendors, ctx.query) };
  });

  httpServer.post('/api/purchasing/vendors/:vendorId/deactivate', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'vendor'))) {
      throw new ForbiddenError('missing edit:vendor permission');
    }
    const vendor = await purchasing.deactivateVendor(ctx.params.vendorId!, actor.companyId);
    return { status: 200, body: vendor };
  });

  httpServer.post('/api/purchasing/purchase-orders', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'purchase_order'))) {
      throw new ForbiddenError('missing create:purchase_order permission');
    }
    const body = parseJsonBody<{ vendorId: string; projectId?: string; description: string; amount: number }>(ctx.body);
    const order = await purchasing.createPurchaseOrder({ companyId: actor.companyId, createdByUserId: actor.userId, ...body });
    await emitEvent({
      companyId: actor.companyId,
      type: 'purchase_order.created',
      payload: { ...order },
      actorUserId: actor.userId,
      dedupeKey: `purchase_order.created:${order.id}`,
    });
    return { status: 201, body: order };
  });

  httpServer.get('/api/purchasing/purchase-orders', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'purchase_order'))) {
      throw new ForbiddenError('missing view:purchase_order permission');
    }
    const orders = await purchasing.listPurchaseOrders(actor.companyId);
    return { status: 200, body: paginate(orders, ctx.query) };
  });

  httpServer.post('/api/purchasing/purchase-orders/:orderId/approve', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'approve', 'purchase_order'))) {
      throw new ForbiddenError('missing approve:purchase_order permission');
    }
    const order = await purchasing.approvePurchaseOrder(ctx.params.orderId!, actor.companyId);
    await emitEvent({
      companyId: actor.companyId,
      type: 'purchase_order.status_changed',
      payload: { ...order },
      actorUserId: actor.userId,
      dedupeKey: `purchase_order.status_changed:${order.id}:${order.status}`,
    });
    return { status: 200, body: order };
  });

  httpServer.post('/api/purchasing/purchase-orders/:orderId/fulfill', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'purchase_order'))) {
      throw new ForbiddenError('missing edit:purchase_order permission');
    }
    const order = await purchasing.fulfillPurchaseOrder(ctx.params.orderId!, actor.companyId);
    await emitEvent({
      companyId: actor.companyId,
      type: 'purchase_order.status_changed',
      payload: { ...order },
      actorUserId: actor.userId,
      dedupeKey: `purchase_order.status_changed:${order.id}:${order.status}`,
    });
    return { status: 200, body: order };
  });

  httpServer.post('/api/purchasing/purchase-orders/:orderId/cancel', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'purchase_order'))) {
      throw new ForbiddenError('missing edit:purchase_order permission');
    }
    const order = await purchasing.cancelPurchaseOrder(ctx.params.orderId!, actor.companyId);
    await emitEvent({
      companyId: actor.companyId,
      type: 'purchase_order.status_changed',
      payload: { ...order },
      actorUserId: actor.userId,
      dedupeKey: `purchase_order.status_changed:${order.id}:${order.status}`,
    });
    return { status: 200, body: order };
  });

  // ---- Marketing: campaigns ----
  httpServer.post('/api/marketing/campaigns', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'campaign'))) {
      throw new ForbiddenError('missing create:campaign permission');
    }
    const body = parseJsonBody<{ name: string; channel: Campaign['channel']; budget: number; startDate: string; endDate?: string }>(ctx.body);
    const campaign = await marketing.createCampaign({ companyId: actor.companyId, ...body });
    return { status: 201, body: campaign };
  });

  httpServer.get('/api/marketing/campaigns', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'campaign'))) {
      throw new ForbiddenError('missing view:campaign permission');
    }
    const campaigns = await marketing.listCampaigns(actor.companyId);
    return { status: 200, body: paginate(campaigns, ctx.query) };
  });

  httpServer.post('/api/marketing/campaigns/:campaignId/status', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'campaign'))) {
      throw new ForbiddenError('missing edit:campaign permission');
    }
    const body = parseJsonBody<{ status: Campaign['status'] }>(ctx.body);
    const campaign = await marketing.updateStatus(ctx.params.campaignId!, actor.companyId, body.status);
    await emitEvent({
      companyId: actor.companyId,
      type: 'campaign.status_changed',
      payload: { ...campaign },
      actorUserId: actor.userId,
      dedupeKey: `campaign.status_changed:${campaign.id}:${campaign.status}`,
    });
    return { status: 200, body: campaign };
  });

  httpServer.get('/api/marketing/campaigns/:campaignId/performance', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'campaign'))) {
      throw new ForbiddenError('missing view:campaign permission');
    }
    const performance = await marketing.campaignPerformance(ctx.params.campaignId!, actor.companyId);
    return { status: 200, body: performance };
  });

  // ---- Communication: internal messages ----
  httpServer.post('/api/communication/messages', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'message'))) {
      throw new ForbiddenError('missing create:message permission');
    }
    const body = parseJsonBody<{
      toUserId?: string;
      subject: string;
      body: string;
      channel?: Message['channel'];
      relatedResource?: Message['relatedResource'];
      relatedResourceId?: string;
    }>(ctx.body);
    const message = await communication.sendMessage({ companyId: actor.companyId, fromUserId: actor.userId, ...body });
    return { status: 201, body: message };
  });

  httpServer.get('/api/communication/my-messages', async (ctx) => {
    const actor = await actorOf(ctx);
    const messages = await communication.listForUser(actor.userId, actor.companyId);
    return { status: 200, body: paginate(messages, ctx.query) };
  });

  httpServer.get('/api/communication/messages', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'message'))) {
      throw new ForbiddenError('missing view:message permission');
    }
    const relatedResource = ctx.query.get('relatedResource') as Message['relatedResource'] | null;
    const relatedResourceId = ctx.query.get('relatedResourceId');
    const messages = relatedResource && relatedResourceId
      ? await communication.listForResource(relatedResource, relatedResourceId, actor.companyId)
      : await communication.listForCompany(actor.companyId);
    return { status: 200, body: paginate(messages, ctx.query) };
  });

  httpServer.post('/api/communication/messages/:messageId/read', async (ctx) => {
    const actor = await actorOf(ctx);
    const message = await communication.markRead(ctx.params.messageId!, actor.companyId, actor.userId);
    return { status: 200, body: message };
  });

  // ---- Analytics & AI lead scoring ----
  httpServer.get('/api/analytics/sales-funnel', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'analytics'))) {
      throw new ForbiddenError('missing view:analytics permission');
    }
    return { status: 200, body: await analytics.salesFunnel(actor.companyId) };
  });

  httpServer.get('/api/analytics/pipeline', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'analytics'))) {
      throw new ForbiddenError('missing view:analytics permission');
    }
    return { status: 200, body: await analytics.pipelineSummary(actor.companyId) };
  });

  httpServer.get('/api/analytics/collections-aging', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'analytics'))) {
      throw new ForbiddenError('missing view:analytics permission');
    }
    return { status: 200, body: await analytics.collectionsAging(actor.companyId) };
  });

  httpServer.get('/api/analytics/inventory-occupancy', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'analytics'))) {
      throw new ForbiddenError('missing view:analytics permission');
    }
    return { status: 200, body: await analytics.inventoryOccupancy(actor.companyId) };
  });

  httpServer.get('/api/analytics/broker-performance', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'analytics'))) {
      throw new ForbiddenError('missing view:analytics permission');
    }
    return { status: 200, body: await analytics.brokerPerformance(actor.companyId) };
  });

  httpServer.get('/api/analytics/lead-scores', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'analytics'))) {
      throw new ForbiddenError('missing view:analytics permission');
    }
    return { status: 200, body: await leadScoring.rankedLeads(actor.companyId) };
  });

  httpServer.get('/api/crm/leads/:leadId/score', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'lead'))) {
      throw new ForbiddenError('missing view:lead permission');
    }
    return { status: 200, body: await leadScoring.scoreLead(ctx.params.leadId!, actor.companyId) };
  });

  // ---- Customer Portal ----
  httpServer.post('/api/portal/grant-access', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'portal_access'))) {
      throw new ForbiddenError('missing create:portal_access permission');
    }
    const body = parseJsonBody<{ leadId: string; email: string; password: string }>(ctx.body);
    const { customer } = await portal.grantPortalAccess({ companyId: actor.companyId, ...body });
    return { status: 201, body: customer };
  });

  const customerActorOf = async (ctx: RequestContext): Promise<{ actor: Actor; customerId: string }> => {
    const actor = await actorOf(ctx);
    if (actor.userType !== 'customer_user') throw new ForbiddenError('this endpoint is for customer portal accounts only');
    const user = await repos.users.findById(actor.userId);
    if (!user?.customerId) throw new ForbiddenError('this account is not linked to a customer record');
    return { actor, customerId: user.customerId };
  };

  httpServer.get('/api/portal/me', async (ctx) => {
    const { actor, customerId } = await customerActorOf(ctx);
    const customer = await portal.getCustomer(customerId, actor.companyId);
    if (!customer) throw new NotFoundError('customer not found');
    return { status: 200, body: customer };
  });

  httpServer.get('/api/portal/contracts', async (ctx) => {
    const { actor, customerId } = await customerActorOf(ctx);
    const contracts = await portal.myContracts(customerId, actor.companyId);
    return { status: 200, body: paginate(contracts, ctx.query) };
  });

  httpServer.get('/api/portal/contracts/:contractId/schedule', async (ctx) => {
    const { actor, customerId } = await customerActorOf(ctx);
    const schedule = await portal.myContractSchedule(customerId, actor.companyId, ctx.params.contractId!);
    return { status: 200, body: schedule };
  });

  // ---- Tasks (generic tasks/reminders/follow-ups; also the target of the
  // Automation Engine's create_task action) ----
  httpServer.post('/api/tasks', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'task'))) {
      throw new ForbiddenError('missing create:task permission');
    }
    const body = parseJsonBody<{
      title: string;
      description?: string;
      dueAt?: string;
      assignedToUserId?: string;
      relatedResource?: Task['relatedResource'];
      relatedResourceId?: string;
    }>(ctx.body);
    const task = await tasks.createTask({ companyId: actor.companyId, createdByUserId: actor.userId, ...body });
    return { status: 201, body: task };
  });

  httpServer.get('/api/tasks', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'task'))) {
      throw new ForbiddenError('missing view:task permission');
    }
    const list = await tasks.listForCompany(actor.companyId);
    return { status: 200, body: paginate(list, ctx.query) };
  });

  httpServer.get('/api/tasks/my', async (ctx) => {
    const actor = await actorOf(ctx);
    const list = await tasks.listForUser(actor.userId, actor.companyId);
    return { status: 200, body: paginate(list, ctx.query) };
  });

  httpServer.post('/api/tasks/:taskId/complete', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'task'))) {
      throw new ForbiddenError('missing edit:task permission');
    }
    const task = await tasks.completeTask(ctx.params.taskId!, actor.companyId);
    return { status: 200, body: task };
  });

  httpServer.post('/api/tasks/:taskId/cancel', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'task'))) {
      throw new ForbiddenError('missing edit:task permission');
    }
    const task = await tasks.cancelTask(ctx.params.taskId!, actor.companyId);
    return { status: 200, body: task };
  });

  // ---- Automation Engine: workflows ----
  httpServer.post('/api/automation/workflows', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'workflow'))) {
      throw new ForbiddenError('missing create:workflow permission');
    }
    const body = parseJsonBody<{
      name: string;
      description?: string;
      trigger: WorkflowDefinition['trigger'];
      steps: WorkflowStepInput[];
    }>(ctx.body);
    const workflow = await automation.createWorkflow({ companyId: actor.companyId, createdByUserId: actor.userId, ...body });
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'create', resource: 'workflow', resourceId: workflow.id });
    return { status: 201, body: workflow };
  });

  httpServer.get('/api/automation/workflows', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'workflow'))) {
      throw new ForbiddenError('missing view:workflow permission');
    }
    const list = await automation.listWorkflows(actor.companyId);
    return { status: 200, body: paginate(list, ctx.query) };
  });

  httpServer.get('/api/automation/templates', async (ctx) => {
    await actorOf(ctx); // any authenticated user may read the built-in catalogue
    return { status: 200, body: automation.listTemplates() };
  });

  // Company-wide execution monitoring — a dashboard summary of workflow and
  // run counts by status, plus pending approvals awaiting a decision.
  httpServer.get('/api/automation/stats', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'workflow_run'))) {
      throw new ForbiddenError('missing view:workflow_run permission');
    }
    const stats = await automation.getStats(actor.companyId);
    return { status: 200, body: stats };
  });

  httpServer.get('/api/automation/workflows/:workflowId', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'workflow'))) {
      throw new ForbiddenError('missing view:workflow permission');
    }
    const workflow = await automation.getWorkflow(ctx.params.workflowId!, actor.companyId);
    return { status: 200, body: workflow };
  });

  httpServer.patch('/api/automation/workflows/:workflowId', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'workflow'))) {
      throw new ForbiddenError('missing edit:workflow permission');
    }
    const body = parseJsonBody<{ name?: string; description?: string; steps?: WorkflowStepInput[] }>(ctx.body);
    const workflow = await automation.updateWorkflow(ctx.params.workflowId!, actor.companyId, body);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'edit', resource: 'workflow', resourceId: workflow.id });
    return { status: 200, body: workflow };
  });

  httpServer.post('/api/automation/workflows/:workflowId/status', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'workflow'))) {
      throw new ForbiddenError('missing edit:workflow permission');
    }
    const body = parseJsonBody<{ status: WorkflowDefinition['status'] }>(ctx.body);
    const workflow = await automation.setWorkflowStatus(ctx.params.workflowId!, actor.companyId, body.status);
    await auditLog.record({
      companyId: actor.companyId,
      actorUserId: actor.userId,
      action: 'edit',
      resource: 'workflow',
      resourceId: workflow.id,
      metadata: { status: body.status },
    });
    return { status: 200, body: workflow };
  });

  // ---- Automation Engine: run history & execution monitoring ----
  httpServer.get('/api/automation/workflows/:workflowId/runs', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'workflow_run'))) {
      throw new ForbiddenError('missing view:workflow_run permission');
    }
    const list = await automation.listRuns(ctx.params.workflowId!, actor.companyId);
    return { status: 200, body: paginate(list, ctx.query) };
  });

  httpServer.get('/api/automation/runs/:runId', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'workflow_run'))) {
      throw new ForbiddenError('missing view:workflow_run permission');
    }
    const run = await automation.getRun(ctx.params.runId!, actor.companyId);
    return { status: 200, body: run };
  });

  httpServer.get('/api/automation/runs/:runId/steps', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'workflow_run'))) {
      throw new ForbiddenError('missing view:workflow_run permission');
    }
    const steps = await automation.listStepRuns(ctx.params.runId!, actor.companyId);
    return { status: 200, body: steps };
  });

  // Failure recovery — resumes a failed run from the exact step it stopped
  // on (e.g. after fixing whatever the failing step needed, like a
  // webhook endpoint being back up).
  httpServer.post('/api/automation/runs/:runId/retry', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'workflow_run'))) {
      throw new ForbiddenError('missing edit:workflow_run permission');
    }
    const run = await automation.retryRun(ctx.params.runId!, actor.companyId);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'edit', resource: 'workflow_run', resourceId: run.id, metadata: { retried: true } });
    return { status: 200, body: run };
  });

  // ---- Automation Engine: approvals ----
  httpServer.get('/api/automation/approvals', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'approval'))) {
      throw new ForbiddenError('missing view:approval permission');
    }
    const status = ctx.query.get('status') as ApprovalRequest['status'] | null;
    const list = await automation.listApprovals(actor.companyId, status ?? undefined);
    return { status: 200, body: paginate(list, ctx.query) };
  });

  httpServer.post('/api/automation/approvals/:approvalId/approve', async (ctx) => {
    const actor = await actorOf(ctx);
    const run = await automation.approveStep(ctx.params.approvalId!, actor.companyId, actor.userId);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'approve', resource: 'approval', resourceId: ctx.params.approvalId! });
    return { status: 200, body: run };
  });

  httpServer.post('/api/automation/approvals/:approvalId/reject', async (ctx) => {
    const actor = await actorOf(ctx);
    const body = ctx.body && typeof ctx.body === 'object' ? (ctx.body as { reason?: string }) : {};
    const run = await automation.rejectStep(ctx.params.approvalId!, actor.companyId, actor.userId, body.reason);
    await auditLog.record({
      companyId: actor.companyId,
      actorUserId: actor.userId,
      action: 'approve',
      resource: 'approval',
      resourceId: ctx.params.approvalId!,
      metadata: { rejected: true },
    });
    return { status: 200, body: run };
  });

  // ---- Automation Engine: secrets (encrypted-at-rest credentials for
  // webhook_call actions — never returned in plaintext by any route) ----
  httpServer.post('/api/automation/secrets', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'secret'))) {
      throw new ForbiddenError('missing create:secret permission');
    }
    const body = parseJsonBody<{ key: string; value: string }>(ctx.body);
    const secret = await automation.setSecret(actor.companyId, body.key, body.value, actor.userId);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'create', resource: 'secret', resourceId: secret.id });
    return { status: 201, body: secret };
  });

  httpServer.get('/api/automation/secrets', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'secret'))) {
      throw new ForbiddenError('missing view:secret permission');
    }
    const list = await automation.listSecrets(actor.companyId);
    return { status: 200, body: list };
  });

  httpServer.delete('/api/automation/secrets/:secretId', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'delete', 'secret'))) {
      throw new ForbiddenError('missing delete:secret permission');
    }
    const force = ctx.query.get('force') === 'true';
    await automation.deleteSecret(ctx.params.secretId!, actor.companyId, force);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'delete', resource: 'secret', resourceId: ctx.params.secretId!, metadata: { force } });
    return { status: 204 };
  });

  // ---- Automation Engine: inbound webhook receiver. Intentionally
  // unauthenticated (external services can't hold ACTIVE credentials) — the
  // companyId + unguessable slug in the URL is the credential, the same
  // model Zapier/Make webhook URLs use. Only a workflow with an *active*
  // webhook trigger matching that exact slug will ever fire. ----
  httpServer.post('/api/automation/webhooks/:companyId/:slug', async (ctx) => {
    const idempotencyHeader = ctx.headers['idempotency-key'];
    const idempotencyKey = typeof idempotencyHeader === 'string' ? idempotencyHeader : undefined;
    const payload = ctx.body && typeof ctx.body === 'object' ? (ctx.body as Record<string, unknown>) : {};
    const run = await automation.receiveWebhook(ctx.params.companyId!, ctx.params.slug!, payload, idempotencyKey);
    return { status: 202, body: { runId: run.id, status: run.status } };
  });

  // ---- AI Execution Layer ----
  httpServer.post('/api/ai/actions', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'ai_action'))) {
      throw new ForbiddenError('missing create:ai_action permission');
    }
    const body = parseJsonBody<{ actionType: AiActionRequest['actionType']; params: Record<string, unknown>; reasoning?: string }>(ctx.body);
    const request = await aiAgent.requestAction({ companyId: actor.companyId, requestedByUserId: actor.userId, ...body });
    return { status: 201, body: request };
  });

  httpServer.get('/api/ai/actions', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'ai_action'))) {
      throw new ForbiddenError('missing view:ai_action permission');
    }
    const list = await aiAgent.listActionRequests(actor.companyId);
    return { status: 200, body: paginate(list, ctx.query) };
  });

  httpServer.get('/api/ai/actions/:actionId', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'ai_action'))) {
      throw new ForbiddenError('missing view:ai_action permission');
    }
    const request = await aiAgent.getActionRequest(ctx.params.actionId!, actor.companyId);
    return { status: 200, body: request };
  });

  httpServer.post('/api/ai/actions/:approvalId/approve', async (ctx) => {
    const actor = await actorOf(ctx);
    const request = await aiAgent.approveAction(ctx.params.approvalId!, actor.companyId, actor.userId);
    return { status: 200, body: request };
  });

  httpServer.post('/api/ai/actions/:approvalId/reject', async (ctx) => {
    const actor = await actorOf(ctx);
    const body = ctx.body && typeof ctx.body === 'object' ? (ctx.body as { reason?: string }) : {};
    const request = await aiAgent.rejectAction(ctx.params.approvalId!, actor.companyId, actor.userId, body.reason);
    return { status: 200, body: request };
  });

  // ---- AI Execution Layer: policies (per-company, per-action-type
  // autonomy — defaults to require_approval when no policy is set) ----
  httpServer.get('/api/ai/policies', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'ai_action'))) {
      throw new ForbiddenError('missing view:ai_action permission');
    }
    const list = await aiAgent.listPolicies(actor.companyId);
    return { status: 200, body: list };
  });

  httpServer.post('/api/ai/policies', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'ai_action'))) {
      throw new ForbiddenError('missing edit:ai_action permission');
    }
    const body = parseJsonBody<{ actionType: AiPolicy['actionType']; autonomyLevel: AiPolicy['autonomyLevel'] }>(ctx.body);
    const policy = await aiAgent.setPolicy(actor.companyId, body.actionType, body.autonomyLevel, actor.userId);
    await auditLog.record({
      companyId: actor.companyId,
      actorUserId: actor.userId,
      action: 'edit',
      resource: 'ai_action',
      resourceId: policy.id,
      metadata: { actionType: policy.actionType, autonomyLevel: policy.autonomyLevel },
    });
    return { status: 200, body: policy };
  });

  // AI's deterministic "what should happen next" suggestion for a lead —
  // reuses the existing rule-based LeadScoringService, then routes the
  // suggestion through the same permission/policy/approval/audit pipeline
  // as any other AI action (see AiAgentService.suggestNextAction).
  httpServer.post('/api/crm/leads/:leadId/suggest-next-action', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'ai_action'))) {
      throw new ForbiddenError('missing create:ai_action permission');
    }
    const request = await aiAgent.suggestNextAction(ctx.params.leadId!, actor.companyId, actor.userId);
    return { status: 201, body: request };
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
    services: {
      rbac, organization, auth, crm, inventory, paymentPlans, sales, finance, brokers, auditLog, roleManagement, onboarding,
      hr, operations, legal, purchasing, marketing, communication, analytics, leadScoring, portal,
      tasks, automation, eventBus, sweepOverdueAndEmit, aiAgent,
    },
    seedResult,
  };
}
