import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApplication } from '../../app.js';

async function freshApp() {
  return buildApplication({ nodeEnv: 'test', tokenSecret: 'test-secret', allowedOrigins: [], seed: true });
}

test('full lifecycle: Lead -> Opportunity -> Reservation -> Contract -> Payment Schedule -> Payment -> Overdue -> Repayment', async () => {
  const app = await freshApp();
  const { crm, crmStages, sales, inventory, paymentPlans, finance } = app.services;
  const companyId = app.seedResult!.companyId;
  const agentUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Sales Agent')!.userId;
  const financeUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Finance')!.userId;

  const lead = await crm.createLead({ companyId, fullName: 'Lifecycle Client', phone: '0555-9001', ownerEmployeeUserId: agentUserId });
  const stages = await crmStages.listStages(companyId, true);
  const contacted = stages.find((s) => s.key === 'no_answer')!;
  const qualified = stages.find((s) => s.key === 'meeting')!;
  await crm.moveToStage(lead.id, companyId, contacted.id);
  await crm.moveToStage(lead.id, companyId, qualified.id);

  const opportunity = await sales.createOpportunity({ companyId, leadId: lead.id, ownerEmployeeUserId: agentUserId });
  const unit = await inventory.createUnit({ companyId, projectId: 'proj-lifecycle', code: 'L-001', unitType: 'villa', areaSqm: 300, listPrice: 3_000_000 });
  const reservation = await sales.reserveUnitForOpportunity(opportunity.id, unit.id, companyId);

  const template = await paymentPlans.createTemplate({
    companyId,
    name: 'Lifecycle Plan',
    downPaymentType: 'percentage',
    downPaymentValue: 10,
    frequency: 'monthly',
    termMonths: 3,
    fees: [],
  });

  const contract = await sales.signContract({
    companyId,
    reservationId: reservation.id,
    creditedEmployeeUserId: agentUserId,
    paymentPlanTemplateId: template.id,
    totalPrice: 3_000_000,
  });
  assert.equal(contract.status, 'signed');

  const schedule = await paymentPlans.getScheduleForContract(contract.id, companyId);
  assert.ok(schedule.length >= 4); // down payment + 3 monthly installments

  // Pay the down payment in full.
  const downPaymentLine = schedule[0]!;
  await finance.recordPayment({
    companyId,
    contractId: contract.id,
    paymentScheduleLineId: downPaymentLine.id,
    amount: downPaymentLine.amount,
    method: 'transfer',
    recordedByUserId: financeUserId,
  });

  const balanceAfterDownPayment = await finance.getBalance(contract.id, companyId);
  assert.equal(balanceAfterDownPayment.totalPaid, downPaymentLine.amount);

  // Force the first installment into the past so the sweep marks it overdue.
  const firstInstallment = schedule[1]!;
  await app.repos.scheduleLines.save({ ...firstInstallment, dueDate: new Date(Date.now() - 86_400_000).toISOString() });
  const swept = await finance.sweepOverdue();
  assert.ok(swept >= 1);
  const overdueLine = await app.repos.scheduleLines.findById(firstInstallment.id);
  assert.equal(overdueLine!.status, 'overdue');

  // Repayment: the overdue line moves to paid once settled.
  const { line: repaidLine } = await finance.recordPayment({
    companyId,
    contractId: contract.id,
    paymentScheduleLineId: firstInstallment.id,
    amount: overdueLine!.amount,
    method: 'cash',
    recordedByUserId: financeUserId,
  });
  assert.equal(repaidLine.status, 'paid');

  const finalBalance = await finance.getBalance(contract.id, companyId);
  assert.equal(finalBalance.totalPaid, downPaymentLine.amount + overdueLine!.amount);
});

test('a payment cannot be recorded against a schedule line from a different contract', async () => {
  const app = await freshApp();
  const { paymentPlans, finance } = app.services;
  const companyId = app.seedResult!.companyId;
  const financeUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Finance')!.userId;

  const template = await paymentPlans.createTemplate({
    companyId,
    name: 'Cross Contract Plan',
    downPaymentType: 'fixed',
    downPaymentValue: 10_000,
    frequency: 'monthly',
    termMonths: 6,
    fees: [],
  });

  const scheduleA = await paymentPlans.generateForContract('contract-a', companyId, template.id, 100_000);
  await paymentPlans.generateForContract('contract-b', companyId, template.id, 100_000);

  await assert.rejects(() =>
    finance.recordPayment({
      companyId,
      contractId: 'contract-b', // wrong contract for scheduleA's line
      paymentScheduleLineId: scheduleA[0]!.id,
      amount: 1000,
      method: 'cash',
      recordedByUserId: financeUserId,
    }),
  );
});
