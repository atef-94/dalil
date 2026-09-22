import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { InMemoryRepository } from '../../infra/repository.js';
import { RbacEvaluator } from '../permissions/rbac.evaluator.js';
import { AuditLog } from '../../infra/audit-log.js';
import { TaskService } from '../tasks/task.service.js';
import { CommunicationService } from '../communication/communication.service.js';
import { CrmService } from '../crm/crm.service.js';
import { CrmStageService } from '../crm/crm-stage.service.js';
import { MarketingService } from '../marketing/marketing.service.js';
import { OperationsService } from '../operations/operations.service.js';
import { HrService } from '../hr/hr.service.js';
import { FinanceService } from '../finance/finance.service.js';
import { SalesService } from '../sales/sales.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { LegalService } from '../legal/legal.service.js';
import { BrokersService } from '../brokers/brokers.service.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { PaymentPlansService } from '../payment-plans/payment-plans.service.js';
import { QuotationService } from '../quotations/quotation.service.js';
import { AutomationService } from '../automation/automation.service.js';
import { IntegrationService } from '../integrations/integration.service.js';
import { LeadScoringService } from './lead-scoring.service.js';
import { LeadTimelineService } from '../crm/lead-timeline.service.js';
import { LeadDistributionService } from '../crm/lead-distribution.service.js';
import { AiAgentService } from './ai-agent.service.js';
import { AiWorkflowService } from './ai-workflow.service.js';
import { NotFoundError } from '../../infra/errors.js';
import type {
  ActionName,
  AgentDecision,
  AiActionRequest,
  AiPolicy,
  AiWorkflowRun,
  AiWorkflowStepRun,
  ApprovalRequest,
  AuditLogEntry,
  BrokerCompany,
  BrokerLead,
  Campaign,
  Commission,
  CommissionRule,
  CommunicationDeliveryEvent,
  Employee,
  IntegrationConnection,
  IntegrationEvent,
  Lead,
  LeadDistributionPool,
  LeaveRequest,
  LegalDocument,
  MaintenanceTicket,
  Message,
  Contract,
  CrmStage,
  Opportunity,
  Payment,
  PaymentPlanTemplate,
  PaymentScheduleLine,
  PermissionGrant,
  PermissionOverride,
  Project,
  Quotation,
  Receipt,
  Refund,
  Reservation,
  ResourceName,
  Role,
  Secret,
  Task,
  Unit,
  UnitHold,
  User,
  UserRole,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStepRun,
} from '../../domain/types.js';

async function freshHarness(companyIds: string[] = ['c1', 'c2']) {
  const users = new InMemoryRepository<User>();
  const employees = new InMemoryRepository<Employee>();
  const roles = new InMemoryRepository<Role>();
  const grants = new InMemoryRepository<PermissionGrant>();
  const userRoles = new InMemoryRepository<UserRole>();
  const overrides = new InMemoryRepository<PermissionOverride>();
  const rbac = new RbacEvaluator({ users, employees, roles, grants, userRoles, overrides });

  const workflows = new InMemoryRepository<WorkflowDefinition>();
  const runs = new InMemoryRepository<WorkflowRun>();
  const stepRuns = new InMemoryRepository<WorkflowStepRun>();
  const approvals = new InMemoryRepository<ApprovalRequest>();
  const secrets = new InMemoryRepository<Secret>();

  const tasksRepo = new InMemoryRepository<Task>();
  const messages = new InMemoryRepository<Message>();
  const leads = new InMemoryRepository<Lead>();
  const campaigns = new InMemoryRepository<Campaign>();
  const auditLogRepo = new InMemoryRepository<AuditLogEntry>();
  const maintenanceTickets = new InMemoryRepository<MaintenanceTicket>();
  const units = new InMemoryRepository<Unit>();
  const leaveRequests = new InMemoryRepository<LeaveRequest>();
  const payments = new InMemoryRepository<Payment>();
  const receipts = new InMemoryRepository<Receipt>();
  const refunds = new InMemoryRepository<Refund>();
  const scheduleLines = new InMemoryRepository<PaymentScheduleLine>();
  const opportunities = new InMemoryRepository<Opportunity>();
  const contracts = new InMemoryRepository<Contract>();
  const holds = new InMemoryRepository<UnitHold>();
  const reservations = new InMemoryRepository<Reservation>();
  const projects = new InMemoryRepository<Project>();
  const templates = new InMemoryRepository<PaymentPlanTemplate>();
  const pools = new InMemoryRepository<LeadDistributionPool>();
  const legalDocuments = new InMemoryRepository<LegalDocument>();
  const brokerCompanies = new InMemoryRepository<BrokerCompany>();
  const brokerLeads = new InMemoryRepository<BrokerLead>();
  const commissionRules = new InMemoryRepository<CommissionRule>();
  const commissions = new InMemoryRepository<Commission>();

  const crmStages = new CrmStageService(new InMemoryRepository<CrmStage>());
  for (const companyId of companyIds) {
    await crmStages.seedDefaultStages(companyId);
  }
  const tasks = new TaskService(tasksRepo);
  const communication = new CommunicationService(messages);
  const crm = new CrmService(leads, crmStages);
  const marketing = new MarketingService(campaigns, leads, crmStages);
  const auditLog = new AuditLog(auditLogRepo);
  const leadScoring = new LeadScoringService(leads, crmStages);
  const leadTimeline = new LeadTimelineService(leads, auditLogRepo, messages, tasksRepo, opportunities, contracts);
  const leadDistribution = new LeadDistributionService(pools, users, employees, leads, crm, crmStages);
  const operations = new OperationsService(maintenanceTickets, units);
  const hr = new HrService(leaveRequests, employees);
  const finance = new FinanceService(payments, receipts, scheduleLines, refunds);
  const inventory = new InventoryService(units, holds, reservations, projects);
  const paymentPlans = new PaymentPlansService(templates, scheduleLines);
  const quotations = new QuotationService(new InMemoryRepository<Quotation>(), units, paymentPlans);
  const sales = new SalesService(opportunities, contracts, inventory, paymentPlans);
  const legal = new LegalService(legalDocuments, contracts);
  const brokers = new BrokersService(brokerCompanies, brokerLeads, commissionRules, commissions, crm);
  const analytics = new AnalyticsService(leads, opportunities, contracts, scheduleLines, units, commissions, auditLogRepo, campaigns, crmStages);

  const automation = new AutomationService(
    { workflows, runs, stepRuns, approvals, secrets },
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
    'test-encryption-secret-not-for-production',
  );

  const actionRequests = new InMemoryRepository<AiActionRequest>();
  const policies = new InMemoryRepository<AiPolicy>();
  const agentDecisions = new InMemoryRepository<AgentDecision>();

  const integrationConnections = new InMemoryRepository<IntegrationConnection>();
  const integrationEvents = new InMemoryRepository<IntegrationEvent>();
  const communicationDeliveryEvents = new InMemoryRepository<CommunicationDeliveryEvent>();
  const integrations = new IntegrationService(
    { connections: integrationConnections, events: integrationEvents, deliveryEvents: communicationDeliveryEvents },
    automation,
    auditLog,
    (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch,
    0,
  );
  automation.setIntegrationSender((companyId, provider, action, params, userId) =>
    integrations.send(companyId, provider as IntegrationConnection['provider'], action, params, userId),
  );

  const ai = new AiAgentService(
    { actionRequests, policies, approvals, agentDecisions },
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

  const aiWorkflowRuns = new InMemoryRepository<AiWorkflowRun>();
  const aiWorkflowStepRuns = new InMemoryRepository<AiWorkflowStepRun>();
  const aiWorkflow = new AiWorkflowService(
    { runs: aiWorkflowRuns, steps: aiWorkflowStepRuns },
    automation,
    ai,
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

  return {
    rbac,
    ai,
    aiWorkflow,
    automation,
    integrations,
    users,
    roles,
    grants,
    userRoles,
    leads,
    crm,
    crmStages,
    inventory,
    paymentPlans,
    leadDistribution,
    communication,
    employees,
    units,
    policies,
    auditLogRepo,
    aiWorkflowRuns,
    aiWorkflowStepRuns,
    messages,
  };
}

type Harness = Awaited<ReturnType<typeof freshHarness>>;

async function stageByKey(crmStages: CrmStageService, companyId: string, key: string): Promise<CrmStage> {
  const stages = await crmStages.listStages(companyId, true);
  const stage = stages.find((s) => s.key === key);
  if (!stage) throw new Error(`no seeded stage with key "${key}" for ${companyId}`);
  return stage;
}

async function seedUserWithGrants(
  h: Harness,
  companyId: string,
  userId: string,
  grantList: { action: ActionName; resource: ResourceName; scope?: 'own' | 'department' | 'company' }[],
): Promise<void> {
  await h.users.save({
    id: userId,
    companyId,
    email: `${userId}@c.com`,
    passwordHash: 'x',
    userType: 'employee_user',
    locale: 'en',
    failedLoginCount: 0,
    createdAt: new Date().toISOString(),
  });
  const role: Role = { id: `role-${userId}`, companyId, name: 'Test Role', isSystem: false };
  await h.roles.save(role);
  await h.userRoles.save({ id: randomUUID(), userId, roleId: role.id });
  for (const g of grantList) {
    await h.grants.save({ id: randomUUID(), roleId: role.id, action: g.action, resource: g.resource, scope: g.scope ?? 'company', sensitivity: 'standard' });
  }
}

const FULL_GRANTS: { action: ActionName; resource: ResourceName }[] = [
  { action: 'create', resource: 'task' },
  { action: 'create', resource: 'message' },
  { action: 'edit', resource: 'lead' },
];

/** Builds a lead that scores >= the high-value threshold (40): a
 * mid-pipeline stage, a tracked source, an assigned owner, and (unless
 * overridden) real requirement/budget fields so the multi-step flow has
 * something concrete to match against. */
async function createHighValueLead(h: Harness, companyId: string, overrides: Partial<Lead> = {}): Promise<Lead> {
  const qualified = await stageByKey(h.crmStages, companyId, 'qualified');
  const lead = await h.crm.createLead({
    companyId,
    fullName: 'Jane Prospect',
    phone: '+201000000001',
    email: 'jane@example.com',
    sourceId: 'campaign-1',
    stageId: qualified.id,
    ownerEmployeeUserId: overrides.ownerEmployeeUserId ?? 'agent-1',
    propertyTypeWanted: 'apartment',
    minAreaSqm: 80,
    maxAreaSqm: 140,
    maxDownPayment: 200_000,
    maxInstallment: 100_000,
    ...overrides,
  });
  return lead;
}

async function seedMatchingUnit(h: Harness, companyId: string): Promise<Unit> {
  const project = await h.inventory.createProject({ companyId, name: 'Marina Towers' });
  return h.inventory.createUnit({ companyId, projectId: project.id, code: 'A-101', unitType: 'apartment', areaSqm: 110, listPrice: 1_200_000 });
}

async function seedAffordableTemplate(h: Harness, companyId: string): Promise<PaymentPlanTemplate> {
  return h.paymentPlans.createTemplate({
    companyId,
    name: 'Standard 12mo',
    downPaymentType: 'percentage',
    downPaymentValue: 10,
    frequency: 'monthly',
    termMonths: 12,
    fees: [],
  });
}

test('a lead below the high-value score threshold completes immediately without running the multi-step plan', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', FULL_GRANTS);
  const fresh = await stageByKey(h.crmStages, 'c1', 'fresh');
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Cold Lead', phone: '+201000000099', stageId: fresh.id });

  const run = await h.aiWorkflow.startWorkflow('high_value_lead_followup', 'c1', lead.id, 'human-1');
  assert.equal(run.status, 'completed');
  assert.match(run.outcomeSummary ?? '', /below the high-value threshold/);

  const steps = await h.aiWorkflow.getSteps(run.id, 'c1');
  assert.equal(steps.length, 2); // analyze_lead + complete, nothing further
  assert.equal(steps[0]!.stepName, 'analyze_lead');
});

test('a high-value lead with no captured requirements escalates for a human qualifying call', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', FULL_GRANTS);
  const qualified = await stageByKey(h.crmStages, 'c1', 'qualified');
  const lead = await h.crm.createLead({
    companyId: 'c1', fullName: 'No Requirements', phone: '+201000000098', email: 'a@b.com',
    sourceId: 'src', stageId: qualified.id, ownerEmployeeUserId: 'agent-1',
  });

  const run = await h.aiWorkflow.startWorkflow('high_value_lead_followup', 'c1', lead.id, 'human-1');
  assert.equal(run.status, 'escalated');
  assert.match(run.outcomeSummary ?? '', /no captured requirements/);
});

test('a high-value lead escalates when no unit matches, even after broadening the search', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', FULL_GRANTS);
  const lead = await createHighValueLead(h, 'c1');
  // no units seeded at all

  const run = await h.aiWorkflow.startWorkflow('high_value_lead_followup', 'c1', lead.id, 'human-1');
  assert.equal(run.status, 'escalated');
  assert.match(run.outcomeSummary ?? '', /No available unit matched/);

  const steps = await h.aiWorkflow.getSteps(run.id, 'c1');
  const replanStep = steps.find((s) => s.stepName === 'match_suitable_units' && s.status === 'replanned');
  assert.ok(replanStep, 'expected a replanned step broadening the search before escalating');
});

test('a mutating step blocked by missing RBAC permission escalates instead of silently skipping', async () => {
  const h = await freshHarness();
  // no grants at all for human-1
  await seedUserWithGrants(h, 'c1', 'human-1', []);
  const lead = await createHighValueLead(h, 'c1');
  await seedMatchingUnit(h, 'c1');
  await seedAffordableTemplate(h, 'c1');

  const run = await h.aiWorkflow.startWorkflow('high_value_lead_followup', 'c1', lead.id, 'human-1');
  assert.equal(run.status, 'escalated');
  assert.match(run.outcomeSummary ?? '', /does not have permission to create_task/);
});

test('a mutating step with no AiPolicy set defaults to require_approval and escalates rather than assuming success', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', FULL_GRANTS);
  const lead = await createHighValueLead(h, 'c1');
  await seedMatchingUnit(h, 'c1');
  await seedAffordableTemplate(h, 'c1');
  // no AiPolicy set for create_task -> defaults to require_approval

  const run = await h.aiWorkflow.startWorkflow('high_value_lead_followup', 'c1', lead.id, 'human-1');
  assert.equal(run.status, 'escalated');
  assert.match(run.outcomeSummary ?? '', /pending human approval/);
});

test('the full happy path runs every step, waits for a reply, then completes and advances the CRM stage on reply', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', FULL_GRANTS);
  const lead = await createHighValueLead(h, 'c1');
  await seedMatchingUnit(h, 'c1');
  await seedAffordableTemplate(h, 'c1');
  await h.ai.setPolicy('c1', 'create_task', 'auto_execute', 'human-1');
  await h.ai.setPolicy('c1', 'send_message', 'auto_execute', 'human-1');
  await h.ai.setPolicy('c1', 'update_lead_status', 'auto_execute', 'human-1');

  const run = await h.aiWorkflow.startWorkflow('high_value_lead_followup', 'c1', lead.id, 'human-1');
  assert.equal(run.status, 'waiting');
  assert.equal(run.currentStepName, 'wait_for_response');
  assert.ok(run.resumeAt);

  const steps = await h.aiWorkflow.getSteps(run.id, 'c1');
  const stepNames = steps.map((s) => s.stepName);
  assert.deepEqual(stepNames, [
    'analyze_lead',
    'retrieve_history',
    'identify_requirements',
    'match_suitable_units',
    'analyze_payment_plans',
    'select_sales_agent',
    'create_task',
    'generate_personalized_message',
    'send_message',
    'wait_for_response',
  ]);
  assert.ok(steps.every((s) => s.status === 'succeeded'));

  // A real reply gets logged against the lead by someone other than the
  // requester (simulating a customer/agent response).
  await h.communication.sendMessage({
    companyId: 'c1', fromUserId: 'agent-1', toUserId: 'human-1',
    subject: 'Re: interested', body: 'Yes, I would like to view it', relatedResource: 'lead', relatedResourceId: lead.id,
  });

  const resumed = await h.aiWorkflow.resumeWorkflow(run.id, 'c1', 'human-1');
  assert.equal(resumed.status, 'completed');
  assert.match(resumed.outcomeSummary ?? '', /replied and was moved to/);

  const updatedLead = await h.crm.getLead(lead.id);
  assert.notEqual(updatedLead!.stageId, lead.stageId); // moved on from Qualified
});

test('resuming with no reply logged creates a manual follow-up task and escalates', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', FULL_GRANTS);
  const lead = await createHighValueLead(h, 'c1');
  await seedMatchingUnit(h, 'c1');
  await seedAffordableTemplate(h, 'c1');
  await h.ai.setPolicy('c1', 'create_task', 'auto_execute', 'human-1');
  await h.ai.setPolicy('c1', 'send_message', 'auto_execute', 'human-1');

  const run = await h.aiWorkflow.startWorkflow('high_value_lead_followup', 'c1', lead.id, 'human-1');
  assert.equal(run.status, 'waiting');

  const resumed = await h.aiWorkflow.resumeWorkflow(run.id, 'c1', 'human-1');
  assert.equal(resumed.status, 'escalated');
  assert.match(resumed.outcomeSummary ?? '', /No response within the wait window/);
});

test('sweepDueWaitingRuns resumes a run whose resumeAt has already elapsed', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', FULL_GRANTS);
  const lead = await createHighValueLead(h, 'c1');
  await seedMatchingUnit(h, 'c1');
  await seedAffordableTemplate(h, 'c1');
  await h.ai.setPolicy('c1', 'create_task', 'auto_execute', 'human-1');
  await h.ai.setPolicy('c1', 'send_message', 'auto_execute', 'human-1');

  const run = await h.aiWorkflow.startWorkflow('high_value_lead_followup', 'c1', lead.id, 'human-1');
  assert.equal(run.status, 'waiting');

  // Force the deadline into the past instead of waiting real hours.
  await h.aiWorkflowRuns.save({ ...run, resumeAt: new Date(Date.now() - 60_000).toISOString() });

  const results = await h.aiWorkflow.sweepDueWaitingRuns();
  assert.equal(results.length, 1);
  assert.equal(results[0]!.id, run.id);
  assert.equal(results[0]!.status, 'escalated'); // no reply was logged

  const stillWaiting = await h.aiWorkflow.sweepDueWaitingRuns();
  assert.equal(stillWaiting.length, 0); // already resolved, not swept again
});

test('starting a workflow twice for the same lead while one is still active returns the same run (idempotent)', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', FULL_GRANTS);
  const lead = await createHighValueLead(h, 'c1');
  await seedMatchingUnit(h, 'c1');
  await seedAffordableTemplate(h, 'c1');
  await h.ai.setPolicy('c1', 'create_task', 'auto_execute', 'human-1');
  await h.ai.setPolicy('c1', 'send_message', 'auto_execute', 'human-1');

  const first = await h.aiWorkflow.startWorkflow('high_value_lead_followup', 'c1', lead.id, 'human-1');
  assert.equal(first.status, 'waiting');
  const second = await h.aiWorkflow.startWorkflow('high_value_lead_followup', 'c1', lead.id, 'human-1');
  assert.equal(second.id, first.id);

  const allRuns = await h.aiWorkflow.listRuns('c1', lead.id);
  assert.equal(allRuns.length, 1);
});

test('an AI workflow run cannot be read across tenants', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', FULL_GRANTS);
  const lead = await createHighValueLead(h, 'c1');
  const run = await h.aiWorkflow.startWorkflow('high_value_lead_followup', 'c1', lead.id, 'human-1');
  await assert.rejects(() => h.aiWorkflow.getRun(run.id, 'c2'), NotFoundError);
});

test('resuming a run that is not in waiting status is rejected', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', FULL_GRANTS);
  const fresh = await stageByKey(h.crmStages, 'c1', 'fresh');
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Cold Lead', phone: '+201000000097', stageId: fresh.id });
  const run = await h.aiWorkflow.startWorkflow('high_value_lead_followup', 'c1', lead.id, 'human-1');
  assert.equal(run.status, 'completed');
  await assert.rejects(() => h.aiWorkflow.resumeWorkflow(run.id, 'c1', 'human-1'));
});
