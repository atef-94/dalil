import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSchedule, validateTemplate } from './schedule-generator.js';
import type { PaymentPlanTemplate } from '../../domain/types.js';

function baseTemplate(overrides: Partial<PaymentPlanTemplate> = {}): PaymentPlanTemplate {
  return {
    id: 'tpl-1',
    companyId: 'company-1',
    name: 'Test Template',
    version: 1,
    downPaymentType: 'percentage',
    downPaymentValue: 10,
    frequency: 'monthly',
    termMonths: 12,
    fees: [],
    createdAt: new Date().toISOString(),
    archived: false,
    ...overrides,
  };
}

test('percentage down payment computes correctly', () => {
  const lines = generateSchedule({ template: baseTemplate({ downPaymentValue: 10 }), totalPrice: 100_000 });
  assert.equal(lines[0]!.label, 'Down Payment');
  assert.equal(lines[0]!.amount, 10_000);
});

test('fixed down payment uses the raw value', () => {
  const lines = generateSchedule({ template: baseTemplate({ downPaymentType: 'fixed', downPaymentValue: 5000 }), totalPrice: 100_000 });
  assert.equal(lines[0]!.amount, 5000);
});

test('fixed down payment is capped at the effective price', () => {
  const lines = generateSchedule({ template: baseTemplate({ downPaymentType: 'fixed', downPaymentValue: 999_999 }), totalPrice: 100_000 });
  assert.equal(lines[0]!.amount, 100_000);
});

test('monthly frequency generates one installment per month of the term', () => {
  const lines = generateSchedule({ template: baseTemplate({ frequency: 'monthly', termMonths: 12 }), totalPrice: 120_000 });
  const installments = lines.filter((l) => l.label.startsWith('Installment'));
  assert.equal(installments.length, 12);
});

test('quarterly frequency generates termMonths/3 installments', () => {
  const lines = generateSchedule({ template: baseTemplate({ frequency: 'quarterly', termMonths: 12 }), totalPrice: 120_000 });
  const installments = lines.filter((l) => l.label.startsWith('Installment'));
  assert.equal(installments.length, 4);
});

test('semiannual frequency generates termMonths/6 installments', () => {
  const lines = generateSchedule({ template: baseTemplate({ frequency: 'semiannual', termMonths: 24 }), totalPrice: 120_000 });
  const installments = lines.filter((l) => l.label.startsWith('Installment'));
  assert.equal(installments.length, 4);
});

test('annual frequency generates termMonths/12 installments', () => {
  const lines = generateSchedule({ template: baseTemplate({ frequency: 'annual', termMonths: 60 }), totalPrice: 120_000 });
  const installments = lines.filter((l) => l.label.startsWith('Installment'));
  assert.equal(installments.length, 5);
});

test('custom frequency uses customMonthInterval', () => {
  const lines = generateSchedule({
    template: baseTemplate({ frequency: 'custom', customMonthInterval: 4, termMonths: 24 }),
    totalPrice: 120_000,
  });
  const installments = lines.filter((l) => l.label.startsWith('Installment'));
  assert.equal(installments.length, 6);
});

test('custom frequency without customMonthInterval throws', () => {
  assert.throws(() => generateSchedule({ template: baseTemplate({ frequency: 'custom' }), totalPrice: 100_000 }));
});

test('up to 240-month (20-year) terms are accepted', () => {
  const lines = generateSchedule({ template: baseTemplate({ termMonths: 240, frequency: 'monthly' }), totalPrice: 1_000_000 });
  const installments = lines.filter((l) => l.label.startsWith('Installment'));
  assert.equal(installments.length, 240);
});

test('terms beyond 240 months are rejected', () => {
  assert.throws(() => validateTemplate(baseTemplate({ termMonths: 241 })));
});

test('fee lines are appended at their configured month offset', () => {
  const lines = generateSchedule({
    template: baseTemplate({ fees: [{ label: 'Admin Fee', amount: 500, dueMonthOffset: 0 }] }),
    totalPrice: 100_000,
  });
  const fee = lines.find((l) => l.label === 'Admin Fee');
  assert.ok(fee);
  assert.equal(fee!.amount, 500);
});

test('a deal-specific discount reduces the effective price before splitting', () => {
  const withDiscount = generateSchedule({ template: baseTemplate({ downPaymentValue: 0 }), totalPrice: 100_000, discountPercent: 10 });
  const installmentsSum = withDiscount.filter((l) => l.label.startsWith('Installment')).reduce((s, l) => s + l.amount, 0);
  assert.equal(Math.round(installmentsSum), 90_000);
});

test('escalation grows later installments relative to earlier ones', () => {
  const lines = generateSchedule({
    template: baseTemplate({ downPaymentValue: 0, frequency: 'annual', termMonths: 36 }),
    totalPrice: 300_000,
    escalationPercentPerYear: 10,
  });
  const installments = lines.filter((l) => l.label.startsWith('Installment'));
  assert.ok(installments[2]!.amount > installments[0]!.amount);
});

test('installment amounts sum to the exact remaining balance (no rounding drift)', () => {
  const template = baseTemplate({ downPaymentType: 'percentage', downPaymentValue: 13, frequency: 'monthly', termMonths: 17 });
  const lines = generateSchedule({ template, totalPrice: 987_654.32 });
  const installments = lines.filter((l) => l.label.startsWith('Installment'));
  const remaining = Math.round((987_654.32 - lines[0]!.amount) * 100) / 100;
  const sum = Math.round(installments.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  assert.equal(sum, remaining);
});
