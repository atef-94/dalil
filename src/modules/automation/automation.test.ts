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
import { FinanceService } from '../finance/finance.service.js';
import { SalesService } from '../sales/sales.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { PaymentPlansService } from '../payment-plans/payment-plans.service.js';
import { AutomationService } from './automation.service.js';
import type {
  ActionName,
  ApprovalRequest,
  AuditLogEntry,
  Campaign,
  Contract,
  Employee,
  Lead,
  Message,
  Opportunity,
  Payment,
  PaymentPlanTemplate,
  PaymentScheduleLine,
  PermissionGrant,
  PermissionOverride,
  Project,
  Receipt,
  Refund,
  ResourceName,
  Role,
  Secret,
  Task,
  Unit,
  UnitHold,
  Reservation,
  User,
  UserRole,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStepRun,
} from '../../domain/types.js';

function freshHarness(retryBaseDelayMs = 0, maxConcurrentRuns = 10) {
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

  const tasks = new TaskService(tasksRepo);
  const communication = new CommunicationService(messages);
  const crm = new CrmService(leads);
  const marketing = new MarketingService(campaigns, leads);
  const auditLog = new AuditLog(auditLogRepo);

  const opportunities = new InMemoryRepository<Opportunity>();
  const contracts = new InMemoryRepository<Contract>();
  const payments = new InMemoryRepository<Payment>();
  const receipts = new InMemoryRepository<Receipt>();
  const refunds = new InMemoryRepository<Refund>();
  const scheduleLines = new InMemoryRepository<PaymentScheduleLine>();
  const units = new InMemoryRepository<Unit>();
  const holds = new InMemoryRepository<UnitHold>();
  const reservations = new InMemoryRepository<Reservation>();
  const projects = new InMemoryRepository<Project>();
  const templates = new InMemoryRepository<PaymentPlanTemplate>();
  const inventory = new InventoryService(units, holds, reservations, projects);
  const paymentPlans = new PaymentPlansService(templates, scheduleLines);
  const finance = new FinanceService(payments, receipts, scheduleLines, refunds);
  const sales = new SalesService(opportunities, contracts, inventory, paymentPlans);

  const fetchCalls: { url: string; init?: RequestInit }[] = [];
  let fetchImpl: typeof fetch = (async (url, init) => {
    fetchCalls.push({ url: String(url), init: init as RequestInit | undefined });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

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
    ((url: Parameters<typeof fetch>[0], init?: RequestInit) => fetchImpl(url, init)) as typeof fetch,
    retryBaseDelayMs,
    maxConcurrentRuns,
  );

  return {
    rbac,
    automation,
    users,
    employees,
    roles,
    grants,
    userRoles,
    leads,
    campaigns,
    crm,
    marketing,
    finance,
    sales,
    contracts,
    scheduleLines,
    units,
    projects,
    reservations,
    runs,
    stepRuns,
    auditLogRepo,
    fetchCalls,
    setFetchImpl: (impl: typeof fetch) => {
      fetchImpl = impl;
    },
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
const APPROVE_GRANT: { action: ActionName; resource: ResourceName } = { action: 'approve', resource: 'approval' };

test('an event-triggered workflow executes its action and completes', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', [CREATE_TASK_GRANT]);
  const workflow = await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Welcome task',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'lead.created' },
    steps: [{ name: 'Create task', action: { type: 'create_task', params: { title: 'Follow up with {{fullName}}' } } }],
  });
  assert.equal(workflow.status, 'active');

  const results = await h.automation.handleEvent({ companyId: 'c1', type: 'lead.created', payload: { fullName: 'Amir' }, actorUserId: 'owner-1' });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.status, 'completed');

  const steps = await h.automation.listStepRuns(results[0]!.id, 'c1');
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.status, 'succeeded');
  assert.equal(typeof steps[0]!.output?.taskId, 'string');
});

test('emitting the same event twice only creates one run (idempotency)', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', [CREATE_TASK_GRANT]);
  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Welcome task',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'lead.created' },
    steps: [{ name: 'Create task', action: { type: 'create_task', params: { title: 'Follow up' } } }],
  });

  const event = { companyId: 'c1', type: 'lead.created' as const, payload: { fullName: 'Amir' }, dedupeKey: 'lead-1' };
  const first = await h.automation.handleEvent(event);
  const second = await h.automation.handleEvent(event);
  assert.equal(first[0]!.id, second[0]!.id);

  const workflow = (await h.automation.listWorkflows('c1'))[0]!;
  const allRuns = await h.automation.listRuns(workflow.id, 'c1');
  assert.equal(allRuns.length, 1);
});

test('a step whose conditions fail is skipped, not blocking; a matching step still runs', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', [CREATE_TASK_GRANT]);
  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Branching workflow',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'lead.status_changed' },
    steps: [
      {
        name: 'Only when lost',
        conditions: [{ field: 'status', operator: 'eq', value: 'lost' }],
        action: { type: 'create_task', params: { title: 'Win-back task' } },
      },
      {
        name: 'Only when qualified',
        conditions: [{ field: 'status', operator: 'eq', value: 'qualified' }],
        action: { type: 'create_task', params: { title: 'Prepare proposal' } },
      },
    ],
  });

  const [run] = await h.automation.handleEvent({ companyId: 'c1', type: 'lead.status_changed', payload: { status: 'qualified' } });
  assert.equal(run!.status, 'completed');
  const steps = await h.automation.listStepRuns(run!.id, 'c1');
  assert.equal(steps.length, 2);
  const skipped = steps.find((s) => s.status === 'skipped');
  const succeeded = steps.find((s) => s.status === 'succeeded');
  assert.ok(skipped);
  assert.ok(succeeded);
});

test('a step is retried up to maxRetries and succeeds on the final attempt', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', [{ action: 'view', resource: 'secret' }]);
  let attempts = 0;
  h.setFetchImpl((async () => {
    attempts += 1;
    if (attempts < 3) return new Response('error', { status: 500 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch);

  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Retrying webhook',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'contract.signed' },
    steps: [{ name: 'Call webhook', maxRetries: 2, action: { type: 'webhook_call', params: { url: 'https://example.com/hook' } } }],
  });

  const [run] = await h.automation.handleEvent({ companyId: 'c1', type: 'contract.signed', payload: {} });
  assert.equal(run!.status, 'completed');
  assert.equal(attempts, 3);
  const steps = await h.automation.listStepRuns(run!.id, 'c1');
  assert.equal(steps[0]!.status, 'succeeded');
  assert.equal(steps[0]!.attempts, 3);
});

test('onFailure "stop" halts the run; onFailure "continue" proceeds to the next step', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', [CREATE_TASK_GRANT]);

  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Stops on failure',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'contract.signed' },
    steps: [
      { name: 'Missing title fails', action: { type: 'create_task', params: {} } },
      { name: 'Never reached', action: { type: 'create_task', params: { title: 'Unreachable' } } },
    ],
  });
  const [stoppedRun] = await h.automation.handleEvent({ companyId: 'c1', type: 'contract.signed', payload: { id: 'stop' } });
  assert.equal(stoppedRun!.status, 'failed');
  const stoppedSteps = await h.automation.listStepRuns(stoppedRun!.id, 'c1');
  assert.equal(stoppedSteps.length, 1);

  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Continues past failure',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'contract.cancelled' },
    steps: [
      { name: 'Missing title fails', onFailure: 'continue', action: { type: 'create_task', params: {} } },
      { name: 'Still runs', action: { type: 'create_task', params: { title: 'Reached' } } },
    ],
  });
  const [continuedRun] = await h.automation.handleEvent({ companyId: 'c1', type: 'contract.cancelled', payload: { id: 'continue' } });
  assert.equal(continuedRun!.status, 'completed');
  const continuedSteps = await h.automation.listStepRuns(continuedRun!.id, 'c1');
  assert.equal(continuedSteps.length, 2);
  assert.equal(continuedSteps[0]!.status, 'failed');
  assert.equal(continuedSteps[1]!.status, 'succeeded');
});

test('require_approval pauses the run; approving resumes and completes it', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', [CREATE_TASK_GRANT]);
  await seedUserWithGrants(h, 'c1', 'approver-1', [APPROVE_GRANT]);

  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Needs approval',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'contract.signed' },
    steps: [
      { name: 'Require approval', action: { type: 'require_approval', params: { reason: 'Confirm before proceeding' } } },
      { name: 'Follow-up task', action: { type: 'create_task', params: { title: 'Post-approval task' } } },
    ],
  });

  const [run] = await h.automation.handleEvent({ companyId: 'c1', type: 'contract.signed', payload: {} });
  assert.equal(run!.status, 'waiting_approval');

  const pending = await h.automation.listApprovals('c1', 'pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.reason, 'Confirm before proceeding');

  const resumed = await h.automation.approveStep(pending[0]!.id, 'c1', 'approver-1');
  assert.equal(resumed.status, 'completed');

  const steps = await h.automation.listStepRuns(run!.id, 'c1');
  assert.equal(steps.length, 2);
  assert.equal(steps[0]!.status, 'succeeded');
  assert.equal(steps[1]!.status, 'succeeded');
});

test('rejecting an approval cancels the run and never executes the remaining steps', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', [CREATE_TASK_GRANT]);
  await seedUserWithGrants(h, 'c1', 'approver-1', [APPROVE_GRANT]);

  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Needs approval',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'contract.signed' },
    steps: [
      { name: 'Require approval', action: { type: 'require_approval', params: {} } },
      { name: 'Follow-up task', action: { type: 'create_task', params: { title: 'Should never run' } } },
    ],
  });

  const [run] = await h.automation.handleEvent({ companyId: 'c1', type: 'contract.signed', payload: {} });
  const pending = await h.automation.listApprovals('c1', 'pending');

  const cancelled = await h.automation.rejectStep(pending[0]!.id, 'c1', 'approver-1', 'not needed');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.error, 'not needed');

  const steps = await h.automation.listStepRuns(run!.id, 'c1');
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.status, 'failed');
});

test('approving an approval request from a different company is rejected (cross-tenant)', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', [CREATE_TASK_GRANT]);
  await seedUserWithGrants(h, 'c2', 'approver-2', [APPROVE_GRANT]);

  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Needs approval',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'contract.signed' },
    steps: [{ name: 'Require approval', action: { type: 'require_approval', params: {} } }],
  });
  await h.automation.handleEvent({ companyId: 'c1', type: 'contract.signed', payload: {} });
  const pending = await h.automation.listApprovals('c1', 'pending');

  await assert.rejects(() => h.automation.approveStep(pending[0]!.id, 'c2', 'approver-2'));
});

test('a workflow step never bypasses RBAC: a creator without the required grant fails the step', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', []); // no grants at all
  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Unauthorized workflow',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'lead.created' },
    steps: [{ name: 'Create task', action: { type: 'create_task', params: { title: 'Should be denied' } } }],
  });

  const [run] = await h.automation.handleEvent({ companyId: 'c1', type: 'lead.created', payload: {} });
  assert.equal(run!.status, 'failed');
  const steps = await h.automation.listStepRuns(run!.id, 'c1');
  assert.match(steps[0]!.error ?? '', /permission/i);
});

test('update_lead_status action updates the real lead through CrmService', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', [{ action: 'edit', resource: 'lead' }]);
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100' });

  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Advance lead',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'lead.created' },
    steps: [{ name: 'Mark contacted', action: { type: 'update_lead_status', params: { leadId: lead.id, status: 'contacted' } } }],
  });
  const [run] = await h.automation.handleEvent({ companyId: 'c1', type: 'lead.created', payload: {} });
  assert.equal(run!.status, 'completed');

  const updated = await h.crm.getLead(lead.id);
  assert.equal(updated!.status, 'contacted');
});

test('assign_lead_owner action reassigns the lead through CrmService', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', [{ action: 'edit', resource: 'lead' }]);
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100' });

  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Reassign lead',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'lead.created' },
    steps: [{ name: 'Assign owner', action: { type: 'assign_lead_owner', params: { leadId: lead.id, ownerEmployeeUserId: 'emp-9' } } }],
  });
  const [run] = await h.automation.handleEvent({ companyId: 'c1', type: 'lead.created', payload: {} });
  assert.equal(run!.status, 'completed');
  const updated = await h.crm.getLead(lead.id);
  assert.equal(updated!.ownerEmployeeUserId, 'emp-9');
});

test('ai_decide dispatches to the configured AI decider and returns its decision', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', [{ action: 'create', resource: 'ai_action' }]);
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Client A', phone: '0100' });

  const deciderCalls: { companyId: string; agentKey: string; subjectId: string; requestedByUserId: string }[] = [];
  h.automation.setAiDecider(async (companyId, agentKey, subjectId, requestedByUserId) => {
    deciderCalls.push({ companyId, agentKey, subjectId, requestedByUserId });
    return {
      id: 'decision-1',
      companyId,
      agentKey,
      subjectType: 'lead',
      subjectId,
      confidence: 90,
      reasoning: 'stubbed decision',
      alternatives: [],
      status: 'proceeded',
      requestedByUserId,
      createdAt: new Date().toISOString(),
    };
  });

  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Hand lead to AI',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'lead.created' },
    steps: [{ name: 'AI decides', action: { type: 'ai_decide', params: { agentKey: 'sales', subjectId: lead.id } } }],
  });
  const [run] = await h.automation.handleEvent({ companyId: 'c1', type: 'lead.created', payload: {} });
  assert.equal(run!.status, 'completed');
  assert.deepEqual(deciderCalls, [{ companyId: 'c1', agentKey: 'sales', subjectId: lead.id, requestedByUserId: 'owner-1' }]);

  const savedStepRuns = await h.stepRuns.findAll((sr) => sr.runId === run!.id);
  assert.equal(savedStepRuns[0]!.output?.reasoning, 'stubbed decision');
});

test('ai_decide fails clearly when no AI decider is configured for this deployment', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', [{ action: 'create', resource: 'ai_action' }]);

  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Hand lead to AI',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'lead.created' },
    steps: [{ name: 'AI decides', action: { type: 'ai_decide', params: { agentKey: 'sales', subjectId: 'lead-1' } } }],
  });
  const [run] = await h.automation.handleEvent({ companyId: 'c1', type: 'lead.created', payload: {} });
  assert.equal(run!.status, 'failed');
  assert.match(run!.error ?? '', /no AI decider is configured/);
});

test('update_campaign_status action updates the real campaign through MarketingService', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', [{ action: 'edit', resource: 'campaign' }]);
  const campaign = await h.marketing.createCampaign({ companyId: 'c1', name: 'Spring Push', channel: 'digital', budget: 1000, startDate: '2026-01-01' });

  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Activate campaign',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'campaign.status_changed' },
    steps: [{ name: 'Activate', action: { type: 'update_campaign_status', params: { campaignId: campaign.id, status: 'active' } } }],
  });
  const [run] = await h.automation.handleEvent({ companyId: 'c1', type: 'campaign.status_changed', payload: {} });
  assert.equal(run!.status, 'completed');
  const updated = await h.marketing.getCampaign(campaign.id);
  assert.equal(updated!.status, 'active');
});

test('record_payment action records a real payment through FinanceService and advances the schedule line', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', [{ action: 'edit', resource: 'payment_schedule' }]);
  await h.contracts.save({ id: 'contract-1', companyId: 'c1', reservationId: 'r1', unitId: 'u1', clientId: 'lead-1', creditedEmployeeUserId: 'owner-1', paymentPlanTemplateId: 't1', status: 'signed', createdAt: new Date().toISOString() });
  await h.scheduleLines.save({ id: 'line-1', companyId: 'c1', contractId: 'contract-1', sourceTemplateId: 't1', sourceTemplateVersion: 1, sequence: 0, label: 'Down payment', dueDate: new Date().toISOString(), amount: 1000, amountPaid: 0, status: 'upcoming' });

  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Record collected payment',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'payment.recorded' },
    steps: [{ name: 'Record it', action: { type: 'record_payment', params: { contractId: 'contract-1', paymentScheduleLineId: 'line-1', amount: 1000, method: 'transfer' } } }],
  });
  const [run] = await h.automation.handleEvent({ companyId: 'c1', type: 'payment.recorded', payload: {} });
  assert.equal(run!.status, 'completed');
  const line = await h.scheduleLines.findById('line-1');
  assert.equal(line!.status, 'paid');
  assert.equal(line!.amountPaid, 1000);
});

test('record_payment action rejects a contract belonging to a different company (cross-tenant)', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', [{ action: 'edit', resource: 'payment_schedule' }]);
  await h.contracts.save({ id: 'contract-2', companyId: 'c2', reservationId: 'r2', unitId: 'u2', clientId: 'lead-2', creditedEmployeeUserId: 'owner-2', paymentPlanTemplateId: 't1', status: 'signed', createdAt: new Date().toISOString() });

  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Record collected payment',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'payment.recorded' },
    steps: [{ name: 'Record it', action: { type: 'record_payment', params: { contractId: 'contract-2', paymentScheduleLineId: 'line-1', amount: 1000, method: 'transfer' } } }],
  });
  const [run] = await h.automation.handleEvent({ companyId: 'c1', type: 'payment.recorded', payload: {} });
  assert.equal(run!.status, 'failed');
  assert.match(run!.error ?? '', /contract not found/);
});

test('cancel_contract action cancels a real contract through SalesService', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', [{ action: 'edit', resource: 'contract' }]);
  await h.units.save({ id: 'u3', companyId: 'c1', projectId: 'p1', code: 'A-101', unitType: 'apartment', areaSqm: 120, listPrice: 900000, status: 'contracted', createdAt: new Date().toISOString() });
  await h.reservations.save({ id: 'r3', companyId: 'c1', unitId: 'u3', clientId: 'lead-3', status: 'converted', createdAt: new Date().toISOString(), expiresAt: new Date().toISOString() });
  await h.contracts.save({ id: 'contract-3', companyId: 'c1', reservationId: 'r3', unitId: 'u3', clientId: 'lead-3', creditedEmployeeUserId: 'owner-1', paymentPlanTemplateId: 't1', status: 'signed', createdAt: new Date().toISOString() });

  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Cancel stale contract',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'contract.signed' },
    steps: [{ name: 'Cancel it', action: { type: 'cancel_contract', params: { contractId: 'contract-3' } } }],
  });
  const [run] = await h.automation.handleEvent({ companyId: 'c1', type: 'contract.signed', payload: {} });
  assert.equal(run!.status, 'completed');
  const cancelled = await h.contracts.findById('contract-3');
  assert.equal(cancelled!.status, 'cancelled');
});

test('cancel_contract action fails when the workflow creator lacks edit:contract permission', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', []);
  await h.contracts.save({ id: 'contract-4', companyId: 'c1', reservationId: 'r4', unitId: 'u4', clientId: 'lead-4', creditedEmployeeUserId: 'owner-1', paymentPlanTemplateId: 't1', status: 'signed', createdAt: new Date().toISOString() });

  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Cancel stale contract',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'contract.signed' },
    steps: [{ name: 'Cancel it', action: { type: 'cancel_contract', params: { contractId: 'contract-4' } } }],
  });
  const [run] = await h.automation.handleEvent({ companyId: 'c1', type: 'contract.signed', payload: {} });
  assert.equal(run!.status, 'failed');
  assert.match(run!.error ?? '', /lacks edit:contract permission/);
});

test('webhook_call sends a bearer token resolved from the encrypted secret store', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', [{ action: 'view', resource: 'secret' }]);
  await h.automation.setSecret('c1', 'zapier_token', 'super-secret-value', 'owner-1');

  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Notify Zapier',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'contract.signed' },
    steps: [{ name: 'Call webhook', action: { type: 'webhook_call', params: { url: 'https://hooks.example.com/x', secretKey: 'zapier_token' } } }],
  });
  const [run] = await h.automation.handleEvent({ companyId: 'c1', type: 'contract.signed', payload: {} });
  assert.equal(run!.status, 'completed');
  assert.equal(h.fetchCalls.length, 1);
  const headers = h.fetchCalls[0]!.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer super-secret-value');
});

test('secrets are never exposed in plaintext by listSecrets', async () => {
  const h = freshHarness();
  const saved = await h.automation.setSecret('c1', 'api_key', 'plaintext-value', 'owner-1');
  assert.equal((saved as unknown as Record<string, unknown>).encryptedValue, undefined);
  assert.equal((saved as unknown as Record<string, unknown>).value, undefined);

  const listed = await h.automation.listSecrets('c1');
  assert.equal(listed.length, 1);
  assert.equal((listed[0] as unknown as Record<string, unknown>).encryptedValue, undefined);
  assert.equal(JSON.stringify(listed).includes('plaintext-value'), false);
});

test('deleteSecret rejects a secret belonging to a different company (cross-tenant)', async () => {
  const h = freshHarness();
  const saved = await h.automation.setSecret('c1', 'api_key', 'value', 'owner-1');
  await assert.rejects(() => h.automation.deleteSecret(saved.id, 'c2'));
});

test('runDueScheduledWorkflows only fires once per interval window', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', [CREATE_TASK_GRANT]);
  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Hourly reminder',
    createdByUserId: 'owner-1',
    trigger: { type: 'scheduled', intervalMinutes: 60 },
    steps: [{ name: 'Create reminder', action: { type: 'create_task', params: { title: 'Hourly check' } } }],
  });

  const now = new Date('2026-01-01T00:00:00.000Z');
  const firstBatch = await h.automation.runDueScheduledWorkflows(now);
  assert.equal(firstBatch.length, 1);
  assert.equal(firstBatch[0]!.status, 'completed');

  const soonAfter = new Date('2026-01-01T00:05:00.000Z');
  const secondBatch = await h.automation.runDueScheduledWorkflows(soonAfter);
  assert.equal(secondBatch.length, 0);

  const muchLater = new Date('2026-01-01T02:00:00.000Z');
  const thirdBatch = await h.automation.runDueScheduledWorkflows(muchLater);
  assert.equal(thirdBatch.length, 1);
  assert.notEqual(thirdBatch[0]!.id, firstBatch[0]!.id);
});

test('receiveWebhook triggers the matching workflow and dedupes repeated deliveries', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', [CREATE_TASK_GRANT]);
  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Inbound webhook',
    createdByUserId: 'owner-1',
    trigger: { type: 'webhook', webhookSlug: 'my-hook' },
    steps: [{ name: 'Create task', action: { type: 'create_task', params: { title: 'From webhook' } } }],
  });

  const first = await h.automation.receiveWebhook('c1', 'my-hook', { foo: 'bar' }, 'delivery-1');
  assert.equal(first.status, 'completed');
  const second = await h.automation.receiveWebhook('c1', 'my-hook', { foo: 'bar' }, 'delivery-1');
  assert.equal(second.id, first.id);

  await assert.rejects(() => h.automation.receiveWebhook('c1', 'no-such-slug', {}));
});

test('a workflow with a duplicate webhook slug in the same company is rejected', async () => {
  const h = freshHarness();
  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'First',
    createdByUserId: 'owner-1',
    trigger: { type: 'webhook', webhookSlug: 'shared-slug' },
    steps: [{ name: 'Step', action: { type: 'create_task', params: { title: 'x' } } }],
  });
  await assert.rejects(() =>
    h.automation.createWorkflow({
      companyId: 'c1',
      name: 'Second',
      createdByUserId: 'owner-1',
      trigger: { type: 'webhook', webhookSlug: 'shared-slug' },
      steps: [{ name: 'Step', action: { type: 'create_task', params: { title: 'y' } } }],
    }),
  );
});

test('getWorkflow rejects a workflow belonging to a different company (cross-tenant)', async () => {
  const h = freshHarness();
  const workflow = await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Private workflow',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'lead.created' },
    steps: [{ name: 'Step', action: { type: 'create_task', params: { title: 'x' } } }],
  });
  await assert.rejects(() => h.automation.getWorkflow(workflow.id, 'c2'));
});

test('creating a workflow with no steps is rejected', async () => {
  const h = freshHarness();
  await assert.rejects(() =>
    h.automation.createWorkflow({
      companyId: 'c1',
      name: 'Empty workflow',
      createdByUserId: 'owner-1',
      trigger: { type: 'event', eventType: 'lead.created' },
      steps: [],
    }),
  );
});

test('creating a scheduled workflow without intervalMinutes is rejected', async () => {
  const h = freshHarness();
  await assert.rejects(() =>
    h.automation.createWorkflow({
      companyId: 'c1',
      name: 'Bad schedule',
      createdByUserId: 'owner-1',
      trigger: { type: 'scheduled' },
      steps: [{ name: 'Step', action: { type: 'create_task', params: { title: 'x' } } }],
    }),
  );
});

test('pausing a workflow stops it from reacting to new events', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', [CREATE_TASK_GRANT]);
  const workflow = await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Pausable',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'lead.created' },
    steps: [{ name: 'Step', action: { type: 'create_task', params: { title: 'x' } } }],
  });
  await h.automation.setWorkflowStatus(workflow.id, 'c1', 'paused');
  const results = await h.automation.handleEvent({ companyId: 'c1', type: 'lead.created', payload: {} });
  assert.equal(results.length, 0);
});

test('listTemplates returns a non-empty catalogue of built-in templates', () => {
  const h = freshHarness();
  const templates = h.automation.listTemplates();
  assert.ok(templates.length > 0);
  for (const t of templates) {
    assert.ok(t.key);
    assert.ok(t.steps.length > 0);
  }
});

test('listTemplates includes the new HR/onboarding starting points', () => {
  const h = freshHarness();
  const keys = h.automation.listTemplates().map((t) => t.key);
  assert.ok(keys.includes('new-employee-onboarding-task'));
  assert.ok(keys.includes('leave-request-notification'));
});

// ---- Phase 1 hardening: idempotency race protection ----

test('two concurrent duplicate event deliveries are serialized into exactly one run', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', [CREATE_TASK_GRANT]);
  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Race test',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'lead.created' },
    steps: [{ name: 'Create task', action: { type: 'create_task', params: { title: 'Race task' } } }],
  });
  const event = { companyId: 'c1', type: 'lead.created' as const, payload: { id: 'lead-race' }, dedupeKey: 'race-key' };
  const [first, second] = await Promise.all([h.automation.handleEvent(event), h.automation.handleEvent(event)]);
  assert.equal(first[0]!.id, second[0]!.id);

  const workflow = (await h.automation.listWorkflows('c1'))[0]!;
  const allRuns = await h.automation.listRuns(workflow.id, 'c1');
  assert.equal(allRuns.length, 1);
});

// ---- Phase 1 hardening: retry backoff ----

test('retried step attempts wait with exponential backoff between attempts', async () => {
  const h = freshHarness(20);
  await seedUserWithGrants(h, 'c1', 'owner-1', [{ action: 'view', resource: 'secret' }]);
  let attempts = 0;
  const timestamps: number[] = [];
  h.setFetchImpl((async () => {
    timestamps.push(Date.now());
    attempts++;
    if (attempts < 3) return new Response('error', { status: 500 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch);

  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Backoff test',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'contract.signed' },
    steps: [{ name: 'Call webhook', maxRetries: 2, action: { type: 'webhook_call', params: { url: 'https://example.com/hook' } } }],
  });
  const [run] = await h.automation.handleEvent({ companyId: 'c1', type: 'contract.signed', payload: {} });
  assert.equal(run!.status, 'completed');
  assert.equal(attempts, 3);
  assert.ok(timestamps[1]! - timestamps[0]! >= 15, `expected a backoff delay before attempt 2, got ${timestamps[1]! - timestamps[0]!}ms`);
  assert.ok(timestamps[2]! - timestamps[1]! >= 15, `expected a backoff delay before attempt 3, got ${timestamps[2]! - timestamps[1]!}ms`);
});

// ---- Phase 1 hardening: concurrency-bounded execution ----

test('executeRun respects the configured process-wide concurrency limit', async () => {
  const h = freshHarness(0, 1);
  await seedUserWithGrants(h, 'c1', 'owner-1', [{ action: 'view', resource: 'secret' }]);
  let concurrent = 0;
  let maxObserved = 0;
  h.setFetchImpl((async () => {
    concurrent++;
    maxObserved = Math.max(maxObserved, concurrent);
    await new Promise((r) => setTimeout(r, 20));
    concurrent--;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch);

  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Slow webhook A',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'contract.signed' },
    steps: [{ name: 'Call webhook', action: { type: 'webhook_call', params: { url: 'https://example.com/a' } } }],
  });
  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Slow webhook B',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'contract.cancelled' },
    steps: [{ name: 'Call webhook', action: { type: 'webhook_call', params: { url: 'https://example.com/b' } } }],
  });

  await Promise.all([
    h.automation.handleEvent({ companyId: 'c1', type: 'contract.signed', payload: { id: 'a' } }),
    h.automation.handleEvent({ companyId: 'c1', type: 'contract.cancelled', payload: { id: 'b' } }),
  ]);
  assert.equal(maxObserved, 1, 'the concurrency limiter should have serialized the two runs to one at a time');
});

// ---- Phase 1 hardening: failure audit logging ----

test('a failed step is written to the audit log, not just the step-run record', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', [CREATE_TASK_GRANT]);
  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Audit failure test',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'contract.signed' },
    steps: [{ name: 'Missing title fails', action: { type: 'create_task', params: {} } }],
  });
  const [run] = await h.automation.handleEvent({ companyId: 'c1', type: 'contract.signed', payload: {} });
  assert.equal(run!.status, 'failed');

  const entries = await h.auditLogRepo.findAll((e) => e.companyId === 'c1' && e.resourceId === run!.id);
  const failureEntry = entries.find((e) => (e.metadata as Record<string, unknown> | undefined)?.failed === true);
  assert.ok(failureEntry, 'expected a failure audit log entry for the failed step');
});

// ---- Phase 1 hardening: manual failure recovery (retryRun) ----

test('retryRun resumes a failed run and can succeed once the external failure is fixed', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', [{ action: 'view', resource: 'secret' }]);
  h.setFetchImpl((async () => new Response('down', { status: 500 })) as typeof fetch);

  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Outage recovery',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'contract.signed' },
    steps: [{ name: 'Call webhook', action: { type: 'webhook_call', params: { url: 'https://example.com/hook' } } }],
  });
  const [run] = await h.automation.handleEvent({ companyId: 'c1', type: 'contract.signed', payload: {} });
  assert.equal(run!.status, 'failed');

  h.setFetchImpl((async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch);
  const retried = await h.automation.retryRun(run!.id, 'c1');
  assert.equal(retried.status, 'completed');
});

test('retryRun rejects a run that is not currently failed', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', [CREATE_TASK_GRANT]);
  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Completed workflow',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'lead.created' },
    steps: [{ name: 'x', action: { type: 'create_task', params: { title: 'x' } } }],
  });
  const [run] = await h.automation.handleEvent({ companyId: 'c1', type: 'lead.created', payload: {} });
  assert.equal(run!.status, 'completed');
  await assert.rejects(() => h.automation.retryRun(run!.id, 'c1'));
});

test('retryRun rejects a failed run belonging to a different company (cross-tenant)', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', [CREATE_TASK_GRANT]);
  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Fails',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'contract.signed' },
    steps: [{ name: 'Missing title fails', action: { type: 'create_task', params: {} } }],
  });
  const [run] = await h.automation.handleEvent({ companyId: 'c1', type: 'contract.signed', payload: {} });
  assert.equal(run!.status, 'failed');
  await assert.rejects(() => h.automation.retryRun(run!.id, 'c2'));
});

// ---- Phase 1 hardening: crash recovery ----

test('recoverStuckRuns resumes a run left running by a simulated process crash', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', [CREATE_TASK_GRANT]);
  const workflow = await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Crash recovery',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'contract.signed' },
    steps: [{ name: 'Create task', action: { type: 'create_task', params: { title: 'Recovered task' } } }],
  });
  // Simulate a process crash mid-execution: a run persisted as 'running'
  // that never got the chance to reach a terminal status.
  await h.runs.save({
    id: 'stuck-run-1',
    companyId: 'c1',
    workflowId: workflow.id,
    status: 'running',
    triggerPayload: {},
    idempotencyKey: 'stuck-key',
    currentStepIndex: 0,
    startedAt: new Date().toISOString(),
    initiatedBy: 'system',
  });
  const recovered = await h.automation.recoverStuckRuns();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]!.status, 'completed');
});

// ---- Phase 1 hardening: execution monitoring stats ----

test('getStats returns accurate counts across workflows, runs, and pending approvals', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'owner-1', [CREATE_TASK_GRANT]);
  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Stats WF',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'lead.created' },
    steps: [{ name: 'Ask approval', action: { type: 'require_approval', params: {} } }],
  });
  await h.automation.handleEvent({ companyId: 'c1', type: 'lead.created', payload: {} });
  const stats = await h.automation.getStats('c1');
  assert.equal(stats.totalWorkflows, 1);
  assert.equal(stats.activeWorkflows, 1);
  assert.equal(stats.totalRuns, 1);
  assert.equal(stats.waitingApprovalRuns, 1);
  assert.equal(stats.pendingApprovals, 1);
});

// ---- Phase 1 hardening: secret deletion safety ----

test('deleteSecret blocks deleting a secret referenced by an active workflow unless forced', async () => {
  const h = freshHarness();
  const secret = await h.automation.setSecret('c1', 'in_use_key', 'value', 'owner-1');
  await h.automation.createWorkflow({
    companyId: 'c1',
    name: 'Uses secret',
    createdByUserId: 'owner-1',
    trigger: { type: 'event', eventType: 'contract.signed' },
    steps: [{ name: 'Call webhook', action: { type: 'webhook_call', params: { url: 'https://example.com', secretKey: 'in_use_key' } } }],
  });
  await assert.rejects(() => h.automation.deleteSecret(secret.id, 'c1'));
  await h.automation.deleteSecret(secret.id, 'c1', true);
  const remaining = await h.automation.listSecrets('c1');
  assert.equal(remaining.length, 0);
});

test('deleteSecret succeeds without force when no active workflow references it', async () => {
  const h = freshHarness();
  const secret = await h.automation.setSecret('c1', 'unused_key', 'value', 'owner-1');
  await h.automation.deleteSecret(secret.id, 'c1');
  const remaining = await h.automation.listSecrets('c1');
  assert.equal(remaining.length, 0);
});
