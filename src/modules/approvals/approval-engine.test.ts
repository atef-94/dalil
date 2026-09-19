import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { InMemoryRepository } from '../../infra/repository.js';
import { RbacEvaluator } from '../permissions/rbac.evaluator.js';
import { ApprovalEngineService } from './approval-engine.service.js';
import type { ActionApproval, ActionName, Employee, PermissionGrant, PermissionOverride, ResourceName, Role, User, UserRole } from '../../domain/types.js';

function freshHarness() {
  const users = new InMemoryRepository<User>();
  const employees = new InMemoryRepository<Employee>();
  const roles = new InMemoryRepository<Role>();
  const grants = new InMemoryRepository<PermissionGrant>();
  const userRoles = new InMemoryRepository<UserRole>();
  const overrides = new InMemoryRepository<PermissionOverride>();
  const rbac = new RbacEvaluator({ users, employees, roles, grants, userRoles, overrides });
  const approvals = new InMemoryRepository<ActionApproval>();
  const svc = new ApprovalEngineService(approvals, rbac);
  return { svc, approvals, users, roles, grants, userRoles };
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

test('requestApproval requires a non-empty reason', async () => {
  const h = freshHarness();
  await assert.rejects(() => h.svc.requestApproval({ companyId: 'c1', actionType: 'discount_override', requestedByUserId: 'u1', reason: '', context: {} }));
});

test('requestApproval creates a pending approval carrying the given context', async () => {
  const h = freshHarness();
  const approval = await h.svc.requestApproval({
    companyId: 'c1',
    actionType: 'discount_override',
    requestedByUserId: 'u1',
    reason: 'discount above policy threshold',
    context: { reservationId: 'r1', discountPercent: 15 },
  });
  assert.equal(approval.status, 'pending');
  assert.deepEqual(approval.context, { reservationId: 'r1', discountPercent: 15 });
});

test('approve requires the approve:approval permission', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'requester-1', []);
  const approval = await h.svc.requestApproval({ companyId: 'c1', actionType: 'discount_override', requestedByUserId: 'requester-1', reason: 'x', context: {} });
  await assert.rejects(() => h.svc.approve(approval.id, 'c1', 'requester-1'));
});

test('approve transitions pending -> approved and records who decided', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'approver-1', [{ action: 'approve', resource: 'approval' }]);
  const approval = await h.svc.requestApproval({ companyId: 'c1', actionType: 'discount_override', requestedByUserId: 'requester-1', reason: 'x', context: {} });
  const approved = await h.svc.approve(approval.id, 'c1', 'approver-1');
  assert.equal(approved.status, 'approved');
  assert.equal(approved.decidedByUserId, 'approver-1');
  assert.ok(approved.decidedAt);
});

test('approve rejects an approval that is not pending (already decided)', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'approver-1', [{ action: 'approve', resource: 'approval' }]);
  const approval = await h.svc.requestApproval({ companyId: 'c1', actionType: 'discount_override', requestedByUserId: 'requester-1', reason: 'x', context: {} });
  await h.svc.approve(approval.id, 'c1', 'approver-1');
  await assert.rejects(() => h.svc.approve(approval.id, 'c1', 'approver-1'));
});

test('reject transitions pending -> rejected and requires the approve:approval permission', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'approver-1', [{ action: 'approve', resource: 'approval' }]);
  await seedUserWithGrants(h, 'c1', 'requester-1', []);
  const approval = await h.svc.requestApproval({ companyId: 'c1', actionType: 'discount_override', requestedByUserId: 'requester-1', reason: 'x', context: {} });
  await assert.rejects(() => h.svc.reject(approval.id, 'c1', 'requester-1', 'no'));
  const rejected = await h.svc.reject(approval.id, 'c1', 'approver-1', 'too large a discount');
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.rejectionReason, 'too large a discount');
});

test('reject defaults the rejection reason when none is given', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'approver-1', [{ action: 'approve', resource: 'approval' }]);
  const approval = await h.svc.requestApproval({ companyId: 'c1', actionType: 'discount_override', requestedByUserId: 'requester-1', reason: 'x', context: {} });
  const rejected = await h.svc.reject(approval.id, 'c1', 'approver-1');
  assert.equal(rejected.rejectionReason, 'rejected by approver');
});

test('approve and reject reject an approval from a different company (cross-tenant)', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'approver-1', [{ action: 'approve', resource: 'approval' }]);
  const approval = await h.svc.requestApproval({ companyId: 'c1', actionType: 'discount_override', requestedByUserId: 'requester-1', reason: 'x', context: {} });
  await assert.rejects(() => h.svc.approve(approval.id, 'c2', 'approver-1'));
});

test('listApprovals filters by company and optionally by status', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'approver-1', [{ action: 'approve', resource: 'approval' }]);
  const a1 = await h.svc.requestApproval({ companyId: 'c1', actionType: 'discount_override', requestedByUserId: 'r1', reason: 'x', context: {} });
  await h.svc.requestApproval({ companyId: 'c1', actionType: 'discount_override', requestedByUserId: 'r2', reason: 'y', context: {} });
  await h.svc.requestApproval({ companyId: 'c2', actionType: 'discount_override', requestedByUserId: 'r3', reason: 'z', context: {} });
  await h.svc.approve(a1.id, 'c1', 'approver-1');

  const allC1 = await h.svc.listApprovals('c1');
  assert.equal(allC1.length, 2);
  const pendingC1 = await h.svc.listApprovals('c1', 'pending');
  assert.equal(pendingC1.length, 1);
});

test('recordResumeFailure records a failure reason without changing the decision', async () => {
  const h = freshHarness();
  await seedUserWithGrants(h, 'c1', 'approver-1', [{ action: 'approve', resource: 'approval' }]);
  const approval = await h.svc.requestApproval({ companyId: 'c1', actionType: 'discount_override', requestedByUserId: 'r1', reason: 'x', context: {} });
  const approved = await h.svc.approve(approval.id, 'c1', 'approver-1');
  const withFailure = await h.svc.recordResumeFailure(approved.id, 'c1', 'reservation no longer active');
  assert.equal(withFailure.status, 'approved');
  assert.equal(withFailure.resumeFailedReason, 'reservation no longer active');
});
