import type {
  ActionName,
  AgentDecision,
  AiActionRequest,
  AiLlmUsage,
  AiMemory,
  AiModelConfig,
  AiPolicy,
  AiWorkflowGoalType,
  AiWorkflowRun,
  AiWorkflowStepRun,
  ApprovalRequest,
  CommunicationDeliveryEvent,
  DocumentExtractedField,
  DocumentExtractionRun,
  IntegrationConnection,
  IntegrationEvent,
  AuditLogEntry,
  Branch,
  BrokerCompany,
  BrokerLead,
  Campaign,
  Commission,
  CommissionRule,
  Company,
  Contract,
  CrmStage,
  Customer,
  Department,
  Employee,
  Lead,
  LeadDistributionPool,
  LeaveRequest,
  LegalDocument,
  MaintenanceTicket,
  Message,
  Opportunity,
  Payment,
  PaymentFrequency,
  PaymentPlanTemplate,
  PaymentScheduleLine,
  PermissionGrant,
  Project,
  Developer,
  ProjectPhase,
  Launch,
  Facility,
  Consultant,
  SalesPhoneNumber,
  ProjectUnitSpec,
  ActionApproval,
  ApprovableActionType,
  DiscountApprovalPolicy,
  ImportSession,
  PurchaseOrder,
  Quotation,
  QuotationStatus,
  Receipt,
  Refund,
  Reservation,
  ResourceName,
  Role,
  SalesCommission,
  SalesCommissionRule,
  ScopeName,
  Secret,
  SensitivityTier,
  SignatureEnvelope,
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
import { netContractValue } from './domain/money.js';
import type { DatabaseSync } from 'node:sqlite';
import { InMemoryRepository, type Repository } from './infra/repository.js';
import { SqliteRepository } from './infra/sqlite-repository.js';
import { HttpServer, type RequestContext } from './infra/http-server.js';
import { SlidingWindowRateLimiter } from './infra/rate-limiter.js';
import { paginate } from './infra/pagination.js';
import { searchFilter } from './infra/search.js';
import { parseCsvRecords } from './infra/csv.js';
import { runImport, SkipRow } from './infra/csv-import.js';
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
import { CrmStageService } from './modules/crm/crm-stage.service.js';
import { LeadDistributionService } from './modules/crm/lead-distribution.service.js';
import { LeadTimelineService } from './modules/crm/lead-timeline.service.js';
import { InventoryService } from './modules/inventory/inventory.service.js';
import { PaymentPlansService } from './modules/payment-plans/payment-plans.service.js';
import { SalesService } from './modules/sales/sales.service.js';
import { FinanceService } from './modules/finance/finance.service.js';
import { BrokersService } from './modules/brokers/brokers.service.js';
import { SalesCommissionService } from './modules/commissions/sales-commission.service.js';
import { ApprovalEngineService } from './modules/approvals/approval-engine.service.js';
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
import { AiMemoryService } from './modules/ai/ai-memory.service.js';
import { LlmOrchestratorService } from './modules/ai/llm-orchestrator.service.js';
import { AiWorkflowService } from './modules/ai/ai-workflow.service.js';
import { IntegrationService } from './modules/integrations/integration.service.js';
import { SignatureService } from './modules/integrations/e-signature.service.js';
import { CommunicationDeliveryService } from './modules/integrations/communication-delivery.service.js';
import { ForecastingService } from './modules/forecasting/forecasting.service.js';
import { ScenarioSimulationService } from './modules/forecasting/scenario-simulation.service.js';
import { ImportSessionService } from './modules/imports/import-session.service.js';
import { LeadImportService, LEAD_IMPORT_FIELDS } from './modules/crm/lead-import.service.js';
import { PaymentImportService, PAYMENT_IMPORT_FIELDS } from './modules/finance/payment-import.service.js';
import {
  InventoryImportService,
  INVENTORY_IMPORT_FIELDS,
  CATALOG_IMPORT_FIELDS,
  AVAILABILITY_IMPORT_FIELDS,
  CATALOG_ANCHOR_KEYS,
  AVAILABILITY_ANCHOR_KEYS,
  type InventoryImportOptions,
} from './modules/inventory/inventory-import.service.js';
import { classifySheet } from './infra/field-mapping.js';
import { DocumentIntelligenceService } from './modules/documents/document-intelligence.service.js';
import { QuotationService } from './modules/quotations/quotation.service.js';
import { buildQuotationWorkbook, buildQuotationPrintHtml } from './modules/quotations/quotation-export.service.js';
import { buildOfferPdf, fetchOfferImages } from './modules/quotations/offer-pdf.service.js';
import { IMPORT_MAX_BODY_BYTES } from './infra/http-server.js';
import type { MultipartBody } from './infra/multipart.js';

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
  /** Whether to trust X-Forwarded-For for client-IP-based rate limiting —
   * see HttpServerOptions.trustProxy for why this defaults to false (an
   * untrusted client can otherwise spoof a fresh rate-limit bucket on every
   * request). Only set true when genuinely deployed behind a trusted single
   * reverse proxy. */
  trustProxy?: boolean;
}

export interface Application {
  httpServer: HttpServer;
  repos: ReturnType<typeof buildRepos>;
  services: {
    rbac: RbacEvaluator;
    organization: OrganizationService;
    auth: AuthService;
    crm: CrmService;
    crmStages: CrmStageService;
    leadDistribution: LeadDistributionService;
    leadTimeline: LeadTimelineService;
    inventory: InventoryService;
    paymentPlans: PaymentPlansService;
    quotations: QuotationService;
    sales: SalesService;
    finance: FinanceService;
    brokers: BrokersService;
    salesCommissions: SalesCommissionService;
    approvalEngine: ApprovalEngineService;
    forecasting: ForecastingService;
    scenarioSimulation: ScenarioSimulationService;
    importSessions: ImportSessionService;
    leadImport: LeadImportService;
    paymentImport: PaymentImportService;
    inventoryImport: InventoryImportService;
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
    aiMemory: AiMemoryService;
    llmOrchestrator: LlmOrchestratorService;
    documentIntelligence: DocumentIntelligenceService;
    aiWorkflow: AiWorkflowService;
    integrations: IntegrationService;
    signatures: SignatureService;
    /** Sweeps overdue payment schedule lines AND emits one
     * `payment.overdue_swept` domain event per swept line — use this
     * instead of `finance.sweepOverdue()` wherever the sweep should also
     * feed the Automation Engine (the HTTP route and main.ts's tick both
     * do). `finance.sweepOverdue()` itself stays event-free for existing
     * callers/tests that only care about the count. */
    /** `companyId` optional — omit it (as main.ts's tick does) to sweep
     * every tenant; a per-tenant HTTP caller must always pass its own. */
    sweepOverdueAndEmit: (companyId?: string) => Promise<number>;
    /** Auto-reassigns leads that breached their first-contact SLA and
     * emits one `lead.sla_breached` event per breach — use this instead
     * of `leadDistribution.sweepSlaBreaches()` wherever the sweep should
     * also feed the Automation Engine (the HTTP route and main.ts's tick
     * both do), mirroring sweepOverdueAndEmit above. `companyId` optional,
     * same rule as sweepOverdueAndEmit. */
    sweepSlaBreachesAndEmit: (companyId?: string) => Promise<number>;
    /** Expires active Reservations past their expiresAt and emits one
     * `reservation.expired` domain event per reservation, mirroring
     * sweepOverdueAndEmit/sweepSlaBreachesAndEmit above, including the
     * optional `companyId` rule. */
    sweepExpiredReservationsAndEmit: (companyId?: string) => Promise<number>;
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
    developers: repo<Developer>('developers'),
    projectPhases: repo<ProjectPhase>('project_phases'),
    launches: repo<Launch>('launches'),
    facilities: repo<Facility>('facilities'),
    consultants: repo<Consultant>('consultants'),
    salesPhoneNumbers: repo<SalesPhoneNumber>('sales_phone_numbers'),
    projectUnitSpecs: repo<ProjectUnitSpec>('project_unit_specs'),
    users: repo<User>('users'),
    roles: repo<Role>('roles'),
    grants: repo<PermissionGrant>('permission_grants'),
    userRoles: repo<UserRole>('user_roles'),
    overrides: repo<import('./domain/types.js').PermissionOverride>('permission_overrides'),
    leads: repo<Lead>('leads'),
    crmStages: repo<CrmStage>('crm_stages'),
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
    agentDecisions: repo<AgentDecision>('agent_decisions'),
    aiMemory: repo<AiMemory>('ai_memory'),
    aiModelConfigs: repo<AiModelConfig>('ai_model_configs'),
    aiLlmUsage: repo<AiLlmUsage>('ai_llm_usage'),
    documentExtractionRuns: repo<DocumentExtractionRun>('document_extraction_runs'),
    documentExtractedFields: repo<DocumentExtractedField>('document_extracted_fields'),
    integrationConnections: repo<IntegrationConnection>('integration_connections'),
    integrationEvents: repo<IntegrationEvent>('integration_events'),
    communicationDeliveryEvents: repo<CommunicationDeliveryEvent>('communication_delivery_events'),
    leadDistributionPools: repo<LeadDistributionPool>('lead_distribution_pools'),
    salesCommissionRules: repo<SalesCommissionRule>('sales_commission_rules'),
    salesCommissions: repo<SalesCommission>('sales_commissions'),
    actionApprovals: repo<ActionApproval>('action_approvals'),
    discountApprovalPolicies: repo<DiscountApprovalPolicy>('discount_approval_policies'),
    refunds: repo<Refund>('refunds'),
    importSessions: repo<ImportSession>('import_sessions'),
    quotations: repo<Quotation>('quotations'),
    aiWorkflowRuns: repo<AiWorkflowRun>('ai_workflow_runs'),
    aiWorkflowStepRuns: repo<AiWorkflowStepRun>('ai_workflow_step_runs'),
    signatureEnvelopes: repo<SignatureEnvelope>('signature_envelopes'),
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
  const crmStages = new CrmStageService(repos.crmStages);
  const crm = new CrmService(repos.leads, crmStages);
  const importSessions = new ImportSessionService(repos.importSessions);
  const leadImport = new LeadImportService(repos.leads, repos.users, crm);
  const leadDistribution = new LeadDistributionService(repos.leadDistributionPools, repos.users, repos.employees, repos.leads, crm, crmStages);
  const leadTimeline = new LeadTimelineService(repos.leads, repos.auditEntries, repos.messages, repos.tasks, repos.opportunities, repos.contracts);
  const inventory = new InventoryService(
    repos.units,
    repos.unitHolds,
    repos.reservations,
    repos.projects,
    repos.developers,
    repos.projectPhases,
    repos.launches,
    repos.facilities,
    repos.consultants,
    repos.salesPhoneNumbers,
    repos.projectUnitSpecs,
  );
  const inventoryImport = new InventoryImportService(inventory);
  const documentIntelligence = new DocumentIntelligenceService(repos.documentExtractionRuns, repos.documentExtractedFields, inventoryImport);
  const paymentPlans = new PaymentPlansService(repos.templates, repos.scheduleLines);
  const quotations = new QuotationService(repos.quotations, repos.units, paymentPlans);
  const sales = new SalesService(repos.opportunities, repos.contracts, inventory, paymentPlans, repos.discountApprovalPolicies);
  const approvalEngine = new ApprovalEngineService(repos.actionApprovals, rbac);
  const finance = new FinanceService(repos.payments, repos.receipts, repos.scheduleLines, repos.refunds);
  const paymentImport = new PaymentImportService(repos.leads, inventory, sales, paymentPlans, finance);
  const brokers = new BrokersService(repos.brokerCompanies, repos.brokerLeads, repos.commissionRules, repos.commissions, crm);
  const salesCommissions = new SalesCommissionService(repos.salesCommissionRules, repos.salesCommissions, repos.employees, repos.users);
  const roleManagement = new RoleManagementService(repos.roles, repos.grants, repos.userRoles);
  const onboarding = new OnboardingService(organization, auth, roleManagement, crmStages);
  const hr = new HrService(repos.leaveRequests, repos.employees);
  const operations = new OperationsService(repos.maintenanceTickets, repos.units);
  const legal = new LegalService(repos.legalDocuments, repos.contracts);
  const purchasing = new PurchasingService(repos.vendors, repos.purchaseOrders);
  const marketing = new MarketingService(repos.campaigns, repos.leads, crmStages);
  const communication = new CommunicationService(repos.messages);
  const analytics = new AnalyticsService(repos.leads, repos.opportunities, repos.contracts, repos.scheduleLines, repos.units, repos.commissions, repos.auditEntries, repos.campaigns, crmStages);
  const forecasting = new ForecastingService(repos.contracts, repos.scheduleLines, repos.payments, repos.units);
  const scenarioSimulation = new ScenarioSimulationService(repos.templates);
  const leadScoring = new LeadScoringService(repos.leads, crmStages);
  const portal = new PortalService(repos.customers, repos.leads, repos.contracts, repos.scheduleLines, auth, repos.opportunities, repos.legalDocuments, repos.messages, repos.tasks);
  const tasks = new TaskService(repos.tasks);
  const eventBus = new EventBus();
  const automation = new AutomationService(
    { workflows: repos.workflows, runs: repos.workflowRuns, stepRuns: repos.workflowStepRuns, approvals: repos.approvals, secrets: repos.secrets },
    rbac,
    tasks,
    communication,
    crm,
    crmStages,
    marketing,
    finance,
    sales,
    inventory,
    leadScoring,
    quotations,
    paymentPlans,
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
  const integrations = new IntegrationService(
    { connections: repos.integrationConnections, events: repos.integrationEvents, deliveryEvents: repos.communicationDeliveryEvents },
    automation,
    auditLog,
  );
  // Wires the generic `integration_call` action type (workflow steps and
  // AI actions alike) to the Integration Layer's send() — see the
  // integrationSender field comment in automation.service.ts for why this
  // is late-bound instead of a constructor dependency.
  automation.setIntegrationSender((companyId, provider, action, params, userId) =>
    integrations.send(companyId, provider as IntegrationConnection['provider'], action, params, userId),
  );
  const signatures = new SignatureService(repos.signatureEnvelopes, repos.contracts, integrations, automation);
  const communicationDelivery = new CommunicationDeliveryService(repos.communicationDeliveryEvents, integrations, automation);
  // Wires the real delivery-status lookup in as the executor for the
  // `get_delivery_status` AI tool — see the deliveryStatusGetter field
  // comment in automation.service.ts for why this is late-bound.
  automation.setDeliveryStatusGetter((companyId, relatedResourceId) => integrations.getLatestDeliveryStatusForResource(companyId, relatedResourceId));

  const aiMemory = new AiMemoryService(repos.aiMemory);
  // Wires the `recall_memory` AI tool — see the memoryRecaller field
  // comment in automation.service.ts.
  automation.setMemoryRecaller((companyId, filter) =>
    aiMemory.recall(companyId, {
      category: filter.category as AiMemory['category'] | undefined,
      subjectType: filter.subjectType as string | undefined,
      subjectId: filter.subjectId as string | undefined,
      query: filter.query as string | undefined,
    }),
  );

  const llmOrchestrator = new LlmOrchestratorService(repos.aiModelConfigs, repos.aiLlmUsage, automation);

  const aiAgent = new AiAgentService(
    { actionRequests: repos.aiActionRequests, policies: repos.aiPolicies, approvals: repos.approvals, agentDecisions: repos.agentDecisions },
    rbac,
    automation,
    crm,
    crmStages,
    leadScoring,
    auditLog,
    marketing,
    operations,
    hr,
    finance,
    integrations,
    legal,
    brokers,
    inventory,
    analytics,
    tasks,
    communication,
  );
  // Wires the `ai_decide` action type — a workflow step (or a manual
  // trigger) can hand a subject off to a specialized agent and let it
  // choose + execute (via the exact same requestAction pipeline as any
  // other AI action) its own next step. This is what connects Phase 1's
  // Automation Engine, Phase 2's AI Agent Orchestration Layer, and Phase
  // 3's Integration Layer into the cross-module workflows Phase 4 asks
  // for — see the "Lead AI Outreach" workflow template.
  automation.setAiDecider((companyId, agentKey, subjectId, requestedByUserId) =>
    aiAgent.decide(agentKey, companyId, subjectId, requestedByUserId),
  );

  const aiWorkflow = new AiWorkflowService(
    { runs: repos.aiWorkflowRuns, steps: repos.aiWorkflowStepRuns },
    automation,
    aiAgent,
    crm,
    crmStages,
    leadScoring,
    leadTimeline,
    inventory,
    paymentPlans,
    leadDistribution,
    communication,
    integrations,
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
      crmStages: repos.crmStages,
      leads: repos.leads,
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
    trustProxy: options.trustProxy ?? false,
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
  // of duplicating the sweep-then-emit logic. `companyId` omitted (main.ts's
  // tick) sweeps every tenant; the manual HTTP route always passes its own.
  const sweepOverdueAndEmit = async (companyId?: string): Promise<number> => {
    const swept = await finance.sweepOverdueDetailed(new Date(), companyId);
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

  // Same shared-by-manual-route-and-tick shape as sweepOverdueAndEmit
  // above, for the SLA sweep instead of the payment-overdue sweep.
  const sweepSlaBreachesAndEmit = async (companyId?: string): Promise<number> => {
    const breaches = await leadDistribution.sweepSlaBreaches(new Date(), companyId);
    for (const breach of breaches) {
      await emitEvent({
        companyId: breach.companyId,
        type: 'lead.sla_breached',
        payload: { ...breach },
        dedupeKey: `lead.sla_breached:${breach.leadId}:${breach.reassignmentCount}`,
      });
    }
    return breaches.length;
  };

  // Same shared-by-manual-route-and-tick shape as sweepOverdueAndEmit above,
  // for expired reservations — closes the previously-open gap where a
  // reservation past its expiresAt never released its unit back onto the
  // market unless something else happened to touch that unit.
  const sweepExpiredReservationsAndEmit = async (companyId?: string): Promise<number> => {
    const expired = await inventory.sweepExpiredReservationsDetailed(new Date(), companyId);
    for (const reservation of expired) {
      await emitEvent({
        companyId: reservation.companyId,
        type: 'reservation.expired',
        payload: { ...reservation },
        dedupeKey: `reservation.expired:${reservation.id}`,
      });
    }
    return expired.length;
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

  // The 60-day lead-ownership protection law: at contract-signing time,
  // resolve who actually gets commission credit — the lead's original
  // first-contact owner if still inside the 60-day window, otherwise
  // whoever is actually signing. Best-effort: if the reservation/lead
  // can't be resolved for any reason, falls back to the signer, exactly
  // like this route always behaved before this law existed — signContract
  // itself still does the real reservation validation.
  const resolveCreditedEmployee = async (companyId: string, reservationId: string, signingUserId: string): Promise<string> => {
    const reservation = await inventory.getReservation(reservationId);
    if (!reservation || reservation.companyId !== companyId) return signingUserId;
    const protectedOwner = await crm.resolveCommissionOwner(reservation.clientId, companyId).catch(() => undefined);
    return protectedOwner ?? signingUserId;
  };

  // Records base/override internal sales commission lines for a freshly
  // signed contract and emits one sales_commission.recorded event per
  // line, so the Automation Engine can react (e.g. notify the earner) the
  // same way it reacts to any other domain event. Never blocks or fails
  // the contract-signing response — a commission-recording issue must
  // never undo or block a signed contract.
  const recordSalesCommissionsAndEmit = async (companyId: string, contract: Contract, actorUserId: string): Promise<void> => {
    if (contract.totalPrice === undefined) return;
    // Commission is earned on what the company actually stands to collect,
    // not the pre-discount list price — a discounted deal is a smaller
    // deal. Without this, an agent would earn the same commission on a
    // heavily discounted contract as on a full-price one.
    try {
      const recorded = await salesCommissions.recordCommissionsForContract(companyId, contract.id, contract.creditedEmployeeUserId, netContractValue(contract.totalPrice, contract.discountPercent));
      for (const commission of recorded) {
        await emitEvent({
          companyId,
          type: 'sales_commission.recorded',
          payload: { ...commission },
          actorUserId,
          dedupeKey: `sales_commission.recorded:${commission.id}`,
        });
      }
    } catch (err) {
      process.stderr.write(`sales commission recording failed for contract ${contract.id}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  };

  // The one real place a signed contract actually gets created — used
  // both by the direct POST /api/sales/contracts route and by the
  // discount-override approval resume path below, so approval never
  // takes a shortcut around audit/event/commission recording.
  const finishContractSigning = async (
    companyId: string,
    input: { reservationId: string; creditedEmployeeUserId: string; paymentPlanTemplateId: string; totalPrice: number; discountPercent?: number; escalationPercentPerYear?: number },
    actorUserId: string,
  ): Promise<Contract> => {
    const contract = await sales.signContract({ companyId, ...input });
    await auditLog.record({ companyId, actorUserId, action: 'create', resource: 'contract', resourceId: contract.id });
    await emitEvent({ companyId, type: 'contract.signed', payload: { ...contract }, actorUserId, dedupeKey: `contract.signed:${contract.id}` });
    await recordSalesCommissionsAndEmit(companyId, contract, actorUserId);
    return contract;
  };

  // Same reuse principle as finishContractSigning above: a contract
  // amendment is identical whether it happens immediately (no policy
  // gate configured — see the route below) or after approval.
  const finishContractAmendment = async (
    companyId: string,
    input: { contractId: string; newTotalPrice: number; discountPercent?: number },
    actorUserId: string,
  ): Promise<Contract> => {
    const contract = await sales.amendContract({ companyId, ...input });
    await auditLog.record({ companyId, actorUserId, action: 'edit', resource: 'contract', resourceId: contract.id, metadata: { amended: true, newTotalPrice: input.newTotalPrice, discountPercent: input.discountPercent } });
    await emitEvent({ companyId, type: 'contract.amended', payload: { ...contract }, actorUserId, dedupeKey: `contract.amended:${contract.id}:${Date.now()}` });
    return contract;
  };

  const finishRefund = async (
    companyId: string,
    input: { contractId: string; paymentScheduleLineId: string; amount: number; reason: string },
    actorUserId: string,
  ) => {
    const result = await finance.recordRefund({ companyId, recordedByUserId: actorUserId, ...input });
    await auditLog.record({ companyId, actorUserId, action: 'edit', resource: 'payment_schedule', resourceId: result.line.id, metadata: { refunded: true, amount: input.amount, reason: input.reason } });
    await emitEvent({ companyId, type: 'payment.refunded', payload: { ...result.refund }, actorUserId, dedupeKey: `payment.refunded:${result.refund.id}` });
    return result;
  };

  // Dispatch table for resuming an approved ActionApproval — the
  // Universal Approval Engine itself knows nothing about contracts or
  // discounts; this is the one place that maps an actionType to what
  // "finishing" it actually means. Add a case here for each new
  // actionType this engine gates.
  const resumeApprovedAction = async (approval: ActionApproval, actorUserId: string): Promise<unknown> => {
    if (approval.actionType === 'discount_override') {
      const ctx = approval.context as {
        reservationId: string;
        creditedEmployeeUserId: string;
        paymentPlanTemplateId: string;
        totalPrice: number;
        discountPercent?: number;
        escalationPercentPerYear?: number;
      };
      return finishContractSigning(approval.companyId, ctx, actorUserId);
    }
    if (approval.actionType === 'contract_amendment') {
      const ctx = approval.context as { contractId: string; newTotalPrice: number; discountPercent?: number };
      return finishContractAmendment(approval.companyId, ctx, actorUserId);
    }
    if (approval.actionType === 'refund') {
      const ctx = approval.context as { contractId: string; paymentScheduleLineId: string; amount: number; reason: string };
      return finishRefund(approval.companyId, ctx, actorUserId);
    }
    throw new ValidationError(`no resume handler registered for action type "${String(approval.actionType)}"`);
  };

  // ---- Auth ----
  // Fixed real security gap found during audit: this route previously had
  // no auth check at all — anyone, unauthenticated, could create a login
  // account inside ANY company by companyId (including the well-known
  // "company-demo"), for any userType. The resulting account held zero
  // RBAC grants so couldn't read/write real data, but it still broke
  // tenant isolation (an outsider could inject an account into a company
  // they don't belong to) and let requests authenticate as a "real" user
  // of that tenant. Now: requires an authenticated staff member with
  // create:employee (the same permission that already gates provisioning
  // an org-chart Employee), always registers into the ACTOR's own
  // company (the companyId in the body is ignored, never trusted), and —
  // filling a real completeness gap — is now the only way to actually
  // provision a broker_user login for an approved BrokerCompany, since no
  // route did that at all before (the broker-lead-submission flow was
  // otherwise unreachable in practice).
  httpServer.post('/api/auth/register', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'employee'))) {
      throw new ForbiddenError('missing create:employee permission');
    }
    const body = parseJsonBody<{ email: string; password: string; userType: string; locale?: 'en' | 'ar'; employeeId?: string; brokerCompanyId?: string; customerId?: string }>(ctx.body);
    const userType = body.userType as User['userType'];
    if (userType === 'broker_user') {
      if (!body.brokerCompanyId) throw new ValidationError('brokerCompanyId is required for a broker_user account');
      const brokerCompanies = await brokers.listBrokerCompanies(actor.companyId);
      const brokerCompany = brokerCompanies.find((bc) => bc.id === body.brokerCompanyId);
      if (!brokerCompany) throw new NotFoundError('broker company not found');
      if (brokerCompany.status !== 'approved') throw new ForbiddenError('broker company must be approved before it can have login accounts');
    }
    const user = await auth.register({
      companyId: actor.companyId,
      email: body.email,
      password: body.password,
      userType,
      locale: body.locale ?? 'en',
      employeeId: body.employeeId,
      brokerCompanyId: userType === 'broker_user' ? body.brokerCompanyId : undefined,
      customerId: body.customerId,
    });
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'create', resource: 'employee', resourceId: user.id, metadata: { userType, accountCreation: true } });
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
    const searched = searchFilter(filtered, ['fullName', 'email', 'title'], ctx.query.get('q'));
    return { status: 200, body: paginate(searched, ctx.query) };
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

  // Company name/creation date for the Settings page — no dedicated
  // 'company' RBAC resource exists (every authenticated user already
  // implicitly knows their own companyId from GET /api/me, and a company's
  // display name isn't sensitive), so this only requires authentication,
  // the same bar GET /api/me itself uses.
  httpServer.get('/api/organization/company', async (ctx) => {
    const actor = await actorOf(ctx);
    const company = await repos.companies.findById(actor.companyId);
    if (!company) throw new NotFoundError('company not found');
    return { status: 200, body: company };
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

  // Bulk CSV import for roles + grants. A permission matrix is too
  // security-sensitive to derive from a loosely-worded prose column like
  // "Create, View All, Edit, Delete" — one wrong guess there is a real
  // access-control bug. So this uses one row per exact (Role, Action,
  // Resource, Scope) grant instead: unambiguous, and validated the same
  // way the manual "Add grant" screen already validates it (RbacEvaluator
  // rejects an invalid resource/action/scope at check time, same as any
  // other grant). The role itself is created on its first occurrence and
  // reused for subsequent rows with the same name.
  httpServer.post('/api/roles/import', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'role'))) {
      throw new ForbiddenError('missing create:role permission');
    }
    if (!(await rbac.can(actor.userId, 'edit', 'role'))) {
      throw new ForbiddenError('missing edit:role permission');
    }
    const body = parseJsonBody<{ csv: string }>(ctx.body);
    const records = parseCsvRecords(body.csv);
    const existingRoles = await roleManagement.listRoles(actor.companyId);
    const roleByName = new Map<string, Role>(existingRoles.map((r) => [r.name, r]));
    const result = await runImport(records, [], async (record) => {
      const roleName = record['Role Name']?.trim();
      const action = record['Action']?.trim() as ActionName;
      const resource = record['Resource']?.trim() as ResourceName;
      const scope = record['Scope']?.trim() as ScopeName;
      const sensitivity = (record['Sensitivity']?.trim() || undefined) as SensitivityTier | undefined;
      if (!roleName) throw new ValidationError('"Role Name" is required');
      if (!action || !resource || !scope) throw new ValidationError('"Action", "Resource", and "Scope" are required');
      let role = roleByName.get(roleName);
      if (!role) {
        role = await roleManagement.createRole(actor.companyId, roleName);
        roleByName.set(roleName, role);
      }
      return roleManagement.addGrant(actor.companyId, role.id, { action, resource, scope, sensitivity });
    });
    return { status: 200, body: result };
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

  // Bulk CSV import — one real paymentPlans.createTemplate() call per row.
  // Discount/maintenance-fee/delivery-payment percentages aren't fields on
  // PaymentPlanTemplate (discount is applied per-contract at signing time,
  // not stored on the template), so they're reported as unsupportedColumns
  // rather than silently accepted and dropped.
  httpServer.post('/api/payment-plan-templates/import', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'payment_plan_template'))) {
      throw new ForbiddenError('missing create:payment_plan_template permission');
    }
    const body = parseJsonBody<{ csv: string }>(ctx.body);
    const records = parseCsvRecords(body.csv);
    const projects = await inventory.listProjects(actor.companyId);
    const FREQUENCY_MAP: Record<string, PaymentFrequency> = {
      monthly: 'monthly',
      quarterly: 'quarterly',
      'semi-annually': 'semiannual',
      semiannual: 'semiannual',
      annually: 'annual',
      annual: 'annual',
      'one time': 'monthly', // cash plans: termMonths will be 0, so frequency is moot
    };
    const result = await runImport(
      records,
      ['Plan ID', 'Delivery Payment (%)', 'Discount Rate (%)', 'Maintenance Fee (%)', 'Status'],
      async (record) => {
        const name = record['Plan Name']?.trim();
        if (!name) throw new ValidationError('"Plan Name" is required');
        const downPaymentValue = Number((record['Down Payment (%)'] ?? '').replace('%', ''));
        if (!Number.isFinite(downPaymentValue)) throw new ValidationError('"Down Payment (%)" must be a number');
        const years = Number(record['Installment Years'] ?? '0');
        // A pure cash/one-time plan (0 installment years) still needs a
        // valid termMonths >= 1 (see schedule-generator.ts's real
        // validation) — mapped to 1 month, with the down payment already
        // covering the full amount for a 100%-down cash plan.
        const termMonths = Math.max(1, Number.isFinite(years) ? Math.round(years * 12) : 1);
        const frequencyKey = (record['Payment Frequency'] ?? '').trim().toLowerCase();
        const frequency = FREQUENCY_MAP[frequencyKey] ?? 'monthly';
        const applicableProjects = (record['Applicable Projects'] ?? '').split(',').map((p) => p.trim()).filter(Boolean);
        const projectId = applicableProjects.length === 1 ? projects.find((p) => p.name === applicableProjects[0])?.id : undefined;
        return paymentPlans.createTemplate({
          companyId: actor.companyId,
          projectId,
          name,
          downPaymentType: 'percentage',
          downPaymentValue,
          frequency,
          termMonths,
          fees: [],
        });
      },
    );
    return { status: 200, body: result };
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

  // ---- Quotations (Dynamic Payment Plan & Quotation Generator) ----
  // Reuses PaymentPlansService.previewSchedule under the hood (see
  // quotation.service.ts) — never a second calculation engine.
  interface QuotationRequestBody {
    unitId: string;
    paymentPlanTemplateId: string;
    discountPercent?: number;
    escalationPercentPerYear?: number;
    totalPriceOverride?: number;
    leadId?: string;
  }

  // Unit-code lookup — the Offer builder's entry point ("type a unit code,
  // auto-fill everything"): a salesperson knows the code on the price
  // list, never the unit's internal id.
  httpServer.get('/api/quotations/units/by-code/:code', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'quotation', { companyId: actor.companyId, ownerUserId: actor.userId }))) {
      throw new ForbiddenError('missing create:quotation permission');
    }
    const unit = await quotations.findUnitByCode(actor.companyId, ctx.params.code!);
    const project = await inventory.getProject(unit.projectId);
    return { status: 200, body: { unit, project } };
  });

  httpServer.post('/api/quotations/calculate', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'quotation', { companyId: actor.companyId, ownerUserId: actor.userId }))) {
      throw new ForbiddenError('missing create:quotation permission');
    }
    const body = parseJsonBody<QuotationRequestBody>(ctx.body);
    const calculation = await quotations.calculate(actor.companyId, body);
    return { status: 200, body: calculation };
  });

  httpServer.post('/api/quotations', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'quotation', { companyId: actor.companyId, ownerUserId: actor.userId }))) {
      throw new ForbiddenError('missing create:quotation permission');
    }
    const body = parseJsonBody<QuotationRequestBody>(ctx.body);
    const quotation = await quotations.generate({ ...body, companyId: actor.companyId, createdByUserId: actor.userId });
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'create', resource: 'quotation', resourceId: quotation.id });
    return { status: 201, body: quotation };
  });

  httpServer.get('/api/quotations', async (ctx) => {
    const actor = await actorOf(ctx);
    const scope = await rbac.getListAccessScope(actor.userId, 'view', 'quotation');
    if (scope.kind === 'none') return { status: 403, body: { error: 'missing view:quotation permission' } };
    const all = await quotations.listForCompany(actor.companyId, {
      unitId: ctx.query.get('unitId') ?? undefined,
      leadId: ctx.query.get('leadId') ?? undefined,
    });
    const filtered = await filterByListScope(all, scope, (q) => employeeScopeKeys(q.createdByUserId));
    return { status: 200, body: paginate(filtered, ctx.query) };
  });

  const quotationScopeCheck = async (actor: Actor, action: ActionName, quotationId: string) => {
    const quotation = await quotations.getQuotation(quotationId, actor.companyId);
    const ownerKeys = await employeeScopeKeys(quotation.createdByUserId);
    const allowed = await rbac.can(actor.userId, action, 'quotation', {
      companyId: quotation.companyId,
      ownerUserId: quotation.createdByUserId,
      departmentId: ownerKeys.departmentId,
      branchId: ownerKeys.branchId,
      managerEmployeeId: ownerKeys.managerEmployeeId,
    });
    if (!allowed) throw new ForbiddenError(`missing ${action}:quotation permission for this quotation`);
    return quotation;
  };

  httpServer.get('/api/quotations/:id', async (ctx) => {
    const actor = await actorOf(ctx);
    const quotation = await quotationScopeCheck(actor, 'view', ctx.params.id!);
    const { calculation } = await quotations.recompute(quotation.id, actor.companyId);
    return { status: 200, body: { quotation, calculation } };
  });

  httpServer.patch('/api/quotations/:id/status', async (ctx) => {
    const actor = await actorOf(ctx);
    await quotationScopeCheck(actor, 'edit', ctx.params.id!);
    const body = parseJsonBody<{ status: QuotationStatus }>(ctx.body);
    const updated = await quotations.updateStatus(ctx.params.id!, actor.companyId, body.status);
    return { status: 200, body: updated };
  });

  httpServer.get('/api/quotations/:id/excel', async (ctx) => {
    const actor = await actorOf(ctx);
    const quotation = await quotationScopeCheck(actor, 'view', ctx.params.id!);
    const { calculation } = await quotations.recompute(quotation.id, actor.companyId);
    const buffer = await buildQuotationWorkbook(quotation, calculation);
    return {
      status: 200,
      body: { filename: `${quotation.referenceNumber}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', base64: buffer.toString('base64') },
    };
  });

  // Returns a print-ready HTML document rather than a server-rendered PDF —
  // the frontend opens it and calls window.print() so the browser's own
  // "Save as PDF" produces the file; see quotation-export.service.ts for
  // why this avoids a fabricated server PDF pipeline.
  httpServer.get('/api/quotations/:id/print', async (ctx) => {
    const actor = await actorOf(ctx);
    const quotation = await quotationScopeCheck(actor, 'view', ctx.params.id!);
    const { calculation } = await quotations.recompute(quotation.id, actor.companyId);
    const html = buildQuotationPrintHtml(quotation, calculation, calculation.unit);
    return { status: 200, body: { html } };
  });

  httpServer.post('/api/quotations/:id/share', async (ctx) => {
    const actor = await actorOf(ctx);
    const quotation = await quotationScopeCheck(actor, 'view', ctx.params.id!);
    const body = parseJsonBody<{ channel: 'whatsapp' | 'email'; message: string; toUserId?: string }>(ctx.body);
    if (body.channel !== 'whatsapp' && body.channel !== 'email') throw new ValidationError('channel must be "whatsapp" or "email"');
    const message = await communication.sendMessage({
      companyId: actor.companyId,
      fromUserId: actor.userId,
      toUserId: body.toUserId,
      subject: `Quotation ${quotation.referenceNumber}`,
      body: body.message,
      channel: body.channel,
      relatedResource: 'quotation',
      relatedResourceId: quotation.id,
    });
    return { status: 201, body: message };
  });

  // Real, server-rendered Offer PDF — cover with project images, unit
  // info, the immutable payment schedule snapshot, master plan with this
  // unit highlighted, and the unit's own floor plan. See
  // offer-pdf.service.ts; any image URL that fails to resolve is simply
  // skipped, never a reason to fail generating the document.
  httpServer.get('/api/quotations/:id/pdf', async (ctx) => {
    const actor = await actorOf(ctx);
    const quotation = await quotationScopeCheck(actor, 'view', ctx.params.id!);
    const { calculation } = await quotations.recompute(quotation.id, actor.companyId);
    const project = await inventory.getProject(quotation.projectId);
    if (!project) throw new NotFoundError('project not found for this quotation');
    const images = await fetchOfferImages(calculation.unit, project);
    const buffer = await buildOfferPdf(quotation, calculation, calculation.unit, project, images);
    return {
      status: 200,
      body: { filename: `${quotation.referenceNumber}.pdf`, contentType: 'application/pdf', base64: buffer.toString('base64') },
    };
  });

  // Generates the real Offer PDF and sends it as an actual WhatsApp
  // document (not a link, not a log-only entry) via the connected Meta
  // Cloud API integration, then logs it to the lead's own communication
  // timeline (tagged relatedResource:'lead' — not 'quotation' — so it
  // surfaces on LeadTimelineService like any other lead activity).
  httpServer.post('/api/quotations/:id/send-whatsapp', async (ctx) => {
    const actor = await actorOf(ctx);
    const quotation = await quotationScopeCheck(actor, 'view', ctx.params.id!);
    const body = parseJsonBody<{ to: string; message?: string }>(ctx.body);
    if (!body.to?.trim()) throw new ValidationError('"to" (the recipient WhatsApp number) is required');

    const { calculation } = await quotations.recompute(quotation.id, actor.companyId);
    const project = await inventory.getProject(quotation.projectId);
    if (!project) throw new NotFoundError('project not found for this quotation');
    const images = await fetchOfferImages(calculation.unit, project);
    const buffer = await buildOfferPdf(quotation, calculation, calculation.unit, project, images);

    const caption = body.message?.trim() || `Offer ${quotation.referenceNumber} — ${project.name}, Unit ${calculation.unit.code}`;
    const result = await integrations.send(
      actor.companyId,
      'whatsapp',
      'send_document',
      { to: body.to.trim(), body: caption, documentBuffer: buffer, documentFilename: `${quotation.referenceNumber}.pdf`, leadId: quotation.leadId },
      actor.userId,
    );

    const message = await communication.sendMessage({
      companyId: actor.companyId,
      fromUserId: actor.userId,
      subject: `Offer ${quotation.referenceNumber}`,
      body: caption,
      channel: 'whatsapp',
      relatedResource: quotation.leadId ? 'lead' : 'quotation',
      relatedResourceId: quotation.leadId ?? quotation.id,
    });

    return { status: 201, body: { message, providerResult: result } };
  });

  // ---- Inventory ----
  httpServer.post('/api/inventory/projects', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'project'))) {
      throw new ForbiddenError('missing create:project permission');
    }
    const body = parseJsonBody<Parameters<typeof inventory.createProject>[0]>(ctx.body);
    const project = await inventory.createProject({ ...body, companyId: actor.companyId });
    return { status: 201, body: project };
  });

  // Real, server-side project search (destination/developer/price-range/
  // unit-type) — the same InventoryService.searchProjects the AI's
  // search_projects tool calls, so results never diverge. Falls back to
  // the plain list (no filters) when no query params are given, matching
  // the previous behavior exactly.
  httpServer.get('/api/inventory/projects', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'project'))) {
      throw new ForbiddenError('missing view:project permission');
    }
    const destination = ctx.query.get('destination') ?? undefined;
    const developerId = ctx.query.get('developerId') ?? undefined;
    const unitType = ctx.query.get('unitType') ?? undefined;
    const q = ctx.query.get('q') ?? undefined;
    const minPriceFromRaw = ctx.query.get('minPriceFrom');
    const maxPriceToRaw = ctx.query.get('maxPriceTo');
    const projects =
      destination || developerId || unitType || q || minPriceFromRaw || maxPriceToRaw
        ? await inventory.searchProjects(actor.companyId, {
            destination,
            developerId,
            unitType,
            q,
            minPriceFrom: minPriceFromRaw ? Number(minPriceFromRaw) : undefined,
            maxPriceTo: maxPriceToRaw ? Number(maxPriceToRaw) : undefined,
            limit: 200,
          })
        : await inventory.listProjects(actor.companyId);
    return { status: 200, body: paginate(projects, ctx.query) };
  });

  httpServer.get('/api/inventory/projects/:projectId', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'project'))) {
      throw new ForbiddenError('missing view:project permission');
    }
    return { status: 200, body: await inventory.getProjectFullDetails(ctx.params.projectId!, actor.companyId) };
  });

  httpServer.patch('/api/inventory/projects/:projectId', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'project'))) {
      throw new ForbiddenError('missing edit:project permission');
    }
    const body = parseJsonBody<Parameters<typeof inventory.updateProjectDetails>[2]>(ctx.body);
    const project = await inventory.updateProjectDetails(ctx.params.projectId!, actor.companyId, body);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'edit', resource: 'project', resourceId: project.id, metadata: { fields: Object.keys(body) } });
    return { status: 200, body: project };
  });

  // ---- Project master data: Developer / Phase / Launch / Facility /
  // Consultant / Sales Phone Number — all gated on the existing 'project'
  // RBAC resource (create/edit/view) rather than six new near-identical
  // resources, since these are project master data, not a separate
  // permission surface. ----
  httpServer.post('/api/inventory/developers', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'project'))) throw new ForbiddenError('missing create:project permission');
    const body = parseJsonBody<{ name: string; description?: string; website?: string; logoUrl?: string }>(ctx.body);
    return { status: 201, body: await inventory.createDeveloper({ ...body, companyId: actor.companyId }) };
  });

  httpServer.get('/api/inventory/developers', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'project'))) throw new ForbiddenError('missing view:project permission');
    return { status: 200, body: paginate(await inventory.listDevelopers(actor.companyId), ctx.query) };
  });

  httpServer.get('/api/inventory/developers/:developerId/portfolio', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'project'))) throw new ForbiddenError('missing view:project permission');
    const developer = await inventory.getDeveloper(ctx.params.developerId!);
    if (!developer || developer.companyId !== actor.companyId) throw new NotFoundError('developer not found');
    const projects = await inventory.getDeveloperPortfolio(ctx.params.developerId!, actor.companyId);
    return { status: 200, body: { developer, projects } };
  });

  httpServer.post('/api/inventory/projects/:projectId/phases', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'project'))) throw new ForbiddenError('missing create:project permission');
    const body = parseJsonBody<{ name: string; order?: number }>(ctx.body);
    return { status: 201, body: await inventory.createProjectPhase({ ...body, companyId: actor.companyId, projectId: ctx.params.projectId! }) };
  });

  httpServer.get('/api/inventory/projects/:projectId/phases', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'project'))) throw new ForbiddenError('missing view:project permission');
    return { status: 200, body: await inventory.listProjectPhases(actor.companyId, ctx.params.projectId!) };
  });

  httpServer.post('/api/inventory/projects/:projectId/launches', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'project'))) throw new ForbiddenError('missing create:project permission');
    const body = parseJsonBody<Omit<Parameters<typeof inventory.createLaunch>[0], 'companyId' | 'projectId'>>(ctx.body);
    return { status: 201, body: await inventory.createLaunch({ ...body, companyId: actor.companyId, projectId: ctx.params.projectId! }) };
  });

  httpServer.get('/api/inventory/projects/:projectId/launches', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'project'))) throw new ForbiddenError('missing view:project permission');
    return { status: 200, body: await inventory.listLaunches(actor.companyId, ctx.params.projectId!) };
  });

  httpServer.post('/api/inventory/facilities', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'project'))) throw new ForbiddenError('missing create:project permission');
    const body = parseJsonBody<{ name: string; category?: string }>(ctx.body);
    return { status: 201, body: await inventory.createFacility({ ...body, companyId: actor.companyId }) };
  });

  httpServer.get('/api/inventory/facilities', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'project'))) throw new ForbiddenError('missing view:project permission');
    return { status: 200, body: paginate(await inventory.listFacilities(actor.companyId), ctx.query) };
  });

  httpServer.get('/api/inventory/projects/:projectId/facilities', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'project'))) throw new ForbiddenError('missing view:project permission');
    return { status: 200, body: await inventory.getProjectFacilities(ctx.params.projectId!, actor.companyId) };
  });

  httpServer.post('/api/inventory/consultants', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'project'))) throw new ForbiddenError('missing create:project permission');
    const body = parseJsonBody<{ name: string; role: Consultant['role']; contactInfo?: string }>(ctx.body);
    return { status: 201, body: await inventory.createConsultant({ ...body, companyId: actor.companyId }) };
  });

  httpServer.get('/api/inventory/consultants', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'project'))) throw new ForbiddenError('missing view:project permission');
    const role = (ctx.query.get('role') as Consultant['role'] | null) ?? undefined;
    return { status: 200, body: paginate(await inventory.listConsultants(actor.companyId, role), ctx.query) };
  });

  httpServer.post('/api/inventory/projects/:projectId/sales-phone-numbers', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'project'))) throw new ForbiddenError('missing create:project permission');
    const body = parseJsonBody<{ phoneNumber: string; countryCode?: string; type?: string; source?: string }>(ctx.body);
    return { status: 201, body: await inventory.createSalesPhoneNumber({ ...body, companyId: actor.companyId, projectId: ctx.params.projectId! }) };
  });

  httpServer.get('/api/inventory/projects/:projectId/sales-phone-numbers', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'project'))) throw new ForbiddenError('missing view:project permission');
    return { status: 200, body: await inventory.listSalesPhoneNumbers(actor.companyId, ctx.params.projectId!) };
  });

  httpServer.post('/api/inventory/sales-phone-numbers/:phoneId/deactivate', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'project'))) throw new ForbiddenError('missing edit:project permission');
    return { status: 200, body: await inventory.deactivateSalesPhoneNumber(ctx.params.phoneId!, actor.companyId) };
  });

  // Project Unit Specs — a project's marketed product ranges (Unit Type +
  // Bedrooms -> BUA/price ranges), distinct from a physical Unit. Gated on
  // 'project', same as every other project-master-data entity above.
  httpServer.post('/api/inventory/projects/:projectId/unit-specs', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'project'))) throw new ForbiddenError('missing create:project permission');
    const body = parseJsonBody<Omit<Parameters<typeof inventory.createProjectUnitSpec>[0], 'companyId' | 'projectId'>>(ctx.body);
    return { status: 201, body: await inventory.createProjectUnitSpec({ ...body, companyId: actor.companyId, projectId: ctx.params.projectId! }) };
  });

  httpServer.get('/api/inventory/projects/:projectId/unit-specs', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'project'))) throw new ForbiddenError('missing view:project permission');
    return { status: 200, body: await inventory.listProjectUnitSpecs(actor.companyId, ctx.params.projectId!) };
  });

  httpServer.patch('/api/inventory/unit-specs/:specId', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'project'))) throw new ForbiddenError('missing edit:project permission');
    const body = parseJsonBody<Parameters<typeof inventory.updateProjectUnitSpec>[2]>(ctx.body);
    return { status: 200, body: await inventory.updateProjectUnitSpec(ctx.params.specId!, actor.companyId, body) };
  });

  httpServer.post('/api/inventory/units', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'unit'))) {
      throw new ForbiddenError('missing create:unit permission');
    }
    const body = parseJsonBody<Omit<Parameters<typeof inventory.createUnit>[0], 'companyId'>>(ctx.body);
    const unit = await inventory.createUnit({ ...body, companyId: actor.companyId });
    return { status: 201, body: unit };
  });

  // Bulk CSV import — one real inventory.createUnit() call per row, same
  // permission as the manual route above. Columns beyond the real Unit
  // schema (Building/Block, Floor, Bedrooms, etc.) aren't stored anywhere
  // yet, so they're reported back as unsupportedColumns rather than
  // silently dropped.
  httpServer.post('/api/inventory/units/import', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'unit'))) {
      throw new ForbiddenError('missing create:unit permission');
    }
    const body = parseJsonBody<{ csv: string }>(ctx.body);
    const records = parseCsvRecords(body.csv);
    const projects = await inventory.listProjects(actor.companyId);
    const result = await runImport(
      records,
      ['Building/Block', 'Floor', 'Bedrooms', 'Bathrooms', 'Finishing Type', 'View', 'Price per SQM (EGP)', 'Maintenance Fee (%)', 'Delivery Date', 'Status'],
      async (record) => {
        const projectName = record['Project Name']?.trim();
        const project = projects.find((p) => p.name === projectName);
        if (!project) throw new ValidationError(`project "${projectName}" not found — create it first`);
        const code = record['Unit ID']?.trim();
        const unitType = record['Unit Type']?.trim();
        const areaSqm = Number(record['Area (SQM)']);
        const listPrice = Number((record['Total Price (EGP)'] ?? '').replace(/,/g, ''));
        if (!code) throw new ValidationError('"Unit ID" is required');
        if (!unitType) throw new ValidationError('"Unit Type" is required');
        if (!Number.isFinite(areaSqm) || areaSqm <= 0) throw new ValidationError('"Area (SQM)" must be a positive number');
        if (!Number.isFinite(listPrice) || listPrice <= 0) throw new ValidationError('"Total Price (EGP)" must be a positive number');
        return inventory.createUnit({ companyId: actor.companyId, projectId: project.id, code, unitType, areaSqm, listPrice });
      },
    );
    return { status: 200, body: result };
  });

  // ---- Inventory Import pipeline (staged: upload -> preview -> confirm) ----
  // The richer alternative to the bulk-CSV route above, for real
  // Excel/PDF exports with unpredictable headers. Every row still only
  // ever writes through inventory.createUnit()/updateUnitDetails() — a
  // sold/reserved/contracted unit is always shown as a protected conflict,
  // never silently changed.

  httpServer.post(
    '/api/inventory/units/import/upload',
    async (ctx) => {
      const actor = await actorOf(ctx);
      if (!(await rbac.can(actor.userId, 'create', 'unit'))) {
        throw new ForbiddenError('missing create:unit permission');
      }
      const body = ctx.body as MultipartBody | undefined;
      const file = body?.files?.[0];
      if (!file) throw new ValidationError('a file upload ("file" field) is required');

      const session = await importSessions.createSession({
        companyId: actor.companyId,
        createdByUserId: actor.userId,
        targetType: 'inventory_unit',
        fileName: file.filename,
        fileBuffer: file.data,
        contentType: file.contentType,
        fields: INVENTORY_IMPORT_FIELDS,
        fillDownBlankCells: body?.fields?.fillDownBlankCells === 'true',
        // Only Developer/Project/Phase/Destination ever inherit a blank
        // cell from the row above — Price/BUA/Garden/Bedrooms/Status never
        // do, matching every real spreadsheet's actual merged-cell shape
        // (a title column merged down a block of rows; a price column
        // never is).
        hierarchicalFieldKeys: ['projectName', 'developerName', 'phaseName', 'destination'],
        sheetNameAsColumn: body?.fields?.sheetNameAsProject === 'true' ? 'Project' : undefined,
      });
      // Informational only — classifies the detected columns as a project-
      // catalog table, a live-availability table, a summary/fact-sheet, or
      // unrecognized, so the frontend can suggest the right import mode
      // instead of the user having to guess. Never changes what gets
      // imported; the user's own mode choice at the preview step does.
      const detectedSheetKind = classifySheet(session.detectedColumns, CATALOG_IMPORT_FIELDS, AVAILABILITY_IMPORT_FIELDS, CATALOG_ANCHOR_KEYS, AVAILABILITY_ANCHOR_KEYS);
      return {
        status: 200,
        body: {
          sessionId: session.id,
          fileName: session.fileName,
          fileType: session.fileType,
          detectedColumns: session.detectedColumns,
          suggestedMapping: session.suggestedMapping,
          sampleRows: session.rawRows.slice(0, 5),
          totalRows: session.rawRows.length,
          fields: INVENTORY_IMPORT_FIELDS,
          detectedSheetKind,
        },
      };
    },
    { maxBodyBytes: IMPORT_MAX_BODY_BYTES },
  );

  httpServer.post('/api/inventory/units/import/:sessionId/preview', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'unit'))) {
      throw new ForbiddenError('missing create:unit permission');
    }
    const body = parseJsonBody<{ mapping: Record<string, string | null>; options?: InventoryImportOptions & { mode?: 'availability' | 'catalog' } }>(ctx.body);
    const session = await importSessions.confirmMapping(ctx.params.sessionId!, actor.companyId, body.mapping, body.options as Record<string, unknown> | undefined);
    const mappedRows = importSessions.mapRows(session);
    // 'catalog' mode never writes a physical Unit — a Project Catalog
    // workbook describes a product range (see inventory-import.service.ts's
    // own top-of-file comment), not individually coded units.
    const preview =
      body.options?.mode === 'catalog'
        ? await inventoryImport.buildProjectUnitSpecPreview(actor.companyId, mappedRows, body.options)
        : await inventoryImport.buildPreview(actor.companyId, mappedRows, body.options);
    return { status: 200, body: preview };
  });

  httpServer.post('/api/inventory/units/import/:sessionId/confirm', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'unit'))) {
      throw new ForbiddenError('missing create:unit permission');
    }
    const session = await importSessions.getSession(ctx.params.sessionId!, actor.companyId);
    if (!session.confirmedMapping) {
      throw new ValidationError('this import session has not been mapped yet — call the preview step first');
    }
    const mappedRows = importSessions.mapRows(session);
    const options = session.importOptions as (InventoryImportOptions & { mode?: 'availability' | 'catalog' }) | undefined;
    const result =
      options?.mode === 'catalog'
        ? await inventoryImport.importProjectUnitSpecRows(actor.companyId, mappedRows, options, { sourceImportId: session.id })
        : await inventoryImport.importRows(
            actor.companyId,
            mappedRows,
            async (unit, action) => {
              await auditLog.record({
                companyId: actor.companyId,
                actorUserId: actor.userId,
                action: action === 'create' ? 'create' : 'edit',
                resource: 'unit',
                resourceId: unit.id,
                metadata: { importedViaFile: true, importSessionId: session.id, fileName: session.fileName },
              });
            },
            options,
            { sourceImportId: session.id },
          );
    if (options?.mode === 'catalog') {
      for (const r of (result as Awaited<ReturnType<typeof inventoryImport.importProjectUnitSpecRows>>).results) {
        if (r.specId) {
          await auditLog.record({
            companyId: actor.companyId,
            actorUserId: actor.userId,
            action: r.status === 'created' ? 'create' : 'edit',
            resource: 'project',
            resourceId: r.specId,
            metadata: { importedViaFile: true, importSessionId: session.id, fileName: session.fileName, entity: 'project_unit_spec' },
          });
        }
      }
    }
    await importSessions.markConfirmed(session.id, actor.companyId);
    return { status: 200, body: result };
  });

  // Import History — lists past import sessions for this company across all
  // targets (lead/inventory_unit/payment), newest first. Gated on view:unit
  // since inventory is the primary consumer today; a company with no
  // create:unit access sees an empty toolbar entry point instead (see
  // frontend), never a 403 surprise on an otherwise-visible page.
  httpServer.get('/api/imports/history', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'unit'))) {
      throw new ForbiddenError('missing view:unit permission');
    }
    const targetTypeParam = ctx.query.get('targetType');
    const validTargetTypes = ['lead', 'inventory_unit', 'payment'] as const;
    const targetType = validTargetTypes.find((t) => t === targetTypeParam);
    const sessions = await importSessions.listForCompany(actor.companyId, targetType);
    return { status: 200, body: sessions };
  });

  // ---- Document Intelligence (bounded) ----
  // Real field extraction from a text-bearing PDF (a unit spec sheet,
  // reservation form) — distinct from the tabular CSV/Excel importers
  // above. Gated on the same create/view:unit grants as inventory import
  // since its only import target is a Unit. Never auto-imports: every run
  // requires an explicit confirm step, and confirmExtraction() itself
  // refuses when a required field is missing or unreviewed low-confidence
  // (see DocumentIntelligenceService's class doc comment).
  httpServer.post(
    '/api/documents/extract/upload',
    async (ctx) => {
      const actor = await actorOf(ctx);
      if (!(await rbac.can(actor.userId, 'create', 'unit'))) {
        throw new ForbiddenError('missing create:unit permission');
      }
      const body = ctx.body as MultipartBody | undefined;
      const file = body?.files?.[0];
      if (!file) throw new ValidationError('a file upload ("file" field) is required');
      const { run, fields } = await documentIntelligence.extractFromPdf(actor.companyId, actor.userId, file.filename, file.data);
      await auditLog.record({
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: 'create',
        resource: 'unit',
        resourceId: run.id,
        metadata: { documentExtraction: true, fileName: run.fileName, status: run.status },
      });
      return { status: 201, body: { run, fields } };
    },
    { maxBodyBytes: IMPORT_MAX_BODY_BYTES },
  );

  httpServer.get('/api/documents/extract', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'unit'))) {
      throw new ForbiddenError('missing view:unit permission');
    }
    const runs = await documentIntelligence.listRuns(actor.companyId);
    return { status: 200, body: paginate(runs, ctx.query) };
  });

  httpServer.get('/api/documents/extract/:runId', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'unit'))) {
      throw new ForbiddenError('missing view:unit permission');
    }
    const run = await documentIntelligence.getRun(ctx.params.runId!, actor.companyId);
    const fields = await documentIntelligence.listFields(run.id, actor.companyId);
    return { status: 200, body: { run, fields } };
  });

  httpServer.post('/api/documents/extract/fields/:fieldId/correct', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'unit'))) {
      throw new ForbiddenError('missing create:unit permission');
    }
    const body = parseJsonBody<{ correctedValue: string }>(ctx.body);
    const field = await documentIntelligence.correctField(ctx.params.fieldId!, actor.companyId, body.correctedValue);
    return { status: 200, body: field };
  });

  httpServer.post('/api/documents/extract/:runId/review', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'unit'))) {
      throw new ForbiddenError('missing create:unit permission');
    }
    const run = await documentIntelligence.markReviewed(ctx.params.runId!, actor.companyId, actor.userId);
    return { status: 200, body: run };
  });

  httpServer.post('/api/documents/extract/:runId/reject', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'unit'))) {
      throw new ForbiddenError('missing create:unit permission');
    }
    const run = await documentIntelligence.rejectExtraction(ctx.params.runId!, actor.companyId, actor.userId);
    return { status: 200, body: run };
  });

  httpServer.post('/api/documents/extract/:runId/confirm', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'unit'))) {
      throw new ForbiddenError('missing create:unit permission');
    }
    const body = parseJsonBody<{ options?: InventoryImportOptions }>(ctx.body);
    const result = await documentIntelligence.confirmExtraction(
      ctx.params.runId!,
      actor.companyId,
      actor.userId,
      async (unit, action) => {
        await auditLog.record({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: action === 'create' ? 'create' : 'edit',
          resource: 'unit',
          resourceId: unit.id,
          metadata: { importedViaDocumentExtraction: true, extractionRunId: ctx.params.runId },
        });
      },
      body.options,
    );
    return { status: 200, body: result };
  });

  // Real, server-side advanced search — the same InventoryService.searchUnits
  // the AI's search_units tool calls, so a human's filter results and the
  // AI's never quietly diverge. `status` defaults to 'any' here (unlike the
  // AI tool's 'available' default) to preserve this route's previous
  // behavior of listing every unit regardless of status when unfiltered.
  httpServer.get('/api/inventory/units', async (ctx) => {
    const actor = await actorOf(ctx);
    const scope = await rbac.getListAccessScope(actor.userId, 'view', 'unit');
    if (scope.kind === 'none') return { status: 403, body: { error: 'missing view:unit permission' } };
    const numOrUndef = (v: string | null) => (v ? Number(v) : undefined);
    const units = await inventory.searchUnits(actor.companyId, {
      projectId: ctx.query.get('projectId') ?? undefined,
      phaseId: ctx.query.get('phaseId') ?? undefined,
      unitType: ctx.query.get('unitType') ?? undefined,
      status: (ctx.query.get('status') as 'available' | 'held' | 'reserved' | 'contracted' | 'cancelled' | 'any' | null) ?? 'any',
      minPrice: numOrUndef(ctx.query.get('minPrice')),
      maxPrice: numOrUndef(ctx.query.get('maxPrice')),
      minAreaSqm: numOrUndef(ctx.query.get('minAreaSqm')),
      maxAreaSqm: numOrUndef(ctx.query.get('maxAreaSqm')),
      minGardenAreaSqm: numOrUndef(ctx.query.get('minGardenAreaSqm')),
      maxGardenAreaSqm: numOrUndef(ctx.query.get('maxGardenAreaSqm')),
      bedrooms: numOrUndef(ctx.query.get('bedrooms')),
      minBedrooms: numOrUndef(ctx.query.get('minBedrooms')),
      maxBedrooms: numOrUndef(ctx.query.get('maxBedrooms')),
      finishingType: ctx.query.get('finishingType') ?? undefined,
      view: ctx.query.get('view') ?? undefined,
      floorLabel: ctx.query.get('floorLabel') ?? undefined,
      designType: ctx.query.get('designType') ?? undefined,
      destination: ctx.query.get('destination') ?? undefined,
      developerId: ctx.query.get('developerId') ?? undefined,
      limit: 500,
    });
    const filtered = searchFilter(units, ['code', 'unitType'], ctx.query.get('q'));
    return { status: 200, body: paginate(filtered, ctx.query) };
  });

  // Manual unit edit route — previously updateUnitDetails() was only ever
  // reachable through the bulk import pipeline, with no way to correct a
  // single unit's commercial/descriptive fields (or set its floor-plan
  // image / master-plan highlight position, both otherwise write-only
  // dead fields) outside of a full re-import.
  httpServer.patch('/api/inventory/units/:unitId', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'unit'))) {
      throw new ForbiddenError('missing edit:unit permission');
    }
    const body = parseJsonBody<Parameters<typeof inventory.updateUnitDetails>[2]>(ctx.body);
    const unit = await inventory.updateUnitDetails(ctx.params.unitId!, actor.companyId, body);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'edit', resource: 'unit', resourceId: unit.id, metadata: { fields: Object.keys(body) } });
    return { status: 200, body: unit };
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

  httpServer.get('/api/inventory/reservations', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'unit'))) {
      throw new ForbiddenError('missing view:unit permission');
    }
    const status = ctx.query.get('status') as Reservation['status'] | null;
    const reservations = await inventory.listReservations(actor.companyId, status ?? undefined);
    return { status: 200, body: paginate(reservations, ctx.query) };
  });

  // Manual trigger for the same sweep main.ts's 60s tick runs — mirrors
  // POST /api/finance/sweep-overdue's shape for expired reservations.
  httpServer.post('/api/inventory/sweep-expired-reservations', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'unit'))) {
      throw new ForbiddenError('missing edit:unit permission');
    }
    const count = await sweepExpiredReservationsAndEmit(actor.companyId);
    return { status: 200, body: { swept: count } };
  });

  // ---- CRM ----
  httpServer.post('/api/crm/leads', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'lead'))) {
      throw new ForbiddenError('missing create:lead permission');
    }
    const body = parseJsonBody<{
      fullName: string;
      phone: string;
      email?: string;
      nationalId?: string;
      sourceId?: string;
      stageId?: string;
      tags?: string[];
      priority?: Lead['priority'];
      ownerEmployeeUserId?: string;
      requiredSkill?: string;
    }>(ctx.body);
    // An explicit ownerEmployeeUserId always wins. Otherwise, if this
    // company has configured a Lead Distribution pool, hand the lead to
    // whichever employee is next in rotation (round-robin, or the next
    // matching skill_based candidate) and start its first-contact SLA
    // clock; a company that never configures a pool sees the exact same
    // "creator owns it" behavior this route always had.
    let ownerEmployeeUserId = body.ownerEmployeeUserId;
    let firstContactSlaDueAt: string | undefined;
    if (!ownerEmployeeUserId) {
      const assignment = await leadDistribution.pickOwnerForNewLead(actor.companyId, body.requiredSkill);
      if (assignment) {
        ownerEmployeeUserId = assignment.ownerUserId;
        firstContactSlaDueAt = assignment.firstContactSlaDueAt;
      }
    }
    const lead = await crm.createLead({
      companyId: actor.companyId,
      fullName: body.fullName,
      phone: body.phone,
      email: body.email,
      nationalId: body.nationalId,
      sourceId: body.sourceId,
      stageId: body.stageId,
      tags: body.tags,
      priority: body.priority,
      requiredSkill: body.requiredSkill,
      ownerEmployeeUserId: ownerEmployeeUserId ?? actor.userId,
      firstContactSlaDueAt,
    });
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'create', resource: 'lead', resourceId: lead.id });
    await emitEvent({ companyId: actor.companyId, type: 'lead.created', payload: { ...lead }, actorUserId: actor.userId, dedupeKey: `lead.created:${lead.id}` });
    return { status: 201, body: lead };
  });

  // ---- CRM Stages ----
  // The configurable pipeline behind the CRM workspace's tabs/cards — an
  // admin can add, edit, reorder, and archive stages with zero code
  // changes; every place that classifies a Lead (scoring, automation, AI,
  // analytics) reads the isDefault/isWon/isLost/order flags, never a
  // hardcoded stage name, so a custom stage behaves correctly immediately.
  httpServer.get('/api/crm/stages', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'crm_stage'))) {
      throw new ForbiddenError('missing view:crm_stage permission');
    }
    const includeInactive = ctx.query.get('includeInactive') === 'true';
    const stages = await crmStages.listStages(actor.companyId, includeInactive);
    return { status: 200, body: stages };
  });

  httpServer.post('/api/crm/stages', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'crm_stage'))) {
      throw new ForbiddenError('missing create:crm_stage permission');
    }
    const body = parseJsonBody<Parameters<CrmStageService['createStage']>[0]>(ctx.body);
    const stage = await crmStages.createStage({ ...body, companyId: actor.companyId });
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'create', resource: 'crm_stage', resourceId: stage.id });
    return { status: 201, body: stage };
  });

  httpServer.patch('/api/crm/stages/:stageId', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'crm_stage'))) {
      throw new ForbiddenError('missing edit:crm_stage permission');
    }
    const body = parseJsonBody<Parameters<CrmStageService['updateStage']>[2]>(ctx.body);
    const stage = await crmStages.updateStage(ctx.params.stageId!, actor.companyId, body);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'edit', resource: 'crm_stage', resourceId: stage.id });
    return { status: 200, body: stage };
  });

  httpServer.post('/api/crm/stages/reorder', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'crm_stage'))) {
      throw new ForbiddenError('missing edit:crm_stage permission');
    }
    const body = parseJsonBody<{ orderedStageIds: string[] }>(ctx.body);
    const stages = await crmStages.reorderStages(actor.companyId, body.orderedStageIds);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'edit', resource: 'crm_stage', resourceId: actor.companyId, metadata: { reordered: true } });
    return { status: 200, body: stages };
  });

  httpServer.post('/api/crm/stages/:stageId/set-default', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'crm_stage'))) {
      throw new ForbiddenError('missing edit:crm_stage permission');
    }
    const stage = await crmStages.setDefaultStage(ctx.params.stageId!, actor.companyId);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'edit', resource: 'crm_stage', resourceId: stage.id, metadata: { setDefault: true } });
    return { status: 200, body: stage };
  });

  httpServer.post('/api/crm/stages/:stageId/archive', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'delete', 'crm_stage'))) {
      throw new ForbiddenError('missing delete:crm_stage permission');
    }
    const stage = await crmStages.archiveStage(ctx.params.stageId!, actor.companyId);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'delete', resource: 'crm_stage', resourceId: stage.id });
    return { status: 200, body: stage };
  });

  // ---- Lead Distribution + SLA ----
  // Configuring/viewing the pool is a company-wide edit on the lead
  // resource — the same permission assign_lead_owner already maps to
  // (see automation.service.ts ACTION_RESOURCE/ACTION_VERB) — rather than
  // a new resource, since this is still "how leads get owned," just
  // automated instead of manual.
  httpServer.post('/api/crm/lead-distribution/pool', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'lead'))) {
      throw new ForbiddenError('missing edit:lead permission');
    }
    const body = parseJsonBody<{ mode: 'round_robin' | 'skill_based'; memberUserIds: string[]; slaMinutes: number }>(ctx.body);
    const pool = await leadDistribution.configurePool({ companyId: actor.companyId, ...body });
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'edit', resource: 'lead', resourceId: pool.id, metadata: { leadDistributionPool: true } });
    return { status: 200, body: pool };
  });

  httpServer.get('/api/crm/lead-distribution/pool', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'lead'))) {
      throw new ForbiddenError('missing view:lead permission');
    }
    const pool = await leadDistribution.getPool(actor.companyId);
    if (!pool) return { status: 404, body: { error: 'no lead distribution pool configured for this company' } };
    return { status: 200, body: pool };
  });

  // Manual trigger for the same sweep main.ts's periodic tick runs — lets
  // an admin (or a test) force an immediate pass instead of waiting for
  // leads to actually breach on the clock.
  httpServer.post('/api/crm/lead-distribution/sweep', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'lead'))) {
      throw new ForbiddenError('missing edit:lead permission');
    }
    const swept = await sweepSlaBreachesAndEmit(actor.companyId);
    return { status: 200, body: { swept } };
  });

  // Bulk CSV import — one real crm.createLead() call per row, same
  // permission and the same audit/event trail (lead.created) as the
  // manual route above, so imported leads flow through the Automation
  // Engine and AI Execution Layer exactly like manually-entered ones.
  httpServer.post('/api/crm/leads/import', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'lead'))) {
      throw new ForbiddenError('missing create:lead permission');
    }
    const body = parseJsonBody<{ csv: string }>(ctx.body);
    const records = parseCsvRecords(body.csv);
    const companyUsers = await repos.users.findAll((u) => u.companyId === actor.companyId);
    const result = await runImport(
      records,
      ['Lead ID', 'Lead Source', 'Interested Project', 'Interested Unit Type', 'Budget Min (EGP)', 'Budget Max (EGP)', 'Preferred Payment Plan', 'Lead Status', 'Priority', 'Notes'],
      async (record) => {
        const fullName = `${record['First Name'] ?? ''} ${record['Last Name'] ?? ''}`.trim();
        const phone = record['Phone']?.trim();
        const email = record['Email']?.trim() || undefined;
        if (!fullName) throw new ValidationError('"First Name"/"Last Name" are required');
        if (!phone) throw new ValidationError('"Phone" is required');
        const agentEmail = record['Assigned Sales Agent']?.trim();
        const owner = agentEmail ? companyUsers.find((u) => u.email === agentEmail) : undefined;
        const lead = await crm.createLead({ companyId: actor.companyId, fullName, phone, email, ownerEmployeeUserId: owner?.id ?? actor.userId });
        await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'create', resource: 'lead', resourceId: lead.id, metadata: { importedViaCsv: true } });
        await emitEvent({ companyId: actor.companyId, type: 'lead.created', payload: { ...lead }, actorUserId: actor.userId, dedupeKey: `lead.created:${lead.id}` });
        return lead;
      },
    );
    return { status: 200, body: result };
  });

  // ---- Lead Import pipeline (staged: upload -> preview -> confirm) ----
  // A richer alternative to the one-shot bulk-CSV route above, for real
  // Excel/CSV/PDF exports with unpredictable column headers: upload parses
  // the file and suggests a mapping, preview shows exactly what would be
  // imported (including duplicates/invalid rows) without writing anything,
  // and confirm is the only step that actually calls crm.createLead.

  httpServer.post(
    '/api/crm/leads/import/upload',
    async (ctx) => {
      const actor = await actorOf(ctx);
      if (!(await rbac.can(actor.userId, 'create', 'lead'))) {
        throw new ForbiddenError('missing create:lead permission');
      }
      const body = ctx.body as MultipartBody | undefined;
      const file = body?.files?.[0];
      if (!file) throw new ValidationError('a file upload ("file" field) is required');

      const session = await importSessions.createSession({
        companyId: actor.companyId,
        createdByUserId: actor.userId,
        targetType: 'lead',
        fileName: file.filename,
        fileBuffer: file.data,
        contentType: file.contentType,
        fields: LEAD_IMPORT_FIELDS,
      });
      return {
        status: 200,
        body: {
          sessionId: session.id,
          fileName: session.fileName,
          fileType: session.fileType,
          detectedColumns: session.detectedColumns,
          suggestedMapping: session.suggestedMapping,
          sampleRows: session.rawRows.slice(0, 5),
          totalRows: session.rawRows.length,
          fields: LEAD_IMPORT_FIELDS,
        },
      };
    },
    { maxBodyBytes: IMPORT_MAX_BODY_BYTES },
  );

  httpServer.post('/api/crm/leads/import/:sessionId/preview', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'lead'))) {
      throw new ForbiddenError('missing create:lead permission');
    }
    const body = parseJsonBody<{ mapping: Record<string, string | null> }>(ctx.body);
    const session = await importSessions.confirmMapping(ctx.params.sessionId!, actor.companyId, body.mapping);
    const mappedRows = importSessions.mapRows(session);
    const preview = await leadImport.buildPreview(actor.companyId, mappedRows);
    return { status: 200, body: preview };
  });

  httpServer.post('/api/crm/leads/import/:sessionId/confirm', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'lead'))) {
      throw new ForbiddenError('missing create:lead permission');
    }
    const session = await importSessions.getSession(ctx.params.sessionId!, actor.companyId);
    if (!session.confirmedMapping) {
      throw new ValidationError('this import session has not been mapped yet — call the preview step first');
    }
    const mappedRows = importSessions.mapRows(session);
    const result = await leadImport.importRows(actor.companyId, actor.userId, mappedRows, async (lead) => {
      await auditLog.record({
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: 'create',
        resource: 'lead',
        resourceId: lead.id,
        metadata: { importedViaFile: true, importSessionId: session.id, fileName: session.fileName },
      });
      await emitEvent({ companyId: actor.companyId, type: 'lead.created', payload: { ...lead }, actorUserId: actor.userId, dedupeKey: `lead.created:${lead.id}` });
    });
    await importSessions.markConfirmed(session.id, actor.companyId);
    return { status: 200, body: result };
  });

  httpServer.get('/api/crm/leads', async (ctx) => {
    const actor = await actorOf(ctx);
    const scope = await rbac.getListAccessScope(actor.userId, 'view', 'lead');
    if (scope.kind === 'none') return { status: 403, body: { error: 'missing view:lead permission' } };
    let leads = await crm.listForScope(scope, (lead) => employeeScopeKeys(lead.ownerEmployeeUserId));
    const stageId = ctx.query.get('stageId');
    if (stageId) leads = leads.filter((l) => l.stageId === stageId);
    const filtered = searchFilter(leads, ['fullName', 'phone', 'email'], ctx.query.get('q'));
    return { status: 200, body: paginate(filtered, ctx.query) };
  });

  httpServer.get('/api/crm/leads/:leadId', async (ctx) => {
    const actor = await actorOf(ctx);
    const lead = await crm.getLead(ctx.params.leadId!);
    if (!lead || lead.companyId !== actor.companyId) throw new NotFoundError('lead not found');
    const ownerKeys = await employeeScopeKeys(lead.ownerEmployeeUserId);
    const allowed = await rbac.can(actor.userId, 'view', 'lead', {
      companyId: lead.companyId,
      ownerUserId: lead.ownerEmployeeUserId,
      departmentId: ownerKeys.departmentId,
      branchId: ownerKeys.branchId,
      managerEmployeeId: ownerKeys.managerEmployeeId,
    });
    if (!allowed) throw new ForbiddenError('missing view:lead permission for this lead');
    return { status: 200, body: lead };
  });

  httpServer.patch('/api/crm/leads/:leadId/stage', async (ctx) => {
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
    const body = parseJsonBody<{ stageId: string; lostReason?: string }>(ctx.body);
    const fromStageId = lead.stageId;
    const updated = await crm.moveToStage(ctx.params.leadId!, actor.companyId, body.stageId, body.lostReason);
    const stage = await crmStages.getStage(updated.stageId, actor.companyId);
    // Previously-unfixed gap: this route never wrote to the audit trail at
    // all, so a lead's stage history had no persisted record beyond its
    // current value — the Lead Timeline (GET .../timeline below) and
    // AnalyticsService.speedToFirstContact both read this `toStageId`
    // metadata to reconstruct that history.
    await auditLog.record({
      companyId: actor.companyId,
      actorUserId: actor.userId,
      action: 'edit',
      resource: 'lead',
      resourceId: updated.id,
      // toStatus is kept (as the new stage's display name, not a legacy
      // enum value) purely so LeadTimelineService's existing
      // `typeof meta.toStatus === 'string'` detection — intentionally left
      // unmodified, see the CRM restructuring plan — still renders a
      // readable "Status changed to ..." timeline entry for stage moves.
      metadata: { fromStageId, toStageId: updated.stageId, toStatus: stage.name, lostReason: updated.lostReason },
    });
    // Both events fire together during the transition period: 'status_changed'
    // keeps any pre-existing workflow/AiPolicy row triggered on the legacy
    // name working unchanged, while 'stage_changed' (carrying the
    // human-readable stageKey/stageName at the top level, for simple
    // workflow-condition matching) is what new templates should target.
    await emitEvent({
      companyId: actor.companyId,
      type: 'lead.status_changed',
      payload: { ...updated },
      actorUserId: actor.userId,
      dedupeKey: `lead.status_changed:${updated.id}:${updated.stageId}`,
    });
    await emitEvent({
      companyId: actor.companyId,
      type: 'lead.stage_changed',
      payload: { ...updated, stageKey: stage.key, stageName: stage.name },
      actorUserId: actor.userId,
      dedupeKey: `lead.stage_changed:${updated.id}:${updated.stageId}`,
    });
    return { status: 200, body: updated };
  });

  // Progressive custom-field capture: an agent fills these real-estate/
  // financial qualifying details in as they learn more, not all at once.
  httpServer.patch('/api/crm/leads/:leadId/details', async (ctx) => {
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
    const body = parseJsonBody<{
      propertyTypeWanted?: string;
      purchaseGoal?: string;
      preferredLocation?: string;
      minAreaSqm?: number;
      maxAreaSqm?: number;
      expectedDeliveryTimeline?: string;
      maxDownPayment?: number;
      maxInstallment?: number;
      preferredTenorMonths?: number;
      preferredTransferMethod?: string;
    }>(ctx.body);
    const updated = await crm.updateCustomFields(ctx.params.leadId!, actor.companyId, body);
    return { status: 200, body: updated };
  });

  httpServer.patch('/api/crm/leads/:leadId/owner', async (ctx) => {
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
    const body = parseJsonBody<{ ownerEmployeeUserId: string }>(ctx.body);
    const updated = await crm.assignOwner(ctx.params.leadId!, actor.companyId, body.ownerEmployeeUserId);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'assign', resource: 'lead', resourceId: updated.id, metadata: { newOwnerUserId: updated.ownerEmployeeUserId } });
    return { status: 200, body: updated };
  });

  httpServer.patch('/api/crm/leads/:leadId/tags', async (ctx) => {
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
    const body = parseJsonBody<{ tags?: string[]; priority?: Lead['priority'] }>(ctx.body);
    const updated = await crm.updateTagsAndPriority(ctx.params.leadId!, actor.companyId, body);
    return { status: 200, body: updated };
  });

  // Unified Lead Timeline: everything ACTIVE actually recorded about this
  // lead (status/owner history, messages, tasks, opportunity, contract),
  // in one chronological view.
  httpServer.get('/api/crm/leads/:leadId/timeline', async (ctx) => {
    const actor = await actorOf(ctx);
    const lead = await crm.getLead(ctx.params.leadId!);
    if (!lead || lead.companyId !== actor.companyId) throw new NotFoundError('lead not found');
    const ownerKeys = await employeeScopeKeys(lead.ownerEmployeeUserId);
    const allowed = await rbac.can(actor.userId, 'view', 'lead', {
      companyId: lead.companyId,
      ownerUserId: lead.ownerEmployeeUserId,
      departmentId: ownerKeys.departmentId,
      branchId: ownerKeys.branchId,
      managerEmployeeId: ownerKeys.managerEmployeeId,
    });
    if (!allowed) throw new ForbiddenError('missing view:lead permission for this lead');
    const timeline = await leadTimeline.getTimeline(ctx.params.leadId!, actor.companyId);
    return { status: 200, body: timeline };
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

  // Discount governance: a company that never configures this sees zero
  // change from the discount behavior it always had — any discount can
  // still be applied directly.
  httpServer.post('/api/sales/discount-policy', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'contract'))) {
      throw new ForbiddenError('missing edit:contract permission');
    }
    const body = parseJsonBody<{ maxDiscountPercentWithoutApproval: number }>(ctx.body);
    const policy = await sales.setDiscountApprovalPolicy(actor.companyId, body.maxDiscountPercentWithoutApproval);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'edit', resource: 'contract', resourceId: policy.id, metadata: { discountPolicy: true } });
    return { status: 200, body: policy };
  });

  httpServer.get('/api/sales/discount-policy', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'contract'))) {
      throw new ForbiddenError('missing view:contract permission');
    }
    const policy = await sales.getDiscountApprovalPolicy(actor.companyId);
    if (!policy) return { status: 404, body: { error: 'no discount approval policy configured for this company' } };
    return { status: 200, body: policy };
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
    if (!body.reservationId) throw new ValidationError('"reservationId" is required');
    if (!body.paymentPlanTemplateId) throw new ValidationError('"paymentPlanTemplateId" is required');
    if (!Number.isFinite(body.totalPrice) || body.totalPrice <= 0) throw new ValidationError('"totalPrice" must be a positive number');
    const creditedEmployeeUserId = await resolveCreditedEmployee(actor.companyId, body.reservationId, actor.userId);
    const signInput = {
      reservationId: body.reservationId,
      creditedEmployeeUserId,
      paymentPlanTemplateId: body.paymentPlanTemplateId,
      totalPrice: body.totalPrice,
      discountPercent: body.discountPercent,
      escalationPercentPerYear: body.escalationPercentPerYear,
    };

    // Universal Approval Engine, wired in for the one real ungoverned
    // action this system had: a discount of any size could always be
    // applied at signing with no oversight. A company that never
    // configures a policy sees no change — sales.discountRequiresApproval
    // returns false with nothing configured.
    if (await sales.discountRequiresApproval(actor.companyId, body.discountPercent)) {
      const approval = await approvalEngine.requestApproval({
        companyId: actor.companyId,
        actionType: 'discount_override',
        requestedByUserId: actor.userId,
        reason: `Discount of ${body.discountPercent}% exceeds the company's no-approval threshold`,
        context: signInput,
      });
      await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'create', resource: 'approval', resourceId: approval.id, metadata: { actionType: 'discount_override' } });
      await emitEvent({ companyId: actor.companyId, type: 'action_approval.requested', payload: { ...approval }, actorUserId: actor.userId, dedupeKey: `action_approval.requested:${approval.id}` });
      return { status: 202, body: approval };
    }

    const contract = await finishContractSigning(actor.companyId, signInput, actor.userId);
    return { status: 201, body: contract };
  });

  // Bulk CSV import for reservations/contracts. Unlike the other import
  // routes, this can't be a single create() call per row: a contract only
  // exists after reserving a real unit for a real opportunity, and that
  // reservation is concurrency-protected (see SalesService/InventoryService)
  // precisely to stop double-booking. So each row resolves human-friendly
  // keys (customer phone, project+unit code, plan name) to real records
  // and then drives the exact same protected pipeline the manual UI does —
  // createOpportunity -> reserveUnitForOpportunity -> signContract — never
  // a shortcut around it. A "Reservation" row stops after reserving; a
  // "Contract" row also signs.
  httpServer.post('/api/sales/contracts/import', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'contract'))) {
      throw new ForbiddenError('missing create:contract permission');
    }
    if (!(await rbac.can(actor.userId, 'create', 'opportunity'))) {
      throw new ForbiddenError('missing create:opportunity permission');
    }
    const body = parseJsonBody<{ csv: string }>(ctx.body);
    const records = parseCsvRecords(body.csv);
    const [leads, projects, units, templates, opportunities] = await Promise.all([
      repos.leads.findAll((l) => l.companyId === actor.companyId),
      inventory.listProjects(actor.companyId),
      inventory.listUnits(actor.companyId),
      paymentPlans.listTemplates(actor.companyId),
      sales.listOpportunities(actor.companyId),
    ]);
    const result = await runImport(
      records,
      ['Contract/Reservation ID', 'Reservation Deposit (EGP)', 'Reservation Date', 'Expiry Date', 'Status', 'Assigned Agent', 'Broker Name', 'Notes'],
      async (record) => {
        const phone = record['Customer Phone']?.trim();
        const lead = leads.find((l) => l.phone === phone);
        if (!lead) throw new ValidationError(`no lead found with phone "${phone}" — import leads first`);

        const projectName = record['Project Name']?.trim();
        const unitCode = record['Unit ID']?.trim();
        const project = projects.find((p) => p.name === projectName);
        const unit = project && units.find((u) => u.projectId === project.id && u.code === unitCode);
        if (!unit) throw new ValidationError(`unit "${unitCode}" in project "${projectName}" not found`);

        let opportunity = opportunities.find((o) => o.leadId === lead.id && o.stage === 'open');
        if (!opportunity) {
          opportunity = await sales.createOpportunity({ companyId: actor.companyId, leadId: lead.id, ownerEmployeeUserId: actor.userId });
          opportunities.push(opportunity);
          await emitEvent({ companyId: actor.companyId, type: 'opportunity.created', payload: { ...opportunity }, actorUserId: actor.userId, dedupeKey: `opportunity.created:${opportunity.id}` });
        }

        const reservation = await sales.reserveUnitForOpportunity(opportunity.id, unit.id, actor.companyId);

        const type = (record['Type'] ?? '').trim().toLowerCase();
        if (type === 'reservation') return reservation;

        const planName = record['Payment Plan']?.trim();
        const template = templates.find((t) => t.name === planName);
        if (!template) throw new ValidationError(`payment plan template "${planName}" not found`);
        const totalPrice = Number((record['Total Price (EGP)'] ?? '').replace(/,/g, ''));
        if (!Number.isFinite(totalPrice) || totalPrice <= 0) throw new ValidationError('"Total Price (EGP)" must be a positive number');

        const contract = await sales.signContract({
          companyId: actor.companyId,
          reservationId: reservation.id,
          creditedEmployeeUserId: (await crm.resolveCommissionOwner(lead.id, actor.companyId)) ?? actor.userId,
          paymentPlanTemplateId: template.id,
          totalPrice,
        });
        await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'create', resource: 'contract', resourceId: contract.id, metadata: { importedViaCsv: true } });
        await emitEvent({ companyId: actor.companyId, type: 'contract.signed', payload: { ...contract }, actorUserId: actor.userId, dedupeKey: `contract.signed:${contract.id}` });
        await recordSalesCommissionsAndEmit(actor.companyId, contract, actor.userId);
        // Generate the payment schedule immediately, same as an operator
        // would do as the very next manual step — a signed contract with
        // no schedule isn't usable yet, and a Finance import row can't
        // record a payment against a schedule line that doesn't exist.
        await paymentPlans.generateForContract(contract.id, actor.companyId, template.id, totalPrice);
        return contract;
      },
    );
    return { status: 200, body: result };
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

  // Re-pricing money a client already committed to is always sensitive —
  // unlike the discount-override gate (which only applies above a
  // configurable threshold), every amendment goes through the Universal
  // Approval Engine, no policy escape.
  httpServer.post('/api/sales/contracts/:contractId/amend', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'contract'))) {
      throw new ForbiddenError('missing edit:contract permission');
    }
    const body = parseJsonBody<{ newTotalPrice: number; discountPercent?: number; reason: string }>(ctx.body);
    const contractId = ctx.params.contractId!;
    const amendmentContext = { contractId, newTotalPrice: body.newTotalPrice, discountPercent: body.discountPercent };
    const approval = await approvalEngine.requestApproval({
      companyId: actor.companyId,
      actionType: 'contract_amendment',
      requestedByUserId: actor.userId,
      reason: body.reason,
      context: amendmentContext,
    });
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'create', resource: 'approval', resourceId: approval.id, metadata: { actionType: 'contract_amendment', contractId } });
    await emitEvent({ companyId: actor.companyId, type: 'action_approval.requested', payload: { ...approval }, actorUserId: actor.userId, dedupeKey: `action_approval.requested:${approval.id}` });
    return { status: 202, body: approval };
  });

  // ---- E-Signature ----
  // Additive to the existing contract flow — Contract.status itself, and
  // everything that depends on it, is unchanged; this only tracks whether a
  // customer has actually digitally signed the document.
  httpServer.post('/api/sales/contracts/:contractId/signature-envelopes', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'signature_envelope'))) {
      throw new ForbiddenError('missing create:signature_envelope permission');
    }
    const body = parseJsonBody<{ signerEmail: string; documentUrl: string }>(ctx.body);
    const envelope = await signatures.sendForSignature({
      companyId: actor.companyId,
      contractId: ctx.params.contractId!,
      signerEmail: body.signerEmail,
      documentUrl: body.documentUrl,
      requestedByUserId: actor.userId,
    });
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'create', resource: 'signature_envelope', resourceId: envelope.id, metadata: { contractId: envelope.contractId } });
    await emitEvent({ companyId: actor.companyId, type: 'contract.signature_sent', payload: { ...envelope }, actorUserId: actor.userId, dedupeKey: `contract.signature_sent:${envelope.id}` });
    return { status: 201, body: envelope };
  });

  httpServer.get('/api/sales/contracts/:contractId/signature-envelopes', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'signature_envelope'))) {
      throw new ForbiddenError('missing view:signature_envelope permission');
    }
    const list = await signatures.listForContract(ctx.params.contractId!, actor.companyId);
    return { status: 200, body: paginate(list, ctx.query) };
  });

  // Inbound e-signature provider callback. Intentionally unauthenticated —
  // same companyId + unguessable-id-in-the-URL model as the Automation
  // Engine's webhook receiver above — but additionally requires a valid
  // HMAC-SHA256 signature (computed over this connection's own
  // webhook_secret) before any envelope state changes: an unsigned or
  // mis-signed callback is refused outright, never treated as a real
  // "customer signed" event. The signature is verified over this server's
  // JSON re-serialization of the body (the HTTP layer only ever hands route
  // handlers already-parsed JSON, not the original raw bytes) — a real
  // provider integration wanting byte-exact verification against its own
  // raw payload would need the shared body-reader extended to preserve it.
  httpServer.post('/api/integrations/e-signature/webhooks/:companyId/:envelopeId', async (ctx) => {
    const rawBody = ctx.body === undefined ? '' : JSON.stringify(ctx.body);
    const signatureHeader = ctx.headers['x-signature-hmac'];
    const envelope = await signatures.handleWebhook(
      ctx.params.envelopeId!,
      ctx.params.companyId!,
      rawBody,
      typeof signatureHeader === 'string' ? signatureHeader : undefined,
    );
    return { status: 200, body: { id: envelope.id, status: envelope.status } };
  });

  // Real WhatsApp/email delivery-status callback — HMAC-verified against
  // the connection's own webhook_secret exactly like the e-signature
  // webhook above. Accepts a normalized {providerMessageId, status,
  // failureReason?} body (see CommunicationDeliveryService's class doc
  // for why: not certified against WhatsApp Cloud API's or SendGrid's own
  // raw payload shape, same honest scope as every other connector here).
  httpServer.post('/api/integrations/communication/webhooks/:companyId/:connectionId', async (ctx) => {
    const rawBody = ctx.body === undefined ? '' : JSON.stringify(ctx.body);
    const signatureHeader = ctx.headers['x-signature-hmac'];
    const event = await communicationDelivery.handleWebhook(
      ctx.params.companyId!,
      ctx.params.connectionId!,
      rawBody,
      typeof signatureHeader === 'string' ? signatureHeader : undefined,
    );
    return { status: 200, body: { id: event.id, status: event.status } };
  });

  // The real delivery timeline for one sent message — every status
  // transition a verified webhook has actually reported, not an assumed
  // "sent = delivered". See CommunicationDeliveryService.
  httpServer.get('/api/integrations/communication/delivery/:providerMessageId', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'integration_connection'))) {
      throw new ForbiddenError('missing view:integration_connection permission');
    }
    const timeline = await communicationDelivery.getTimeline(actor.companyId, ctx.params.providerMessageId!);
    return { status: 200, body: timeline };
  });

  // The latest delivery status for whatever a lead/customer/etc. was last
  // messaged — the same real lookup the `get_delivery_status` AI tool uses
  // (see automation.setDeliveryStatusGetter above), exposed directly so the
  // frontend doesn't have to round-trip through the AI action pipeline just
  // to show a status badge. Returns 'unknown' rather than 404 when nothing
  // has been sent yet — a CRM view showing "no message sent" is not an error.
  httpServer.get('/api/integrations/communication/delivery/by-resource/:resourceId', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'integration_connection'))) {
      throw new ForbiddenError('missing view:integration_connection permission');
    }
    const latest = await integrations.getLatestDeliveryStatusForResource(actor.companyId, ctx.params.resourceId!);
    return { status: 200, body: latest ?? { status: 'unknown' } };
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

  // Bulk CSV import for collections. A finance export's literal "Contract
  // ID"/"Receipt ID" values won't match this system's own generated IDs
  // unless they came from ACTIVE itself, so rows are resolved by
  // Project+Unit (finds the signed contract for that unit) and Installment
  // Number (finds that schedule line by its real sequence number) instead —
  // stable keys that survive being re-exported from anywhere. Every payment
  // still goes through the exact same finance.recordPayment() the manual
  // route above uses, so it's still subject to the real validation there
  // (positive amount, line not already fully paid, etc).
  httpServer.post('/api/finance/payments/import', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'payment_schedule'))) {
      throw new ForbiddenError('missing edit:payment_schedule permission');
    }
    const body = parseJsonBody<{ csv: string }>(ctx.body);
    const records = parseCsvRecords(body.csv);
    const [projects, units, contracts] = await Promise.all([
      inventory.listProjects(actor.companyId),
      inventory.listUnits(actor.companyId),
      sales.listContracts(actor.companyId),
    ]);
    const METHOD_MAP: Record<string, Payment['method']> = {
      'bank transfer': 'transfer',
      transfer: 'transfer',
      cheque: 'cheque',
      check: 'cheque',
      'visa pos': 'card',
      card: 'card',
      cash: 'cash',
    };
    const result = await runImport(
      records,
      ['Receipt/Transaction ID', 'Contract ID', 'Customer Name', 'Payment Status', 'Finance Officer', 'Notes'],
      async (record) => {
        const projectName = record['Project']?.trim();
        const unitCode = record['Unit']?.trim();
        const project = projects.find((p) => p.name === projectName);
        const unit = project && units.find((u) => u.projectId === project.id && u.code === unitCode);
        if (!unit) throw new ValidationError(`unit "${unitCode}" in project "${projectName}" not found`);
        const contract = contracts.find((c) => c.unitId === unit.id && c.status === 'signed');
        if (!contract) throw new ValidationError(`no signed contract found for unit "${unitCode}"`);

        const amount = Number((record['Amount Paid (EGP)'] ?? '').replace(/,/g, ''));
        if (!Number.isFinite(amount) || amount <= 0) throw new SkipRow('"Amount Paid (EGP)" is 0 or blank — nothing to record for this row yet');

        const schedule = await paymentPlans.getScheduleForContract(contract.id, actor.companyId);
        const sequence = Number(record['Installment Number'] ?? '');
        const line = schedule.find((l) => l.sequence === sequence);
        if (!line) throw new ValidationError(`no schedule line found with installment number ${record['Installment Number']} for this contract`);

        const methodKey = (record['Payment Method'] ?? '').trim().toLowerCase();
        const method = METHOD_MAP[methodKey];
        if (!method) throw new ValidationError(`unrecognized "Payment Method": "${record['Payment Method']}"`);

        const recorded = await finance.recordPayment({ companyId: actor.companyId, contractId: contract.id, paymentScheduleLineId: line.id, amount, method, recordedByUserId: actor.userId });
        await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'edit', resource: 'payment_schedule', resourceId: recorded.line.id, metadata: { amount, importedViaCsv: true } });
        await emitEvent({
          companyId: actor.companyId,
          type: 'payment.recorded',
          payload: { ...recorded },
          actorUserId: actor.userId,
          dedupeKey: `payment.recorded:${recorded.payment.id}`,
        });
        return recorded.payment;
      },
    );
    return { status: 200, body: result };
  });

  // ---- Payment Import pipeline (staged: upload -> preview -> confirm) ----
  // The richer alternative to the bulk-CSV route above, for real Excel/PDF
  // exports with unpredictable headers. Same resolution rules (Phone or
  // Project+Unit -> contract, Installment Number -> schedule line) and the
  // same single write path (finance.recordPayment), just reachable through
  // upload/preview/confirm so the user sees exactly what would be recorded
  // — including conflicts (already-paid/overpaying installments) — before
  // anything actually happens.

  httpServer.post(
    '/api/finance/payments/import/upload',
    async (ctx) => {
      const actor = await actorOf(ctx);
      if (!(await rbac.can(actor.userId, 'edit', 'payment_schedule'))) {
        throw new ForbiddenError('missing edit:payment_schedule permission');
      }
      const body = ctx.body as MultipartBody | undefined;
      const file = body?.files?.[0];
      if (!file) throw new ValidationError('a file upload ("file" field) is required');

      const session = await importSessions.createSession({
        companyId: actor.companyId,
        createdByUserId: actor.userId,
        targetType: 'payment',
        fileName: file.filename,
        fileBuffer: file.data,
        contentType: file.contentType,
        fields: PAYMENT_IMPORT_FIELDS,
      });
      return {
        status: 200,
        body: {
          sessionId: session.id,
          fileName: session.fileName,
          fileType: session.fileType,
          detectedColumns: session.detectedColumns,
          suggestedMapping: session.suggestedMapping,
          sampleRows: session.rawRows.slice(0, 5),
          totalRows: session.rawRows.length,
          fields: PAYMENT_IMPORT_FIELDS,
        },
      };
    },
    { maxBodyBytes: IMPORT_MAX_BODY_BYTES },
  );

  httpServer.post('/api/finance/payments/import/:sessionId/preview', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'payment_schedule'))) {
      throw new ForbiddenError('missing edit:payment_schedule permission');
    }
    const body = parseJsonBody<{ mapping: Record<string, string | null> }>(ctx.body);
    const session = await importSessions.confirmMapping(ctx.params.sessionId!, actor.companyId, body.mapping);
    const mappedRows = importSessions.mapRows(session);
    const preview = await paymentImport.buildPreview(actor.companyId, mappedRows);
    return { status: 200, body: preview };
  });

  httpServer.post('/api/finance/payments/import/:sessionId/confirm', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'payment_schedule'))) {
      throw new ForbiddenError('missing edit:payment_schedule permission');
    }
    const session = await importSessions.getSession(ctx.params.sessionId!, actor.companyId);
    if (!session.confirmedMapping) {
      throw new ValidationError('this import session has not been mapped yet — call the preview step first');
    }
    const mappedRows = importSessions.mapRows(session);
    const result = await paymentImport.importRows(actor.companyId, actor.userId, mappedRows, async (recorded) => {
      await auditLog.record({
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: 'edit',
        resource: 'payment_schedule',
        resourceId: recorded.line.id,
        metadata: { amount: recorded.payment.amount, importedViaFile: true, importSessionId: session.id, fileName: session.fileName },
      });
      await emitEvent({
        companyId: actor.companyId,
        type: 'payment.recorded',
        payload: { ...recorded },
        actorUserId: actor.userId,
        dedupeKey: `payment.recorded:${recorded.payment.id}`,
      });
    });
    await importSessions.markConfirmed(session.id, actor.companyId);
    return { status: 200, body: result };
  });

  httpServer.get('/api/finance/contracts/:contractId/balance', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'payment_schedule'))) {
      throw new ForbiddenError('missing view:payment_schedule permission');
    }
    const balance = await finance.getBalance(ctx.params.contractId!, actor.companyId);
    return { status: 200, body: balance };
  });

  httpServer.get('/api/finance/refunds', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'payment_schedule'))) {
      throw new ForbiddenError('missing view:payment_schedule permission');
    }
    const refunds = await finance.listRefunds(actor.companyId);
    return { status: 200, body: paginate(refunds, ctx.query) };
  });

  // Reversing money already collected is always sensitive — every
  // refund request goes through the Universal Approval Engine, no
  // direct-execute path, regardless of amount.
  httpServer.post('/api/finance/refunds', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'payment_schedule'))) {
      throw new ForbiddenError('missing edit:payment_schedule permission');
    }
    const body = parseJsonBody<{ contractId: string; paymentScheduleLineId: string; amount: number; reason: string }>(ctx.body);
    // Fixed real cross-tenant gap found during audit: unlike every other
    // approval-gated route (discount_override validates the reservation,
    // contract_amendment validates the contract), this one created a real
    // ApprovalRequest for any contractId/paymentScheduleLineId string with
    // no check that it belongs to the actor's own company — the request
    // would only ever fail later, at approval time, instead of being
    // rejected up front like everywhere else.
    const line = await finance.getScheduleLine(body.paymentScheduleLineId, actor.companyId);
    if (!line || line.contractId !== body.contractId) {
      throw new NotFoundError('payment schedule line not found for this contract');
    }
    const refundContext = { contractId: body.contractId, paymentScheduleLineId: body.paymentScheduleLineId, amount: body.amount, reason: body.reason };
    const approval = await approvalEngine.requestApproval({
      companyId: actor.companyId,
      actionType: 'refund',
      requestedByUserId: actor.userId,
      reason: body.reason,
      context: refundContext,
    });
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'create', resource: 'approval', resourceId: approval.id, metadata: { actionType: 'refund', contractId: body.contractId } });
    await emitEvent({ companyId: actor.companyId, type: 'action_approval.requested', payload: { ...approval }, actorUserId: actor.userId, dedupeKey: `action_approval.requested:${approval.id}` });
    return { status: 202, body: approval };
  });

  httpServer.post('/api/finance/sweep-overdue', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'payment_schedule'))) {
      throw new ForbiddenError('missing edit:payment_schedule permission');
    }
    const count = await sweepOverdueAndEmit(actor.companyId);
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
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'create', resource: 'broker_company', resourceId: brokerCompany.id });
    return { status: 201, body: brokerCompany };
  });

  // Bulk CSV import — registers one real BrokerCompany per row, and (if a
  // commission rate is given) a real per-broker CommissionRule through the
  // exact same setCommissionRule() the manual commission-rules screen uses.
  // Only name and commission rate exist on the real schema today — contact
  // details, bank info, tax card, etc. are reported as unsupportedColumns.
  httpServer.post('/api/brokers/companies/import', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'broker_company'))) {
      throw new ForbiddenError('missing create:broker_company permission');
    }
    if (!(await rbac.can(actor.userId, 'edit', 'broker_company'))) {
      throw new ForbiddenError('missing edit:broker_company permission');
    }
    const body = parseJsonBody<{ csv: string }>(ctx.body);
    const records = parseCsvRecords(body.csv);
    const result = await runImport(
      records,
      ['Broker ID', 'Broker Type', 'Contact Person', 'Phone', 'Email', 'Commercial Reg/ID', 'Tax Card', 'Bank Name', 'Account Name', 'IBAN', 'Status', 'Assigned Account Manager', 'Notes'],
      async (record) => {
        const name = record['Company/Individual Name']?.trim();
        if (!name) throw new ValidationError('"Company/Individual Name" is required');
        const rateText = (record['Commission Rate (%)'] ?? '').replace('%', '').trim();
        const rate = rateText ? Number(rateText) : undefined;
        if (rate !== undefined && (!Number.isFinite(rate) || rate <= 0)) throw new ValidationError('"Commission Rate (%)" must be a positive number');
        const brokerCompany = await brokers.registerBrokerCompany({ companyId: actor.companyId, name });
        if (rate !== undefined) await brokers.setCommissionRule(actor.companyId, rate, brokerCompany.id);
        return brokerCompany;
      },
    );
    return { status: 200, body: result };
  });

  httpServer.post('/api/brokers/companies/:brokerCompanyId/approve', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'approve', 'broker_company'))) {
      throw new ForbiddenError('missing approve:broker_company permission');
    }
    const brokerCompany = await brokers.approveBrokerCompany(ctx.params.brokerCompanyId!, actor.companyId);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'approve', resource: 'broker_company', resourceId: brokerCompany.id });
    return { status: 200, body: brokerCompany };
  });

  httpServer.post('/api/brokers/companies/:brokerCompanyId/suspend', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'broker_company'))) {
      throw new ForbiddenError('missing edit:broker_company permission');
    }
    const brokerCompany = await brokers.suspendBrokerCompany(ctx.params.brokerCompanyId!, actor.companyId);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'edit', resource: 'broker_company', resourceId: brokerCompany.id, metadata: { suspended: true } });
    return { status: 200, body: brokerCompany };
  });

  httpServer.post('/api/brokers/leads', async (ctx) => {
    const actor = await actorOf(ctx);
    if (actor.userType !== 'broker_user') {
      throw new ForbiddenError('only broker_user accounts may submit broker leads');
    }
    const user = await repos.users.findById(actor.userId);
    if (!user?.brokerCompanyId) throw new ForbiddenError('this account is not linked to a broker company');
    const body = parseJsonBody<{ fullName: string; phone: string; email?: string; nationalId?: string }>(ctx.body);
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
    const q = ctx.query.get('q');
    if (actor.userType === 'broker_user') {
      const user = await repos.users.findById(actor.userId);
      const own = all.filter((bl) => bl.brokerCompanyId === user?.brokerCompanyId);
      return { status: 200, body: paginate(searchFilter(own, ['fullName', 'phone', 'email'], q), ctx.query) };
    }
    if (!(await rbac.can(actor.userId, 'view', 'broker_company'))) {
      throw new ForbiddenError('missing view:broker_company permission');
    }
    return { status: 200, body: paginate(searchFilter(all, ['fullName', 'phone', 'email'], q), ctx.query) };
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
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'create', resource: 'broker_company', resourceId: commission.id, metadata: { brokerCommission: true, brokerCompanyId: ctx.params.brokerCompanyId, contractId: body.contractId, amount: commission.amount } });
    return { status: 201, body: commission };
  });

  httpServer.post('/api/brokers/commissions/:commissionId/approve', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'approve', 'broker_company'))) {
      throw new ForbiddenError('missing approve:broker_company permission');
    }
    const commission = await brokers.approveCommission(ctx.params.commissionId!, actor.companyId);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'approve', resource: 'broker_company', resourceId: commission.id, metadata: { brokerCommission: true, amount: commission.amount } });
    return { status: 200, body: commission };
  });

  // ---- Internal Sales Commission Engine ----
  // Commission lines are recorded automatically at contract-signing time
  // (see recordSalesCommissionsAndEmit above) — there is no manual
  // "record commission" route, unlike the broker one, since the
  // employee/amount/rate are always fully determined by real contract
  // data and the configured rules.
  httpServer.post('/api/sales-commissions/rules', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'sales_commission'))) {
      throw new ForbiddenError('missing edit:sales_commission permission');
    }
    const body = parseJsonBody<{ tier: 'base' | 'override'; ratePercent: number; employeeUserId?: string }>(ctx.body);
    const rule = await salesCommissions.setCommissionRule({ companyId: actor.companyId, ...body });
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'edit', resource: 'sales_commission', resourceId: rule.id, metadata: { rule: true } });
    return { status: 201, body: rule };
  });

  httpServer.get('/api/sales-commissions/rules', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'sales_commission'))) {
      throw new ForbiddenError('missing view:sales_commission permission');
    }
    const rules = await salesCommissions.listCommissionRules(actor.companyId);
    return { status: 200, body: rules };
  });

  httpServer.get('/api/sales-commissions', async (ctx) => {
    const actor = await actorOf(ctx);
    const scope = await rbac.getListAccessScope(actor.userId, 'view', 'sales_commission');
    if (scope.kind === 'none') return { status: 403, body: { error: 'missing view:sales_commission permission' } };
    const all = await salesCommissions.listCommissions(actor.companyId);
    const filtered = await filterByListScope(all, scope, (c) => employeeScopeKeys(c.employeeUserId));
    return { status: 200, body: paginate(filtered, ctx.query) };
  });

  httpServer.post('/api/sales-commissions/:commissionId/approve', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'approve', 'sales_commission'))) {
      throw new ForbiddenError('missing approve:sales_commission permission');
    }
    const commission = await salesCommissions.approveCommission(ctx.params.commissionId!, actor.companyId);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'approve', resource: 'sales_commission', resourceId: commission.id });
    await emitEvent({ companyId: actor.companyId, type: 'sales_commission.status_changed', payload: { ...commission }, actorUserId: actor.userId, dedupeKey: `sales_commission.status_changed:${commission.id}:approved` });
    return { status: 200, body: commission };
  });

  httpServer.post('/api/sales-commissions/:commissionId/pay', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'sales_commission'))) {
      throw new ForbiddenError('missing edit:sales_commission permission');
    }
    const commission = await salesCommissions.markCommissionPaid(ctx.params.commissionId!, actor.companyId);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'edit', resource: 'sales_commission', resourceId: commission.id, metadata: { paid: true } });
    await emitEvent({ companyId: actor.companyId, type: 'sales_commission.status_changed', payload: { ...commission }, actorUserId: actor.userId, dedupeKey: `sales_commission.status_changed:${commission.id}:paid` });
    return { status: 200, body: commission };
  });

  httpServer.post('/api/sales-commissions/:commissionId/clawback', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'sales_commission'))) {
      throw new ForbiddenError('missing edit:sales_commission permission');
    }
    const body = parseJsonBody<{ reason: string }>(ctx.body);
    const commission = await salesCommissions.clawbackCommission(ctx.params.commissionId!, actor.companyId, body.reason);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'edit', resource: 'sales_commission', resourceId: commission.id, metadata: { clawedBack: true, reason: body.reason } });
    await emitEvent({ companyId: actor.companyId, type: 'sales_commission.status_changed', payload: { ...commission }, actorUserId: actor.userId, dedupeKey: `sales_commission.status_changed:${commission.id}:clawed_back` });
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
    const filtered = searchFilter(requests, ['reason'], ctx.query.get('q'));
    return { status: 200, body: paginate(filtered, ctx.query) };
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
    const filtered = searchFilter(tickets, ['title', 'description'], ctx.query.get('q'));
    return { status: 200, body: paginate(filtered, ctx.query) };
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
    const filtered = searchFilter(documents, ['name', 'notes'], ctx.query.get('q'));
    return { status: 200, body: paginate(filtered, ctx.query) };
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
    const filtered = searchFilter(vendors, ['name', 'category'], ctx.query.get('q'));
    return { status: 200, body: paginate(filtered, ctx.query) };
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
    const filtered = searchFilter(campaigns, ['name'], ctx.query.get('q'));
    return { status: 200, body: paginate(filtered, ctx.query) };
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
    const filtered = searchFilter(messages, ['subject'], ctx.query.get('q'));
    return { status: 200, body: paginate(filtered, ctx.query) };
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
    const filtered = searchFilter(messages, ['subject'], ctx.query.get('q'));
    return { status: 200, body: paginate(filtered, ctx.query) };
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

  httpServer.get('/api/analytics/speed-to-first-contact', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'analytics'))) {
      throw new ForbiddenError('missing view:analytics permission');
    }
    return { status: 200, body: await analytics.speedToFirstContact(actor.companyId) };
  });

  httpServer.get('/api/analytics/funnel-conversion-rates', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'analytics'))) {
      throw new ForbiddenError('missing view:analytics permission');
    }
    return { status: 200, body: await analytics.funnelConversionRates(actor.companyId) };
  });

  httpServer.get('/api/analytics/cost-per-qualified-lead', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'analytics'))) {
      throw new ForbiddenError('missing view:analytics permission');
    }
    return { status: 200, body: await analytics.costPerQualifiedLead(actor.companyId) };
  });

  httpServer.get('/api/analytics/lost-reasons', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'analytics'))) {
      throw new ForbiddenError('missing view:analytics permission');
    }
    return { status: 200, body: await analytics.lostReasonBreakdown(actor.companyId) };
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

  // ---- Forecasting + Scenario Simulation ----
  httpServer.get('/api/forecasting/historical', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'forecast'))) {
      throw new ForbiddenError('missing view:forecast permission');
    }
    const projectId = ctx.query.get('projectId') ?? undefined;
    const months = ctx.query.get('months') ? Number(ctx.query.get('months')) : undefined;
    return { status: 200, body: await forecasting.historicalMonthly(actor.companyId, projectId, months) };
  });

  httpServer.get('/api/forecasting/forecast', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'forecast'))) {
      throw new ForbiddenError('missing view:forecast permission');
    }
    const projectId = ctx.query.get('projectId') ?? undefined;
    const trailingMonths = ctx.query.get('trailingMonths') ? Number(ctx.query.get('trailingMonths')) : undefined;
    const forecastMonths = ctx.query.get('forecastMonths') ? Number(ctx.query.get('forecastMonths')) : undefined;
    return { status: 200, body: await forecasting.forecastFuture(actor.companyId, projectId, trailingMonths, forecastMonths) };
  });

  httpServer.get('/api/forecasting/compare', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'forecast'))) {
      throw new ForbiddenError('missing view:forecast permission');
    }
    const month = ctx.query.get('month');
    if (!month) throw new ValidationError('month query parameter is required (YYYY-MM)');
    const projectId = ctx.query.get('projectId') ?? undefined;
    const trailingMonths = ctx.query.get('trailingMonths') ? Number(ctx.query.get('trailingMonths')) : undefined;
    return { status: 200, body: await forecasting.compareActualVsForecast(actor.companyId, month, projectId, trailingMonths) };
  });

  // Pure calculator — never persists anything, exactly like
  // PaymentPlansService.previewSchedule, which it reuses under the hood.
  httpServer.post('/api/scenario-simulation/run', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'forecast'))) {
      throw new ForbiddenError('missing view:forecast permission');
    }
    const body = parseJsonBody<Parameters<ScenarioSimulationService['runScenario']>[1] & { baseline?: Parameters<ScenarioSimulationService['runScenario']>[1] }>(ctx.body);
    if (body.baseline) {
      const { baseline, ...scenario } = body;
      return { status: 200, body: await scenarioSimulation.compareScenarios(actor.companyId, scenario, baseline) };
    }
    return { status: 200, body: await scenarioSimulation.runScenario(actor.companyId, body) };
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

  httpServer.get('/api/customers', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'portal_access'))) {
      throw new ForbiddenError('missing view:portal_access permission');
    }
    const customers = await portal.listCustomers(actor.companyId);
    const filtered = searchFilter(customers, ['fullName', 'phone', 'email'], ctx.query.get('q'));
    return { status: 200, body: paginate(filtered, ctx.query) };
  });

  // Customer 360: everything ACTIVE already knows about one customer,
  // joined from CRM/Sales/Payment Plans/Legal/Communication/Tasks — see
  // PortalService.getCustomer360 for the join logic. Same permission as
  // the customer list above, since this is just one customer's detail.
  httpServer.get('/api/customers/:id/360', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'portal_access'))) {
      throw new ForbiddenError('missing view:portal_access permission');
    }
    const profile = await portal.getCustomer360(ctx.params.id!, actor.companyId);
    return { status: 200, body: profile };
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

  // Event-to-AI activation control: instantiates a real WorkflowDefinition
  // from a built-in template in one call — the company-level opt-in this
  // deployment requires before any event can drive an AI action (see
  // AutomationService.activateTemplate). Never automatic, never global:
  // create:workflow permission gates it exactly like a hand-built workflow.
  httpServer.post('/api/automation/templates/:templateKey/activate', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'workflow'))) {
      throw new ForbiddenError('missing create:workflow permission');
    }
    const workflow = await automation.activateTemplate(ctx.params.templateKey!, actor.companyId, actor.userId);
    await auditLog.record({
      companyId: actor.companyId, actorUserId: actor.userId, action: 'create', resource: 'workflow', resourceId: workflow.id,
      metadata: { templateKey: ctx.params.templateKey, name: workflow.name },
    });
    return { status: 201, body: workflow };
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

  // ---- Universal Approval Engine ----
  // Independent of the Automation Engine's own ApprovalRequest above (that
  // one only ever exists inside a workflow run) — any route can gate an
  // action behind one of these without building a workflow first. See
  // resumeApprovedAction for how "approving" one actually finishes the
  // underlying action.
  httpServer.get('/api/approvals', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'approval'))) {
      throw new ForbiddenError('missing view:approval permission');
    }
    const status = ctx.query.get('status') as ActionApproval['status'] | null;
    const list = await approvalEngine.listApprovals(actor.companyId, status ?? undefined);
    return { status: 200, body: paginate(list, ctx.query) };
  });

  httpServer.post('/api/approvals/:approvalId/approve', async (ctx) => {
    const actor = await actorOf(ctx);
    const approval = await approvalEngine.approve(ctx.params.approvalId!, actor.companyId, actor.userId);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'approve', resource: 'approval', resourceId: approval.id });
    await emitEvent({ companyId: actor.companyId, type: 'action_approval.decided', payload: { ...approval }, actorUserId: actor.userId, dedupeKey: `action_approval.decided:${approval.id}` });
    try {
      const result = await resumeApprovedAction(approval, actor.userId);
      return { status: 200, body: { approval, result } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await approvalEngine.recordResumeFailure(approval.id, actor.companyId, message);
      throw err;
    }
  });

  httpServer.post('/api/approvals/:approvalId/reject', async (ctx) => {
    const actor = await actorOf(ctx);
    const body = ctx.body && typeof ctx.body === 'object' ? (ctx.body as { reason?: string }) : {};
    const approval = await approvalEngine.reject(ctx.params.approvalId!, actor.companyId, actor.userId, body.reason);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'approve', resource: 'approval', resourceId: approval.id, metadata: { rejected: true } });
    await emitEvent({ companyId: actor.companyId, type: 'action_approval.decided', payload: { ...approval }, actorUserId: actor.userId, dedupeKey: `action_approval.decided:${approval.id}` });
    return { status: 200, body: approval };
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
    const body = parseJsonBody<{
      actionType: AiPolicy['actionType'];
      autonomyLevel: AiPolicy['autonomyLevel'];
      maxFinancialAmount?: number;
      allowedChannels?: string[];
      workingHoursStart?: string;
      workingHoursEnd?: string;
    }>(ctx.body);
    const policy = await aiAgent.setPolicy(actor.companyId, body.actionType, body.autonomyLevel, actor.userId, {
      maxFinancialAmount: body.maxFinancialAmount,
      allowedChannels: body.allowedChannels,
      workingHoursStart: body.workingHoursStart,
      workingHoursEnd: body.workingHoursEnd,
    });
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

  // ---- AI Agent Orchestration Layer ----
  // Specialized agents (Sales/Marketing/Finance/Support/HR), each scoped to
  // its own declared tool boundary, deciding a confidence-scored next
  // action for one subject (a lead, campaign, overdue payment line,
  // maintenance ticket, or leave request) and routing it through the exact
  // same permission/policy/approval/audit pipeline as any other AI action
  // — see AiAgentService.decide().
  httpServer.get('/api/ai/agents', async (ctx) => {
    await actorOf(ctx);
    return { status: 200, body: aiAgent.listAgents() };
  });

  httpServer.get('/api/ai/tools', async (ctx) => {
    await actorOf(ctx);
    const agentKey = ctx.query.get('agent') ?? undefined;
    return { status: 200, body: aiAgent.listTools(agentKey) };
  });

  httpServer.post('/api/ai/agents/:agentKey/decide', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'ai_action'))) {
      throw new ForbiddenError('missing create:ai_action permission');
    }
    const body = parseJsonBody<{ subjectId: string }>(ctx.body);
    const decision = await aiAgent.decide(ctx.params.agentKey!, actor.companyId, body.subjectId, actor.userId);
    return { status: 201, body: decision };
  });

  httpServer.get('/api/ai/decisions', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'ai_action'))) {
      throw new ForbiddenError('missing view:ai_action permission');
    }
    const agentKey = ctx.query.get('agent') ?? undefined;
    const list = await aiAgent.listAgentDecisions(actor.companyId, agentKey);
    return { status: 200, body: paginate(list, ctx.query) };
  });

  httpServer.get('/api/ai/decisions/:decisionId', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'ai_action'))) {
      throw new ForbiddenError('missing view:ai_action permission');
    }
    const decision = await aiAgent.getAgentDecision(ctx.params.decisionId!, actor.companyId);
    return { status: 200, body: decision };
  });

  httpServer.get('/api/ai/agent-stats', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'ai_action'))) {
      throw new ForbiddenError('missing view:ai_action permission');
    }
    const stats = await aiAgent.getAgentStats(actor.companyId);
    return { status: 200, body: stats };
  });

  // ---- Persistent AI Memory Layer ----
  // Only application code (deterministic agent logic, a human via this API)
  // writes memories in this phase — see AiMemoryService's class doc comment
  // for why no AI-callable "remember" tool exists yet. Recall is agent-
  // callable (the `recall_memory` tool, read-only) and human-callable here.
  httpServer.post('/api/ai/memory', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'ai_memory'))) {
      throw new ForbiddenError('missing create:ai_memory permission');
    }
    const body = parseJsonBody<{
      category: AiMemory['category'];
      content: string;
      subjectType?: string;
      subjectId?: string;
      key?: string;
      tags?: string[];
      confidence?: number;
      sensitivity?: AiMemory['sensitivity'];
      expiresAt?: string;
    }>(ctx.body);
    const memory = await aiMemory.remember({
      companyId: actor.companyId,
      category: body.category,
      content: body.content,
      subjectType: body.subjectType,
      subjectId: body.subjectId,
      key: body.key,
      tags: body.tags,
      source: { type: 'user_note', id: actor.userId },
      confidence: body.confidence,
      sensitivity: body.sensitivity,
      createdByUserId: actor.userId,
      expiresAt: body.expiresAt,
    });
    await auditLog.record({
      companyId: actor.companyId,
      actorUserId: actor.userId,
      action: 'create',
      resource: 'ai_memory',
      resourceId: memory.id,
      metadata: { category: memory.category, subjectType: memory.subjectType, subjectId: memory.subjectId },
    });
    return { status: 201, body: memory };
  });

  httpServer.get('/api/ai/memory', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'ai_memory'))) {
      throw new ForbiddenError('missing view:ai_memory permission');
    }
    const limitParam = ctx.query.get('limit');
    const list = await aiMemory.recall(
      actor.companyId,
      {
        category: (ctx.query.get('category') ?? undefined) as AiMemory['category'] | undefined,
        subjectType: ctx.query.get('subjectType') ?? undefined,
        subjectId: ctx.query.get('subjectId') ?? undefined,
        key: ctx.query.get('key') ?? undefined,
        query: ctx.query.get('query') ?? undefined,
      },
      limitParam ? Number(limitParam) : undefined,
    );
    return { status: 200, body: list };
  });

  httpServer.post('/api/ai/memory/:memoryId/invalidate', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'ai_memory'))) {
      throw new ForbiddenError('missing edit:ai_memory permission');
    }
    const memory = await aiMemory.invalidate(ctx.params.memoryId!, actor.companyId, actor.userId);
    await auditLog.record({
      companyId: actor.companyId,
      actorUserId: actor.userId,
      action: 'edit',
      resource: 'ai_memory',
      resourceId: memory.id,
      metadata: { invalidated: true },
    });
    return { status: 200, body: memory };
  });

  // ---- LLM Provider Abstraction ----
  // No external AI API is configured for this deployment — these routes
  // manage the real, testable provider config (see LlmOrchestratorService's
  // class doc comment) rather than a stand-in for one. CEO-only by default
  // seed, same posture as /api/automation/secrets: API keys are financial/
  // security-sensitive and never returned by any route here.
  httpServer.post('/api/ai/llm/config', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'ai_llm_config'))) {
      throw new ForbiddenError('missing create:ai_llm_config permission');
    }
    const body = parseJsonBody<{
      provider: AiModelConfig['provider'];
      displayName: string;
      model: string;
      baseUrl: string;
      apiKey: string;
      maxOutputTokens?: number;
      temperature?: number;
      timeoutMs?: number;
      maxRetries?: number;
      dailyTokenBudget?: number;
      costPerInputTokenUsd?: number;
      costPerOutputTokenUsd?: number;
      isActive?: boolean;
    }>(ctx.body);
    const config = await llmOrchestrator.setModelConfig({ ...body, companyId: actor.companyId, createdByUserId: actor.userId });
    await auditLog.record({
      companyId: actor.companyId,
      actorUserId: actor.userId,
      action: 'create',
      resource: 'ai_llm_config',
      resourceId: config.id,
      metadata: { provider: config.provider, model: config.model },
    });
    return { status: 201, body: config };
  });

  httpServer.get('/api/ai/llm/config', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'ai_llm_config'))) {
      throw new ForbiddenError('missing view:ai_llm_config permission');
    }
    const list = await llmOrchestrator.listModelConfigs(actor.companyId);
    return { status: 200, body: list };
  });

  httpServer.post('/api/ai/llm/config/:configId/deactivate', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'ai_llm_config'))) {
      throw new ForbiddenError('missing edit:ai_llm_config permission');
    }
    const config = await llmOrchestrator.deactivateModelConfig(ctx.params.configId!, actor.companyId);
    await auditLog.record({
      companyId: actor.companyId,
      actorUserId: actor.userId,
      action: 'edit',
      resource: 'ai_llm_config',
      resourceId: config.id,
      metadata: { deactivated: true },
    });
    return { status: 200, body: config };
  });

  httpServer.get('/api/ai/llm/usage', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'ai_llm_config'))) {
      throw new ForbiddenError('missing view:ai_llm_config permission');
    }
    const list = await llmOrchestrator.listUsage(actor.companyId, ctx.query.get('modelConfigId') ?? undefined);
    return { status: 200, body: paginate(list, ctx.query) };
  });

  // ---- Integration Layer (WhatsApp, Email, Meta Ads, Google Calendar,
  // Stripe, and a generic custom_api connector for other approved
  // third-party services) — secure credential storage (reused from the
  // Automation Engine's encrypted Secret store), rate limiting, retries,
  // and delivery logging. See IntegrationService. ----
  httpServer.get('/api/integrations/connectors', async (ctx) => {
    await actorOf(ctx);
    return { status: 200, body: integrations.listConnectors() };
  });

  httpServer.post('/api/integrations/connections', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'integration_connection'))) {
      throw new ForbiddenError('missing create:integration_connection permission');
    }
    const body = parseJsonBody<{
      provider: IntegrationConnection['provider'];
      displayName: string;
      config?: Record<string, unknown>;
      credentials: Record<string, string>;
    }>(ctx.body);
    const connection = await integrations.connect({ companyId: actor.companyId, createdByUserId: actor.userId, ...body });
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'create', resource: 'integration_connection', resourceId: connection.id, metadata: { provider: connection.provider } });
    return { status: 201, body: connection };
  });

  httpServer.get('/api/integrations/connections', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'integration_connection'))) {
      throw new ForbiddenError('missing view:integration_connection permission');
    }
    const list = await integrations.listConnections(actor.companyId);
    return { status: 200, body: paginate(list, ctx.query) };
  });

  httpServer.delete('/api/integrations/connections/:connectionId', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'delete', 'integration_connection'))) {
      throw new ForbiddenError('missing delete:integration_connection permission');
    }
    const connection = await integrations.disconnect(ctx.params.connectionId!, actor.companyId);
    await auditLog.record({ companyId: actor.companyId, actorUserId: actor.userId, action: 'delete', resource: 'integration_connection', resourceId: connection.id });
    return { status: 200, body: connection };
  });

  httpServer.post('/api/integrations/:provider/send', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'integration_connection'))) {
      throw new ForbiddenError('missing create:integration_connection permission');
    }
    const body = parseJsonBody<{ action: string; params: Record<string, unknown> }>(ctx.body);
    const result = await integrations.send(actor.companyId, ctx.params.provider as IntegrationConnection['provider'], body.action, body.params ?? {}, actor.userId);
    return { status: 200, body: result };
  });

  httpServer.get('/api/integrations/events', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'integration_connection'))) {
      throw new ForbiddenError('missing view:integration_connection permission');
    }
    const connectionId = ctx.query.get('connectionId') ?? undefined;
    const list = await integrations.listEvents(actor.companyId, connectionId);
    return { status: 200, body: paginate(list, ctx.query) };
  });

  // ---- AI Workflow / Agentic Orchestration Engine ----
  // Multi-step, replanning-capable AI workflows layered on top of the AI
  // Execution Layer above: every mutating step routes through
  // aiAgent.requestAction() (never automation.executeActionDirect()
  // directly), so the exact same RBAC/autonomy/approval/audit pipeline
  // gates every action a workflow takes. See AiWorkflowService.
  httpServer.post('/api/ai/workflows', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'create', 'ai_action'))) {
      throw new ForbiddenError('missing create:ai_action permission');
    }
    const body = parseJsonBody<{ goalType: AiWorkflowGoalType; subjectId: string }>(ctx.body);
    const run = await aiWorkflow.startWorkflow(body.goalType, actor.companyId, body.subjectId, actor.userId);
    return { status: 201, body: run };
  });

  httpServer.get('/api/ai/workflows', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'ai_action'))) {
      throw new ForbiddenError('missing view:ai_action permission');
    }
    const subjectId = ctx.query.get('subjectId') ?? undefined;
    const list = await aiWorkflow.listRuns(actor.companyId, subjectId);
    return { status: 200, body: paginate(list, ctx.query) };
  });

  httpServer.get('/api/ai/workflows/:runId', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'ai_action'))) {
      throw new ForbiddenError('missing view:ai_action permission');
    }
    const run = await aiWorkflow.getRun(ctx.params.runId!, actor.companyId);
    return { status: 200, body: run };
  });

  httpServer.get('/api/ai/workflows/:runId/steps', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'view', 'ai_action'))) {
      throw new ForbiddenError('missing view:ai_action permission');
    }
    const steps = await aiWorkflow.getSteps(ctx.params.runId!, actor.companyId);
    return { status: 200, body: steps };
  });

  httpServer.post('/api/ai/workflows/:runId/resume', async (ctx) => {
    const actor = await actorOf(ctx);
    if (!(await rbac.can(actor.userId, 'edit', 'ai_action'))) {
      throw new ForbiddenError('missing edit:ai_action permission');
    }
    const run = await aiWorkflow.resumeWorkflow(ctx.params.runId!, actor.companyId, actor.userId);
    return { status: 200, body: run };
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
      rbac, organization, auth, crm, crmStages, leadDistribution, leadTimeline, inventory, paymentPlans, sales, finance, brokers, salesCommissions, approvalEngine, forecasting, scenarioSimulation, auditLog, roleManagement, onboarding,
      hr, operations, legal, purchasing, marketing, communication, analytics, leadScoring, portal,
      tasks, automation, eventBus, sweepOverdueAndEmit, sweepSlaBreachesAndEmit, sweepExpiredReservationsAndEmit, aiAgent, aiMemory, llmOrchestrator, documentIntelligence, aiWorkflow, integrations, signatures,
      importSessions, leadImport, paymentImport, inventoryImport, quotations,
    },
    seedResult,
  };
}
