import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { InMemoryRepository } from '../../infra/repository.js';
import { CrmService } from './crm.service.js';
import { CrmStageService } from './crm-stage.service.js';
import { LeadDistributionService } from './lead-distribution.service.js';
import type { CrmStage, Employee, Lead, LeadDistributionPool, User } from '../../domain/types.js';

async function freshHarness(companyId = 'c1') {
  const leads = new InMemoryRepository<Lead>();
  const users = new InMemoryRepository<User>();
  const employees = new InMemoryRepository<Employee>();
  const pools = new InMemoryRepository<LeadDistributionPool>();
  const crmStages = new CrmStageService(new InMemoryRepository<CrmStage>());
  await crmStages.seedDefaultStages(companyId);
  const crm = new CrmService(leads, crmStages);
  const svc = new LeadDistributionService(pools, users, employees, leads, crm, crmStages);
  return { leads, users, employees, pools, crm, crmStages, svc };
}

async function seedEmployeeUser(
  h: Awaited<ReturnType<typeof freshHarness>>,
  companyId: string,
  opts: { skills?: string[] } = {},
): Promise<{ userId: string; employeeId: string }> {
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
    skills: opts.skills,
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

test('configurePool rejects a member who is not an employee_user of this company', async () => {
  const h = await freshHarness();
  await assert.rejects(() => h.svc.configurePool({ companyId: 'c1', mode: 'round_robin', memberUserIds: ['nope'], slaMinutes: 15 }));
});

test('configurePool rejects an empty pool or non-positive SLA', async () => {
  const h = await freshHarness();
  const agent = await seedEmployeeUser(h, 'c1');
  await assert.rejects(() => h.svc.configurePool({ companyId: 'c1', mode: 'round_robin', memberUserIds: [], slaMinutes: 15 }));
  await assert.rejects(() => h.svc.configurePool({ companyId: 'c1', mode: 'round_robin', memberUserIds: [agent.userId], slaMinutes: 0 }));
});

test('pickOwnerForNewLead round-robins fairly across the pool', async () => {
  const h = await freshHarness();
  const a = await seedEmployeeUser(h, 'c1');
  const b = await seedEmployeeUser(h, 'c1');
  const c = await seedEmployeeUser(h, 'c1');
  await h.svc.configurePool({ companyId: 'c1', mode: 'round_robin', memberUserIds: [a.userId, b.userId, c.userId], slaMinutes: 15 });

  const picks = [];
  for (let i = 0; i < 6; i++) {
    const assignment = await h.svc.pickOwnerForNewLead('c1');
    picks.push(assignment!.ownerUserId);
  }
  assert.deepEqual(picks, [a.userId, b.userId, c.userId, a.userId, b.userId, c.userId]);
});

test('pickOwnerForNewLead sets a real SLA deadline slaMinutes in the future', async () => {
  const h = await freshHarness();
  const a = await seedEmployeeUser(h, 'c1');
  await h.svc.configurePool({ companyId: 'c1', mode: 'round_robin', memberUserIds: [a.userId], slaMinutes: 30 });
  const before = Date.now();
  const assignment = await h.svc.pickOwnerForNewLead('c1');
  const dueAt = Date.parse(assignment!.firstContactSlaDueAt);
  assert.ok(dueAt >= before + 29 * 60_000 && dueAt <= before + 31 * 60_000);
});

test('pickOwnerForNewLead returns undefined when no pool is configured', async () => {
  const h = await freshHarness();
  const assignment = await h.svc.pickOwnerForNewLead('c1');
  assert.equal(assignment, undefined);
});

test('skill-based pool narrows to matching members, falling back to the full pool if nobody matches', async () => {
  const h = await freshHarness();
  const luxury = await seedEmployeeUser(h, 'c1', { skills: ['luxury'] });
  const general = await seedEmployeeUser(h, 'c1', { skills: [] });
  await h.svc.configurePool({ companyId: 'c1', mode: 'skill_based', memberUserIds: [general.userId, luxury.userId], slaMinutes: 15 });

  const matched = await h.svc.pickOwnerForNewLead('c1', 'luxury');
  assert.equal(matched!.ownerUserId, luxury.userId);

  const unmatched = await h.svc.pickOwnerForNewLead('c1', 'waterfront');
  assert.ok([general.userId, luxury.userId].includes(unmatched!.ownerUserId));
});

test('sweepSlaBreaches reassigns a breached lead to the next pool member and penalizes the original owner', async () => {
  const h = await freshHarness();
  const a = await seedEmployeeUser(h, 'c1');
  const b = await seedEmployeeUser(h, 'c1');
  await h.svc.configurePool({ companyId: 'c1', mode: 'round_robin', memberUserIds: [a.userId, b.userId], slaMinutes: 15 });

  const assignment = await h.svc.pickOwnerForNewLead('c1');
  assert.equal(assignment!.ownerUserId, a.userId);
  const lead = await h.crm.createLead({
    companyId: 'c1',
    fullName: 'Client X',
    phone: '0100',
    ownerEmployeeUserId: assignment!.ownerUserId,
    firstContactSlaDueAt: assignment!.firstContactSlaDueAt,
  });

  const future = new Date(Date.now() + 20 * 60_000);
  const breaches = await h.svc.sweepSlaBreaches(future);
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0]!.leadId, lead.id);
  assert.equal(breaches[0]!.previousOwnerUserId, a.userId);
  assert.equal(breaches[0]!.newOwnerUserId, b.userId);
  assert.equal(breaches[0]!.reassignmentCount, 1);

  const updatedLead = await h.leads.findById(lead.id);
  assert.equal(updatedLead!.ownerEmployeeUserId, b.userId);
  assert.equal(updatedLead!.reassignmentCount, 1);
  assert.ok(Date.parse(updatedLead!.firstContactSlaDueAt!) > future.getTime());

  const employeeA = await h.employees.findById(a.employeeId);
  assert.equal(employeeA!.slaPenaltyPoints, 1);
  const employeeB = await h.employees.findById(b.employeeId);
  assert.equal(employeeB!.slaPenaltyPoints ?? 0, 0);
});

test('sweepSlaBreaches never touches a lead that already moved past new', async () => {
  const h = await freshHarness();
  const a = await seedEmployeeUser(h, 'c1');
  await h.svc.configurePool({ companyId: 'c1', mode: 'round_robin', memberUserIds: [a.userId], slaMinutes: 15 });
  const assignment = await h.svc.pickOwnerForNewLead('c1');
  const lead = await h.crm.createLead({
    companyId: 'c1',
    fullName: 'Client Y',
    phone: '0200',
    ownerEmployeeUserId: assignment!.ownerUserId,
    firstContactSlaDueAt: assignment!.firstContactSlaDueAt,
  });
  const contacted = (await h.crmStages.listStages('c1')).find((s) => s.key === 'contacted')!;
  await h.crm.moveToStage(lead.id, 'c1', contacted.id);

  const future = new Date(Date.now() + 20 * 60_000);
  const breaches = await h.svc.sweepSlaBreaches(future);
  assert.equal(breaches.length, 0);
});

test('sweepSlaBreaches with a single-member pool re-flags the lead and still penalizes, without reassigning', async () => {
  const h = await freshHarness();
  const a = await seedEmployeeUser(h, 'c1');
  await h.svc.configurePool({ companyId: 'c1', mode: 'round_robin', memberUserIds: [a.userId], slaMinutes: 15 });
  const assignment = await h.svc.pickOwnerForNewLead('c1');
  const lead = await h.crm.createLead({
    companyId: 'c1',
    fullName: 'Client Z',
    phone: '0300',
    ownerEmployeeUserId: assignment!.ownerUserId,
    firstContactSlaDueAt: assignment!.firstContactSlaDueAt,
  });

  const future = new Date(Date.now() + 20 * 60_000);
  const breaches = await h.svc.sweepSlaBreaches(future);
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0]!.newOwnerUserId, undefined);
  assert.equal(breaches[0]!.previousOwnerUserId, a.userId);

  const updatedLead = await h.leads.findById(lead.id);
  assert.equal(updatedLead!.ownerEmployeeUserId, a.userId);
  assert.equal(updatedLead!.reassignmentCount, 1);

  const employeeA = await h.employees.findById(a.employeeId);
  assert.equal(employeeA!.slaPenaltyPoints, 1);
});

test('sweepSlaBreaches is repeatable: a lead that keeps missing SLA keeps cycling instead of being processed once and ignored', async () => {
  const h = await freshHarness();
  const a = await seedEmployeeUser(h, 'c1');
  const b = await seedEmployeeUser(h, 'c1');
  await h.svc.configurePool({ companyId: 'c1', mode: 'round_robin', memberUserIds: [a.userId, b.userId], slaMinutes: 15 });
  const assignment = await h.svc.pickOwnerForNewLead('c1');
  const lead = await h.crm.createLead({
    companyId: 'c1',
    fullName: 'Client W',
    phone: '0400',
    ownerEmployeeUserId: assignment!.ownerUserId,
    firstContactSlaDueAt: assignment!.firstContactSlaDueAt,
  });

  const firstBreach = new Date(Date.now() + 20 * 60_000);
  await h.svc.sweepSlaBreaches(firstBreach);
  const secondBreach = new Date(Date.now() + 40 * 60_000);
  const breaches = await h.svc.sweepSlaBreaches(secondBreach);
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0]!.previousOwnerUserId, b.userId);
  assert.equal(breaches[0]!.newOwnerUserId, a.userId);
  assert.equal(breaches[0]!.reassignmentCount, 2);

  const updatedLead = await h.leads.findById(lead.id);
  assert.equal(updatedLead!.reassignmentCount, 2);
});
