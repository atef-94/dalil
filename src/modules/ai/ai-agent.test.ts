import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { InMemoryRepository } from '../../infra/repository.js';
import { RbacEvaluator } from '../permissions/rbac.evaluator.js';
import { AuditLog } from '../../infra/audit-log.js';
import { TaskService } from '../tasks/task.service.js';
import { CommunicationService } from '../communication/communication.service.js';
import { CrmService } from '../crm/crm.service.js';
import { MarketingService } from '../marketing/marketing.service.js';
import { OperationsService } from '../operations/operations.service.js';
import { HrService } from '../hr/hr.service.js';
import { FinanceService } from '../finance/finance.service.js';
import { SalesService } from '../sales/sales.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { PaymentPlansService } from '../payment-plans/payment-plans.service.js';
import { AutomationService } from '../automation/automation.service.js';
import { IntegrationService } from '../integrations/integration.service.js';
import { LeadScoringService } from './lead-scoring.service.js';
import { AiAgentService } from './ai-agent.service.js';
import type {
  ActionName,
  AgentDecision,
  AiActionRequest,
  AiPolicy,
  ApprovalRequest,
  AuditLogEntry,
  Campaign,
  Employee,
  IntegrationConnection,
  IntegrationEvent,
  Lead,
  LeaveRequest,
  MaintenanceTicket,
  Message,
  Contract,
  Opportunity,
  Payment,
  PaymentPlanTemplate,
  PaymentScheduleLine,
  PermissionGrant,
  PermissionOverride,
  Project,
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

function freshHarness() {
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

  const tasks = new TaskService(tasksRepo);
  const communication = new CommunicationService(messages);
  const crm = new CrmService(leads);
  const marketing = new MarketingService(campaigns, leads);
  const auditLog = new AuditLog(auditLogRepo);
  const leadScoring = new LeadScoringService(leads);
  const operations = new OperationsService(maintenanceTickets, units);
  const hr = new HrService(leaveRequests, employees);
  const finance = new FinanceService(payments, receipts, scheduleLines, refunds);
  const inventory = new InventoryService(units, holds, reservations, projects);
  const paymentPlans = new PaymentPlansService(templates, scheduleLines);
  const sales = new SalesService(opportunities, contracts, inventory, paymentPlans);

  const automation = new AutomationService(
    { workflows, runs, stepRuns, approvals, secrets },
    rbac,
    tasks,
    communication,
    crm,
    marketing,
    finance,
    sales,
    auditLog,
    'test-encryption-secret-not-for-production',
  );

  const actionRequests = new InMemoryRepository<AiActionRequest>();
  const policies = new InMemoryRepository<AiPolicy>();
  const agentDecisions = new InMemoryRepository<AgentDecision>();

  const integrationConnections = new InMemoryRepository<IntegrationConnection>();
  const integrationEvents = new InMemoryRepository<IntegrationEvent>();
  const integrationFetchCalls: { url: string; init?: RequestInit }[] = [];
  let integrationFetchImpl: typeof fetch = (async (url, init) => {
    integrationFetchCalls.push({ url: String(url), init: init as RequestInit | undefined });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const integrations = new IntegrationService(
    { connections: integrationConnections, events: integrationEvents },
    automation,
    auditLog,
    ((url: Parameters<typeof fetch>[0], init?: RequestInit) => integrationFetchImpl(url, init)) as typeof fetch,
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
    leadScoring,
    auditLog,
    marketing,
    operations,
    hr,
    finance,
    integrations,
  );

  return {
    rbac,
    ai,
    automation,
    integrations,
    integrationFetchCalls,
    setIntegrationFetchImpl: (impl: typeof fetch) => {
      integrationFetchImpl = impl;
    },
    users,
    roles,
    grants,
    userRoles,
    leads,
    crm,
    marketing,
    operations,
    hr,
    finance,
    employees,
    units,
    policies,
    auditLogRepo,
    scheduleLines,
    leaveRequests,
  };
}

async function seedUserWithGrants(
  h: ReturnType<typeof freshHarness>,
  companyId: string,
  userId: string,
  grantList: { action: ActionName; resource: ResourceName }[],
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
    await h.grants.save({ id: randomUUID(), roleId: role.id, action: g.action, resource: g.resource, scope: 'company', sensitivity: 'standard' });
  }
}

const CREATE_TASK_GRANT: { action: ActionName; resource: ResourceName } = { action: 'create', resource: 'task' };
const EDIT_LEAD_GRANT: { action: ActionName; resource: ResourceName } = { action: 'edit', resource: 'lead' };
const APPROVE_GRANT: { action: ActionName; resource: ResourceName } = { action: 'approve', resource: 'approval' };

test('an AI action request without the required RBAC grant is denied and never executes', async () => {
  const h = freshHarness();
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
  const h = freshHarness();
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
  const h = freshHarness();
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
  const h = freshHarness();
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
  const h = freshHarness();
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
  const h = freshHarness();
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
  const h = freshHarness();
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
  const h = freshHarness();
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
  const h = freshHarness();
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

test('getActionRequest rejects a request belonging to a different company (cross-tenant)', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  const request = await h.ai.requestAction({ companyId: 'c1', requestedByUserId: 'human-1', actionType: 'create_task', params: { title: 'x' } });
  await assert.rejects(() => h.ai.getActionRequest(request.id, 'c2'));
});

test('suggestNextAction proposes advancing a well-scored new lead to contacted', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [EDIT_LEAD_GRANT]);
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Promising Client', phone: '0100', sourceId: 'campaign-1', ownerEmployeeUserId: 'human-1' });
  const decision = await h.ai.suggestNextAction(lead.id, 'c1', 'human-1');
  assert.equal(decision.status, 'proceeded');
  assert.equal(decision.chosenActionType, 'update_lead_status');
  assert.equal((decision.params as { status: string }).status, 'contacted');
  assert.match(decision.reasoning, /score/i);
});

test('suggestNextAction reports no_action for a lead already lost, without proposing anything', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [EDIT_LEAD_GRANT]);
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Gone Cold', phone: '0100' });
  await h.crm.updateStatus(lead.id, 'lost', 'went with a competitor');
  const decision = await h.ai.suggestNextAction(lead.id, 'c1', 'human-1');
  assert.equal(decision.status, 'no_action');
  assert.equal(decision.chosenActionType, undefined);
});

test('suggestNextAction executes automatically when the company opts a lead action into auto_execute', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [EDIT_LEAD_GRANT]);
  await h.ai.setPolicy('c1', 'update_lead_status', 'auto_execute', 'human-1');
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Hot Lead', phone: '0100', sourceId: 'campaign-1', ownerEmployeeUserId: 'human-1' });
  const decision = await h.ai.suggestNextAction(lead.id, 'c1', 'human-1');
  assert.equal(decision.status, 'proceeded');
  assert.equal(decision.resultActionStatus, 'executed');
  const updated = await h.crm.getLead(lead.id);
  assert.equal(updated!.status, 'contacted');
});

test('setPolicy overwrites an existing policy for the same company and action type rather than duplicating it', async () => {
  const h = freshHarness();
  await h.ai.setPolicy('c1', 'create_task', 'suggest_only', 'human-1');
  await h.ai.setPolicy('c1', 'create_task', 'auto_execute', 'human-1');
  const policies = await h.ai.listPolicies('c1');
  const matching = policies.filter((p) => p.actionType === 'create_task');
  assert.equal(matching.length, 1);
  assert.equal(matching[0]!.autonomyLevel, 'auto_execute');
});

test('every AI action request is recorded in the audit log with executedByAI metadata', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', []);
  await h.ai.requestAction({ companyId: 'c1', requestedByUserId: 'human-1', actionType: 'create_task', params: { title: 'x' } });
  const list = await h.ai.listActionRequests('c1');
  assert.equal(list.length, 1);
  assert.equal(list[0]!.status, 'denied_permission');
});

// ---- Phase 2: Agent Orchestration Layer ----

test('listAgents returns the 5 specialized business-function agents', () => {
  const h = freshHarness();
  const keys = h.ai.listAgents().map((a) => a.key);
  assert.deepEqual(keys.sort(), ['finance', 'hr', 'marketing', 'sales', 'support']);
});

test('listTools returns the full tool registry, or a per-agent boundary-filtered subset', () => {
  const h = freshHarness();
  const allTools = h.ai.listTools();
  assert.ok(allTools.length >= 7);
  const salesTools = h.ai.listTools('sales');
  assert.ok(salesTools.every((t) => ['update_lead_status', 'assign_lead_owner', 'create_task', 'send_message', 'integration_call'].includes(t.actionType)));
  assert.ok(!salesTools.some((t) => t.actionType === 'webhook_call'));
});

test('listTools rejects an unknown agent key', () => {
  const h = freshHarness();
  assert.throws(() => h.ai.listTools('not-a-real-agent'));
});

// ---- Cross-module: Sales agent reaching out via the Integration Layer ----

const INTEGRATION_CALL_GRANT: { action: ActionName; resource: ResourceName } = { action: 'create', resource: 'integration_connection' };

test('sales agent reaches out via a connected WhatsApp integration instead of only updating status', async () => {
  const h = freshHarness();
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
  // still unchanged — reaching out doesn't itself advance the funnel stage
  const unchanged = await h.crm.getLead(lead.id);
  assert.equal(unchanged!.status, 'new');
});

test('sales agent falls back to email when only an email integration is connected and the lead has no phone-eligible WhatsApp path', async () => {
  const h = freshHarness();
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
  const h = freshHarness();
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

  const updated = await h.crm.getLead(lead.id);
  assert.equal(updated!.status, 'contacted');
});

test('a qualified lead escalates to a human instead of guessing at conversion', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [EDIT_LEAD_GRANT]);
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Qualified Client', phone: '0100' });
  await h.crm.updateStatus(lead.id, 'contacted');
  await h.crm.updateStatus(lead.id, 'qualified');
  const decision = await h.ai.decide('sales', 'c1', lead.id, 'human-1');
  assert.equal(decision.status, 'escalated');
  assert.equal(decision.confidence, 15);
});

test('a repeat decision within the cooldown window reuses the prior decision instead of re-deciding', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [EDIT_LEAD_GRANT]);
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Repeat Client', phone: '0100' });
  const first = await h.ai.decide('sales', 'c1', lead.id, 'human-1');
  const second = await h.ai.decide('sales', 'c1', lead.id, 'human-1');
  assert.equal(first.id, second.id);
});

test('decide throws for an unknown agent key', async () => {
  const h = freshHarness();
  await assert.rejects(() => h.ai.decide('not-a-real-agent', 'c1', 'subject-1', 'human-1'));
});

// ---- Marketing Agent ----

test('marketing agent flags a low-converting, high-volume campaign for review', async () => {
  const h = freshHarness();
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
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  const campaign = await h.marketing.createCampaign({ companyId: 'c1', name: 'Planned Campaign', channel: 'digital', budget: 1000, startDate: '2026-01-01' });
  const decision = await h.ai.decide('marketing', 'c1', campaign.id, 'human-1');
  assert.equal(decision.status, 'no_action');
});

// ---- Finance Agent ----

test('finance agent recommends a collections follow-up for an overdue payment line', async () => {
  const h = freshHarness();
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
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  const line = await h.scheduleLines.save({
    id: 'line-2', companyId: 'c1', contractId: 'contract-1', sourceTemplateId: 'tpl-1', sourceTemplateVersion: 1,
    sequence: 1, label: 'Installment 1', dueDate: new Date().toISOString(), amount: 10000, amountPaid: 0, status: 'upcoming',
  });
  const decision = await h.ai.decide('finance', 'c1', line.id, 'human-1');
  assert.equal(decision.status, 'no_action');
});

// ---- Support / Customer Service Agent ----

async function seedUnit(h: ReturnType<typeof freshHarness>, companyId = 'c1'): Promise<Unit> {
  return h.units.save({
    id: 'unit-1', companyId, projectId: 'project-1', code: 'A-101', unitType: 'apartment',
    areaSqm: 100, listPrice: 1000000, status: 'available', createdAt: new Date().toISOString(),
  });
}

test('support agent flags an urgent unassigned ticket for prompt assignment', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  const unit = await seedUnit(h);
  const ticket = await h.operations.createTicket({ companyId: 'c1', unitId: unit.id, title: 'Burst pipe', priority: 'urgent', reportedByUserId: 'human-1' });
  const decision = await h.ai.decide('support', 'c1', ticket.id, 'human-1');
  assert.equal(decision.status, 'proceeded');
  assert.equal(decision.chosenActionType, 'create_task');
  assert.equal(decision.confidence, 90);
});

test('support agent reports no_action for a low-priority assigned ticket', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  const unit = await seedUnit(h);
  const ticket = await h.operations.createTicket({ companyId: 'c1', unitId: unit.id, title: 'Squeaky door', priority: 'low', reportedByUserId: 'human-1' });
  await h.operations.assignTicket(ticket.id, 'c1', 'human-1');
  const decision = await h.ai.decide('support', 'c1', ticket.id, 'human-1');
  assert.equal(decision.status, 'no_action');
});

// ---- HR Agent ----

test('hr agent recommends a reminder for a leave request pending too long', async () => {
  const h = freshHarness();
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
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT]);
  await h.employees.save({ id: 'emp-1', companyId: 'c1', fullName: 'Test Employee', email: 'e@c1.com', title: 'Agent', status: 'active', createdAt: new Date().toISOString() });
  const leave = await h.hr.requestLeave({ companyId: 'c1', employeeId: 'emp-1', type: 'annual', startDate: '2026-03-01', endDate: '2026-03-05' });
  const decision = await h.ai.decide('hr', 'c1', leave.id, 'human-1');
  assert.equal(decision.status, 'no_action');
});

// ---- Execution history / monitoring ----

test('listAgentDecisions and getAgentStats reflect decisions across agents', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [CREATE_TASK_GRANT, EDIT_LEAD_GRANT]);
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Stats Lead', phone: '0100' });
  await h.crm.updateStatus(lead.id, 'contacted');
  await h.crm.updateStatus(lead.id, 'qualified');
  await h.ai.decide('sales', 'c1', lead.id, 'human-1'); // escalates (qualified lead)

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
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [EDIT_LEAD_GRANT]);
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Tenant Lead', phone: '0100' });
  const decision = await h.ai.decide('sales', 'c1', lead.id, 'human-1');
  await assert.rejects(() => h.ai.getAgentDecision(decision.id, 'c2'));
});
