import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { PaymentPlansService } from '../payment-plans/payment-plans.service.js';
import { QuotationService } from './quotation.service.js';
import type { PaymentPlanTemplate, PaymentScheduleLine, Quotation, Unit } from '../../domain/types.js';

async function setup() {
  const units = new InMemoryRepository<Unit>();
  const paymentPlans = new PaymentPlansService(new InMemoryRepository<PaymentPlanTemplate>(), new InMemoryRepository<PaymentScheduleLine>());
  const quotations = new QuotationService(new InMemoryRepository<Quotation>(), units, paymentPlans);

  const unit = await units.save({
    id: 'unit-1',
    companyId: 'c1',
    projectId: 'proj-1',
    code: 'A-101',
    unitType: 'apartment',
    areaSqm: 120,
    listPrice: 1_000_000,
    status: 'available',
    createdAt: new Date().toISOString(),
  });

  const template = await paymentPlans.createTemplate({
    companyId: 'c1',
    name: 'Standard 5yr',
    downPaymentType: 'percentage',
    downPaymentValue: 10,
    frequency: 'quarterly',
    termMonths: 60,
    fees: [],
  });

  return { quotations, units, paymentPlans, unit, template };
}

test('calculate reuses PaymentPlansService.previewSchedule for the schedule', async () => {
  const { quotations, unit, template } = await setup();
  const calc = await quotations.calculate('c1', { unitId: unit.id, paymentPlanTemplateId: template.id });
  assert.equal(calc.totalPrice, 1_000_000);
  assert.equal(calc.discountPercent, 0);
  assert.ok(calc.schedule.length > 0);
  assert.equal(calc.downPayment, calc.schedule.find((l) => l.label === 'Down Payment')?.amount);
});

test('calculate applies a totalPriceOverride and discount', async () => {
  const { quotations, unit, template } = await setup();
  const calc = await quotations.calculate('c1', { unitId: unit.id, paymentPlanTemplateId: template.id, totalPriceOverride: 900_000, discountPercent: 5 });
  assert.equal(calc.totalPrice, 900_000);
  assert.equal(calc.netValue, 900_000 * 0.95);
});

test('calculate rejects a unit belonging to a different company (cross-tenant)', async () => {
  const { quotations, unit, template } = await setup();
  await assert.rejects(() => quotations.calculate('other-company', { unitId: unit.id, paymentPlanTemplateId: template.id }));
});

test('generate persists a new quotation with version 1 and a unique reference number', async () => {
  const { quotations, unit, template } = await setup();
  const quotation = await quotations.generate({ companyId: 'c1', unitId: unit.id, paymentPlanTemplateId: template.id, createdByUserId: 'u1' });
  assert.equal(quotation.version, 1);
  assert.match(quotation.referenceNumber, /^Q-\d{8}-0001$/);
  assert.equal(quotation.status, 'generated');
  assert.equal(quotation.unitId, unit.id);
  assert.equal(quotation.projectId, unit.projectId);
});

test('generate increments version and never reuses a reference number for a repeat quote on the same unit', async () => {
  const { quotations, unit, template } = await setup();
  const q1 = await quotations.generate({ companyId: 'c1', unitId: unit.id, paymentPlanTemplateId: template.id, createdByUserId: 'u1' });
  const q2 = await quotations.generate({ companyId: 'c1', unitId: unit.id, paymentPlanTemplateId: template.id, createdByUserId: 'u1' });
  assert.equal(q2.version, 2);
  assert.notEqual(q1.id, q2.id);
  assert.notEqual(q1.referenceNumber, q2.referenceNumber);
});

test('generate never mutates a prior version — both remain retrievable', async () => {
  const { quotations, unit, template } = await setup();
  const q1 = await quotations.generate({ companyId: 'c1', unitId: unit.id, paymentPlanTemplateId: template.id, createdByUserId: 'u1' });
  await quotations.generate({ companyId: 'c1', unitId: unit.id, paymentPlanTemplateId: template.id, createdByUserId: 'u1' });
  const reloaded = await quotations.getQuotation(q1.id, 'c1');
  assert.equal(reloaded.version, 1);
});

test('recompute replays the stored inputs through the same engine as calculate', async () => {
  const { quotations, unit, template } = await setup();
  const quotation = await quotations.generate({
    companyId: 'c1',
    unitId: unit.id,
    paymentPlanTemplateId: template.id,
    createdByUserId: 'u1',
    discountPercent: 8,
    totalPriceOverride: 950_000,
  });
  const { calculation } = await quotations.recompute(quotation.id, 'c1');
  const direct = await quotations.calculate('c1', { unitId: unit.id, paymentPlanTemplateId: template.id, discountPercent: 8, totalPriceOverride: 950_000 });
  assert.deepEqual(calculation.schedule, direct.schedule);
  assert.equal(calculation.netValue, direct.netValue);
});

test('getQuotation rejects cross-tenant access', async () => {
  const { quotations, unit, template } = await setup();
  const quotation = await quotations.generate({ companyId: 'c1', unitId: unit.id, paymentPlanTemplateId: template.id, createdByUserId: 'u1' });
  await assert.rejects(() => quotations.getQuotation(quotation.id, 'other-company'));
});

test('listForCompany returns both quotations and supports unitId/leadId filters', async () => {
  const { quotations, unit, template } = await setup();
  const q1 = await quotations.generate({ companyId: 'c1', unitId: unit.id, paymentPlanTemplateId: template.id, createdByUserId: 'u1', leadId: 'lead-1' });
  const q2 = await quotations.generate({ companyId: 'c1', unitId: unit.id, paymentPlanTemplateId: template.id, createdByUserId: 'u1', leadId: 'lead-2' });
  const all = await quotations.listForCompany('c1');
  assert.deepEqual(new Set(all.map((q) => q.id)), new Set([q1.id, q2.id]));
  const forLead1 = await quotations.listForCompany('c1', { leadId: 'lead-1' });
  assert.deepEqual(forLead1.map((q) => q.id), [q1.id]);
});

test('updateStatus transitions status and rejects cross-tenant access', async () => {
  const { quotations, unit, template } = await setup();
  const quotation = await quotations.generate({ companyId: 'c1', unitId: unit.id, paymentPlanTemplateId: template.id, createdByUserId: 'u1' });
  const sent = await quotations.updateStatus(quotation.id, 'c1', 'sent');
  assert.equal(sent.status, 'sent');
  await assert.rejects(() => quotations.updateStatus(quotation.id, 'other-company', 'accepted'));
});

test('generate rejects a nonexistent unit', async () => {
  const { quotations, template } = await setup();
  await assert.rejects(() => quotations.generate({ companyId: 'c1', unitId: 'no-such-unit', paymentPlanTemplateId: template.id, createdByUserId: 'u1' }));
});
