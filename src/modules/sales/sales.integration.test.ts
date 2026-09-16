import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApplication } from '../../app.js';

async function freshApp() {
  return buildApplication({ nodeEnv: 'test', tokenSecret: 'test-secret', allowedOrigins: [], seed: true });
}

test('full chain: Lead -> Opportunity -> Reserve Unit -> Sign Contract generates a payment schedule', async () => {
  const app = await freshApp();
  const { crm, sales, inventory, paymentPlans } = app.services;
  const companyId = app.seedResult!.companyId;
  const agentUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Sales Agent')!.userId;

  const lead = await crm.createLead({ companyId, fullName: 'Client A', phone: '0555-0001', ownerEmployeeUserId: agentUserId });
  await crm.updateStatus(lead.id, 'contacted');
  await crm.updateStatus(lead.id, 'qualified');

  const opportunity = await sales.createOpportunity({ companyId, leadId: lead.id, ownerEmployeeUserId: agentUserId });
  const unit = await inventory.createUnit({ companyId, projectId: 'proj-1', code: 'B-201', unitType: 'apartment', areaSqm: 150, listPrice: 1_500_000 });
  const reservation = await sales.reserveUnitForOpportunity(opportunity.id, unit.id);

  const template = await paymentPlans.createTemplate({
    companyId,
    name: 'Integration Test Plan',
    downPaymentType: 'percentage',
    downPaymentValue: 10,
    frequency: 'monthly',
    termMonths: 12,
    fees: [],
  });

  const contract = await sales.signContract({
    companyId,
    reservationId: reservation.id,
    creditedEmployeeUserId: agentUserId,
    paymentPlanTemplateId: template.id,
    totalPrice: 1_500_000,
  });

  assert.equal(contract.status, 'signed');
  const schedule = await paymentPlans.getScheduleForContract(contract.id);
  assert.ok(schedule.length > 1);

  const refreshedUnit = await inventory.getUnit(unit.id);
  assert.equal(refreshedUnit!.status, 'contracted');

  const refreshedOpportunity = await sales.getOpportunity(opportunity.id);
  assert.equal(refreshedOpportunity!.stage, 'won');
});

test('concurrency regression: 5 concurrent signContract calls against the same reservation produce exactly 1 success', async () => {
  const app = await freshApp();
  const { crm, sales, inventory, paymentPlans } = app.services;
  const companyId = app.seedResult!.companyId;
  const agentUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Sales Agent')!.userId;

  const lead = await crm.createLead({ companyId, fullName: 'Client B', phone: '0555-0002', ownerEmployeeUserId: agentUserId });
  const opportunity = await sales.createOpportunity({ companyId, leadId: lead.id, ownerEmployeeUserId: agentUserId });
  const unit = await inventory.createUnit({ companyId, projectId: 'proj-1', code: 'B-202', unitType: 'apartment', areaSqm: 150, listPrice: 1_000_000 });
  const reservation = await sales.reserveUnitForOpportunity(opportunity.id, unit.id);
  const template = await paymentPlans.createTemplate({
    companyId,
    name: 'Race Test Plan',
    downPaymentType: 'fixed',
    downPaymentValue: 100_000,
    frequency: 'monthly',
    termMonths: 6,
    fees: [],
  });

  const attempts = Array.from({ length: 5 }, () =>
    sales
      .signContract({ companyId, reservationId: reservation.id, creditedEmployeeUserId: agentUserId, paymentPlanTemplateId: template.id, totalPrice: 1_000_000 })
      .then(
        (contract) => ({ ok: true as const, contract }),
        (err) => ({ ok: false as const, err }),
      ),
  );
  const results = await Promise.all(attempts);
  const successes = results.filter((r) => r.ok);
  assert.equal(successes.length, 1);

  const winningContractId = (successes[0] as { ok: true; contract: { id: string } }).contract.id;
  const schedule = await paymentPlans.getScheduleForContract(winningContractId);
  assert.ok(schedule.length > 0);

  const refreshedUnit = await inventory.getUnit(unit.id);
  assert.equal(refreshedUnit!.status, 'contracted');
});

test('reserving a unit for a non-open opportunity fails', async () => {
  const app = await freshApp();
  const { crm, sales, inventory } = app.services;
  const companyId = app.seedResult!.companyId;
  const agentUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Sales Agent')!.userId;

  const lead = await crm.createLead({ companyId, fullName: 'Client C', phone: '0555-0003', ownerEmployeeUserId: agentUserId });
  const opportunity = await sales.createOpportunity({ companyId, leadId: lead.id, ownerEmployeeUserId: agentUserId });
  const unitOne = await inventory.createUnit({ companyId, projectId: 'proj-1', code: 'B-203', unitType: 'apartment', areaSqm: 120, listPrice: 800_000 });
  const unitTwo = await inventory.createUnit({ companyId, projectId: 'proj-1', code: 'B-204', unitType: 'apartment', areaSqm: 120, listPrice: 800_000 });

  await sales.reserveUnitForOpportunity(opportunity.id, unitOne.id);
  await assert.rejects(() => sales.reserveUnitForOpportunity(opportunity.id, unitTwo.id));
});

test('generating a payment schedule for the same contract twice is idempotent (no duplicate lines)', async () => {
  const app = await freshApp();
  const { paymentPlans } = app.services;
  const companyId = app.seedResult!.companyId;

  const template = await paymentPlans.createTemplate({
    companyId,
    name: 'Idempotency Test Plan',
    downPaymentType: 'percentage',
    downPaymentValue: 20,
    frequency: 'quarterly',
    termMonths: 12,
    fees: [],
  });

  const first = await paymentPlans.generateForContract('contract-idempotent', companyId, template.id, 500_000);
  const second = await paymentPlans.generateForContract('contract-idempotent', companyId, template.id, 500_000);
  assert.equal(first.length, second.length);
  assert.deepEqual(first.map((l) => l.id).sort(), second.map((l) => l.id).sort());
});
