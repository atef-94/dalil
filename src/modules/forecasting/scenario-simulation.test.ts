import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from '../../infra/repository.js';
import { ScenarioSimulationService } from './scenario-simulation.service.js';
import type { PaymentPlanTemplate } from '../../domain/types.js';

function freshService() {
  const templates = new InMemoryRepository<PaymentPlanTemplate>();
  const svc = new ScenarioSimulationService(templates);
  return { svc, templates };
}

test('runScenario with an ad-hoc plan computes net value, totalCollectible, and a monthly cash flow', async () => {
  const { svc } = freshService();
  const result = await svc.runScenario('co1', {
    totalPrice: 1000000,
    discountPercent: 10,
    adHocPlan: { downPaymentType: 'percentage', downPaymentValue: 20, frequency: 'monthly', termMonths: 12 },
    startDate: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(result.netContractValue, 900000);
  assert.equal(result.discountAmount, 100000);
  assert.equal(result.totalCollectible, 900000);
  assert.equal(result.schedule.length, 13); // down payment + 12 installments
  assert.ok(result.cashFlowByMonth.length > 0);
  assert.equal(result.cashFlowByMonth.reduce((sum, m) => sum + m.amount, 0), 900000);
});

test('runScenario reuses a saved template by templateId, identically to the real signing path', async () => {
  const { svc, templates } = freshService();
  await templates.save({ id: 't1', companyId: 'co1', name: 'Standard', version: 1, downPaymentType: 'percentage', downPaymentValue: 10, frequency: 'quarterly', termMonths: 24, fees: [], createdAt: new Date().toISOString(), archived: false });
  const result = await svc.runScenario('co1', { totalPrice: 500000, templateId: 't1', startDate: '2026-01-01T00:00:00.000Z' });
  assert.equal(result.netContractValue, 500000);
  assert.equal(result.schedule[0]!.amount, 50000); // 10% down payment
});

test('runScenario rejects a templateId from a different company (cross-tenant)', async () => {
  const { svc, templates } = freshService();
  await templates.save({ id: 't1', companyId: 'other-co', name: 'Standard', version: 1, downPaymentType: 'percentage', downPaymentValue: 10, frequency: 'monthly', termMonths: 12, fees: [], createdAt: new Date().toISOString(), archived: false });
  await assert.rejects(() => svc.runScenario('co1', { totalPrice: 500000, templateId: 't1' }));
});

test('runScenario requires either templateId or adHocPlan', async () => {
  const { svc } = freshService();
  await assert.rejects(() => svc.runScenario('co1', { totalPrice: 500000 }));
});

test('runScenario computes a lower NPV than nominal total when a positive discount rate is applied', async () => {
  const { svc } = freshService();
  const nominal = await svc.runScenario('co1', {
    totalPrice: 1000000,
    adHocPlan: { downPaymentType: 'percentage', downPaymentValue: 0, frequency: 'monthly', termMonths: 12 },
    startDate: '2026-01-01T00:00:00.000Z',
  });
  const discounted = await svc.runScenario('co1', {
    totalPrice: 1000000,
    adHocPlan: { downPaymentType: 'percentage', downPaymentValue: 0, frequency: 'monthly', termMonths: 12 },
    startDate: '2026-01-01T00:00:00.000Z',
    annualDiscountRatePercentForNpv: 12,
  });
  assert.equal(nominal.npv, nominal.totalCollectible);
  assert.ok(discounted.npv < discounted.totalCollectible);
});

test('compareScenarios returns both results plus deltas', async () => {
  const { svc } = freshService();
  const comparison = await svc.compareScenarios(
    'co1',
    { totalPrice: 1000000, discountPercent: 15, adHocPlan: { downPaymentType: 'percentage', downPaymentValue: 20, frequency: 'monthly', termMonths: 12 } },
    { totalPrice: 1000000, discountPercent: 0, adHocPlan: { downPaymentType: 'percentage', downPaymentValue: 20, frequency: 'monthly', termMonths: 12 } },
  );
  assert.equal(comparison.scenario.netContractValue, 850000);
  assert.equal(comparison.baseline.netContractValue, 1000000);
  assert.equal(comparison.delta.netContractValueDelta, -150000);
});

test('runScenario rejects a non-positive totalPrice', async () => {
  const { svc } = freshService();
  await assert.rejects(() => svc.runScenario('co1', { totalPrice: 0, adHocPlan: { downPaymentType: 'percentage', downPaymentValue: 10, frequency: 'monthly', termMonths: 12 } }));
});
