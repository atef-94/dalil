import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApplication } from '../../app.js';
import { PaymentImportService } from './payment-import.service.js';

async function setup() {
  const app = await buildApplication({ nodeEnv: 'test', tokenSecret: 'test-secret', allowedOrigins: [], seed: true });
  const { crm, crmStages, sales, inventory, paymentPlans, finance } = app.services;
  const companyId = app.seedResult!.companyId;
  const agentUserId = app.seedResult!.demoUsers.find((u) => u.label === 'Sales Agent')!.userId;

  const lead = await crm.createLead({ companyId, fullName: 'Payment Import Client', phone: '0500000001', ownerEmployeeUserId: agentUserId });
  const stages = await crmStages.listStages(companyId, true);
  await crm.moveToStage(lead.id, companyId, stages.find((s) => s.key === 'contacted')!.id);
  await crm.moveToStage(lead.id, companyId, stages.find((s) => s.key === 'qualified')!.id);

  const opportunity = await sales.createOpportunity({ companyId, leadId: lead.id, ownerEmployeeUserId: agentUserId });
  const project = await inventory.createProject({ companyId, name: `Payment Import Project ${Date.now()}` });
  const unit = await inventory.createUnit({ companyId, projectId: project.id, code: `PI-${Date.now()}`, unitType: 'apartment', areaSqm: 120, listPrice: 1_000_000 });

  const reservation = await sales.reserveUnitForOpportunity(opportunity.id, unit.id, companyId);
  const template = await paymentPlans.createTemplate({
    companyId,
    name: 'Payment Import Plan',
    downPaymentType: 'percentage',
    downPaymentValue: 10,
    frequency: 'monthly',
    termMonths: 2,
    fees: [],
  });
  const contract = await sales.signContract({
    companyId,
    reservationId: reservation.id,
    creditedEmployeeUserId: agentUserId,
    paymentPlanTemplateId: template.id,
    totalPrice: 1_000_000,
  });
  const schedule = await paymentPlans.getScheduleForContract(contract.id, companyId);

  const svc = new PaymentImportService(app.repos.leads, inventory, sales, paymentPlans, finance);
  return { app, svc, companyId, agentUserId, lead, unit, project: project!, contract, schedule, finance };
}

test('buildPreview resolves a valid row via phone', async () => {
  const { svc, companyId, lead, schedule } = await setup();
  const preview = await svc.buildPreview(companyId, [{ phone: lead.phone, installmentNumber: String(schedule[0]!.sequence), amount: String(schedule[0]!.amount), method: 'cash' }]);
  assert.equal(preview.validCount, 1);
  assert.equal(preview.rows[0]!.resolved!.paymentScheduleLineId, schedule[0]!.id);
});

test('buildPreview resolves a valid row via Project+Unit', async () => {
  const { svc, companyId, project, unit, schedule } = await setup();
  const preview = await svc.buildPreview(companyId, [
    { projectName: project.name, unitCode: unit.code, installmentNumber: String(schedule[0]!.sequence), amount: String(schedule[0]!.amount), method: 'transfer' },
  ]);
  assert.equal(preview.validCount, 1);
});

test('buildPreview flags a missing/invalid amount as invalid', async () => {
  const { svc, companyId, lead, schedule } = await setup();
  const preview = await svc.buildPreview(companyId, [{ phone: lead.phone, installmentNumber: String(schedule[0]!.sequence), amount: '0', method: 'cash' }]);
  assert.equal(preview.invalidCount, 1);
  assert.match(preview.rows[0]!.issues.join(), /Amount Paid.*positive/);
});

test('buildPreview flags an unrecognized payment method as invalid', async () => {
  const { svc, companyId, lead, schedule } = await setup();
  const preview = await svc.buildPreview(companyId, [{ phone: lead.phone, installmentNumber: String(schedule[0]!.sequence), amount: String(schedule[0]!.amount), method: 'bitcoin' }]);
  assert.equal(preview.invalidCount, 1);
  assert.match(preview.rows[0]!.issues.join(), /unrecognized "Payment Method"/);
});

test('buildPreview flags a row with no phone and no Project+Unit as invalid', async () => {
  const { svc, companyId, schedule } = await setup();
  const preview = await svc.buildPreview(companyId, [{ installmentNumber: String(schedule[0]!.sequence), amount: String(schedule[0]!.amount), method: 'cash' }]);
  assert.equal(preview.invalidCount, 1);
  assert.match(preview.rows[0]!.issues.join(), /neither Phone nor Project\+Unit/);
});

test('buildPreview flags an already-fully-paid installment as a conflict', async () => {
  const { svc, companyId, lead, schedule, finance, contract, agentUserId } = await setup();
  await finance.recordPayment({ companyId, contractId: contract.id, paymentScheduleLineId: schedule[0]!.id, amount: schedule[0]!.amount, method: 'cash', recordedByUserId: agentUserId });
  const preview = await svc.buildPreview(companyId, [{ phone: lead.phone, installmentNumber: String(schedule[0]!.sequence), amount: '100', method: 'cash' }]);
  assert.equal(preview.conflictCount, 1);
  assert.match(preview.rows[0]!.issues.join(), /already fully paid/);
});

test('buildPreview flags an overpaying amount as a conflict', async () => {
  const { svc, companyId, lead, schedule } = await setup();
  const overAmount = schedule[0]!.amount + 999999;
  const preview = await svc.buildPreview(companyId, [{ phone: lead.phone, installmentNumber: String(schedule[0]!.sequence), amount: String(overAmount), method: 'cash' }]);
  assert.equal(preview.conflictCount, 1);
  assert.match(preview.rows[0]!.issues.join(), /overpay/);
});

test('buildPreview flags two rows in the same file targeting the same installment as a conflict', async () => {
  const { svc, companyId, lead, schedule } = await setup();
  const half = schedule[0]!.amount / 2;
  const preview = await svc.buildPreview(companyId, [
    { phone: lead.phone, installmentNumber: String(schedule[0]!.sequence), amount: String(half), method: 'cash' },
    { phone: lead.phone, installmentNumber: String(schedule[0]!.sequence), amount: String(half), method: 'cash' },
  ]);
  assert.equal(preview.validCount, 1);
  assert.equal(preview.conflictCount, 1);
  assert.match(preview.rows[1]!.issues.join(), /another row in this same file/);
});

test('importRows records real payments for valid rows and skips conflicts/invalid rows', async () => {
  const { svc, companyId, agentUserId, lead, schedule, app, contract } = await setup();
  const recorded: string[] = [];
  const result = await svc.importRows(
    companyId,
    agentUserId,
    [
      { phone: lead.phone, installmentNumber: String(schedule[0]!.sequence), amount: String(schedule[0]!.amount), method: 'cash' },
      { installmentNumber: String(schedule[0]!.sequence), amount: '100', method: 'cash' }, // invalid: no phone/project+unit
    ],
    async (recordedResult) => {
      recorded.push(recordedResult.payment.id);
    },
  );
  assert.equal(result.total, 2);
  assert.equal(result.succeeded, 1);
  assert.equal(result.skipped, 1);
  assert.equal(recorded.length, 1);

  const line = await app.repos.scheduleLines.findById(schedule[0]!.id);
  assert.equal(line!.status, 'paid');
  const payments = await app.repos.payments.findAll((p) => p.contractId === contract.id);
  assert.equal(payments.length, 1);
});
