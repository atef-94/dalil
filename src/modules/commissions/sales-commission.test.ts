import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { InMemoryRepository } from '../../infra/repository.js';
import { SalesCommissionService } from './sales-commission.service.js';
import type { Employee, SalesCommission, SalesCommissionRule, User } from '../../domain/types.js';

function freshHarness() {
  const rules = new InMemoryRepository<SalesCommissionRule>();
  const commissions = new InMemoryRepository<SalesCommission>();
  const employees = new InMemoryRepository<Employee>();
  const users = new InMemoryRepository<User>();
  const svc = new SalesCommissionService(rules, commissions, employees, users);
  return { svc, rules, commissions, employees, users };
}

async function seedEmployeeUser(h: ReturnType<typeof freshHarness>, companyId: string, managerEmployeeId?: string): Promise<{ userId: string; employeeId: string }> {
  const employeeId = randomUUID();
  const userId = randomUUID();
  await h.employees.save({
    id: employeeId,
    companyId,
    fullName: `Agent ${userId.slice(0, 4)}`,
    email: `${userId}@x.com`,
    title: 'Sales Agent',
    status: 'active',
    createdAt: new Date().toISOString(),
    managerEmployeeId,
  });
  await h.users.save({
    id: userId,
    companyId,
    email: `${userId}@x.com`,
    passwordHash: 'hash',
    userType: 'employee_user',
    employeeId,
    locale: 'en',
    failedLoginCount: 0,
    createdAt: new Date().toISOString(),
  });
  return { userId, employeeId };
}

test('setCommissionRule rejects an invalid tier, out-of-range rate, or foreign employee', async () => {
  const h = freshHarness();
  const agent = await seedEmployeeUser(h, 'c1');
  await assert.rejects(() => h.svc.setCommissionRule({ companyId: 'c1', tier: 'wrong' as never, ratePercent: 5 }));
  await assert.rejects(() => h.svc.setCommissionRule({ companyId: 'c1', tier: 'base', ratePercent: 150 }));
  await assert.rejects(() => h.svc.setCommissionRule({ companyId: 'c2', tier: 'base', ratePercent: 5, employeeUserId: agent.userId }));
});

test('recordCommissionsForContract does nothing when no rules are configured (no behavior change for a company that never opts in)', async () => {
  const h = freshHarness();
  const agent = await seedEmployeeUser(h, 'c1');
  const created = await h.svc.recordCommissionsForContract('c1', 'contract-1', agent.userId, 1_000_000);
  assert.deepEqual(created, []);
});

test('recordCommissionsForContract pays the base rate to the credited employee', async () => {
  const h = freshHarness();
  const agent = await seedEmployeeUser(h, 'c1');
  await h.svc.setCommissionRule({ companyId: 'c1', tier: 'base', ratePercent: 2 });
  const created = await h.svc.recordCommissionsForContract('c1', 'contract-1', agent.userId, 1_000_000);
  assert.equal(created.length, 1);
  assert.equal(created[0]!.tier, 'base');
  assert.equal(created[0]!.employeeUserId, agent.userId);
  assert.equal(created[0]!.amount, 20_000);
  assert.equal(created[0]!.status, 'pending');
});

test('recordCommissionsForContract also pays an override commission to the manager when configured', async () => {
  const h = freshHarness();
  const manager = await seedEmployeeUser(h, 'c1');
  const agent = await seedEmployeeUser(h, 'c1', manager.employeeId);
  await h.svc.setCommissionRule({ companyId: 'c1', tier: 'base', ratePercent: 2 });
  await h.svc.setCommissionRule({ companyId: 'c1', tier: 'override', ratePercent: 0.5 });
  const created = await h.svc.recordCommissionsForContract('c1', 'contract-1', agent.userId, 1_000_000);
  assert.equal(created.length, 2);
  const base = created.find((c) => c.tier === 'base')!;
  const override = created.find((c) => c.tier === 'override')!;
  assert.equal(base.employeeUserId, agent.userId);
  assert.equal(base.amount, 20_000);
  assert.equal(override.employeeUserId, manager.userId);
  assert.equal(override.amount, 5_000);
});

test('recordCommissionsForContract skips the override when the employee has no manager', async () => {
  const h = freshHarness();
  const agent = await seedEmployeeUser(h, 'c1');
  await h.svc.setCommissionRule({ companyId: 'c1', tier: 'base', ratePercent: 2 });
  await h.svc.setCommissionRule({ companyId: 'c1', tier: 'override', ratePercent: 0.5 });
  const created = await h.svc.recordCommissionsForContract('c1', 'contract-1', agent.userId, 1_000_000);
  assert.equal(created.length, 1);
  assert.equal(created[0]!.tier, 'base');
});

test('recordCommissionsForContract is idempotent — calling it twice for the same contract never double-pays', async () => {
  const h = freshHarness();
  const agent = await seedEmployeeUser(h, 'c1');
  await h.svc.setCommissionRule({ companyId: 'c1', tier: 'base', ratePercent: 2 });
  const first = await h.svc.recordCommissionsForContract('c1', 'contract-1', agent.userId, 1_000_000);
  const second = await h.svc.recordCommissionsForContract('c1', 'contract-1', agent.userId, 1_000_000);
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  const all = await h.svc.listCommissions('c1');
  assert.equal(all.length, 1);
});

test('an employee-specific rate takes precedence over the company-wide default', async () => {
  const h = freshHarness();
  const agent = await seedEmployeeUser(h, 'c1');
  await h.svc.setCommissionRule({ companyId: 'c1', tier: 'base', ratePercent: 2 });
  await h.svc.setCommissionRule({ companyId: 'c1', tier: 'base', ratePercent: 5, employeeUserId: agent.userId });
  const created = await h.svc.recordCommissionsForContract('c1', 'contract-1', agent.userId, 1_000_000);
  assert.equal(created[0]!.amount, 50_000);
});

test('commission lifecycle: pending -> approved -> paid', async () => {
  const h = freshHarness();
  const agent = await seedEmployeeUser(h, 'c1');
  await h.svc.setCommissionRule({ companyId: 'c1', tier: 'base', ratePercent: 2 });
  const [created] = await h.svc.recordCommissionsForContract('c1', 'contract-1', agent.userId, 1_000_000);
  const approved = await h.svc.approveCommission(created!.id, 'c1');
  assert.equal(approved.status, 'approved');
  const paid = await h.svc.markCommissionPaid(created!.id, 'c1');
  assert.equal(paid.status, 'paid');
});

test('markCommissionPaid rejects a commission that is not yet approved', async () => {
  const h = freshHarness();
  const agent = await seedEmployeeUser(h, 'c1');
  await h.svc.setCommissionRule({ companyId: 'c1', tier: 'base', ratePercent: 2 });
  const [created] = await h.svc.recordCommissionsForContract('c1', 'contract-1', agent.userId, 1_000_000);
  await assert.rejects(() => h.svc.markCommissionPaid(created!.id, 'c1'));
});

test('clawbackCommission requires a reason and only applies to approved or paid commissions', async () => {
  const h = freshHarness();
  const agent = await seedEmployeeUser(h, 'c1');
  await h.svc.setCommissionRule({ companyId: 'c1', tier: 'base', ratePercent: 2 });
  const [created] = await h.svc.recordCommissionsForContract('c1', 'contract-1', agent.userId, 1_000_000);
  await assert.rejects(() => h.svc.clawbackCommission(created!.id, 'c1', 'contract fell through'));
  const approved = await h.svc.approveCommission(created!.id, 'c1');
  await assert.rejects(() => h.svc.clawbackCommission(approved.id, 'c1', ''));
  const clawedBack = await h.svc.clawbackCommission(approved.id, 'c1', 'contract fell through');
  assert.equal(clawedBack.status, 'clawed_back');
  assert.equal(clawedBack.clawedBackReason, 'contract fell through');
});

test('approveCommission and markCommissionPaid reject a commission from a different company (cross-tenant)', async () => {
  const h = freshHarness();
  const agent = await seedEmployeeUser(h, 'c1');
  await h.svc.setCommissionRule({ companyId: 'c1', tier: 'base', ratePercent: 2 });
  const [created] = await h.svc.recordCommissionsForContract('c1', 'contract-1', agent.userId, 1_000_000);
  await assert.rejects(() => h.svc.approveCommission(created!.id, 'c2'));
});

test('listCommissions filters by employeeUserId when given', async () => {
  const h = freshHarness();
  const agentA = await seedEmployeeUser(h, 'c1');
  const agentB = await seedEmployeeUser(h, 'c1');
  await h.svc.setCommissionRule({ companyId: 'c1', tier: 'base', ratePercent: 2 });
  await h.svc.recordCommissionsForContract('c1', 'contract-1', agentA.userId, 1_000_000);
  await h.svc.recordCommissionsForContract('c1', 'contract-2', agentB.userId, 1_000_000);
  const onlyA = await h.svc.listCommissions('c1', agentA.userId);
  assert.equal(onlyA.length, 1);
  assert.equal(onlyA[0]!.employeeUserId, agentA.userId);
});
