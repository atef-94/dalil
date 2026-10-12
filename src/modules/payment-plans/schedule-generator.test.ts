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
  const { lines } = generateSchedule({ template: baseTemplate({ downPaymentValue: 10 }), totalPrice: 100_000 });
  assert.equal(lines[0]!.label, 'Down Payment');
  assert.equal(lines[0]!.kind, 'down_payment');
  assert.equal(lines[0]!.amount, 10_000);
});

test('fixed down payment uses the raw value', () => {
  const { lines } = generateSchedule({ template: baseTemplate({ downPaymentType: 'fixed', downPaymentValue: 5000 }), totalPrice: 100_000 });
  assert.equal(lines[0]!.amount, 5000);
});

test('fixed down payment is capped at the effective price', () => {
  const { lines } = generateSchedule({ template: baseTemplate({ downPaymentType: 'fixed', downPaymentValue: 999_999 }), totalPrice: 100_000 });
  assert.equal(lines[0]!.amount, 100_000);
});

test('monthly frequency generates one installment per month of the term', () => {
  const { lines } = generateSchedule({ template: baseTemplate({ frequency: 'monthly', termMonths: 12 }), totalPrice: 120_000 });
  const installments = lines.filter((l) => l.kind === 'installment');
  assert.equal(installments.length, 12);
});

test('quarterly frequency generates termMonths/3 installments', () => {
  const { lines } = generateSchedule({ template: baseTemplate({ frequency: 'quarterly', termMonths: 12 }), totalPrice: 120_000 });
  const installments = lines.filter((l) => l.kind === 'installment');
  assert.equal(installments.length, 4);
});

test('semiannual frequency generates termMonths/6 installments', () => {
  const { lines } = generateSchedule({ template: baseTemplate({ frequency: 'semiannual', termMonths: 24 }), totalPrice: 120_000 });
  const installments = lines.filter((l) => l.kind === 'installment');
  assert.equal(installments.length, 4);
});

test('annual frequency generates termMonths/12 installments', () => {
  const { lines } = generateSchedule({ template: baseTemplate({ frequency: 'annual', termMonths: 60 }), totalPrice: 120_000 });
  const installments = lines.filter((l) => l.kind === 'installment');
  assert.equal(installments.length, 5);
});

test('custom frequency uses customMonthInterval', () => {
  const { lines } = generateSchedule({
    template: baseTemplate({ frequency: 'custom', customMonthInterval: 4, termMonths: 24 }),
    totalPrice: 120_000,
  });
  const installments = lines.filter((l) => l.kind === 'installment');
  assert.equal(installments.length, 6);
});

test('custom frequency without customMonthInterval throws', () => {
  assert.throws(() => generateSchedule({ template: baseTemplate({ frequency: 'custom' }), totalPrice: 100_000 }));
});

test('up to 240-month (20-year) terms are accepted', () => {
  const { lines } = generateSchedule({ template: baseTemplate({ termMonths: 240, frequency: 'monthly' }), totalPrice: 1_000_000 });
  const installments = lines.filter((l) => l.kind === 'installment');
  assert.equal(installments.length, 240);
});

test('terms beyond 240 months are rejected', () => {
  assert.throws(() => validateTemplate(baseTemplate({ termMonths: 241 })));
});

test('fee lines are appended at their configured month offset', () => {
  const { lines } = generateSchedule({
    template: baseTemplate({ fees: [{ label: 'Admin Fee', amount: 500, dueMonthOffset: 0 }] }),
    totalPrice: 100_000,
  });
  const fee = lines.find((l) => l.label === 'Admin Fee');
  assert.ok(fee);
  assert.equal(fee!.kind, 'fee');
  assert.equal(fee!.amount, 500);
});

test('a deal-specific discount reduces the effective price before splitting', () => {
  const { lines } = generateSchedule({ template: baseTemplate({ downPaymentValue: 0 }), totalPrice: 100_000, discountPercent: 10 });
  const installmentsSum = lines.filter((l) => l.kind === 'installment').reduce((s, l) => s + l.amount, 0);
  assert.equal(Math.round(installmentsSum), 90_000);
});

test('escalation grows later installments relative to earlier ones', () => {
  const { lines } = generateSchedule({
    template: baseTemplate({ downPaymentValue: 0, frequency: 'annual', termMonths: 36 }),
    totalPrice: 300_000,
    escalationPercentPerYear: 10,
  });
  const installments = lines.filter((l) => l.kind === 'installment');
  assert.ok(installments[2]!.amount > installments[0]!.amount);
});

test('installment amounts sum to the exact remaining balance (no rounding drift)', () => {
  const template = baseTemplate({ downPaymentType: 'percentage', downPaymentValue: 13, frequency: 'monthly', termMonths: 17 });
  const { lines } = generateSchedule({ template, totalPrice: 987_654.32 });
  const installments = lines.filter((l) => l.kind === 'installment');
  const remaining = Math.round((987_654.32 - lines[0]!.amount) * 100) / 100;
  const sum = Math.round(installments.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  assert.equal(sum, remaining);
});

test('equal_installments always reconciles exactly (isValid true, zero remaining/overpayment)', () => {
  const { validation } = generateSchedule({ template: baseTemplate(), totalPrice: 250_000 });
  assert.equal(validation.isValid, true);
  assert.equal(validation.remainingBalance, 0);
  assert.equal(validation.overpayment, 0);
});

// ---- installments_plus_scheduled ----

test('installments_plus_scheduled with no manual amount falls back to the auto-calculated equal share', () => {
  const template = baseTemplate({ paymentMethod: 'installments_plus_scheduled', downPaymentValue: 0 });
  const { lines: equalLines } = generateSchedule({ template: baseTemplate({ downPaymentValue: 0 }), totalPrice: 120_000 });
  const { lines } = generateSchedule({ template, totalPrice: 120_000 });
  const installments = lines.filter((l) => l.kind === 'installment');
  const equalInstallments = equalLines.filter((l) => l.kind === 'installment');
  assert.equal(installments.length, equalInstallments.length);
  assert.equal(installments[0]!.amount, equalInstallments[0]!.amount);
});

test('installments_plus_scheduled with a manual recurring amount uses it for every installment', () => {
  const template = baseTemplate({
    paymentMethod: 'installments_plus_scheduled',
    frequency: 'quarterly',
    termMonths: 12,
    downPaymentValue: 10,
    recurringInstallmentAmount: 50_000,
  });
  const { lines } = generateSchedule({ template, totalPrice: 1_000_000 });
  const installments = lines.filter((l) => l.kind === 'installment');
  assert.equal(installments.length, 4);
  for (const l of installments) assert.equal(l.amount, 50_000);
});

test('scheduled payments carry their own exact dates, independent of installment cadence', () => {
  const template = baseTemplate({
    paymentMethod: 'installments_plus_scheduled',
    frequency: 'quarterly',
    termMonths: 12,
    downPaymentValue: 10,
    recurringInstallmentAmount: 50_000,
    scheduledPayments: [
      { id: 'sp-1', amount: 200_000, dueDate: '2027-12-15T00:00:00.000Z', label: 'Bonus payment' },
      { id: 'sp-2', amount: 200_000, dueDate: '2028-12-15T00:00:00.000Z' },
    ],
  });
  const { lines } = generateSchedule({ template, totalPrice: 1_000_000, startDate: new Date('2026-01-01T00:00:00.000Z') });
  const scheduled = lines.filter((l) => l.kind === 'scheduled_payment');
  assert.equal(scheduled.length, 2);
  assert.equal(scheduled[0]!.dueDate.slice(0, 10), '2027-12-15');
  assert.equal(scheduled[0]!.label, 'Bonus payment');
  assert.equal(scheduled[1]!.label, 'Scheduled Payment'); // default label when none given
});

test('the unified schedule is sorted chronologically regardless of insertion order', () => {
  const template = baseTemplate({
    paymentMethod: 'installments_plus_scheduled',
    frequency: 'annual',
    termMonths: 24,
    downPaymentValue: 10,
    recurringInstallmentAmount: 100_000,
    scheduledPayments: [
      // Deliberately placed between the two annual installments.
      { id: 'sp-1', amount: 50_000, dueDate: '2027-06-01T00:00:00.000Z' },
    ],
  });
  const { lines } = generateSchedule({ template, totalPrice: 1_000_000, startDate: new Date('2026-01-01T00:00:00.000Z') });
  const dates = lines.map((l) => l.dueDate);
  const sorted = [...dates].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(dates, sorted);
  // sequence numbers reflect the sorted order, not insertion order
  lines.forEach((l, i) => assert.equal(l.sequence, i));
});

test('multiple scheduled payments on the same date are both kept, not collapsed', () => {
  const template = baseTemplate({
    paymentMethod: 'installments_plus_scheduled',
    downPaymentValue: 0,
    termMonths: 1,
    recurringInstallmentAmount: 0,
    scheduledPayments: [
      { id: 'sp-1', amount: 100_000, dueDate: '2027-01-01T00:00:00.000Z', label: 'A' },
      { id: 'sp-2', amount: 100_000, dueDate: '2027-01-01T00:00:00.000Z', label: 'B' },
    ],
  });
  const { lines } = generateSchedule({ template, totalPrice: 200_000 });
  const scheduled = lines.filter((l) => l.kind === 'scheduled_payment');
  assert.equal(scheduled.length, 2);
});

test('financial validation: a manual recurring amount lower than the auto share leaves a remaining balance when no scheduled payments cover the gap', () => {
  // Total 1,000,000; down payment 10% = 100,000; remaining 900,000.
  // 4 quarterly installments at 50,000 = 200,000 — far short of the
  // 900,000 remaining, with no scheduled payments to cover the gap.
  const template = baseTemplate({
    paymentMethod: 'installments_plus_scheduled',
    frequency: 'quarterly',
    termMonths: 12,
    downPaymentValue: 10,
    recurringInstallmentAmount: 50_000,
  });
  const { validation } = generateSchedule({ template, totalPrice: 1_000_000 });
  assert.equal(validation.isValid, false);
  assert.ok(validation.remainingBalance > 0);
  assert.equal(validation.overpayment, 0);
});

test('financial validation: scheduled payments that exactly cover the gap reconcile to isValid true', () => {
  // Total 1,000,000; down payment 10% = 100,000; remaining 900,000.
  // 4 quarterly installments at 50,000 = 200,000; two scheduled payments
  // of 350,000 each cover the remaining 700,000 exactly.
  const template = baseTemplate({
    paymentMethod: 'installments_plus_scheduled',
    frequency: 'quarterly',
    termMonths: 12,
    downPaymentValue: 10,
    recurringInstallmentAmount: 50_000,
    scheduledPayments: [
      { id: 'sp-1', amount: 350_000, dueDate: '2027-06-15T00:00:00.000Z' },
      { id: 'sp-2', amount: 350_000, dueDate: '2028-06-15T00:00:00.000Z' },
    ],
  });
  const { validation } = generateSchedule({ template, totalPrice: 1_000_000 });
  assert.equal(validation.isValid, true);
  assert.equal(validation.remainingBalance, 0);
  assert.equal(validation.overpayment, 0);
});

test('financial validation: overpayment is detected and reported, never silently accepted', () => {
  const template = baseTemplate({
    paymentMethod: 'installments_plus_scheduled',
    downPaymentValue: 0,
    termMonths: 1,
    frequency: 'monthly',
    recurringInstallmentAmount: 0,
    scheduledPayments: [
      { id: 'sp-1', amount: 60_000, dueDate: '2026-06-01T00:00:00.000Z' },
    ],
  });
  const { validation } = generateSchedule({ template, totalPrice: 50_000 });
  assert.equal(validation.isValid, false);
  assert.ok(validation.overpayment > 0);
  assert.equal(validation.remainingBalance, 0);
});

test('scheduled payment with a negative amount is rejected', () => {
  const template = baseTemplate({
    paymentMethod: 'installments_plus_scheduled',
    scheduledPayments: [{ id: 'sp-1', amount: -100, dueDate: '2027-01-01T00:00:00.000Z' }],
  });
  assert.throws(() => generateSchedule({ template, totalPrice: 100_000 }));
});

test('scheduled payment with an invalid date is rejected', () => {
  const template = baseTemplate({
    paymentMethod: 'installments_plus_scheduled',
    scheduledPayments: [{ id: 'sp-1', amount: 100, dueDate: 'not-a-date' }],
  });
  assert.throws(() => generateSchedule({ template, totalPrice: 100_000 }));
});

test('a template with no paymentMethod set behaves exactly like equal_installments (backward compatibility)', () => {
  const legacyTemplate = baseTemplate();
  delete (legacyTemplate as Partial<PaymentPlanTemplate>).paymentMethod;
  const equalTemplate = baseTemplate({ paymentMethod: 'equal_installments' });
  const a = generateSchedule({ template: legacyTemplate, totalPrice: 500_000 });
  const b = generateSchedule({ template: equalTemplate, totalPrice: 500_000 });
  assert.deepEqual(a.lines.map((l) => l.amount), b.lines.map((l) => l.amount));
});

// ---- Section 7 audit: large installment counts, rounding, and an
// escalationPercentPerYear <= -100 bug that produced negative installment
// amounts on a real (>=13 month) plan while still reporting isValid: true ----

test('escalationPercentPerYear of exactly -100 is rejected (would zero/negate later installments)', () => {
  const template = baseTemplate({ termMonths: 24 });
  assert.throws(() => generateSchedule({ template, totalPrice: 120_000, escalationPercentPerYear: -100 }), /escalationPercentPerYear/);
});

test('escalationPercentPerYear below -100 is rejected (previously produced negative installment amounts that still summed to the right total)', () => {
  const template = baseTemplate({ termMonths: 24 });
  assert.throws(() => generateSchedule({ template, totalPrice: 120_000, escalationPercentPerYear: -150 }), /escalationPercentPerYear/);
});

test('escalationPercentPerYear between -100 and 0 (a legitimate shrinking-installments plan) is accepted and every installment stays positive', () => {
  const template = baseTemplate({ termMonths: 24 });
  const { lines, validation } = generateSchedule({ template, totalPrice: 120_000, escalationPercentPerYear: -50 });
  const installments = lines.filter((l) => l.kind === 'installment');
  assert.ok(installments.every((l) => l.amount > 0), 'every installment must stay positive');
  assert.equal(validation.isValid, true);
});

test('a large plan (60 monthly installments) reconciles exactly with no negative or zero installment lines', () => {
  const template = baseTemplate({ downPaymentType: 'percentage', downPaymentValue: 5, frequency: 'monthly', termMonths: 60 });
  const { lines, validation } = generateSchedule({ template, totalPrice: 3_333_333.37, escalationPercentPerYear: 5 });
  const installments = lines.filter((l) => l.kind === 'installment');
  assert.equal(installments.length, 60);
  assert.ok(installments.every((l) => l.amount > 0), 'every installment must be positive');
  assert.equal(validation.isValid, true);
  assert.equal(validation.remainingBalance, 0);
  assert.equal(validation.overpayment, 0);
  // The residual from 60-way division must land in the final installment,
  // not silently drift away — assert the raw sum reconciles to the cent.
  const downPayment = lines.find((l) => l.kind === 'down_payment')!.amount;
  const sum = Math.round((downPayment + installments.reduce((s, l) => s + l.amount, 0)) * 100) / 100;
  assert.equal(sum, validation.totalPayable);
});

test('a maximum-length plan (240 monthly installments) still reconciles exactly (rounding does not drift over many lines)', () => {
  const template = baseTemplate({ downPaymentType: 'percentage', downPaymentValue: 0, frequency: 'monthly', termMonths: 240 });
  const { lines, validation } = generateSchedule({ template, totalPrice: 10_000_000.01 });
  const installments = lines.filter((l) => l.kind === 'installment');
  assert.equal(installments.length, 240);
  assert.equal(validation.isValid, true);
  const sum = Math.round(installments.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  assert.equal(sum, 10_000_000.01);
});
