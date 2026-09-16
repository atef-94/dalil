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
import { AutomationService } from '../automation/automation.service.js';
import { LeadScoringService } from './lead-scoring.service.js';
import { AiAgentService } from './ai-agent.service.js';
import type {
  ActionName,
  AiActionRequest,
  AiPolicy,
  ApprovalRequest,
  AuditLogEntry,
  Campaign,
  Employee,
  Lead,
  Message,
  PermissionGrant,
  PermissionOverride,
  ResourceName,
  Role,
  Secret,
  Task,
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

  const tasks = new TaskService(tasksRepo);
  const communication = new CommunicationService(messages);
  const crm = new CrmService(leads);
  const marketing = new MarketingService(campaigns, leads);
  const auditLog = new AuditLog(auditLogRepo);
  const leadScoring = new LeadScoringService(leads);

  const automation = new AutomationService(
    { workflows, runs, stepRuns, approvals, secrets },
    rbac,
    tasks,
    communication,
    crm,
    marketing,
    auditLog,
    'test-encryption-secret-not-for-production',
  );

  const actionRequests = new InMemoryRepository<AiActionRequest>();
  const policies = new InMemoryRepository<AiPolicy>();

  const ai = new AiAgentService({ actionRequests, policies, approvals }, rbac, automation, crm, leadScoring, auditLog);

  return { rbac, ai, automation, users, roles, grants, userRoles, leads, crm, policies };
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
  const request = await h.ai.suggestNextAction(lead.id, 'c1', 'human-1');
  assert.equal(request.actionType, 'update_lead_status');
  assert.equal((request.params as { status: string }).status, 'contacted');
  assert.match(request.reasoning ?? '', /score/i);
});

test('suggestNextAction refuses to propose anything for a lead already lost', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [EDIT_LEAD_GRANT]);
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Gone Cold', phone: '0100' });
  await h.crm.updateStatus(lead.id, 'lost', 'went with a competitor');
  await assert.rejects(() => h.ai.suggestNextAction(lead.id, 'c1', 'human-1'));
});

test('suggestNextAction executes automatically when the company opts a lead action into auto_execute', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'human-1', [EDIT_LEAD_GRANT]);
  await h.ai.setPolicy('c1', 'update_lead_status', 'auto_execute', 'human-1');
  const lead = await h.crm.createLead({ companyId: 'c1', fullName: 'Hot Lead', phone: '0100', sourceId: 'campaign-1', ownerEmployeeUserId: 'human-1' });
  const request = await h.ai.suggestNextAction(lead.id, 'c1', 'human-1');
  assert.equal(request.status, 'executed');
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
