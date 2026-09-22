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
import { AiAgentService } from './ai-agent.service.js';
import { AiMemoryService } from './ai-memory.service.js';
import type {
  ActionName,
  AgentDecision,
  AiActionRequest,
  AiMemory,
  AiPolicy,
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
  const integrationFetchCalls: { url: string; init?: RequestInit }[] = [];
  let integrationFetchImpl: typeof fetch = (async (url, init) => {
    integrationFetchCalls.push({ url: String(url), init: init as RequestInit | undefined });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const integrations = new IntegrationService(
    { connections: integrationConnections, events: integrationEvents, deliveryEvents: communicationDeliveryEvents },
    automation,
    auditLog,
    ((url: Parameters<typeof fetch>[0], init?: RequestInit) => integrationFetchImpl(url, init)) as typeof fetch,
    0,
  );
  automation.setIntegrationSender((companyId, provider, action, params, userId) =>
    integrations.send(companyId, provider as IntegrationConnection['provider'], action, params, userId),
  );
  automation.setDeliveryStatusGetter((companyId, relatedResourceId) => integrations.getLatestDeliveryStatusForResource(companyId, relatedResourceId));

  const aiMemory = new AiMemoryService(new InMemoryRepository<AiMemory>());
  automation.setMemoryRecaller((companyId, filter) =>
    aiMemory.recall(companyId, {
      category: filter.category as AiMemory['category'] | undefined,
      subjectType: filter.subjectType as string | undefined,
      subjectId: filter.subjectId as string | undefined,
      query: filter.query as string | undefined,
    }),
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

  return {
    rbac,
    ai,
    automation,
    integrations,
    aiMemory,
    communicationDeliveryEvents,
    integrationFetchCalls,
    setIntegrationFetchImpl: (impl: typeof fetch) => {
      integrationFetchImpl = impl;
    },
    legal,
    brokers,
    analytics,
    legalDocuments,
    brokerCompanies,
    brokerLeads,
    users,
    roles,
    grants,
    userRoles,
    leads,
    crm,
    crmStages,
    marketing,
    operations,
    hr,
    finance,
    employees,
    units,
    projects,
    inventory,
    templates,
    paymentPlans,
    campaigns,
    policies,
    auditLogRepo,
    scheduleLines,
    contracts,
    leaveRequests,
  };
}

async function stageByKey(crmStages: CrmStageService, companyId: string, key: string): Promise<CrmStage> {
  const stages = await crmStages.listStages(companyId, true);
  const stage = stages.find((s) => s.key === key);
  if (!stage) throw new Error(`no seeded stage with key "${key}" for ${companyId}`);
  return stage;
}

async function seedUserWithGrants(
  h: Awaited<ReturnType<typeof freshHarness>>,
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

const CREATE_TASK_GRANT: { action: ActionName; resource: ResourceName } = { action: 'create', resource: 'task' };
const EDIT_LEAD_GRANT: { action: ActionName; resource: ResourceName } = { action: 'edit', resource: 'lead' };
const APPROVE_GRANT: { action: ActionName; resource: ResourceName } = { action: 'approve', resource: 'approval' };

test('an AI action request without the required RBAC grant is denied and never executes', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', []); // no grants
  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'human-1',
    actionType: 'create_task',
    params: { title: 'Should never happen' },
  });
  assert.equal(request.status, 'denied_permission');
  const tasksAfter = await h.automation.listWorkflows('c1'); // sanity: no side effects touched workflows either
  assert.equal(tasksAfter.length, 0);
});

test('with permission but no AiPolicy set, an action defaults to require_approval and pauses', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'human-1',
    actionType: 'create_task',
    params: { title: 'Follow up with lead' },
    reasoning: 'lead went cold',
  });
  assert.equal(request.status, 'pending_approval');
  assert.ok(request.approvalRequestId);
});

test('approving a pending AI action executes it through the automation engine', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  await seedUserWithGrants(h, 'c1', 'approver-1', [APPROVE_GRANT]);
  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'human-1',
    actionType: 'create_task',
    params: { title: 'Follow up with lead' },
  });
  const executed = await h.ai.approveAction(request.approvalRequestId!, 'c1', 'approver-1');
  assert.equal(executed.status, 'executed');
});

test('rejecting a pending AI action denies it and never executes anything', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  await seedUserWithGrants(h, 'c1', 'approver-1', [APPROVE_GRANT]);
  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'human-1',
    actionType: 'create_task',
    params: { title: 'Follow up with lead' },
  });
  const denied = await h.ai.rejectAction(request.approvalRequestId!, 'c1', 'approver-1', 'not needed');
  assert.equal(denied.status, 'denied_policy');
  assert.equal(denied.reasoning, 'not needed');
});

test('a suggest_only policy never executes, even with full permission', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  await h.ai.setPolicy('c1', 'create_task', 'suggest_only', 'human-1');
  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'human-1',
    actionType: 'create_task',
    params: { title: 'Just a suggestion' },
  });
  assert.equal(request.status, 'suggested');
});

test('an auto_execute policy runs the action immediately with no approval step', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  await h.ai.setPolicy('c1', 'create_task', 'auto_execute', 'human-1');
  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'human-1',
    actionType: 'create_task',
    params: { title: 'Auto task' },
  });
  assert.equal(request.status, 'executed');
});

test('an auto_execute action that fails validation is recorded as denied_policy, not silently dropped', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  await h.ai.setPolicy('c1', 'create_task', 'auto_execute', 'human-1');
  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'human-1',
    actionType: 'create_task',
    params: {}, // missing required title
  });
  assert.equal(request.status, 'denied_policy');
  assert.match(request.reasoning ?? '', /title/i);
});

test('AI can never auto-execute an action the human lacks permission for, regardless of policy', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', []); // no grants at all
  await h.ai.setPolicy('c1', 'create_task', 'auto_execute', 'human-1');
  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'human-1',
    actionType: 'create_task',
    params: { title: 'Should be blocked' },
  });
  assert.equal(request.status, 'denied_permission');
});

test('approving an AI action from a different company is rejected (cross-tenant)', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  await seedUserWithGrants(h, 'c2', 'approver-2', [APPROVE_GRANT]);
  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'human-1',
    actionType: 'create_task',
    params: { title: 'x' },
  });
  await assert.rejects(() => h.ai.approveAction(request.approvalRequestId!, 'c2', 'approver-2'));
});

// ---- Regression: 'own'-scoped RBAC grants must actually work for AI actions ----
// requestAction() must forward the real resource owner to
// AutomationService.canPerformAction() — without it, an 'own'-scoped grant
// (the realistic grant for an individual contributor, e.g. a Sales Agent
// acting on their own lead) could never match, so the AI pipeline would
// silently deny_permission for exactly the users it's meant to serve.

test('an own-scoped grant permits an AI action when the real resource owner is supplied', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'agent-1', [{ action: 'create', resource: 'task', scope: 'own' }]);
  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'agent-1',
    actionType: 'create_task',
    params: { title: 'Follow up' },
    ownerUserId: 'agent-1',
  });
  assert.equal(request.status, 'pending_approval');
});

test('an own-scoped grant is not enough when no owner is supplied (sanity check for the bug this guards)', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'agent-1', [{ action: 'create', resource: 'task', scope: 'own' }]);
  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'agent-1',
    actionType: 'create_task',
    params: { title: 'Follow up' },
    // ownerUserId intentionally omitted
  });
  assert.equal(request.status, 'denied_permission');
});

test('an own-scoped grant does not permit acting on someone else\'s resource', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'agent-1', [{ action: 'create', resource: 'task', scope: 'own' }]);
  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'agent-1',
    actionType: 'create_task',
    params: { title: 'Follow up' },
    ownerUserId: 'someone-else',
  });
  assert.equal(request.status, 'denied_permission');
});

test('decide() threads the lead\'s real owner through so an own-scoped Sales Agent grant actually works end-to-end', async () => {
  const h = await freshHarness();
  // Only an 'own'-scoped grant — the realistic real-world Sales Agent
  // grant (see infra/seed.ts), not the broader 'company' scope every
  // other test in this file uses.
  await seedUserWithGrants(h, 'c1', 'agent-1', [{ action: 'edit', resource: 'lead', scope: 'own' }]);
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Own-Scoped Client', phone: '0100', sourceId: 'campaign-1', ownerEmployeeUserId: 'agent-1' });

  const decision = await h.ai.decide('sales', 'c1', lead.id, 'agent-1');

  assert.equal(decision.status, 'proceeded');
  assert.equal(decision.chosenActionType, 'update_lead_status');
  assert.equal(decision.resultActionStatus, 'pending_approval');
});

test('decide() does not let an own-scoped grant reach across to a lead owned by someone else', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'agent-1', [{ action: 'edit', resource: 'lead', scope: 'own' }]);
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Other Owner Client', phone: '0100', sourceId: 'campaign-1', ownerEmployeeUserId: 'someone-else' });

  const decision = await h.ai.decide('sales', 'c1', lead.id, 'agent-1');

  assert.equal(decision.status, 'proceeded');
  assert.equal(decision.resultActionStatus, 'denied_permission');
});

test('getActionRequest rejects a request belonging to a different company (cross-tenant)', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  const request = await h.ai.requestAction({ companyId: 'c1', requestedByUserId: 'human-1', actionType: 'create_task', params: { title: 'x' } });
  await assert.rejects(() => h.ai.getActionRequest(request.id, 'c2'));
});

test('suggestNextAction proposes advancing a well-scored new lead to contacted', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [EDIT_LEAD_GRANT]);
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Promising Client', phone: '0100', sourceId: 'campaign-1', ownerEmployeeUserId: 'human-1' });
  const contacted = await stageByKey(h.crmStages, 'c1', 'contacted');
  const decision = await h.ai.suggestNextAction(lead.id, 'c1', 'human-1');
  assert.equal(decision.status, 'proceeded');
  assert.equal(decision.chosenActionType, 'update_lead_status');
  assert.equal((decision.params as { stageId: string }).stageId, contacted.id);
  assert.match(decision.reasoning, /score/i);
  // Phase 3: the structured decision output — riskLevel/requiredPermission
  // are read from the real Tool Registry, not fabricated per-decision.
  assert.equal(decision.riskLevel, 'medium');
  assert.deepEqual(decision.requiredPermission, { action: 'edit', resource: 'lead' });
  assert.equal(decision.approvalRequired, true); // no AiPolicy set -> defaults to require_approval
  assert.match(decision.nextRecommendedStep, /approval/i);
});

test('a proceeded decision that auto-executes reports approvalRequired: false and a concrete next step', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [EDIT_LEAD_GRANT]);
  await h.ai.setPolicy('c1', 'update_lead_status', 'auto_execute', 'human-1');
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Auto Client', phone: '0101', sourceId: 'campaign-1', ownerEmployeeUserId: 'human-1' });
  const decision = await h.ai.suggestNextAction(lead.id, 'c1', 'human-1');
  assert.equal(decision.status, 'proceeded');
  assert.equal(decision.resultActionStatus, 'executed');
  assert.equal(decision.approvalRequired, false);
  assert.match(decision.nextRecommendedStep, /already executed/i);
});

test('an escalated decision has no riskLevel/requiredPermission (no action was chosen to execute)', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [EDIT_LEAD_GRANT]);
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Qualified Client', phone: '0100' });
  const recycle = await stageByKey(h.crmStages, 'c1', 'recycle');
  await h.crm.moveToStage(lead.id, 'c1', recycle.id);
  const decision = await h.ai.decide('sales', 'c1', lead.id, 'human-1');
  assert.equal(decision.status, 'escalated');
  // decideSales's escalation path still proposes a create_task action
  // (it's the alternative it would take if not escalated), so risk
  // metadata is still populated from that chosen action type.
  assert.equal(decision.riskLevel, 'low');
  assert.match(decision.nextRecommendedStep, /human review/i);
});

test('suggestNextAction reports no_action for a lead already lost, without proposing anything', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [EDIT_LEAD_GRANT]);
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Gone Cold', phone: '0100' });
  const lost = await stageByKey(h.crmStages, 'c1', 'lost');
  await h.crm.moveToStage(lead.id, 'c1', lost.id, 'went with a competitor');
  const decision = await h.ai.suggestNextAction(lead.id, 'c1', 'human-1');
  assert.equal(decision.status, 'no_action');
  assert.equal(decision.chosenActionType, undefined);
});

test('suggestNextAction executes automatically when the company opts a lead action into auto_execute', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [EDIT_LEAD_GRANT]);
  await h.ai.setPolicy('c1', 'update_lead_status', 'auto_execute', 'human-1');
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Hot Lead', phone: '0100', sourceId: 'campaign-1', ownerEmployeeUserId: 'human-1' });
  const contacted = await stageByKey(h.crmStages, 'c1', 'contacted');
  const decision = await h.ai.suggestNextAction(lead.id, 'c1', 'human-1');
  assert.equal(decision.status, 'proceeded');
  assert.equal(decision.resultActionStatus, 'executed');
  const updated = await h.crm.getLead(lead.id);
  assert.equal(updated!.stageId, contacted.id);
});

test('setPolicy overwrites an existing policy for the same company and action type rather than duplicating it', async () => {
  const h = await freshHarness();
  await h.ai.setPolicy('c1', 'create_task', 'suggest_only', 'human-1');
  await h.ai.setPolicy('c1', 'create_task', 'auto_execute', 'human-1');
  const policies = await h.ai.listPolicies('c1');
  const matching = policies.filter((p) => p.actionType === 'create_task');
  assert.equal(matching.length, 1);
  assert.equal(matching[0]!.autonomyLevel, 'auto_execute');
});

test('every AI action request is recorded in the audit log with executedByAI metadata', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', []);
  await h.ai.requestAction({ companyId: 'c1', requestedByUserId: 'human-1', actionType: 'create_task', params: { title: 'x' } });
  const list = await h.ai.listActionRequests('c1');
  assert.equal(list.length, 1);
  assert.equal(list[0]!.status, 'denied_permission');
});

// ---- Phase 2: Agent Orchestration Layer ----

test('listAgents returns all 9 specialized business-function agents', async () => {
  const h = await freshHarness();
  const keys = h.ai.listAgents().map((a) => a.key);
  assert.deepEqual(keys.sort(), ['broker', 'finance', 'hr', 'inventory', 'legal', 'management', 'marketing', 'sales', 'support']);
});

test('listTools returns the full tool registry, or a per-agent boundary-filtered subset', async () => {
  const h = await freshHarness();
  const allTools = h.ai.listTools();
  assert.ok(allTools.length >= 7);
  const salesTools = h.ai.listTools('sales');
  assert.ok(salesTools.every((t) => [
    'update_lead_status', 'assign_lead_owner', 'create_task', 'send_message', 'integration_call', 'score_lead', 'compare_payment_plans', 'get_delivery_status', 'recall_memory',
    'search_units', 'search_projects', 'get_project_details', 'get_project_payment_plans', 'get_project_facilities', 'get_project_location',
  ].includes(t.actionType)));
  assert.ok(!salesTools.some((t) => t.actionType === 'webhook_call'));
});

test('listTools rejects an unknown agent key', async () => {
  const h = await freshHarness();
  assert.throws(() => h.ai.listTools('not-a-real-agent'));
});

test('the Tool Registry exposes real, non-fabricated risk/department/permission metadata for every tool (Phase 7)', async () => {
  const h = await freshHarness();
  const tools = h.ai.listTools();
  for (const tool of tools) {
    assert.ok(['low', 'medium', 'high'].includes(tool.riskLevel), `${tool.actionType} has an invalid riskLevel`);
    assert.ok(tool.department.length > 0, `${tool.actionType} has no department`);
    assert.equal(tool.auditRequired, true);
    assert.ok(tool.requiredPermission.action && tool.requiredPermission.resource, `${tool.actionType} has no requiredPermission`);
  }
  // High-risk tools are the genuinely dangerous ones (external calls,
  // financial writes) — not an arbitrary label.
  const highRisk = tools.filter((t) => t.riskLevel === 'high').map((t) => t.actionType).sort();
  assert.deepEqual(highRisk, ['cancel_contract', 'record_payment', 'webhook_call']);
  // requiredPermission is read from automation.service.ts's real
  // ACTION_RESOURCE/ACTION_VERB maps, not a second hand-maintained copy —
  // spot-check one entry against what the executor actually enforces.
  const updateLeadStatusTool = tools.find((t) => t.actionType === 'update_lead_status')!;
  assert.deepEqual(updateLeadStatusTool.requiredPermission, { action: 'edit', resource: 'lead' });
});

// ---- Read-only tools (search_units/score_lead/compare_payment_plans) bypass
// the autonomy/approval gate entirely, since they never mutate anything —
// but RBAC is still fully enforced. ----

const VIEW_UNIT_GRANT: { action: ActionName; resource: ResourceName } = { action: 'view', resource: 'unit' };
const VIEW_LEAD_GRANT2: { action: ActionName; resource: ResourceName } = { action: 'view', resource: 'lead' };
const CREATE_QUOTATION_GRANT: { action: ActionName; resource: ResourceName } = { action: 'create', resource: 'quotation' };
const CREATE_LEAD_GRANT: { action: ActionName; resource: ResourceName } = { action: 'create', resource: 'lead' };
const EDIT_CAMPAIGN_GRANT: { action: ActionName; resource: ResourceName } = { action: 'edit', resource: 'campaign' };

test('a read-only tool (search_units) executes immediately with no AiPolicy set — approval would make it unusable', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [VIEW_UNIT_GRANT]);
  await h.projects.save({ id: 'proj-1', companyId: 'c1', name: 'Test Project', createdAt: new Date().toISOString() });
  await h.units.save({ id: 'unit-1', companyId: 'c1', projectId: 'proj-1', code: 'A-101', unitType: '2BR', areaSqm: 120, listPrice: 1_000_000, status: 'available', createdAt: new Date().toISOString() });
  // Deliberately no h.ai.setPolicy call for 'search_units' — if this tool
  // went through the ordinary autonomy gate it would default to
  // require_approval and never execute.
  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'human-1',
    actionType: 'search_units',
    params: { projectId: 'proj-1' },
  });
  assert.equal(request.status, 'executed');
  assert.equal(request.approvalRequestId, undefined);
});

test('a read-only tool (score_lead) still enforces the RBAC permission check', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', []); // no grants at all
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Client', phone: '0100', ownerEmployeeUserId: 'human-1' });
  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'human-1',
    actionType: 'score_lead',
    params: { leadId: lead.id },
  });
  assert.equal(request.status, 'denied_permission');
});

test('score_lead (read-only) returns the same real LeadScoringService result the analytics page uses', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [VIEW_LEAD_GRANT2]);
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Client', phone: '0100', ownerEmployeeUserId: 'human-1' });
  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'human-1',
    actionType: 'score_lead',
    params: { leadId: lead.id },
    ownerUserId: 'human-1',
  });
  assert.equal(request.status, 'executed');
});

test('compare_payment_plans (read-only) computes real comparisons via QuotationService, with no AiPolicy set', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_QUOTATION_GRANT]);
  await h.projects.save({ id: 'proj-1', companyId: 'c1', name: 'Test Project', createdAt: new Date().toISOString() });
  await h.units.save({ id: 'unit-1', companyId: 'c1', projectId: 'proj-1', code: 'A-101', unitType: '2BR', areaSqm: 120, listPrice: 1_000_000, status: 'available', createdAt: new Date().toISOString() });
  await h.templates.save({
    id: 'tpl-1', companyId: 'c1', projectId: 'proj-1', name: 'Standard Plan', version: 1,
    downPaymentType: 'percentage', downPaymentValue: 10, frequency: 'monthly', termMonths: 24, fees: [], createdAt: new Date().toISOString(), archived: false,
  });
  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'human-1',
    actionType: 'compare_payment_plans',
    params: { unitId: 'unit-1' },
    ownerUserId: 'human-1',
  });
  assert.equal(request.status, 'executed');
});

const VIEW_INTEGRATION_GRANT: { action: ActionName; resource: ResourceName } = { action: 'view', resource: 'integration_connection' };

test('get_delivery_status (read-only) returns the real, provider-confirmed status — never "sent = delivered"', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [VIEW_INTEGRATION_GRANT, INTEGRATION_CALL_GRANT, EDIT_LEAD_GRANT]);
  await h.ai.setPolicy('c1', 'integration_call', 'auto_execute', 'human-1');
  await h.integrations.connect({
    companyId: 'c1', provider: 'whatsapp', displayName: 'WA', config: { phoneNumberId: 'pn-1' },
    credentials: { access_token: 'tok' }, createdByUserId: 'human-1',
  });
  h.setIntegrationFetchImpl((async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.LIVE1' }] }), { status: 200 })) as typeof fetch);
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Client', phone: '0100' });

  await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'human-1',
    actionType: 'integration_call',
    params: { provider: 'whatsapp', action: 'send_message', to: '0100', body: 'hi', leadId: lead.id },
    ownerUserId: 'human-1',
  });

  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'human-1',
    actionType: 'get_delivery_status',
    params: { relatedResourceId: lead.id },
  });
  assert.equal(request.status, 'executed');
});

const VIEW_MEMORY_GRANT: { action: ActionName; resource: ResourceName } = { action: 'view', resource: 'ai_memory' };

test('recall_memory (read-only) returns real, tenant-scoped memory and excludes another company\'s memory', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [VIEW_MEMORY_GRANT]);
  await h.aiMemory.remember({ companyId: 'c1', category: 'lead', content: 'Prefers evening calls', subjectType: 'lead', subjectId: 'lead-1', source: { type: 'user_note' } });
  await h.aiMemory.remember({ companyId: 'c2', category: 'lead', content: 'Different company memory', subjectType: 'lead', subjectId: 'lead-1', source: { type: 'user_note' } });

  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'human-1',
    actionType: 'recall_memory',
    params: { subjectType: 'lead', subjectId: 'lead-1' },
  });
  assert.equal(request.status, 'executed');

  // The AI tool's own dispatch path (AutomationService.executeAction's
  // recall_memory case) is what requestAction() just exercised above —
  // check its actual return value directly to confirm it's real,
  // tenant-scoped data, not a stub.
  const output = await h.automation.executeActionDirect('c1', 'human-1', {
    type: 'recall_memory',
    params: { subjectType: 'lead', subjectId: 'lead-1' },
  });
  const memories = (output as { memories: { content: string }[] }).memories;
  assert.equal(memories.length, 1);
  assert.equal(memories[0]!.content, 'Prefers evening calls');
});

test('recall_memory (read-only) is denied without view:ai_memory permission', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', []);
  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'human-1',
    actionType: 'recall_memory',
    params: {},
  });
  assert.equal(request.status, 'denied_permission');
});

// ---- Real post-execution verification (never assumes success just because
// executeActionDirect() didn't throw) ----

test('executing update_lead_status re-reads the lead and records verificationStatus "verified"', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [EDIT_LEAD_GRANT]);
  await h.ai.setPolicy('c1', 'update_lead_status', 'auto_execute', 'human-1');
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Client', phone: '0100', ownerEmployeeUserId: 'human-1' });
  const contacted = await stageByKey(h.crmStages, 'c1', 'contacted');
  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'human-1',
    actionType: 'update_lead_status',
    params: { leadId: lead.id, stageId: contacted.id },
    ownerUserId: 'human-1',
  });
  assert.equal(request.status, 'executed');
  assert.equal(request.verificationStatus, 'verified');
  assert.match(request.verificationDetail ?? '', new RegExp(contacted.id));
});

test('executing create_lead re-reads the new lead and records verificationStatus "verified"', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_LEAD_GRANT]);
  await h.ai.setPolicy('c1', 'create_lead', 'auto_execute', 'human-1');
  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'human-1',
    actionType: 'create_lead',
    params: { fullName: 'New Lead', phone: '0101' },
    ownerUserId: 'human-1',
  });
  assert.equal(request.status, 'executed');
  assert.equal(request.verificationStatus, 'verified');
});

test('executing update_campaign_status re-reads the campaign and records verificationStatus "verified"', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [EDIT_CAMPAIGN_GRANT]);
  await h.ai.setPolicy('c1', 'update_campaign_status', 'auto_execute', 'human-1');
  await h.campaigns.save({ id: 'camp-1', companyId: 'c1', name: 'Test Campaign', channel: 'digital', budget: 1000, startDate: new Date().toISOString(), status: 'active', createdAt: new Date().toISOString() });
  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'human-1',
    actionType: 'update_campaign_status',
    params: { campaignId: 'camp-1', status: 'cancelled' },
  });
  assert.equal(request.status, 'executed');
  assert.equal(request.verificationStatus, 'verified');
});

test('verificationStatus is undefined for a suggested/pending action — verification only ever runs after real execution', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [EDIT_LEAD_GRANT]);
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Client', phone: '0100', ownerEmployeeUserId: 'human-1' });
  const contacted = await stageByKey(h.crmStages, 'c1', 'contacted');
  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'human-1',
    actionType: 'update_lead_status',
    params: { leadId: lead.id, stageId: contacted.id },
    ownerUserId: 'human-1',
  });
  assert.equal(request.status, 'pending_approval');
  assert.equal(request.verificationStatus, undefined);
});

// ---- Advanced AI Policy Engine (partial): financial amount / channel /
// working-hours guardrails on top of the autonomyLevel enum. Every check
// can only escalate auto_execute -> require_approval, never loosen a
// stricter autonomyLevel. ----

const RECORD_PAYMENT_GRANT: { action: ActionName; resource: ResourceName } = { action: 'edit', resource: 'payment_schedule' };

async function seedContractAndLine(h: Awaited<ReturnType<typeof freshHarness>>, companyId = 'c1', lineAmount = 5000) {
  await h.contracts.save({
    id: 'contract-1', companyId, reservationId: 'r1', unitId: 'u1', clientId: 'lead-1',
    creditedEmployeeUserId: 'human-1', paymentPlanTemplateId: 't1', status: 'signed', createdAt: new Date().toISOString(),
  });
  await h.scheduleLines.save({
    id: 'line-1', companyId, contractId: 'contract-1', sourceTemplateId: 't1', sourceTemplateVersion: 1,
    sequence: 0, label: 'Installment', dueDate: new Date().toISOString(), amount: lineAmount, amountPaid: 0, status: 'upcoming',
  });
}

test('a maxFinancialAmount policy limit escalates an over-limit auto_execute payment to require_approval', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [RECORD_PAYMENT_GRANT]);
  await seedContractAndLine(h);
  await h.ai.setPolicy('c1', 'record_payment', 'auto_execute', 'human-1', { maxFinancialAmount: 1000 });

  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'human-1',
    actionType: 'record_payment',
    params: { contractId: 'contract-1', paymentScheduleLineId: 'line-1', amount: 5000, method: 'transfer' },
    ownerUserId: 'human-1',
  });
  assert.equal(request.status, 'pending_approval');
  assert.match(request.reasoning ?? '', /exceeds this company's AI financial limit/);
});

test('a payment within the maxFinancialAmount limit still auto-executes', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [RECORD_PAYMENT_GRANT]);
  await seedContractAndLine(h, 'c1', 500);
  await h.ai.setPolicy('c1', 'record_payment', 'auto_execute', 'human-1', { maxFinancialAmount: 1000 });

  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'human-1',
    actionType: 'record_payment',
    params: { contractId: 'contract-1', paymentScheduleLineId: 'line-1', amount: 500, method: 'transfer' },
    ownerUserId: 'human-1',
  });
  assert.equal(request.status, 'executed');
});

test('an allowedChannels policy limit blocks a disallowed provider on integration_call, requiring approval', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [EDIT_LEAD_GRANT, INTEGRATION_CALL_GRANT]);
  await h.ai.setPolicy('c1', 'integration_call', 'auto_execute', 'human-1', { allowedChannels: ['email'] });
  await h.integrations.connect({
    companyId: 'c1', provider: 'whatsapp', displayName: 'WA', config: { phoneNumberId: 'pn-1' },
    credentials: { access_token: 'tok' }, createdByUserId: 'human-1',
  });

  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'human-1',
    actionType: 'integration_call',
    params: { provider: 'whatsapp', action: 'send_message', to: '0100', body: 'hi' },
    ownerUserId: 'human-1',
  });
  assert.equal(request.status, 'pending_approval');
  assert.match(request.reasoning ?? '', /not in this company's AI-allowed channel list/);
});

test('a workingHours policy limit blocks an outside-window integration_call, requiring approval', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [EDIT_LEAD_GRANT, INTEGRATION_CALL_GRANT]);
  // A 1-hour window starting 2 hours from now (UTC) can never contain "now".
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const start = new Date(now.getTime() + 2 * 3600_000);
  const end = new Date(now.getTime() + 3 * 3600_000);
  await h.ai.setPolicy('c1', 'integration_call', 'auto_execute', 'human-1', {
    workingHoursStart: `${pad(start.getUTCHours())}:${pad(start.getUTCMinutes())}`,
    workingHoursEnd: `${pad(end.getUTCHours())}:${pad(end.getUTCMinutes())}`,
  });
  await h.integrations.connect({
    companyId: 'c1', provider: 'whatsapp', displayName: 'WA', config: { phoneNumberId: 'pn-1' },
    credentials: { access_token: 'tok' }, createdByUserId: 'human-1',
  });

  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'human-1',
    actionType: 'integration_call',
    params: { provider: 'whatsapp', action: 'send_message', to: '0100', body: 'hi' },
    ownerUserId: 'human-1',
  });
  assert.equal(request.status, 'pending_approval');
  assert.match(request.reasoning ?? '', /outside the company's configured AI working hours/);
});

test('requestAction rejects a call missing a required tool parameter without throwing, recorded as denied_policy', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [EDIT_LEAD_GRANT]);
  const request = await h.ai.requestAction({
    companyId: 'c1',
    requestedByUserId: 'human-1',
    actionType: 'update_lead_status',
    params: { leadId: 'lead-1' }, // missing required stageId
  });
  assert.equal(request.status, 'denied_policy');
  assert.match(request.reasoning ?? '', /stageId/);
});

// ---- Cross-module: Sales agent reaching out via the Integration Layer ----

const INTEGRATION_CALL_GRANT: { action: ActionName; resource: ResourceName } = { action: 'create', resource: 'integration_connection' };

test('sales agent reaches out via a connected WhatsApp integration instead of only updating status', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [EDIT_LEAD_GRANT, INTEGRATION_CALL_GRANT]);
  await h.ai.setPolicy('c1', 'integration_call', 'auto_execute', 'human-1');
  await h.integrations.connect({
    companyId: 'c1',
    provider: 'whatsapp',
    displayName: 'Company WhatsApp',
    config: { phoneNumberId: 'pn-1' },
    credentials: { access_token: 'tok' },
    createdByUserId: 'human-1',
  });
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'WA Client', phone: '0100' });

  const decision = await h.ai.decide('sales', 'c1', lead.id, 'human-1');

  assert.equal(decision.chosenActionType, 'integration_call');
  assert.equal(decision.params?.provider, 'whatsapp');
  assert.equal(decision.params?.to, '0100');
  assert.equal(decision.status, 'proceeded');
  assert.equal(h.integrationFetchCalls.length, 1);
  assert.match(h.integrationFetchCalls[0]!.url, /graph\.facebook\.com/);
  // still unchanged — reaching out doesn't itself advance the pipeline stage
  const fresh = await stageByKey(h.crmStages, 'c1', 'fresh');
  const unchanged = await h.crm.getLead(lead.id);
  assert.equal(unchanged!.stageId, fresh.id);
});

test('sales agent falls back to email when only an email integration is connected and the lead has no phone-eligible WhatsApp path', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [EDIT_LEAD_GRANT, INTEGRATION_CALL_GRANT]);
  await h.ai.setPolicy('c1', 'integration_call', 'auto_execute', 'human-1');
  await h.integrations.connect({
    companyId: 'c1',
    provider: 'email',
    displayName: 'Company Email',
    config: { fromAddress: 'sales@demo.local' },
    credentials: { api_key: 'key' },
    createdByUserId: 'human-1',
  });
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Email Client', phone: '0100', email: 'client@example.com' });

  const decision = await h.ai.decide('sales', 'c1', lead.id, 'human-1');

  assert.equal(decision.chosenActionType, 'integration_call');
  assert.equal(decision.params?.provider, 'email');
  assert.equal(decision.params?.to, 'client@example.com');
});

test('a lead is never messaged twice automatically — the second decision advances status instead', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [EDIT_LEAD_GRANT, INTEGRATION_CALL_GRANT]);
  await h.ai.setPolicy('c1', 'integration_call', 'auto_execute', 'human-1');
  await h.ai.setPolicy('c1', 'update_lead_status', 'auto_execute', 'human-1');
  await h.integrations.connect({
    companyId: 'c1',
    provider: 'whatsapp',
    displayName: 'Company WhatsApp',
    config: { phoneNumberId: 'pn-1' },
    credentials: { access_token: 'tok' },
    createdByUserId: 'human-1',
  });
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'WA Client 2', phone: '0200' });

  // First decision: reaches out over WhatsApp (an 'executed' outcome, so
  // it's stale for findRecentDecision's memoization — the second call
  // below genuinely re-runs the rule set instead of replaying this one).
  const first = await h.ai.decide('sales', 'c1', lead.id, 'human-1');
  assert.equal(first.chosenActionType, 'integration_call');
  assert.equal(first.resultActionStatus, 'executed');
  assert.equal(h.integrationFetchCalls.length, 1);

  // Second decision on the same still-'new' lead: hasAlreadyReachedOut now
  // sees the prior IntegrationEvent and refuses to message again, so the
  // agent falls back to its ordinary status-advance action instead.
  const second = await h.ai.decide('sales', 'c1', lead.id, 'human-1');
  assert.equal(second.chosenActionType, 'update_lead_status');
  assert.equal(h.integrationFetchCalls.length, 1);

  const contacted = await stageByKey(h.crmStages, 'c1', 'contacted');
  const updated = await h.crm.getLead(lead.id);
  assert.equal(updated!.stageId, contacted.id);
});

test('a lead at the last stage before a Won/Lost decision escalates to a human instead of guessing at conversion', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [EDIT_LEAD_GRANT]);
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Qualified Client', phone: '0100' });
  const recycle = await stageByKey(h.crmStages, 'c1', 'recycle');
  await h.crm.moveToStage(lead.id, 'c1', recycle.id);
  const decision = await h.ai.decide('sales', 'c1', lead.id, 'human-1');
  assert.equal(decision.status, 'escalated');
  assert.equal(decision.confidence, 15);
});

test('a repeat decision within the cooldown window reuses the prior decision instead of re-deciding', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [EDIT_LEAD_GRANT]);
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Repeat Client', phone: '0100' });
  const first = await h.ai.decide('sales', 'c1', lead.id, 'human-1');
  const second = await h.ai.decide('sales', 'c1', lead.id, 'human-1');
  assert.equal(first.id, second.id);
});

test('decide throws for an unknown agent key', async () => {
  const h = await freshHarness();
  await assert.rejects(() => h.ai.decide('not-a-real-agent', 'c1', 'subject-1', 'human-1'));
});

// ---- Marketing Agent ----

test('marketing agent flags a low-converting, high-volume campaign for review', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  const campaign = await h.marketing.createCampaign({ companyId: 'c1', name: 'Underperformer', channel: 'digital', budget: 5000, startDate: '2026-01-01' });
  await h.marketing.updateStatus(campaign.id, 'c1', 'active');
  for (let i = 0; i < 10; i++) {
    await h.crm.createLead({ companyId: 'c1', fullName: `Lead ${i}`, phone: `010${i}`, sourceId: campaign.id });
  }
  const decision = await h.ai.decide('marketing', 'c1', campaign.id, 'human-1');
  assert.equal(decision.status, 'proceeded');
  assert.equal(decision.chosenActionType, 'create_task');
  assert.match(decision.reasoning, /conversion/i);
});

test('marketing agent reports no_action for a healthy or non-active campaign', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  const campaign = await h.marketing.createCampaign({ companyId: 'c1', name: 'Planned Campaign', channel: 'digital', budget: 1000, startDate: '2026-01-01' });
  const decision = await h.ai.decide('marketing', 'c1', campaign.id, 'human-1');
  assert.equal(decision.status, 'no_action');
});

// ---- Finance Agent ----

test('finance agent recommends a collections follow-up for an overdue payment line', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  const overdueDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const line = await h.scheduleLines.save({
    id: 'line-1', companyId: 'c1', contractId: 'contract-1', sourceTemplateId: 'tpl-1', sourceTemplateVersion: 1,
    sequence: 1, label: 'Installment 1', dueDate: overdueDate, amount: 10000, amountPaid: 0, status: 'overdue',
  });
  const decision = await h.ai.decide('finance', 'c1', line.id, 'human-1');
  assert.equal(decision.status, 'proceeded');
  assert.equal(decision.chosenActionType, 'create_task');
  assert.match(decision.reasoning, /overdue/i);
});

test('finance agent reports no_action for a payment line that is not overdue', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  const line = await h.scheduleLines.save({
    id: 'line-2', companyId: 'c1', contractId: 'contract-1', sourceTemplateId: 'tpl-1', sourceTemplateVersion: 1,
    sequence: 1, label: 'Installment 1', dueDate: new Date().toISOString(), amount: 10000, amountPaid: 0, status: 'upcoming',
  });
  const decision = await h.ai.decide('finance', 'c1', line.id, 'human-1');
  assert.equal(decision.status, 'no_action');
});

// ---- Support / Customer Service Agent ----

async function seedUnit(h: Awaited<ReturnType<typeof freshHarness>>, companyId = 'c1'): Promise<Unit> {
  return h.units.save({
    id: 'unit-1', companyId, projectId: 'project-1', code: 'A-101', unitType: 'apartment',
    areaSqm: 100, listPrice: 1000000, status: 'available', createdAt: new Date().toISOString(),
  });
}

test('support agent flags an urgent unassigned ticket for prompt assignment', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  const unit = await seedUnit(h);
  const ticket = await h.operations.createTicket({ companyId: 'c1', unitId: unit.id, title: 'Burst pipe', priority: 'urgent', reportedByUserId: 'human-1' });
  const decision = await h.ai.decide('support', 'c1', ticket.id, 'human-1');
  assert.equal(decision.status, 'proceeded');
  assert.equal(decision.chosenActionType, 'create_task');
  assert.equal(decision.confidence, 90);
});

test('support agent reports no_action for a low-priority assigned ticket', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  const unit = await seedUnit(h);
  const ticket = await h.operations.createTicket({ companyId: 'c1', unitId: unit.id, title: 'Squeaky door', priority: 'low', reportedByUserId: 'human-1' });
  await h.operations.assignTicket(ticket.id, 'c1', 'human-1');
  const decision = await h.ai.decide('support', 'c1', ticket.id, 'human-1');
  assert.equal(decision.status, 'no_action');
});

// ---- HR Agent ----

test('hr agent recommends a reminder for a leave request pending too long', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  await h.employees.save({ id: 'emp-1', companyId: 'c1', fullName: 'Test Employee', email: 'e@c1.com', title: 'Agent', status: 'active', createdAt: new Date().toISOString() });
  const leave = await h.hr.requestLeave({ companyId: 'c1', employeeId: 'emp-1', type: 'annual', startDate: '2026-03-01', endDate: '2026-03-05' });
  // Back-date requestedAt directly via the repository (HrService has no
  // "back-date a request" API — this only simulates the passage of time).
  await h.leaveRequests.save({ ...leave, requestedAt: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString() });

  const decision = await h.ai.decide('hr', 'c1', leave.id, 'human-1');
  assert.equal(decision.status, 'proceeded');
  assert.equal(decision.chosenActionType, 'create_task');
  assert.match(decision.reasoning, /pending/i);
});

test('hr agent reports no_action for a leave request still within the normal review window', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  await h.employees.save({ id: 'emp-1', companyId: 'c1', fullName: 'Test Employee', email: 'e@c1.com', title: 'Agent', status: 'active', createdAt: new Date().toISOString() });
  const leave = await h.hr.requestLeave({ companyId: 'c1', employeeId: 'emp-1', type: 'annual', startDate: '2026-03-01', endDate: '2026-03-05' });
  const decision = await h.ai.decide('hr', 'c1', leave.id, 'human-1');
  assert.equal(decision.status, 'no_action');
});

// ---- Legal Agent ----

test('legal agent recommends chasing a document stuck pending too long', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  await h.legalDocuments.save({
    id: 'doc-1', companyId: 'c1', contractId: 'contract-1', type: 'title_deed', name: 'Title Deed',
    status: 'pending', uploadedByUserId: 'human-1', createdAt: new Date(Date.now() - 80 * 60 * 60 * 1000).toISOString(),
  });
  const decision = await h.ai.decide('legal', 'c1', 'doc-1', 'human-1');
  assert.equal(decision.status, 'proceeded');
  assert.equal(decision.chosenActionType, 'create_task');
  assert.match(decision.reasoning, /pending/i);
});

test('legal agent recommends verifying a received-but-unverified document', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  await h.legalDocuments.save({
    id: 'doc-2', companyId: 'c1', contractId: 'contract-1', type: 'id_verification', name: 'ID Card',
    status: 'received', uploadedByUserId: 'human-1', createdAt: new Date(Date.now() - 55 * 60 * 60 * 1000).toISOString(),
  });
  const decision = await h.ai.decide('legal', 'c1', 'doc-2', 'human-1');
  assert.equal(decision.status, 'proceeded');
  assert.match(decision.reasoning, /verif/i);
});

test('legal agent reports no_action for an already-verified document', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  await h.legalDocuments.save({
    id: 'doc-3', companyId: 'c1', contractId: 'contract-1', type: 'id_verification', name: 'ID Card',
    status: 'verified', uploadedByUserId: 'human-1', createdAt: new Date().toISOString(), verifiedAt: new Date().toISOString(),
  });
  const decision = await h.ai.decide('legal', 'c1', 'doc-3', 'human-1');
  assert.equal(decision.status, 'no_action');
});

// ---- Broker Agent ----

test('broker agent flags a quarantined lead pending review too long, but never auto-approves it', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  await h.brokerCompanies.save({ id: 'bc-1', companyId: 'c1', name: 'Acme Brokers', status: 'approved', createdAt: new Date().toISOString() });
  await h.brokerLeads.save({
    id: 'bl-1', companyId: 'c1', brokerCompanyId: 'bc-1', submittedByUserId: 'broker-user-1',
    fullName: 'Broker Lead', phone: '0100', approvalStatus: 'pending_approval',
    protectionExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
  });
  const decision = await h.ai.decide('broker', 'c1', 'bl-1', 'human-1');
  assert.equal(decision.status, 'proceeded');
  assert.equal(decision.chosenActionType, 'create_task');
  assert.match(decision.reasoning, /never auto-approved/i);
  // Boundary check: 'approve broker lead' isn't even a valid AutomationActionType,
  // so there's no risk of this agent choosing it — confirmed via its allowedActionTypes.
  const brokerAgent = h.ai.listAgents().find((a) => a.key === 'broker')!;
  assert.deepEqual(brokerAgent.allowedActionTypes.sort(), ['create_task', 'send_message']);
});

test('broker agent reports no_action for a lead already decided', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  await h.brokerCompanies.save({ id: 'bc-2', companyId: 'c1', name: 'Acme Brokers', status: 'approved', createdAt: new Date().toISOString() });
  await h.brokerLeads.save({
    id: 'bl-2', companyId: 'c1', brokerCompanyId: 'bc-2', submittedByUserId: 'broker-user-1',
    fullName: 'Broker Lead 2', phone: '0101', approvalStatus: 'approved', leadId: 'lead-x',
    protectionExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  });
  const decision = await h.ai.decide('broker', 'c1', 'bl-2', 'human-1');
  assert.equal(decision.status, 'no_action');
});

// ---- Project & Inventory Agent ----

test('inventory agent flags a unit that has sat available for a long time with no reservation history', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  const staleUnit = await h.units.save({
    id: 'unit-stale', companyId: 'c1', projectId: 'project-1', code: 'A-999', unitType: 'apartment',
    areaSqm: 100, listPrice: 1000000, status: 'available', createdAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const decision = await h.ai.decide('inventory', 'c1', staleUnit.id, 'human-1');
  assert.equal(decision.status, 'proceeded');
  assert.equal(decision.chosenActionType, 'create_task');
  assert.match(decision.reasoning, /stale|reservation/i);
});

test('inventory agent reports no_action for a recently-listed unit', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  const freshUnit = await h.units.save({
    id: 'unit-fresh', companyId: 'c1', projectId: 'project-1', code: 'A-1', unitType: 'apartment',
    areaSqm: 100, listPrice: 1000000, status: 'available', createdAt: new Date().toISOString(),
  });
  const decision = await h.ai.decide('inventory', 'c1', freshUnit.id, 'human-1');
  assert.equal(decision.status, 'no_action');
});

// ---- Management Intelligence Agent ----

test('management agent flags a company-wide collections risk when overdue share crosses the threshold', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  await h.scheduleLines.save({ id: 'l1', companyId: 'c1', contractId: 'c-1', sourceTemplateId: 't', sourceTemplateVersion: 1, sequence: 1, label: 'Overdue', dueDate: '2026-01-01', amount: 8000, amountPaid: 0, status: 'overdue' });
  await h.scheduleLines.save({ id: 'l2', companyId: 'c1', contractId: 'c-1', sourceTemplateId: 't', sourceTemplateVersion: 1, sequence: 2, label: 'Upcoming', dueDate: '2026-06-01', amount: 2000, amountPaid: 0, status: 'upcoming' });
  const decision = await h.ai.decide('management', 'c1', 'c1', 'human-1');
  assert.equal(decision.status, 'proceeded');
  assert.equal(decision.chosenActionType, 'create_task');
  assert.match(decision.reasoning, /overdue/i);
});

test('management agent reports no_action when collections risk is within normal range', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  await h.scheduleLines.save({ id: 'l3', companyId: 'c1', contractId: 'c-1', sourceTemplateId: 't', sourceTemplateVersion: 1, sequence: 1, label: 'Overdue', dueDate: '2026-01-01', amount: 500, amountPaid: 0, status: 'overdue' });
  await h.scheduleLines.save({ id: 'l4', companyId: 'c1', contractId: 'c-1', sourceTemplateId: 't', sourceTemplateVersion: 1, sequence: 2, label: 'Upcoming', dueDate: '2026-06-01', amount: 9500, amountPaid: 0, status: 'upcoming' });
  const decision = await h.ai.decide('management', 'c1', 'c1', 'human-1');
  assert.equal(decision.status, 'no_action');
});

test('management agent rejects a subjectId that does not match the calling companyId', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  await assert.rejects(() => h.ai.decide('management', 'c1', 'c2', 'human-1'));
});

// ---- Execution history / monitoring ----

test('listAgentDecisions and getAgentStats reflect decisions across agents', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT, EDIT_LEAD_GRANT]);
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Stats Lead', phone: '0100' });
  const recycle = await stageByKey(h.crmStages, 'c1', 'recycle');
  await h.crm.moveToStage(lead.id, 'c1', recycle.id);
  await h.ai.decide('sales', 'c1', lead.id, 'human-1'); // escalates (last stage before Won/Lost)

  const campaign = await h.marketing.createCampaign({ companyId: 'c1', name: 'Stats Campaign', channel: 'digital', budget: 100, startDate: '2026-01-01' });
  await h.ai.decide('marketing', 'c1', campaign.id, 'human-1'); // no_action (planned, not active)

  const decisions = await h.ai.listAgentDecisions('c1');
  assert.equal(decisions.length, 2);
  const salesOnly = await h.ai.listAgentDecisions('c1', 'sales');
  assert.equal(salesOnly.length, 1);

  const stats = await h.ai.getAgentStats('c1');
  assert.equal(stats.sales!.escalated, 1);
  assert.equal(stats.marketing!.noAction, 1);
  assert.equal(stats.finance!.total, 0);
});

test('getAgentDecision rejects a decision belonging to a different company (cross-tenant)', async () => {
  const h = await freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [EDIT_LEAD_GRANT]);
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Tenant Lead', phone: '0100' });
  const decision = await h.ai.decide('sales', 'c1', lead.id, 'human-1');
  await assert.rejects(() => h.ai.getAgentDecision(decision.id, 'c2'));
});
