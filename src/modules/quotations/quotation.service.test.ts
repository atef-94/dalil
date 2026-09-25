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

test('recompute renders the stored snapshot, matching a fresh calculate() call at generation time', async () => {
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
  // Each call's schedule starts from its own new Date() (see
  // schedule-generator.ts), so the two calls can legitimately land in
  // different milliseconds if the two calls straddle a tick — compare
  // everything the engine actually derives from the inputs (sequence,
  // label, amount, status) and assert dueDate is only ever off by a
  // sub-second amount, rather than asserting byte-for-byte timestamp
  // equality across two independently-timed calls.
  assert.equal(calculation.schedule.length, direct.schedule.length);
  for (let i = 0; i < calculation.schedule.length; i++) {
    const a = calculation.schedule[i]!;
    const b = direct.schedule[i]!;
    assert.equal(a.sequence, b.sequence);
    assert.equal(a.label, b.label);
    assert.equal(a.amount, b.amount);
    assert.equal(a.status, b.status);
    assert.ok(Math.abs(Date.parse(a.dueDate) - Date.parse(b.dueDate)) < 1000, `dueDate drift too large at index ${i}: ${a.dueDate} vs ${b.dueDate}`);
  }
  assert.equal(calculation.netValue, direct.netValue);
});

// ---- Deep snapshot: a quotation/offer's schedule must stay byte-for-byte
// reproducible even if the unit's listPrice or the payment plan template
// are edited after generation — the same immutability guarantee
// PaymentScheduleLine gives a signed contract's real schedule. Previously
// recompute() replayed calculate() against the LIVE unit/template, so an
// old quotation's numbers silently drifted whenever either was edited. ----

test('recompute is immune to a later edit of the unit listPrice', async () => {
  const { quotations, units, unit, template } = await setup();
  const quotation = await quotations.generate({ companyId: 'c1', unitId: unit.id, paymentPlanTemplateId: template.id, createdByUserId: 'u1' });
  const { calculation: before } = await quotations.recompute(quotation.id, 'c1');

  await units.save({ ...unit, listPrice: 5_000_000 }); // a real, later price change

  const { calculation: after } = await quotations.recompute(quotation.id, 'c1');
  assert.equal(after.totalPrice, before.totalPrice);
  assert.equal(after.totalPrice, 1_000_000); // still the original price, not the edited one
  assert.deepEqual(after.schedule, before.schedule);
});

test('recompute is immune to a later edit of the payment plan template', async () => {
  const { quotations, paymentPlans, unit, template } = await setup();
  const quotation = await quotations.generate({ companyId: 'c1', unitId: unit.id, paymentPlanTemplateId: template.id, createdByUserId: 'u1' });
  const { calculation: before } = await quotations.recompute(quotation.id, 'c1');
  assert.equal(quotation.sourceTemplateVersion, template.version);

  // A real, later edit to the template's own terms (different down payment,
  // different term) — would completely reshape a freshly-generated
  // schedule, but must never change an already-generated quotation's.
  await paymentPlans.updateTemplate(template.id, { downPaymentValue: 50, termMonths: 12 });

  const { calculation: after } = await quotations.recompute(quotation.id, 'c1');
  assert.deepEqual(after.schedule, before.schedule);
  assert.equal(after.schedule.length, quotation.scheduleSnapshot.length);
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

test('findUnitByCode looks a unit up by its code (case-insensitive), scoped to the company', async () => {
  const { quotations, unit } = await setup();
  const found = await quotations.findUnitByCode('c1', 'a-101');
  assert.equal(found.id, unit.id);
  await assert.rejects(() => quotations.findUnitByCode('c1', 'no-such-code'));
  await assert.rejects(() => quotations.findUnitByCode('other-company', 'A-101'));
});

test('generate rejects a nonexistent unit', async () => {
  const { quotations, template } = await setup();
  await assert.rejects(() => quotations.generate({ companyId: 'c1', unitId: 'no-such-unit', paymentPlanTemplateId: template.id, createdByUserId: 'u1' }));
});
